"""
Бенчмарк: время работы DeepResearchPipeline + скорость генерации токенов.

Запуск:
    python scripts/benchmark_deep_research.py

Использует моки LLM/MCP, поэтому работает без запущенного vLLM.
Замеряет:
- Время каждого шага pipeline
- Суммарное время выполнения
- Имитирует скорость токенов (tokens/sec) на основе задержки LLM
- Сравнивает: без улучшений (v2) vs с улучшениями (v3)
"""

import asyncio
import sys
import os
import time
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ---------------------------------------------------------------------------
# Конфигурация бенчмарка
# ---------------------------------------------------------------------------
SIMULATED_LLM_LATENCY_MS = 300   # ~300 мс на вызов LLM (эмуляция локального vLLM)
SIMULATED_TOKENS_PER_CALL = 256  # средний размер ответа LLM
SIMULATED_WEB_FETCH_LATENCY_MS = 150  # задержка web_fetch (Jina Reader)

QUESTION = (
    "Какие методы оптимизации вывода языковых моделей наиболее эффективны "
    "для однокарточных GPU конфигураций с 16 ГБ VRAM?"
)

# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

_call_log: list = []
_token_count = 0


def make_mock_pipeline(version: str = "v2"):
    """Создаёт pipeline с мок-LLM и MCP."""
    global _call_log, _token_count
    _call_log = []
    _token_count = 0

    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value=(
        "1. **vLLM optimization techniques**\n"
        "   URL: https://arxiv.org/abs/2309.06180\n"
        "   Speculative decoding improves throughput by 2x.\n\n"
        "2. **PagedAttention**\n"
        "   URL: https://vllm.ai/docs\n"
        "   KV cache management for efficient memory use."
    ))

    from src.deep_research import DeepResearchPipeline
    pipeline = DeepResearchPipeline(
        vllm_url="http://localhost:8000/v1",
        model="test-model",
        mcp_client=mcp,
    )
    pipeline._academic_search_enabled = False

    total_tokens = {"n": 0}
    call_times = {"total": 0.0, "count": 0}

    async def _timed_llm(system, user, max_tokens=2048, retries=2):
        """Мок LLM с замером времени."""
        t0 = time.perf_counter()
        # Эмулируем задержку LLM
        await asyncio.sleep(SIMULATED_LLM_LATENCY_MS / 1000)
        elapsed = (time.perf_counter() - t0) * 1000

        total_tokens["n"] += SIMULATED_TOKENS_PER_CALL
        call_times["total"] += elapsed
        call_times["count"] += 1

        response = "none"
        if "сложность" in system.lower() or "оцени" in system.lower():
            response = "medium"
        elif "декомпозиц" in system.lower() or "разбей" in system.lower():
            response = (
                "speculative decoding vLLM optimization\n"
                "prefix caching KV cache reuse\n"
                "chunked prefill GPU throughput\n"
                "AWQ quantization 16GB VRAM\n"
            )
        elif "переформул" in system.lower() or "планировщик" in system.lower():
            response = (
                "vLLM memory optimization techniques\n"
                "GPU inference speed improvements\n"
            )
        elif "противоречи" in system.lower():
            response = "none"
        elif "уверенность" in system.lower() or "уверен" in system.lower():
            response = "0.82"
        elif "пробелы" in system.lower() or "пробел" in system.lower():
            response = "none"
        elif "факт-чекер" in system.lower() or "выдели" in system.lower():
            response = (
                "ФАКТ: Speculative decoding ускоряет вывод на 30-100%\n"
                "СТАТУС: ПОДТВЕРЖДЁН\n"
                "ОБОСНОВАНИЕ: Множество источников согласуются\n\n"
                "ФАКТ: Prefix caching снижает TTFT в 3-5 раз\n"
                "СТАТУС: ПОДТВЕРЖДЁН\n"
                "ОБОСНОВАНИЕ: Описано в документации vLLM"
            )
        elif "оцени каждый" in system.lower() or "1-10" in system.lower():
            response = (
                "1|9|Прямо отвечает на вопрос\n"
                "2|8|Хорошо покрывает тему\n"
                "3|7|Полезные детали"
            )
        elif "отчёт" in system.lower() or "синтез" in system.lower() or "аналитик" in system.lower():
            response = (
                "## Оптимизация вывода LLM на 16GB GPU\n\n"
                "Наиболее эффективные методы:\n\n"
                "1. **Speculative Decoding** [1] — ускорение 30-100% TPS, нулевые затраты VRAM при n-gram режиме\n"
                "2. **Prefix Caching** [2] — снижение TTFT в 3-5 раз для повторяющихся промптов\n"
                "3. **Chunked Prefill** [3] — сглаживание ITL при длинных контекстах\n\n"
                "ИСТОЧНИКИ:\n[1] vLLM: arXiv 2309.06180\n[2] SGLang arXiv 2312.07104\n[3] Sarathi-Serve arXiv 2308.16369"
            )
        elif "критик" in system.lower():
            response = "none"
        elif "пробелы" in system.lower():
            response = "none"
        elif "верификатор" in system.lower() or "json" in system.lower():
            response = (
                '{"verified": ["Speculative decoding ускоряет вывод", "Prefix caching снижает TTFT"], '
                '"refuted": [], '
                '"corrections": ""}'
            )
        elif "редактор" in system.lower():
            response = (
                "## Улучшенный отчёт\n\nВсе методы подтверждены источниками."
            )
        return response

    pipeline._llm_call = _timed_llm
    pipeline._call_metrics = call_times
    pipeline._total_tokens = total_tokens
    return pipeline, mcp


async def run_benchmark(version: str = "v2") -> dict:
    """Запуск бенчмарка pipeline и замер метрик."""
    print(f"\n{'='*60}")
    print(f"  БЕНЧМАРК: Deep Research Pipeline ({version.upper()})")
    print(f"{'='*60}")

    pipeline, mcp = make_mock_pipeline(version)

    steps: dict = {}
    t_total_start = time.perf_counter()

    # --- Step timers ---
    step_log: list = []

    original_estimate = pipeline._estimate_complexity
    original_decompose = pipeline._decompose
    original_search = pipeline._search_sub_query
    original_score = pipeline._score_evidence
    original_contradictions = pipeline._detect_contradictions
    original_verify = pipeline._verify_facts
    original_synthesize = pipeline._synthesize
    original_critique = pipeline._self_critique

    async def timed_estimate(*a, **k):
        t0 = time.perf_counter()
        r = await original_estimate(*a, **k)
        step_log.append(("estimate_complexity", (time.perf_counter()-t0)*1000))
        return r

    async def timed_decompose(*a, **k):
        t0 = time.perf_counter()
        r = await original_decompose(*a, **k)
        step_log.append(("decompose", (time.perf_counter()-t0)*1000))
        return r

    async def timed_search(*a, **k):
        t0 = time.perf_counter()
        r = await original_search(*a, **k)
        step_log.append(("search_sub_query", (time.perf_counter()-t0)*1000))
        return r

    async def timed_score(*a, **k):
        t0 = time.perf_counter()
        r = await original_score(*a, **k)
        step_log.append(("score_evidence", (time.perf_counter()-t0)*1000))
        return r

    async def timed_contradictions(*a, **k):
        t0 = time.perf_counter()
        r = await original_contradictions(*a, **k)
        step_log.append(("detect_contradictions", (time.perf_counter()-t0)*1000))
        return r

    async def timed_verify(*a, **k):
        t0 = time.perf_counter()
        r = await original_verify(*a, **k)
        step_log.append(("verify_facts", (time.perf_counter()-t0)*1000))
        return r

    async def timed_synthesize(*a, **k):
        t0 = time.perf_counter()
        r = await original_synthesize(*a, **k)
        step_log.append(("synthesize", (time.perf_counter()-t0)*1000))
        return r

    async def timed_critique(*a, **k):
        t0 = time.perf_counter()
        r = await original_critique(*a, **k)
        step_log.append(("self_critique", (time.perf_counter()-t0)*1000))
        return r

    pipeline._estimate_complexity = timed_estimate
    pipeline._decompose = timed_decompose
    pipeline._search_sub_query = timed_search
    pipeline._score_evidence = timed_score
    pipeline._detect_contradictions = timed_contradictions
    pipeline._verify_facts = timed_verify
    pipeline._synthesize = timed_synthesize
    pipeline._self_critique = timed_critique

    # Для v3: замеряем enrichment
    if version == "v3":
        original_enrich = pipeline._enrich_with_full_content

        async def timed_enrich(*a, **k):
            t0 = time.perf_counter()
            r = await original_enrich(*a, **k)
            step_log.append(("enrich_full_content", (time.perf_counter()-t0)*1000))
            return r

        pipeline._enrich_with_full_content = timed_enrich

    # --- Запуск ---
    status_events = []

    async def status_cb(agent, model, msg):
        status_events.append(msg)

    result = await pipeline.research(QUESTION, status_callback=status_cb)

    t_total = (time.perf_counter() - t_total_start) * 1000

    # --- Агрегация ---
    step_totals: dict = {}
    for name, ms in step_log:
        step_totals[name] = step_totals.get(name, 0.0) + ms

    # Метрики токенов (эмуляция)
    llm_calls = pipeline._call_metrics["count"]
    total_simulated_tokens = pipeline._total_tokens["n"]
    avg_tps = (total_simulated_tokens / (t_total / 1000)) if t_total > 0 else 0

    print(f"\n📊 РЕЗУЛЬТАТЫ ({version.upper()}):")
    print(f"  Суммарное время: {t_total:,.0f} мс  ({t_total/1000:.2f} сек)")
    print(f"  LLM вызовов: {llm_calls}")
    print(f"  Токенов (эмуляция): {total_simulated_tokens:,}")
    print(f"  Скорость (имитация): {avg_tps:.1f} tokens/sec")
    print(f"  Статус-событий: {len(status_events)}")
    print(f"  Уверенность в отчёте: {result.get('confidence_score', 0):.2%}")
    print(f"  Блоков доказательств: {result.get('evidence_count', 0)}")

    print(f"\n⏱️  ДЕТАЛИЗАЦИЯ ШАГОВ:")
    for step, ms in sorted(step_totals.items(), key=lambda x: -x[1]):
        pct = ms / t_total * 100
        bar = "█" * int(pct / 3)
        print(f"  {step:<30} {ms:>7,.0f} мс  {pct:>5.1f}%  {bar}")

    if version == "v3":
        print(f"\n✅ V3 доп. функции:")
        from src.deep_research import _MAX_PAGES_TO_FETCH, _EVIDENCE_TOKEN_BUDGET_CHARS
        print(f"  Страниц для обогащения (макс): {_MAX_PAGES_TO_FETCH}")
        print(f"  Бюджет символов доказательств: {_EVIDENCE_TOKEN_BUDGET_CHARS:,}")

    return {
        "version": version,
        "total_ms": t_total,
        "llm_calls": llm_calls,
        "tokens": total_simulated_tokens,
        "avg_tps": avg_tps,
        "steps": step_totals,
        "confidence": result.get("confidence_score", 0),
        "evidence_count": result.get("evidence_count", 0),
        "status_events": len(status_events),
    }


def print_comparison(before: dict, after: dict):
    """Сравнительная таблица ДО и ПОСЛЕ."""
    print(f"\n{'='*70}")
    print(f"  СРАВНЕНИЕ: {before['version'].upper()} (до) vs {after['version'].upper()} (после)")
    print(f"{'='*70}")

    def delta(a, b, unit="", positive_better=True):
        if a == 0:
            return "N/A"
        diff = b - a
        pct = diff / a * 100
        sign = "+" if diff > 0 else ""
        better = (diff > 0 and positive_better) or (diff < 0 and not positive_better)
        emoji = "✅" if better else ("⚠️" if abs(pct) < 5 else "❌")
        return f"{sign}{pct:.1f}% ({sign}{diff:.0f}{unit}) {emoji}"

    rows = [
        ("Суммарное время (мс)",   before["total_ms"],   after["total_ms"],   False, "мс"),
        ("LLM вызовов",             before["llm_calls"],  after["llm_calls"],  False, ""),
        ("Токены (имитация)",       before["tokens"],     after["tokens"],     True,  ""),
        ("Скорость tokens/sec",     before["avg_tps"],    after["avg_tps"],    True,  " t/s"),
        ("Блоков доказательств",    before["evidence_count"], after["evidence_count"], True, ""),
        ("Статус-событий",          before["status_events"],  after["status_events"],  False, ""),
        ("Уверенность (confidence)",before["confidence"], after["confidence"], True,  ""),
    ]

    print(f"\n{'Метрика':<30} {'ДО (v2)':>15} {'ПОСЛЕ (v3)':>15}  Изменение")
    print("-" * 80)
    for name, b, a, pos_better, unit in rows:
        if isinstance(b, float):
            b_str = f"{b:.2f}{unit}"
            a_str = f"{a:.2f}{unit}"
        else:
            b_str = f"{b}{unit}"
            a_str = f"{a}{unit}"
        d = delta(b, a, unit, pos_better)
        print(f"  {name:<28} {b_str:>15} {a_str:>15}  {d}")

    # Шаги
    all_steps = set(before["steps"]) | set(after["steps"])
    print(f"\n⏱️  ВРЕМЯ ШАГОВ (мс):")
    print(f"{'Шаг':<30} {'ДО':>10} {'ПОСЛЕ':>10} Δ")
    print("-" * 60)
    for step in sorted(all_steps):
        b_ms = before["steps"].get(step, 0)
        a_ms = after["steps"].get(step, 0)
        if b_ms == 0 and a_ms > 0:
            note = f"НОВЫЙ (+{a_ms:.0f}мс)"
        elif a_ms == 0:
            note = "удалён"
        else:
            diff = a_ms - b_ms
            note = f"{'+' if diff >= 0 else ''}{diff:.0f}мс"
        print(f"  {step:<28} {b_ms:>10.0f} {a_ms:>10.0f}  {note}")


async def main():
    print("\n🚀 OPENCLAW DEEP RESEARCH — БЕНЧМАРК ПРОИЗВОДИТЕЛЬНОСТИ")
    print("   Замер ДО и ПОСЛЕ применения улучшений (v2 → v3)")

    # --- ДО улучшений (v2) ---
    print("\n[1/2] Запуск бенчмарка ТЕКУЩЕЙ версии (v2)...")
    try:
        before = await run_benchmark("v2")
    except Exception as e:
        print(f"  ❌ Ошибка v2: {e}")
        import traceback; traceback.print_exc()
        return

    print("\n" + "─"*60)
    print("  ℹ️  После применения улучшений запустите снова с параметром v3")
    print("─"*60)

    # Попытка запустить v3 если доступны новые методы
    try:
        from src.deep_research import _EVIDENCE_TOKEN_BUDGET_CHARS, _MAX_PAGES_TO_FETCH  # v3 constants
        print("\n[2/2] Запуск бенчмарка УЛУЧШЕННОЙ версии (v3)...")
        after = await run_benchmark("v3")
        print_comparison(before, after)
    except (ImportError, AttributeError) as e:
        print(f"\n  ⚠️  v3 ещё не применён (константы не найдены: {e})")
        print("  → Примените улучшения и запустите скрипт снова")
        # Сохраняем результаты v2
        import json
        out = "scripts/benchmark_v2_results.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(before, f, ensure_ascii=False, indent=2)
        print(f"  💾 Результаты v2 сохранены: {out}")


if __name__ == "__main__":
    asyncio.run(main())
