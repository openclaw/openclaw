import asyncio
import json
import os
import aiohttp
import sys
from archivist_telegram import TelegramArchivist


async def check_model_exists(session: aiohttp.ClientSession, ollama_url: str, model_name: str) -> bool:
    """Проверяет наличие модели на сервере через /api/tags (без pull)."""
    try:
        async with session.get(f"{ollama_url}/api/tags", timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                data = await resp.json()
                existing = [m['name'] for m in data.get('models', [])]
                # Учитываем :latest тег
                return model_name in existing or f"{model_name}:latest" in existing
    except Exception as e:
        print(f"  [!] Не удалось проверить /api/tags: {e}")
    return False


async def pull_model(ollama_url: str, model_name: str):
    """Асинхронная загрузка модели с OLLAMA_HOST для удалённого сервера."""
    print(f"\n[*] Проверка/Загрузка: {model_name}")
    try:
        # 1. Проверяем через API — если модель есть, пропускаем pull
        async with aiohttp.ClientSession() as session:
            if await check_model_exists(session, ollama_url, model_name):
                print(f"  [+] Модель '{model_name}' уже на сервере. Пропускаем pull.")
                return True

        # 2. Загрузка через асинхронный subprocess с корректным OLLAMA_HOST
        print(f"  [*] Выполняю: ollama pull {model_name} (хост: {ollama_url})")

        env = os.environ.copy()
        env["OLLAMA_HOST"] = ollama_url

        process = await asyncio.create_subprocess_exec(
            "ollama", "pull", model_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env
        )
        stdout, stderr = await process.communicate()

        if process.returncode == 0:
            print(f"  [+] Успешно загружена: {model_name}")
            return True
        else:
            error_msg = stderr.decode().strip() if stderr else "Unknown"
            print(f"  [-] Ошибка загрузки {model_name}: {error_msg}")
            return False

    except Exception as e:
        print(f"  [!] Системная ошибка при загрузке {model_name}: {e}")
        return False


async def test_model_vram(session: aiohttp.ClientSession, ollama_url: str, model_name: str, role: str) -> dict:
    """Тестирует модель на VRAM-совместимость и возвращает метрики."""
    print(f"[*] Тестирую {model_name} (Роль: {role})...")
    payload = {
        "model": model_name,
        "prompt": "Reply with 'OK'. Do not say anything else.",
        "stream": False,
        "keep_alive": "30s"  # CRITICAL: Smart flush instead of 0 to allow optimization
    }
    try:
        timeout = aiohttp.ClientTimeout(total=180)  # 3 минуты для больших моделей
        async with session.post(f"{ollama_url}/api/generate", json=payload, timeout=timeout) as resp:
            if resp.status == 200:
                data = await resp.json()
                # Извлекаем метрики VRAM из ответа Ollama API
                metrics = {
                    "status": "PASS",
                    "load_duration_ms": round(data.get("load_duration", 0) / 1e6, 1),
                    "eval_count": data.get("eval_count", 0),
                    "total_duration_ms": round(data.get("total_duration", 0) / 1e6, 1),
                }
                print(f"  [+] {model_name} ✅ PASS | Load: {metrics['load_duration_ms']}ms | Tokens: {metrics['eval_count']} | Total: {metrics['total_duration_ms']}ms")
                return metrics
            else:
                error_text = await resp.text()
                print(f"  [-] {model_name} ❌ HTTP {resp.status}: {error_text[:200]}")
                return {"status": f"FAIL (HTTP {resp.status})", "load_duration_ms": 0, "eval_count": 0, "total_duration_ms": 0}
    except asyncio.TimeoutError:
        print(f"  [-] {model_name} ❌ TIMEOUT (>180s)")
        return {"status": "FAIL (TIMEOUT)", "load_duration_ms": 0, "eval_count": 0, "total_duration_ms": 0}
    except Exception as e:
        print(f"  [-] {model_name} ❌ ERROR: {e}")
        return {"status": f"ERROR ({e})", "load_duration_ms": 0, "eval_count": 0, "total_duration_ms": 0}


async def main():
    print("=============================================")
    print(" OpenClaw v2026: Ultimate VRAM Hardware Test")
    print(" NVIDIA CUDA (16GB) — 20 ролей, Триада моделей")
    print("=============================================")

    with open('openclaw_config.json', 'r', encoding='utf-8') as f:
        config = json.load(f)

    ollama_url = config['system'].get('ollama_url', 'http://192.168.0.212:11434')
    tg_token = config['system']['telegram']['bot_token']
    chat_id = config['system']['telegram']['admin_chat_id']
    archivist = TelegramArchivist(tg_token, chat_id)

    # 1. Собираем все модели из обеих бригад
    roles_dict = {}
    for brigade_name, brigade_info in config['brigades'].items():
        for role, data in brigade_info['roles'].items():
            roles_dict[f"{brigade_name}::{role}"] = data['model']

    unique_models = sorted(set(roles_dict.values()))

    await archivist.send_status(
        "Hardware Auditor", "Setup",
        f"Запуск диагностики: {len(unique_models)} уникальных моделей, {len(roles_dict)} ролей"
    )

    # 2. Проверка/загрузка моделей (асинхронно, с OLLAMA_HOST)
    print(f"\n[*] Найдено {len(unique_models)} уникальных моделей для проверки.")

    pull_results = {}
    for model in unique_models:
        result = await pull_model(ollama_url, model)
        pull_results[model] = result

    pulled_count = sum(1 for v in pull_results.values() if v)
    print(f"\n[*] Загружено/Подтверждено: {pulled_count}/{len(unique_models)} моделей")

    # 3. Последовательный VRAM-тест каждой роли
    print("\n=============================================")
    print(" 🔬 Тест VRAM: последовательный вывод")
    print(" (keep_alive=0 — авто-очистка после каждой модели)")
    print("=============================================")

    await archivist.send_status(
        "Auditor", "VRAM Test",
        f"Последовательный тест {len(roles_dict)} ролей через {ollama_url}..."
    )

    test_results = {}
    async with aiohttp.ClientSession() as session:
        for role_key, model_name in roles_dict.items():
            metrics = await test_model_vram(session, ollama_url, model_name, role_key)
            test_results[role_key] = {
                "model": model_name,
                **metrics
            }

    # 4. Генерация Диагностической Матрицы
    matrix_output = "📊 *Диагностическая Матрица VRAM (NVIDIA CUDA 16GB):*\n\n"

    # Группируем по бригадам
    for brigade in ["Dmarket", "OpenClaw"]:
        matrix_output += f"🏴 *Бригада {brigade}:*\n"
        for role_key, data in test_results.items():
            if not role_key.startswith(f"{brigade}::"):
                continue
            role_name = role_key.split("::")[1]
            icon = "✅" if data["status"] == "PASS" else "❌"
            matrix_output += f"{icon} `{role_name}` → `{data['model']}` | {data['status']}"
            if data["status"] == "PASS":
                matrix_output += f" | {data['load_duration_ms']}ms"
            matrix_output += "\n"
        matrix_output += "\n"

    pass_count = sum(1 for d in test_results.values() if d["status"] == "PASS")
    total_count = len(test_results)
    matrix_output += f"*Итог:* {pass_count}/{total_count} ролей прошли VRAM тест на NVIDIA CUDA 16GB.\n"
    matrix_output += f"*Уникальных моделей:* {len(unique_models)} | *Загружено:* {pulled_count}"

    print("\n[*] Отправка матрицы в Telegram...")
    await archivist.send_summary("Матрица Диагностики (NVIDIA CUDA 16GB)", matrix_output)
    print("[+] Готово! Проверьте Telegram.")

if __name__ == "__main__":
    asyncio.run(main())
