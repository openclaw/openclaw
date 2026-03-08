import asyncio
import sys
import os
import json

# Add parent directory to path to import pipeline_executor
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from pipeline_executor import PipelineExecutor

async def test_mcp():
    print("🚀 Initializing OpenClaw Pipeline with MCP Client...")
    
    # Minimal config to trick pipeline executor into loading
    mock_config = {
        "memory": {"model": "gemma3:12b"},
        "system": {"ollama": {"url": "http://192.168.0.212:11434"}}
    }
    
    executor = PipelineExecutor(config=mock_config, ollama_url="http://192.168.0.212:11434")
    
    # 1. Initialize MCP Connections
    await executor.initialize()
    
    print("\n🛠️ Available tools loaded by MCP Client:")
    for tool in executor.mcp_client.available_tools_for_ollama:
        print(f"  - {tool['function']['name']}: {tool['function']['description']}")

    # 2. Run Test Prompt against Executor (qwen2.5-coder:14b)
    print("\n⚡ Sending prompt to qwen2.5-coder:14b (Executor_Tools)...")
    system_prompt = "Ты — Executor, технический гений. У тебя есть доступ к инструментам MCP. Обязательно используй вызов нужного инструмента. Создай в базе данных sqlite таблицу market_items с колонками: id (integer), item_name (text), price (real), timestamp (datetime)."
    user_prompt = "Используя свои инструменты, сделай SQL запрос к SQLite чтобы создать таблицу market_items."
    
    # Mocking the pipeline execution single step for Executor_Tools
    role_config = {"model": "qwen2.5-coder:14b", "system_prompt": system_prompt}
    
    try:
        response = await executor._call_ollama(
            model="qwen2.5-coder:14b",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            role_name="Executor_Tools",
            role_config=role_config
        )
        print("\n✅ Final Model Response:\n")
        print(response)
    except Exception as e:
        print(f"\n❌ Error during execution: {e}")
    finally:
        # 3. Cleanup MCP
        print("\n🧹 Cleaning up MCP connections...")
        await executor.mcp_client.cleanup()

if __name__ == "__main__":
    # Ensure Windows uses ProactorEventLoop for subprocesses
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(test_mcp())
