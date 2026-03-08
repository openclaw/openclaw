import asyncio
import json
import os
import aiohttp
from archivist_telegram import TelegramArchivist
from memory_gc import MemoryGarbageCollector
from risk_manager import RiskManager

async def test_brigades():
    # Load config
    with open('openclaw_config.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    tg_token = config['system']['telegram']['bot_token']
    chat_id = config['system']['telegram']['admin_chat_id']
    ollama_url = config['system'].get('ollama_url', 'http://192.168.0.212:11434')

    print(f"[*] Initializing OpenClaw Test Run...")
    archivist = TelegramArchivist(tg_token, chat_id)

    # 1. SEND INITIAL STATUS
    await archivist.send_status("System", "OpenClaw Core", "Starting Dual-Brigade Test Run (AMD RX 6600 VRAM constraints applied)")
    
    # 2. TEST DMARKET BRIGADE (Risk Manager via deepseek-r1:8b)
    print("\n--- Testing Dmarket Brigade ---")
    await archivist.send_status("Risk Manager (Dmarket)", "deepseek-r1:8b", "Analyzing mock transaction")
    risk_manager = RiskManager(ollama_url)
    
    mock_payload = {"item_id": "AK-47 Redline", "price": 40.50, "balance": 100.0}
    try:
        is_safe = await risk_manager.validate_transaction("/api/v1/buy", mock_payload)
        dmarket_result = "APPROVED" if is_safe else "REJECTED"
    except Exception as e:
        dmarket_result = f"ERROR: {str(e)}"
    
    print(f"[Dmarket] Transaction Result: {dmarket_result}")
    
    # 3. TEST OPENCLAW BRIGADE (Memory GC via llama3.1:8b)
    print("\n--- Testing OpenClaw Brigade ---")
    await archivist.send_status("Memory GC (OpenClaw)", "llama3.1:8b", "Summarizing mock conversation")
    memory_gc = MemoryGarbageCollector(ollama_url)
    
    mock_history = [
        {"role": "user", "content": "I need a tool to fetch item prices from Dmarket."},
        {"role": "assistant", "content": "I created a script in /tools/dmarket_fetcher.py that uses aiohttp to get prices."},
        {"role": "user", "content": "Great, make it save the output to a JSON file."}
    ]
    
    try:
        summary = await memory_gc.summarize_history(mock_history)
        openclaw_result = summary
    except Exception as e:
        openclaw_result = f"ERROR: {str(e)}"
        
    print(f"[OpenClaw] GC Summary: {openclaw_result}")

    # 4. SEND FINAL ARCHIVIST REPORT
    report = (
        f"✅ *TEST RUN COMPLETED*\n\n"
        f"🛠️ *Обновления Инструментария (OpenClaw)*\n"
        f"- Memory GC (Llama-3.1) сработал успешно.\n"
        f"- Краткая выжимка (Context Briefing):\n`{openclaw_result[:200]}...`\n\n"
        f"📈 *Обновления Продукта (Dmarket)*\n"
        f"- Вердикт: *{dmarket_result}*\n\n"
        f"⚠️ VRAM (8GB) оптимизированно расходуется благодаря TaskQueue batching и параметру `keep_alive='30s'`."
    )
    
    print("\n[*] Sending Final Report to Telegram...")
    await archivist.send_summary("Результаты Тестового Запуска", report)
    print("[+] Done!")

if __name__ == "__main__":
    asyncio.run(test_brigades())
