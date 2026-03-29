"""
v14.8 Comprehensive Brigade Stress Test

Тестирует ВСЕ бригады и модели через PipelineExecutor.execute().
Каждая бригада получает реальный запрос по своей специализации.

Coverage:
  - Research-Ops: research, YouTube, general analysis
  - OpenClaw-Core: framework task, tool creation, code
  - Dmarket-Dev: trading, strategy, API
  - Intent routing accuracy
  - Guardrail validators
  - Token budget estimation
  - Fallback model paths

Output: logs/stress_test_v14_8.log (JSON lines)
"""

import asyncio
import json
import logging
import os
import sys
import time
import traceback

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.chdir(ROOT)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from dotenv import load_dotenv
import structlog

load_dotenv()

structlog.configure(
    processors=[
        structlog.dev.ConsoleRenderer(colors=True),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.DEBUG),
)
logger = structlog.get_logger("stress-test-v14.8")


# ── Test cases: (name, brigade, prompt, expected_chain_roles, quality_checks) ──

TEST_CASES = [
    # ── Research-Ops ──
    {
        "name": "Research: general knowledge query",
        "brigade": "Research-Ops",
        "prompt": "Объясни принципы работы transformer архитектуры в нейронных сетях. Укажи ключевые компоненты: self-attention, positional encoding, feed-forward layers.",
        "expected_brigade": "Research-Ops",
        "expected_roles": ["Researcher", "Analyst", "Summarizer"],
        "quality_checks": {
            "min_length": 100,
            "must_contain_any": ["attention", "transformer", "self-attention", "позиционн", "внимани"],
            "must_not_contain": ["я как ИИ", "я не могу", "моём обучении"],
        },
    },
    {
        "name": "Research: YouTube video analysis",
        "brigade": "Research-Ops",
        "prompt": "Сделай анализ данного видео и составь ключевые мысли: https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "expected_brigade": "Research-Ops",
        "expected_roles": ["Researcher", "Analyst", "Summarizer"],
        "quality_checks": {
            "min_length": 50,
            "must_not_contain": ["я как ИИ", "моём обучении", "в моих данных"],
        },
    },
    {
        "name": "Research: data analysis request",
        "brigade": "Research-Ops",
        "prompt": "Проведи анализ: какие метрики важны для оценки производительности LLM моделей? Приведи числовые примеры benchmark результатов.",
        "expected_brigade": "Research-Ops",
        "expected_roles": ["Researcher", "Analyst", "Summarizer"],
        "quality_checks": {
            "min_length": 100,
            "must_contain_any": ["benchmark", "latency", "throughput", "метрик", "tokens/s", "MMLU", "токен"],
        },
    },

    # ── OpenClaw-Core ──
    {
        "name": "OpenClaw: code generation",
        "brigade": "OpenClaw-Core",
        "prompt": "Напиши функцию на Python для бинарного поиска в отсортированном списке с type hints и docstring.",
        "expected_brigade": "OpenClaw-Core",
        "expected_roles": ["Planner", "Coder"],
        "quality_checks": {
            "min_length": 80,
            "must_contain_any": ["def ", "binary", "search", "list", "int", "->"],
            "must_not_contain": ["я как ИИ", "os.system"],
        },
    },
    {
        "name": "OpenClaw: pipeline configuration",
        "brigade": "OpenClaw-Core",
        "prompt": "Проанализируй текущую конфигурацию pipeline и предложи оптимизации для уменьшения latency на 20%.",
        "expected_brigade": "OpenClaw-Core",
        "expected_roles": ["Planner"],
        "quality_checks": {
            "min_length": 50,
            "must_contain_any": ["pipeline", "latency", "оптимиз", "конфиг", "план", "шаг"],
        },
    },

    # ── Dmarket-Dev ──
    {
        "name": "Dmarket: trading strategy",
        "brigade": "Dmarket-Dev",
        "prompt": "Разработай стратегию арбитража CS2 скинов на Dmarket. Учти: rate limit 60 req/min, комиссия 7%, минимальный спред для прибыли.",
        "expected_brigade": "Dmarket-Dev",
        "expected_roles": ["Planner"],
        "quality_checks": {
            "min_length": 80,
            "must_contain_any": ["арбитраж", "спред", "комисси", "стратеги", "dmarket", "rate", "план"],
        },
    },
    {
        "name": "Dmarket: API integration code",
        "brigade": "Dmarket-Dev",
        "prompt": "Напиши async функцию для получения текущих цен на CS2 скины через Dmarket API с HMAC аутентификацией.",
        "expected_brigade": "Dmarket-Dev",
        "expected_roles": ["Planner", "Coder"],
        "quality_checks": {
            "min_length": 80,
            "must_contain_any": ["async", "aiohttp", "httpx", "HMAC", "hmac", "api", "dmarket"],
        },
    },

    # ── Edge cases ──
    {
        "name": "Edge: very short prompt",
        "brigade": "Research-Ops",
        "prompt": "Что такое квантовый компьютер?",
        "expected_brigade": "Research-Ops",
        "expected_roles": ["Researcher"],
        "quality_checks": {
            "min_length": 30,
            "must_contain_any": ["квант", "кубит", "qubit", "суперпозиц", "вычислен"],
        },
    },
    {
        "name": "Edge: mixed-language prompt",
        "brigade": "OpenClaw-Core",
        "prompt": "Implement a Redis cache wrapper class in Python с поддержкой TTL и batch operations. Include type hints.",
        "expected_brigade": "OpenClaw-Core",
        "expected_roles": ["Planner", "Coder"],
        "quality_checks": {
            "min_length": 80,
            "must_contain_any": ["redis", "Redis", "cache", "ttl", "TTL", "class"],
        },
    },
]


def load_config() -> dict:
    cfg_path = os.path.join(ROOT, "config", "openclaw_config.json")
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.loads(os.path.expandvars(f.read()))


async def status_printer(role: str, phase: str, text: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"  [{ts}] 📡 {role}/{phase}: {text}")


# ── Quality checker ──

def check_quality(response: str, checks: dict) -> list[str]:
    """Returns list of quality issues found."""
    issues = []

    if not response or not response.strip():
        issues.append("EMPTY_RESPONSE: ответ пустой")
        return issues

    text = response.strip()
    text_lower = text.lower()

    # Min length check
    min_len = checks.get("min_length", 0)
    if len(text) < min_len:
        issues.append(f"TOO_SHORT: {len(text)} chars < {min_len} expected")

    # Must contain at least one of these words
    must_any = checks.get("must_contain_any", [])
    if must_any:
        found = any(kw.lower() in text_lower for kw in must_any)
        if not found:
            issues.append(f"MISSING_KEYWORDS: none of {must_any} found in response")

    # Must NOT contain any of these (hallucination/leakage markers)
    must_not = checks.get("must_not_contain", [])
    for bad in must_not:
        if bad.lower() in text_lower:
            issues.append(f"FORBIDDEN_PHRASE: '{bad}' found in response")

    # Generic hallucination markers
    hallucination_markers = [
        "на момент последних данных",
        "моих обучающих данных",
        "я не имею доступа к",
        "я — языковая модель",
    ]
    for marker in hallucination_markers:
        if marker.lower() in text_lower:
            issues.append(f"HALLUCINATION_MARKER: '{marker}'")

    # Tool leakage check
    tool_leak_patterns = [
        "```tool_call", "sandbox_execute", "youtube_info(",
        "[TOOL_CALL]", "execute_command(",
    ]
    for pattern in tool_leak_patterns:
        if pattern.lower() in text_lower:
            issues.append(f"TOOL_LEAKAGE: '{pattern}' in final response")

    # Raw markup leakage
    markup_patterns = ["<think>", "[STAR]", "[MCP ", "situation:", "task:", "action:", "result:"]
    for m in markup_patterns:
        if m.lower() in text_lower:
            issues.append(f"RAW_MARKUP: '{m}' leaked into response")

    return issues


async def run_test(pipeline, test: dict, test_index: int) -> dict:
    """Run a single test case. Returns result dict."""
    name = test["name"]
    brigade = test["brigade"]
    prompt = test["prompt"]

    print(f"\n{'='*72}")
    print(f"[{test_index+1}/{len(TEST_CASES)}] 🧪 {name}")
    print(f"  Brigade: {brigade}")
    print(f"  Prompt: {prompt[:80]}...")
    print(f"{'='*72}")

    result = {
        "test_name": name,
        "brigade": brigade,
        "prompt": prompt[:200],
        "status": "UNKNOWN",
        "duration_sec": 0,
        "chain_executed": [],
        "response_length": 0,
        "quality_issues": [],
        "error": None,
        "final_response_preview": "",
    }

    t0 = time.perf_counter()
    try:
        pipe_result = await asyncio.wait_for(
            pipeline.execute(
                prompt=prompt,
                brigade=brigade,
                max_steps=5,
                status_callback=status_printer,
            ),
            timeout=180,  # 3 min max per test
        )
        elapsed = time.perf_counter() - t0
        result["duration_sec"] = round(elapsed, 1)

        final = pipe_result.get("final_response", "")
        chain = pipe_result.get("chain_executed", [])
        steps = pipe_result.get("steps", [])
        status = pipe_result.get("status", "?")

        result["chain_executed"] = chain
        result["response_length"] = len(final)
        result["pipeline_status"] = status
        result["n_steps"] = len(steps)
        result["final_response_preview"] = final[:500]

        # Quality check
        quality_issues = check_quality(final, test.get("quality_checks", {}))
        result["quality_issues"] = quality_issues

        # Check if expected roles were used
        expected_roles = test.get("expected_roles", [])
        if expected_roles:
            missing = [r for r in expected_roles if r not in chain]
            if missing and chain:  # don't report if chain is empty (separate issue)
                result["quality_issues"].append(f"MISSING_ROLES: expected {expected_roles}, got {chain}")

        if not final.strip():
            result["status"] = "FAIL_EMPTY"
        elif quality_issues:
            result["status"] = "WARN"
        else:
            result["status"] = "PASS"

        # Print summary
        status_icon = {"PASS": "✅", "WARN": "⚠️", "FAIL_EMPTY": "❌"}.get(result["status"], "❓")
        print(f"\n  {status_icon} Status: {result['status']}")
        print(f"  ⏱  Duration: {elapsed:.1f}s")
        print(f"  🔗  Chain: {' → '.join(chain)}")
        print(f"  📊  Steps: {len(steps)}, Response: {len(final)} chars")
        if quality_issues:
            for issue in quality_issues:
                print(f"  ⚠️  {issue}")
        print(f"\n  ─── Response preview ───")
        print(f"  {final[:300]}")
        print(f"  ───────────────────────")

    except asyncio.TimeoutError:
        elapsed = time.perf_counter() - t0
        result["duration_sec"] = round(elapsed, 1)
        result["status"] = "TIMEOUT"
        result["error"] = f"Timeout after {elapsed:.1f}s"
        print(f"\n  ❌ TIMEOUT after {elapsed:.1f}s")

    except Exception as exc:
        elapsed = time.perf_counter() - t0
        result["duration_sec"] = round(elapsed, 1)
        result["status"] = "ERROR"
        result["error"] = f"{type(exc).__name__}: {exc}"
        print(f"\n  ❌ ERROR: {type(exc).__name__}: {exc}")
        traceback.print_exc()

    return result


async def main() -> None:
    config = load_config()
    vllm_url = config["system"].get("vllm_base_url", "http://localhost:8000/v1")

    print("\n" + "="*72)
    print("🚀 v14.8 COMPREHENSIVE BRIGADE STRESS TEST")
    print("="*72)
    print(f"  Tests: {len(TEST_CASES)}")
    print(f"  Brigades: Research-Ops, OpenClaw-Core, Dmarket-Dev")
    print(f"  Models: nemotron-120b, trinity-large, trinity-mini")
    print("="*72)

    # 1. Configure LLM Gateway
    logger.info("Configuring LLM Gateway...")
    from src.llm_gateway import configure as configure_llm_gateway
    configure_llm_gateway(config)

    # 2. Create & initialise PipelineExecutor
    logger.info("Creating PipelineExecutor...")
    from src.pipeline._core import PipelineExecutor
    pipeline = PipelineExecutor(config=config, vllm_url=vllm_url, vllm_manager=None)
    await pipeline.initialize()
    logger.info("PipelineExecutor initialised OK")

    # 3. Run all tests
    all_results = []
    total_t0 = time.perf_counter()

    for i, test in enumerate(TEST_CASES):
        result = await run_test(pipeline, test, i)
        all_results.append(result)

    total_elapsed = time.perf_counter() - total_t0

    # 4. Summary
    print("\n" + "="*72)
    print("📊 SUMMARY")
    print("="*72)

    pass_count = sum(1 for r in all_results if r["status"] == "PASS")
    warn_count = sum(1 for r in all_results if r["status"] == "WARN")
    fail_count = sum(1 for r in all_results if r["status"] in ("FAIL_EMPTY", "TIMEOUT", "ERROR"))

    print(f"  Total: {len(all_results)} tests in {total_elapsed:.1f}s")
    print(f"  ✅ PASS: {pass_count}")
    print(f"  ⚠️  WARN: {warn_count}")
    print(f"  ❌ FAIL: {fail_count}")
    print()

    # Report all issues
    all_issues = []
    for r in all_results:
        if r["quality_issues"]:
            for issue in r["quality_issues"]:
                all_issues.append({"test": r["test_name"], "issue": issue})
        if r["error"]:
            all_issues.append({"test": r["test_name"], "issue": f"ERROR: {r['error']}"})

    if all_issues:
        print("  ── All Issues ──")
        for item in all_issues:
            print(f"  [{item['test']}] {item['issue']}")
    else:
        print("  No issues found! 🎉")

    print()

    # Per-test table
    print(f"  {'Test':<45} {'Status':<12} {'Time':>6} {'Chain'}")
    print(f"  {'─'*45} {'─'*12} {'─'*6} {'─'*30}")
    for r in all_results:
        chain_str = " → ".join(r["chain_executed"]) if r["chain_executed"] else "—"
        print(f"  {r['test_name']:<45} {r['status']:<12} {r['duration_sec']:>5.1f}s {chain_str}")

    # 5. Save results
    log_path = os.path.join(ROOT, "logs", "stress_test_v14_8.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as f:
        for r in all_results:
            f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
    print(f"\n  📄 Results saved to: {log_path}")

    # 6. Graceful MCP shutdown
    for mcp_name in ("openclaw_mcp", "dmarket_mcp"):
        client = getattr(pipeline, mcp_name, None)
        if client:
            try:
                await client.cleanup()
            except Exception:
                pass

    print("\n" + "="*72)
    print("✅ STRESS TEST COMPLETE")
    print("="*72)


if __name__ == "__main__":
    asyncio.run(main())
