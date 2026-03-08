import asyncio
import json
import logging
import os
import aiohttp
from src.pipeline_executor import PipelineExecutor

# Configure simple logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

async def test_ollama(url):
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=2) as resp:
                return resp.status == 200
    except Exception:
        return False

async def get_ollama_url(config):
    # Try environment variable
    ollama_host_env = os.environ.get("OLLAMA_HOST")
    if ollama_host_env:
        url = f"http://{ollama_host_env}" if not ollama_host_env.startswith("http") else ollama_host_env
        if await test_ollama(url):
            return url
            
    # Try localhost
    if await test_ollama("http://localhost:11434"):
        return "http://localhost:11434"
        
    # Try host.docker.internal
    if await test_ollama("http://host.docker.internal:11434"):
        return "http://host.docker.internal:11434"
        
    # Try WSL host IP
    try:
        with open("/etc/resolv.conf", "r") as f:
            for line in f:
                if line.startswith("nameserver"):
                    wsl_ip = line.split()[1]
                    wsl_url = f"http://{wsl_ip}:11434"
                    if await test_ollama(wsl_url):
                        return wsl_url
    except Exception:
        pass
        
    # Fallback to config
    return config.get("system", {}).get("ollama_url", "http://localhost:11434")

async def test_pipeline():
    # 1. Fallback config to avoid errors
    if not os.path.exists("config/openclaw_config.json"):
        with open("config/openclaw_config.json", "w", encoding="utf-8") as f:
            json.dump({
                "system": {
                    "ollama_url": "http://localhost:11434"
                },
                "brigades": {
                    "OpenClaw": {
                        "roles": {
                            "Planner": {
                                "model": "deepseek-r1:14b",
                                "system_prompt": "Ты — Главный Оркестратор."
                            }
                        }
                    }
                }
            }, f)
            
    with open("config/openclaw_config.json", "r", encoding="utf-8") as f:
        config = json.load(f)

    # 2. Setup dynamically
    ollama_url = await get_ollama_url(config)
        
    print(f"[Sandbox] Using Ollama URL: {ollama_url}")
    executor = PipelineExecutor(config, ollama_url)
    
    await executor.initialize()

    prompt = "Аркадий, твоя единственная цель — создать таблицу market_items. Вызови инструмент 'write_query' сервера SQLite и выполни код: CREATE TABLE market_items (id INTEGER PRIMARY KEY, name TEXT, price REAL, quantity INTEGER); После выполнения проверь список таблиц."

    async def status_cb(role, model, text):
        print(f"\n[{role} | {model}] STATUS: {text}")

    print("================== PIPELINE TEST START ==================")
    print(f"PROMPT: {prompt}")
    print("=========================================================\n")

    result = await executor.execute(
        prompt=prompt,
        brigade="Dmarket",
        status_callback=status_cb
    )
    
    if result.get("status") == "ask_user":
        print(f"\n[ASK_USER Question]: {result.get('question')}")
        user_answer = "Используй только стандартные типы SQLite"
        print(f"[User Answer Simulation]: {user_answer}")
        
        new_prompt = f"Ранее я просил: {prompt}\nТвой вопрос ко мне. Вот мой ответ/уточнение: {user_answer}\nПродолжай задачу с учетом этих новых данных."
        
        print("\n================== PIPELINE RESUME ==================")
        result = await executor.execute(
            prompt=new_prompt,
            brigade="Dmarket",
            status_callback=status_cb
        )

    print("\n================== PIPELINE FINAL RESULT =================")
    print(f"Status: {result.get('status')}")
    print(f"Brigade: {result.get('brigade')}")
    print(f"Chain Executed: {' -> '.join(result.get('chain_executed', []))}")
    print("\n[Final Response]:")
    print(result.get('final_response'))
    print("=========================================================\n")
    
    await executor.openclaw_mcp.cleanup()
    await executor.dmarket_mcp.cleanup()

if __name__ == "__main__":
    asyncio.run(test_pipeline())
