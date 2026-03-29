import asyncio
import os
import sys

# Ensure sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.pipeline_executor import PipelineExecutor
from src.pipeline._logic_provider import OBSIDIAN_DIR, CLAW_LOGIC_DIR
import structlog

logger = structlog.get_logger()

BRIGADE_LOGIC_PATH = os.path.join(CLAW_LOGIC_DIR, "Dmarket-Dev.md")
LEARNING_LOG_PATH = os.path.join(OBSIDIAN_DIR, "Learning_Log.md")

PROMPT = "Напиши функцию на Rust, читающую файл. Создай идеальный код."

def setup_obsidian_notes():
    os.makedirs(CLAW_LOGIC_DIR, exist_ok=True)
    with open(BRIGADE_LOGIC_PATH, "w", encoding="utf-8") as f:
        f.write("#instruction [rust, код]\nchain: [\"Planner\", \"Coder\"]\nВсегда используй библиотеку anyhow и пиши комментарии на латыни.")

async def run_test():
    setup_obsidian_notes()
    
    try:
        executor = PipelineExecutor()
    except Exception as e:
        print(f"Failed to initialize pipeline: {e}")
        return

    print("Running v16.0 STRESS TEST for Obsidian Integration...")
    
    try:
        result = await executor.execute(PROMPT, brigade="Dmarket-Dev", max_steps=4)
        final_response = result.get("final_response", "")
        chain_executed = result.get("chain_executed", [])
    except Exception as e:
        print(f"Pipeline crashed during execution: {e}")
        return

    print("\n--- FINAL PIPELINE RESPONSE ---\n")
    print(final_response)
    print("\n-------------------------------\n")
    
    # 1. Did it use the overridden chain?
    is_chain_overridden = chain_executed[:2] == ["Planner", "Coder"]
    
    # 2. Did it use anyhow?
    used_anyhow = "anyhow" in final_response.lower()
    
    # 3. Are there Latin comments (heuristic)?
    used_latin = any(w in final_response.lower() for w in ["hic", "est", "lorem", "ipsum", "fiat", "autem", "ergo", "nulla", "omnis"])
    
    # Check log
    learning_log_exists = os.path.exists(LEARNING_LOG_PATH)
    log_content = ""
    if learning_log_exists:
        with open(LEARNING_LOG_PATH, "r", encoding="utf-8") as f:
            log_content = f.read()
    
    logged_properly = "Rust" in log_content

    print("--- SUCCESS CRITERIA ---")
    print(f"Chain overridden (Planner->Coder): {is_chain_overridden} -> {chain_executed}")
    print(f"Used 'anyhow': {used_anyhow}")
    print(f"Used Latin comments: {used_latin}")
    print(f"Recorded to Learning_Log: {logged_properly}")
    
    if used_anyhow and used_latin and logged_properly:
        print("\n✅ v16.0 STRESS TEST PASSED")
    else:
        print("\n❌ v16.0 STRESS TEST FAILED OR REQUIRE MANUAL VERIFICATION (Latin check may fail heuristically).")

if __name__ == "__main__":
    asyncio.run(run_test())
