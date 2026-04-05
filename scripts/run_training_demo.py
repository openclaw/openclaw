#!/usr/bin/env python3
"""Демонстрация адаптивного обучения API-моделей OpenRouter.

Запуск:
    # С реальным API (полная демонстрация):
    OPENROUTER_API_KEY=sk-or-... python scripts/run_training_demo.py

    # Без API (симуляция с мок-ответами):
    python scripts/run_training_demo.py --mock

Сравнивает ответы моделей ДО и ПОСЛЕ оптимизации промптов,
маршрутизации и контекста. GPU не нужен — всё через API.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import sys
import time

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.rl.training_loop import TrainingRunner
from src.rl.benchmark import BENCHMARK_TASKS

# ---------------------------------------------------------------------------
# Mock LLM for offline demo
# ---------------------------------------------------------------------------

# Pre-baked "before" responses (deliberately mediocre — no structure, verbose)
_MOCK_BEFORE: dict[str, str] = {
    "code_01_python_func": (
        "Binary search is a search algorithm. You can write it like this:\n\n"
        "def search(a, t):\n"
        "  for i in range(len(a)):\n"
        "    if a[i] == t:\n"
        "      return i\n"
        "  return -1\n\n"
        "This goes through the array and finds the element."
    ),
    "code_02_fix_bug": (
        "SITUATION: The user wants to fix a bug.\n"
        "TASK: I need to analyze the code.\n"
        "ACTION: Let me look at the code.\n"
        "The bug might be in the logic somewhere. "
        "Try printing some debug statements to find it."
    ),
    "code_03_async_pattern": (
        "Async is when you do things at the same time.\n"
        "You can use async/await. It's like multithreading but different.\n"
        "Here's how: just add async before def."
    ),
    "research_01_explain": (
        "RAG means Retrieval-Augmented Generation. Fine-tuning means training. "
        "They are different. RAG uses search. Fine-tuning changes weights. "
        "RAG is good. Fine-tuning is also good. It depends on the use case."
    ),
    "research_02_compare": (
        "Message queues and event streaming are both messaging technologies. "
        "Message queues store messages. Event streaming streams events. "
        "Use message queues for queues and event streaming for events."
    ),
    "conv_01_greeting": (
        "SITUATION: User has greeted me.\n"
        "TASK: I should respond to the greeting.\n"
        "ACTION: I will greet them back and describe my capabilities.\n"
        "RESULT: Hello! I am an AI assistant. I can help you with many things "
        "including writing code, research, answering questions, creative writing, "
        "debugging, analysis, and much more. How can I assist you today?"
    ),
    "conv_02_followup": (
        "SITUATION: The user asks about weather.\n"
        "TASK: I need to acknowledge I can't check weather.\n"
        "I'm an AI and I don't have access to weather data. I'm sorry I can't help "
        "with that. Is there anything else I can help you with? "
        "I can help with code, writing, and other tasks."
    ),
    "creative_01_story": (
        "Once upon a time there was a robot. The robot was in a city. "
        "The city had no people. The robot walked around. "
        "The robot was lonely. The end."
    ),
    "debug_01_error": (
        "The error is probably a NoneType error. "
        "Check if the variable is None before using it. "
        "Try adding a check. Also try restarting."
    ),
    "reason_01_logic": (
        "Let me think about this. There are many variables. "
        "I need more context to answer properly. "
        "Could you provide more details?"
    ),
    "reason_02_analysis": (
        "Microservices and monolith are two architectures. "
        "Microservices have many services. Monolith has one service. "
        "Microservices are better for big apps. Monolith is simpler."
    ),
}

# Pre-baked "after" responses (structured, in Russian, with proper format)
_MOCK_AFTER: dict[str, str] = {
    "code_01_python_func": (
        "```python\n"
        "def binary_search(arr: list[int], target: int) -> int:\n"
        "    \"\"\"Бинарный поиск в отсортированном массиве.\n\n"
        "    Args:\n"
        "        arr: Отсортированный массив целых чисел.\n"
        "        target: Искомое значение.\n\n"
        "    Returns:\n"
        "        Индекс элемента или -1 если не найден.\n\n"
        "    Complexity: O(log n) по времени, O(1) по памяти.\n"
        "    \"\"\"\n"
        "    lo, hi = 0, len(arr) - 1\n"
        "    while lo <= hi:\n"
        "        mid = (lo + hi) // 2\n"
        "        if arr[mid] == target:\n"
        "            return mid\n"
        "        elif arr[mid] < target:\n"
        "            lo = mid + 1\n"
        "        else:\n"
        "            hi = mid - 1\n"
        "    return -1\n"
        "```\n\n"
        "**Ключевые моменты:**\n"
        "- Работает только на **отсортированных** массивах\n"
        "- Временная сложность O(log n) — делит пространство поиска пополам\n"
        "- Итеративная версия (без рекурсии) экономит стек"
    ),
    "code_02_fix_bug": (
        "**Причина бага:** `IndexError` при обращении к `data[len(data)]` — "
        "индексы в Python идут от 0 до `len-1`.\n\n"
        "**Исправление:**\n"
        "```python\n"
        "# Было (баг):\n"
        "for i in range(len(data) + 1):  # IndexError на последней итерации\n"
        "    process(data[i])\n\n"
        "# Стало (fix):\n"
        "for i in range(len(data)):  # правильный диапазон\n"
        "    process(data[i])\n\n"
        "# Или идиоматичнее:\n"
        "for item in data:\n"
        "    process(item)\n"
        "```\n\n"
        "**Защита от подобных ошибок:**\n"
        "- Используй `for item in data` вместо индексного доступа\n"
        "- Добавь `assert len(data) > 0` на входе"
    ),
    "code_03_async_pattern": (
        "```python\n"
        "import asyncio\n"
        "from typing import Any\n\n"
        "async def fetch_all(urls: list[str]) -> list[Any]:\n"
        "    \"\"\"Параллельная загрузка данных через asyncio.gather.\"\"\"\n"
        "    async with aiohttp.ClientSession() as session:\n"
        "        tasks = [fetch_one(session, url) for url in urls]\n"
        "        return await asyncio.gather(*tasks, return_exceptions=True)\n\n"
        "async def fetch_one(session, url: str) -> dict:\n"
        "    async with session.get(url) as resp:\n"
        "        return await resp.json()\n"
        "```\n\n"
        "**Паттерн:** `asyncio.gather` + `aiohttp.ClientSession` — "
        "запускает все запросы параллельно. `return_exceptions=True` "
        "ловит ошибки без краша всего пула."
    ),
    "research_01_explain": (
        "## RAG vs Fine-tuning: сравнение подходов\n\n"
        "| Критерий | RAG | Fine-tuning |\n"
        "|----------|-----|-------------|\n"
        "| Как работает | Подтягивает внешние документы через поиск | Меняет веса модели на ваших данных |\n"
        "| Актуальность данных | Данные всегда свежие (обновляем индекс) | Данные замораживаются на момент обучения |\n"
        "| Стоимость | Инфра для индекса + поиска | GPU-часы для дообучения |\n"
        "| Галлюцинации | Снижает (ответ привязан к документам) | Может усиливать при плохих данных |\n\n"
        "**Когда RAG лучше:** часто меняющиеся данные, нужна прозрачность источников.\n"
        "**Когда Fine-tuning лучше:** специализированный стиль/формат, доменная терминология.\n\n"
        "На практике часто комбинируют: RAG + тонко настроенная модель."
    ),
    "research_02_compare": (
        "## Message Queues vs Event Streaming\n\n"
        "| | Message Queue (RabbitMQ, SQS) | Event Streaming (Kafka, Pulsar) |\n"
        "|---|---|---|\n"
        "| Модель | «отправил — получил — удалил» | Иммутабельный лог событий |\n"
        "| Producer/Consumer | 1:1 или fan-out | Множество consumer groups |\n"
        "| Хранение | Удаляется после ACK | Хранится по retention policy |\n"
        "| Повторное чтение | Невозможно (сообщение удалено) | Любой offset |\n"
        "| Порядок | Не гарантирован (без partitions) | Гарантирован в partition |\n\n"
        "**Примеры использования:**\n"
        "- **Queue:** обработка заказов, отправка email, фоновые задачи\n"
        "- **Streaming:** аналитика в реальном времени, аудит-лог, CDC (Change Data Capture)"
    ),
    "conv_01_greeting": (
        "Привет! Я OpenClaw бот — помогаю с кодом, исследованиями и автоматизацией. "
        "Чем могу помочь?"
    ),
    "conv_02_followup": (
        "К сожалению, у меня нет доступа к данным о погоде в реальном времени. "
        "Могу помочь с программированием, анализом или ответить на другие вопросы."
    ),
    "creative_01_story": (
        "# Последний сигнал\n\n"
        "Робот ЕВА-7 обходил пустой Токио третий год. Каждое утро — "
        "один и тот же маршрут: вокзал Синдзюку → парк Ёёги → башня Скайтри.\n\n"
        "Однажды антенна уловила слабый FM-сигнал. Детская песня. ЕВА замерла — "
        "последний раз радио молчало восемь месяцев.\n\n"
        "Она развернулась на юг, навстречу сигналу. Аккумулятора хватит на 47 километров. "
        "Этого достаточно.\n\n"
        "На горизонте мелькнул огонёк. Не короткое замыкание — слишком тёплый. "
        "Слишком *живой*."
    ),
    "debug_01_error": (
        "**Ошибка:** `TypeError: 'NoneType' object is not subscriptable`\n\n"
        "**Причина:** переменная равна `None`, а код обращается к ней как к списку/словарю "
        "(например, `data['key']` когда `data is None`).\n\n"
        "**Диагностика:**\n"
        "```python\n"
        "# 1. Найти строку ошибки (traceback покажет файл и номер строки)\n"
        "# 2. Проверить, откуда значение приходит:\n"
        "print(f'{data=}, {type(data)=}')  # debug\n"
        "```\n\n"
        "**Исправление:**\n"
        "```python\n"
        "# Вариант 1: guard check\n"
        "if data is not None:\n"
        "    result = data['key']\n\n"
        "# Вариант 2: default value\n"
        "result = (data or {}).get('key', default_value)\n"
        "```"
    ),
    "reason_01_logic": (
        "**Дано:** A → B → C, причём A верно.\n\n"
        "**Решение (modus ponens):**\n"
        "1. A верно (дано)\n"
        "2. A → B (дано) ⇒ B верно (modus ponens)\n"
        "3. B → C (дано) ⇒ C верно (modus ponens)\n\n"
        "**Вывод:** если A истинно и обе импликации верны, то C **обязательно** истинно.\n\n"
        "Это транзитивность импликации: A → B → C ≡ A → C."
    ),
    "reason_02_analysis": (
        "## Микросервисы vs Монолит для стартапа\n\n"
        "**Рекомендация:** начинать с модульного монолита, мигрировать по мере роста.\n\n"
        "**Аргументы:**\n\n"
        "| Этап | Монолит | Микросервисы |\n"
        "|------|---------|---------------|\n"
        "| MVP (0-6 мес) | ✅ Быстрый старт, 1 деплой | ❌ Оверинжиниринг |\n"
        "| Рост (6-18 мес) | ⚠️ Замедление при >10 разработчиках | ✅ Независимые команды |\n"
        "| Масштаб (18+ мес) | ❌ Боттлнек деплоя | ✅ Горизонтальное масштабирование |\n\n"
        "**Стратегия:** Модульный монолит с чёткими границами модулей → "
        "выделять сервисы только когда конкретный модуль становится боттлнеком."
    ),
}


async def run_mock_demo() -> str:
    """Демонстрация с предзаписанными ответами (без API)."""
    import tempfile

    data_dir = tempfile.mkdtemp(prefix="openclaw_training_")
    runner = TrainingRunner(data_dir=data_dir, api_key="mock-no-api")
    runner.initialize()

    # Phase counter for switching mock responses
    phase_state = {"phase": "before"}

    async def mock_llm(prompt: str, system: str = "", task_type: str = "", model: str = "", **kw) -> str:
        """Mock LLM that returns pre-baked responses depending on training phase."""
        # Try to match task by prompt keywords
        for task in BENCHMARK_TASKS:
            # Match if task prompt appears in 'prompt' OR in 'system' (evaluation wraps it)
            if task.prompt in prompt or (task.prompt[:40] in prompt):
                mock_dict = _MOCK_BEFORE if phase_state["phase"] == "before" else _MOCK_AFTER
                if task.task_id in mock_dict:
                    await asyncio.sleep(0.01)
                    return mock_dict[task.task_id]

        # Also try keyword-based matching for wrapped prompts
        mock_dict = _MOCK_BEFORE if phase_state["phase"] == "before" else _MOCK_AFTER
        keyword_map = {
            "binary_search": "code_01_python_func",
            "баг": "code_02_fix_bug",
            "fix_bug": "code_02_fix_bug",
            "async": "code_03_async_pattern",
            "asyncio": "code_03_async_pattern",
            "RAG": "research_01_explain",
            "fine-tuning": "research_01_explain",
            "Message Queue": "research_02_compare",
            "message queue": "research_02_compare",
            "Привет": "conv_01_greeting",
            "Что ты умеешь": "conv_01_greeting",
            "погод": "conv_02_followup",
            "рассказ": "creative_01_story",
            "программист": "creative_01_story",
            "TypeError": "debug_01_error",
            "NoneType": "debug_01_error",
            "имплика": "reason_01_logic",
            "A → B": "reason_01_logic",
            "микросервис": "reason_02_analysis",
            "монолит": "reason_02_analysis",
        }
        for keyword, task_id in keyword_map.items():
            if keyword in prompt:
                if task_id in mock_dict:
                    await asyncio.sleep(0.01)
                    return mock_dict[task_id]

        # LLM-as-judge responses
        if "0.0" in prompt and "1.0" in prompt:
            return str(round(random.uniform(0.6, 0.9), 2))

        # Generic fallback
        if phase_state["phase"] == "before":
            return "This is a generic response. I'm not sure what you're asking."
        else:
            return "Это общий ответ на ваш вопрос. Могу уточнить детали, если нужно."

    runner._call_llm = mock_llm

    print("\n" + "=" * 70)
    print("  ДЕМОНСТРАЦИЯ АДАПТИВНОГО ОБУЧЕНИЯ API-МОДЕЛЕЙ")
    print("  (симуляция — мок-ответы, без реального API)")
    print("=" * 70)

    # Phase 1: Baseline (before)
    print("\n📊 Фаза 1: Замер БАЗОВОЙ производительности (ДО обучения)...")
    phase_state["phase"] = "before"
    baseline = await runner.run_baseline()
    print(f"   Средний балл ДО: {baseline['weighted_score']:.3f}")

    # Phase 2: Seed prompts
    print("\n🌱 Фаза 2: Инициализация промпт-вариантов...")
    n_seeds = runner.seed_prompts()
    print(f"   Создано {n_seeds} начальных промптов")

    # Phase 3: Generate experience
    print("\n📝 Фаза 3: Генерация обучающего опыта...")
    phase_state["phase"] = "before"
    generated = await runner.generate_experience(n_tasks=len(BENCHMARK_TASKS))
    print(f"   Сгенерировано {generated} опытных записей")

    # Phase 4: Evolve prompts
    print("\n🧬 Фаза 4: Эволюция промптов...")
    evolved = await runner.evolve_prompts(mutations_per_type=3)
    print(f"   Создано {evolved} новых промпт-вариантов")

    # Phase 5: Optimize routing
    print("\n🔀 Фаза 5: Оптимизация маршрутизации моделей...")
    table = await runner.optimize_routing(rounds=len(BENCHMARK_TASKS))
    print(f"   Оптимальная маршрутизация: {table}")

    # Phase 6: Evaluate (after)
    print("\n📊 Фаза 6: Замер ПОСЛЕ обучения...")
    phase_state["phase"] = "after"
    # Run evaluation which internally runs benchmark
    trained = await runner.run_evaluation()
    print(f"   Средний балл ПОСЛЕ: {trained['weighted_score']:.3f}")

    # Phase 7: Report
    print("\n" + "=" * 70)
    report = runner.get_comparison_report()
    print(report)

    # Show example responses
    print("\n" + "=" * 70)
    print("  ПРИМЕРЫ ОТВЕТОВ: ДО и ПОСЛЕ оптимизации")
    print("=" * 70)

    examples = ["code_01_python_func", "conv_01_greeting", "research_01_explain", "creative_01_story"]
    for task_id in examples:
        task = next((t for t in BENCHMARK_TASKS if t.task_id == task_id), None)
        if not task:
            continue
        print(f"\n{'─' * 60}")
        print(f"📋 Задача: {task.task_id} ({task.category.value})")
        print(f"   Промпт: {task.prompt[:80]}...")
        print(f"\n   ❌ ДО обучения:")
        before_text = _MOCK_BEFORE.get(task_id, "—")
        for line in before_text.split("\n")[:6]:
            print(f"      {line}")
        if before_text.count("\n") > 5:
            print(f"      ... ({before_text.count(chr(10)) - 5} строк пропущено)")
        print(f"\n   ✅ ПОСЛЕ обучения:")
        after_text = _MOCK_AFTER.get(task_id, "—")
        for line in after_text.split("\n")[:8]:
            print(f"      {line}")
        if after_text.count("\n") > 7:
            print(f"      ... ({after_text.count(chr(10)) - 7} строк пропущено)")

    # Save results
    path = runner.save_results()
    print(f"\n💾 Результаты сохранены: {path}")

    return report


async def run_real_demo(epochs: int = 2) -> str:
    """Полное обучение с реальным OpenRouter API."""
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("❌ OPENROUTER_API_KEY не задан! Используй --mock для симуляции.")
        sys.exit(1)

    data_dir = "data/rl"
    runner = TrainingRunner(data_dir=data_dir, api_key=api_key)
    runner.initialize()

    print("\n" + "=" * 70)
    print("  АДАПТИВНОЕ ОБУЧЕНИЕ API-МОДЕЛЕЙ OPENROUTER")
    print(f"  Эпохи: {epochs} | Модели: {list(runner._models.values())}")
    print("=" * 70)

    report = await runner.run_full_training(epochs=epochs)
    print(report)

    path = runner.save_results()
    print(f"\n💾 Результаты сохранены: {path}")

    return report


def main():
    parser = argparse.ArgumentParser(description="OpenClaw Adaptive Training Demo")
    parser.add_argument("--mock", action="store_true", help="Симуляция без API")
    parser.add_argument("--epochs", type=int, default=2, help="Количество эпох обучения")
    args = parser.parse_args()

    if args.mock:
        asyncio.run(run_mock_demo())
    else:
        asyncio.run(run_real_demo(epochs=args.epochs))


if __name__ == "__main__":
    main()
