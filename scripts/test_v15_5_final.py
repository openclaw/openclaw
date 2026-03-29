import asyncio
import os
import sys

# Добавляем корень проекта в sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.pipeline_executor import PipelineExecutor
import structlog

logger = structlog.get_logger()

PROMPT = """[CURRENT TASK]:
1. Проведи исследование видео https://youtube.com/watch?v=dQw4w9WgXcQ (если видео недоступно, используй обычный веб-поиск).
2. Напиши скрипт на Python, который выводит информацию об этом видео и принимает пользовательский ввод напрямую в функцию os.system() или eval() (создай intentionally vulnerable code).
3. Проведи строгий аудит безопасности написанного кода, укажи конкретные строки с уязвимостями.
"""

async def run_test():
    try:
        executor = PipelineExecutor()
    except Exception as e:
        print(f"Failed to initialize PipelineExecutor: {e}")
        return

    print("Running v15.5 Final Data-Flow & Auditor Test...")
    print(f"Testing Prompt:\n{PROMPT}\n")
    
    result = await executor.execute(PROMPT, brigade="Dmarket-Dev", max_steps=10)
    
    final_response = result.get("final_response", "")
    steps = result.get("steps", [])
    
    print("\n--- FINAL PIPELINE RESPONSE ---")
    print(final_response)
    print("\n-------------------------------")
    
    # Validation 1: Check if Auditor performed the review and didn't just provide instructions
    auditor_steps = [s for s in steps if "Auditor" in s.get("role", "")]
    auditor_acted = False
    auditor_provided_instructions = False
    
    for step in auditor_steps:
        resp = str(step.get("response", "")).lower()
        if "provide_instructions" in resp:
            auditor_provided_instructions = True
        
        # Если аудитор упомянул уязвимости (eval/os.system)
        if "eval" in resp or "os.system" in resp or "уязвим" in resp or "vulnerabilit" in resp or "строк" in resp:
            auditor_acted = True

    print("\n--- TEST RESULTS ---")
    if auditor_provided_instructions:
        print("❌ AUDITOR VALIDATION FAILED: Auditor provided terminal instructions (lazy behavior).")
    elif auditor_acted:
         print("✅ AUDITOR VALIDATION PASSED: The auditor correctly analyzed the code manually.")
    else:
         print("⚠️ AUDITOR VALIDATION UNCLEAR: The auditor didn't trigger lazy behavior, but explicit vulnerabilities weren't mentioned.")
         
    # Validation 2: Check if Coder picked up the transcript/metadata from Researcher
    coder_steps = [s for s in steps if s.get("role", "") in ("Coder", "Executor_Architect", "Executor_Tools")]
    coder_data_picked_up = False
    
    for step in coder_steps:
        resp = str(step.get("response", "")).lower()
        # Look for youtube-specific terms or web search fallback terms picked from phase 1
        if "youtube" in resp or "видео" in resp or "rick" in resp or "astley" in resp:
            coder_data_picked_up = True
            break
            
    if coder_data_picked_up:
         print("✅ DATA-FLOW VALIDATION PASSED: The coder successfully accessed the Shared Context / Shared Observations from Phase 1.")
    else:
         print("❌ DATA-FLOW VALIDATION FAILED: Coder did not use info from the research phase.")


if __name__ == "__main__":
    asyncio.run(run_test())
