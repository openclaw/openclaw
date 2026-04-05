"""
Standalone pipeline test — runs OpenClaw bot pipeline on a raw prompt
WITHOUT Telegram. Records all logs, errors, and timing for analysis.

Usage:
    python scripts/test_pipeline_direct.py
"""

import asyncio
import json
import os
import sys
import time
import traceback
from io import StringIO

# Ensure project root is on path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

import structlog


# ── Capture all structlog output ──────────────────────────────────────────
_log_buffer = StringIO()
_errors: list[dict] = []
_warnings: list[dict] = []

def _capture_processor(logger, method_name, event_dict):
    """Capture every log line into our buffer."""
    ts = time.strftime("%H:%M:%S")
    level = method_name.upper()
    msg = event_dict.get("event", "")
    extra = {k: v for k, v in event_dict.items() if k not in ("event", "timestamp")}
    line = f"[{ts}] {level:8s} {msg}"
    if extra:
        line += f"  | {extra}"
    _log_buffer.write(line + "\n")

    if level in ("ERROR", "CRITICAL"):
        _errors.append({"time": ts, "event": msg, "details": extra})
    elif level == "WARNING":
        _warnings.append({"time": ts, "event": msg, "details": extra})

    return event_dict


structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        _capture_processor,
        structlog.dev.ConsoleRenderer(),
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
    cache_logger_on_first_use=False,
)

log = structlog.get_logger("PipelineTest")


# ── Test prompts (raw, no preprocessing) ──────────────────────────────────
TEST_PROMPTS = [
    {
        "id": "simple_code",
        "prompt": "Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь docstring и type hints.",
        "expected": ["def", "sieve", "prime", "return"],
        "category": "code",
    },
    {
        "id": "analysis",
        "prompt": "Проанализируй плюсы и минусы архитектуры микросервисов по сравнению с монолитом для стартапа с 5 разработчиками.",
        "expected": ["микросервис", "монолит", "масштаб"],
        "category": "general",
    },
    {
        "id": "multi_task",
        "prompt": (
            "1. Напиши функцию сортировки пузырьком на Python\n"
            "2. Проанализируй её сложность O(n²) и предложи оптимизации\n"
            "3. Сравни с quicksort и mergesort по скорости"
        ),
        "expected": ["bubble", "sort", "O(n", "quicksort"],
        "category": "code+analysis",
    },
]


async def test_pipeline_direct():
    """Run the full pipeline on test prompts and record everything."""
    from src.pipeline_executor import PipelineExecutor
    from src.llm_gateway import configure as configure_gateway
    from src.intent_classifier import classify_intent

    # Load config
    config_path = "config/openclaw_config.json"
    with open(config_path, "r", encoding="utf-8") as f:
        raw = os.path.expandvars(f.read())
    config = json.loads(raw)

    log.info("Initializing LLM Gateway...")
    configure_gateway(config)

    log.info("Initializing PipelineExecutor...")
    pipeline = PipelineExecutor(config)
    await pipeline.initialize()

    results = []

    for test in TEST_PROMPTS:
        test_id = test["id"]
        prompt = test["prompt"]
        log.info("=" * 60)
        log.info(f"TEST: {test_id}", category=test["category"])
        log.info(f"PROMPT: {prompt[:120]}...")

        result_entry = {
            "test_id": test_id,
            "prompt": prompt,
            "category": test["category"],
            "response": "",
            "brigade": "",
            "chain": [],
            "steps": [],
            "timing_ms": 0,
            "errors": [],
            "warnings_during": [],
            "intent_raw": "",
            "expected_keywords_found": [],
            "expected_keywords_missing": [],
            "response_length": 0,
            "success": False,
        }

        # Phase 1: Intent classification
        errors_before = len(_errors)
        warnings_before = len(_warnings)
        t0 = time.monotonic()

        try:
            log.info("Phase 1: Intent Classification")
            intent_result = await classify_intent(config, prompt)
            result_entry["intent_raw"] = str(intent_result)
            log.info("Intent result", intent=intent_result)
        except Exception as e:
            log.error("Intent classification failed", error=str(e))
            result_entry["errors"].append(f"intent: {e}")
            intent_result = {"brigade": "OpenClaw-Core", "intent": "general"}

        brigade = intent_result.get("brigade", "OpenClaw-Core") if isinstance(intent_result, dict) else (intent_result if isinstance(intent_result, str) and intent_result else "OpenClaw-Core")
        result_entry["brigade"] = brigade

        # Phase 2: Pipeline execution
        try:
            log.info("Phase 2: Pipeline Execution", brigade=brigade)
            pipeline_result = await pipeline.execute(prompt, brigade=brigade)

            if hasattr(pipeline_result, 'response'):
                result_entry["response"] = pipeline_result.response
            elif isinstance(pipeline_result, dict):
                result_entry["response"] = pipeline_result.get("response", str(pipeline_result))
            elif isinstance(pipeline_result, str):
                result_entry["response"] = pipeline_result
            else:
                result_entry["response"] = str(pipeline_result)

            if hasattr(pipeline_result, 'chain'):
                result_entry["chain"] = pipeline_result.chain
            if hasattr(pipeline_result, 'steps'):
                for step in pipeline_result.steps:
                    step_info = {
                        "role": getattr(step, 'role', '?'),
                        "model": getattr(step, 'model', '?'),
                        "tokens": getattr(step, 'tokens_used', 0),
                        "latency_ms": getattr(step, 'latency_ms', 0),
                        "success": getattr(step, 'success', False),
                    }
                    result_entry["steps"].append(step_info)

            log.info("Pipeline execution completed", response_len=len(result_entry["response"]))

        except Exception as e:
            log.error("Pipeline execution failed", error=str(e), traceback=traceback.format_exc())
            result_entry["errors"].append(f"pipeline: {e}")
            result_entry["response"] = f"ERROR: {e}"

        elapsed_ms = (time.monotonic() - t0) * 1000
        result_entry["timing_ms"] = round(elapsed_ms)
        result_entry["response_length"] = len(result_entry["response"])

        # Check expected keywords
        response_lower = result_entry["response"].lower()
        for kw in test.get("expected", []):
            if kw.lower() in response_lower:
                result_entry["expected_keywords_found"].append(kw)
            else:
                result_entry["expected_keywords_missing"].append(kw)

        # Capture errors/warnings that appeared during this test
        new_errors = _errors[errors_before:]
        new_warnings = _warnings[warnings_before:]
        result_entry["errors"].extend([e["event"] for e in new_errors])
        result_entry["warnings_during"] = [w["event"] for w in new_warnings]

        result_entry["success"] = (
            len(result_entry["response"]) > 50
            and "ERROR" not in result_entry["response"][:20]
        )

        results.append(result_entry)

        log.info(
            f"Result: {'✅ PASS' if result_entry['success'] else '❌ FAIL'}",
            response_len=result_entry["response_length"],
            timing_ms=result_entry["timing_ms"],
            errors=len(result_entry["errors"]),
            keywords_found=len(result_entry["expected_keywords_found"]),
            keywords_missing=len(result_entry["expected_keywords_missing"]),
        )

    # NEW-4 fix: gracefully close MCP sessions before event loop shuts down
    await pipeline.cleanup()

    return results


def generate_report(results: list[dict], logs: str) -> str:
    """Generate a detailed markdown report."""
    lines = [
        "# 📊 OpenClaw Bot — Pipeline Test Report",
        f"**Дата:** {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"**Тестов:** {len(results)}",
        "",
    ]

    # Summary table
    passed = sum(1 for r in results if r["success"])
    failed = len(results) - passed
    lines.append(f"## Сводка: {passed}/{len(results)} пройдено")
    lines.append("")
    lines.append("| # | Тест | Бригада | Время (мс) | Ответ (символов) | Ошибки | Результат |")
    lines.append("|---|------|---------|------------|------------------|--------|-----------|")
    for i, r in enumerate(results, 1):
        status = "✅" if r["success"] else "❌"
        lines.append(
            f"| {i} | {r['test_id']} | {r['brigade']} | {r['timing_ms']} | "
            f"{r['response_length']} | {len(r['errors'])} | {status} |"
        )
    lines.append("")

    # Detailed results
    lines.append("## Детальные результаты")
    for r in results:
        lines.append(f"\n### Тест: `{r['test_id']}` ({'✅' if r['success'] else '❌'})")
        lines.append(f"- **Промпт:** `{r['prompt'][:100]}...`")
        lines.append(f"- **Категория:** {r['category']}")
        lines.append(f"- **Бригада:** {r['brigade']}")
        lines.append(f"- **Цепочка:** {' → '.join(r['chain']) if r['chain'] else 'н/д'}")
        lines.append(f"- **Intent:** {r['intent_raw'][:200]}")
        lines.append(f"- **Время:** {r['timing_ms']} мс")
        lines.append(f"- **Длина ответа:** {r['response_length']} символов")

        if r["expected_keywords_found"]:
            lines.append(f"- **Найденные ключевые слова:** {', '.join(r['expected_keywords_found'])}")
        if r["expected_keywords_missing"]:
            lines.append(f"- **Пропущенные ключевые слова:** ⚠️ {', '.join(r['expected_keywords_missing'])}")

        if r["steps"]:
            lines.append("- **Шаги пайплайна:**")
            for step in r["steps"]:
                lines.append(f"  - {step['role']} ({step['model']}) — {step['latency_ms']}ms, tokens={step['tokens']}")

        if r["errors"]:
            lines.append("- **❌ Ошибки:**")
            for err in r["errors"]:
                lines.append(f"  - `{err}`")

        if r["warnings_during"]:
            lines.append("- **⚠️ Предупреждения:**")
            for w in r["warnings_during"]:
                lines.append(f"  - `{w}`")

        # Response preview
        resp = r["response"]
        if len(resp) > 500:
            resp = resp[:500] + "..."
        lines.append(f"\n**Ответ (preview):**\n```\n{resp}\n```")

    # All errors
    if _errors:
        lines.append("\n## 🔴 Все ошибки (хронологически)")
        for e in _errors:
            lines.append(f"- `[{e['time']}]` {e['event']} — {e['details']}")

    # All warnings
    if _warnings:
        lines.append("\n## 🟡 Все предупреждения")
        for w in _warnings:
            lines.append(f"- `[{w['time']}]` {w['event']} — {w['details']}")

    # Raw logs (last 200 lines)
    log_lines = logs.strip().split("\n")
    lines.append(f"\n## 📋 Логи ({len(log_lines)} строк, последние 200)")
    lines.append("```")
    for line in log_lines[-200:]:
        lines.append(line)
    lines.append("```")

    return "\n".join(lines)


async def main():
    print("=" * 60)
    print("🧪 OpenClaw Bot — Direct Pipeline Test")
    print("=" * 60)

    results = await test_pipeline_direct()
    logs = _log_buffer.getvalue()
    report = generate_report(results, logs)

    # Save report
    os.makedirs("data", exist_ok=True)
    report_path = "data/pipeline_test_report.md"
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)

    # Save raw JSON results
    json_path = "data/pipeline_test_results.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n📄 Report saved to: {report_path}")
    print(f"📊 Raw results saved to: {json_path}")

    # Quick summary
    passed = sum(1 for r in results if r["success"])
    print(f"\n{'='*60}")
    print(f"Results: {passed}/{len(results)} passed")
    print(f"Errors: {len(_errors)}")
    print(f"Warnings: {len(_warnings)}")
    print(f"{'='*60}")


if __name__ == "__main__":
    import warnings
    # NEW-4 fix: Suppress anyio cancel scope tracebacks at asyncio.run() shutdown
    warnings.filterwarnings("ignore", message=".*cancel.*scope.*", category=RuntimeWarning)
    try:
        asyncio.run(main())
    except (RuntimeError, SystemExit):
        pass  # anyio teardown noise — results already saved
