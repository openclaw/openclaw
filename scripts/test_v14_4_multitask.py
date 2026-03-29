"""
v14.4 Autonomous Stress-Test: Multi-Task Decomposer, yt-dlp native, MARCH, Intent routing.

Drives PipelineExecutor.execute() directly — no Telegram required.
"""

import asyncio
import json
import logging
import os
import sys
import time
import traceback

# Ensure repo root is on sys.path
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.chdir(ROOT)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from dotenv import load_dotenv
import structlog

load_dotenv()  # v14.5: ensure OPENROUTER_API_KEY is available

# ── pretty console output ──────────────────────────────────────────
structlog.configure(
    processors=[
        structlog.dev.ConsoleRenderer(colors=True),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.DEBUG),
)
logger = structlog.get_logger("stress-test")


def load_config() -> dict:
    cfg_path = os.path.join(ROOT, "config", "openclaw_config.json")
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.loads(os.path.expandvars(f.read()))


async def status_printer(role: str, phase: str, text: str) -> None:
    """Simple callback that prints pipeline status events."""
    ts = time.strftime("%H:%M:%S")
    print(f"  [{ts}] 📡 {role}/{phase}: {text}")


async def main() -> None:
    config = load_config()
    vllm_url = config["system"].get("vllm_base_url", "http://localhost:8000/v1")

    # 1. Configure LLM Gateway (singleton; must happen before PipelineExecutor use)
    logger.info("Configuring LLM Gateway...")
    from src.llm_gateway import configure as configure_llm_gateway
    configure_llm_gateway(config)

    # 2. Create & initialise PipelineExecutor
    logger.info("Creating PipelineExecutor...")
    from src.pipeline._core import PipelineExecutor
    pipeline = PipelineExecutor(config=config, vllm_url=vllm_url, vllm_manager=None)
    await pipeline.initialize()
    logger.info("PipelineExecutor initialised OK")

    # 3. The stress-test prompt — 4 numbered sub-tasks targeting different brigades
    prompt = (
        "1. Planner: составь нумерованный план из 3 шагов по захвату рынка Dmarket.\n"
        "2. Researcher: найди информацию по видео https://www.youtube.com/watch?v=dQw4w9WgXcQ.\n"
        "3. Code: напиши функцию на Python 3.14 для сортировки списка.\n"
        "4. Vision/Video: проанализируй, готовы ли все системы к работе. "
        "Выведи результат каждого агента строго по пунктам.\n"
        "\n"
        # Padding to pass the >500 char threshold for decomposer activation
        "Контекст: это стресс-тест v14.4 — проверяем Multi-Task Decomposer, "
        "нативный yt-dlp, MARCH Protocol и маршрутизацию по бригадам. "
        "Каждая подзадача должна быть обработана автономно в своей бригаде. "
        "Ожидаем параллельное выполнение и объединённый ответ.\n"
    )

    logger.info("Prompt length", chars=len(prompt))

    # 4. Quick unit-check: does _decompose_multi_task parse correctly?
    from src.pipeline._core import _decompose_multi_task
    sub_tasks = _decompose_multi_task(prompt)
    logger.info("Decomposer pre-check", n_subtasks=len(sub_tasks))
    for i, (text, brigade) in enumerate(sub_tasks):
        logger.info(f"  sub-task {i+1}", brigade=brigade, text=text[:80])

    if len(sub_tasks) < 2:
        logger.error("DECOMPOSER FAILED: fewer than 2 sub-tasks detected — aborting")
        sys.exit(1)

    # 5. Execute the full pipeline (should trigger _execute_multi_task)
    print("\n" + "=" * 72)
    print("🚀  STARTING MULTI-TASK EXECUTION")
    print("=" * 72 + "\n")

    t0 = time.perf_counter()
    try:
        result = await pipeline.execute(
            prompt=prompt,
            brigade="Dmarket-Dev",
            max_steps=5,
            status_callback=status_printer,
        )
        elapsed = time.perf_counter() - t0

        print("\n" + "=" * 72)
        print("✅  EXECUTION COMPLETE")
        print("=" * 72)
        print(f"⏱  Elapsed: {elapsed:.1f}s")
        print(f"📦  Brigade: {result.get('brigade', '?')}")
        print(f"🔗  Chain executed: {result.get('chain_executed', [])}")
        print(f"📊  Steps: {len(result.get('steps', []))}")
        meta = result.get("meta", {})
        print(f"🧩  Decomposed: {meta.get('decomposed', False)}, subtasks: {meta.get('n_subtasks', 0)}")
        print(f"📝  Status: {result.get('status', '?')}")
        print()
        print("─" * 72)
        print("FINAL RESPONSE:")
        print("─" * 72)
        final = result.get("final_response", "")
        print(final[:3000] if len(final) > 3000 else final)
        print("─" * 72)

    except Exception as exc:
        elapsed = time.perf_counter() - t0
        print("\n" + "=" * 72)
        print("❌  EXECUTION FAILED")
        print("=" * 72)
        print(f"⏱  Elapsed before crash: {elapsed:.1f}s")
        print(f"Exception: {type(exc).__name__}: {exc}")
        traceback.print_exc()
    finally:
        # v14.5: graceful MCP shutdown to avoid anyio RuntimeError
        for mcp_name in ("openclaw_mcp", "dmarket_mcp"):
            client = getattr(pipeline, mcp_name, None)
            if client:
                try:
                    await client.cleanup()
                except Exception as e:
                    logger.warning(f"MCP cleanup ({mcp_name})", error=str(e))


if __name__ == "__main__":
    asyncio.run(main())
