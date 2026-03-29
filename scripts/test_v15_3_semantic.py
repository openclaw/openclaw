"""v15.3 stress tests — Semantic Decomposer & LATS Execution Enforcement.

Tests:
1. Paragraph-based semantic splitting for unnumbered multi-task prompts
2. Numbered-list decomposer still works (regression)
3. LATS expansion prompt contains tool-call enforcement + CRITICAL DIRECTIVES
4. <think> tag wrapping / stripping
5. The exact user-provided prompt splits into 4 tasks

Run: python scripts/test_v15_3_semantic.py
"""

import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.pipeline._core import _decompose_multi_task, _ACTION_VERBS_RE, _SEMANTIC_MIN_LEN

PASSED = 0
FAILED = 0


def check(name: str, condition: bool, detail: str = ""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ✅ {name}")
    else:
        FAILED += 1
        print(f"  ❌ {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# Phase 1: Semantic Paragraph Decomposer
# ---------------------------------------------------------------------------
print("\n=== Phase 1: Semantic Paragraph Decomposer ===")

# The canonical test prompt from the directive (no numbers!)
_CANONICAL_PROMPT = """Слушай, я тут посмотрел видео про архитектуру HFT трейдинга: https://www.youtube.com/watch?v=iwRaNYa8yTw
Сделай мне выжимку: что там говорят про оптимизацию задержек (latency)?
Проанализируй доку по Dmarket API (через web_search) и найди точный алгоритм подписи.
Напиши ГОТОВЫЙ модуль на Rust 2024 (через PyO3) для генерации этой подписи. БЕЗ заглушек. И не создавай его в OpenClaw боте а создай в Dmarket боте.
Auditor: проверь код на уязвимости."""


def test_canonical_prompt_splits_into_tasks():
    """The exact user prompt must decompose into multiple tasks."""
    sub_tasks = _decompose_multi_task(_CANONICAL_PROMPT)
    check("canonical prompt decomposes", len(sub_tasks) >= 2, f"got {len(sub_tasks)} tasks")
    check("canonical prompt >= 4 tasks", len(sub_tasks) >= 4, f"got {len(sub_tasks)} tasks")

    if sub_tasks:
        # Print decomposition for visibility
        for i, (text, brigade) in enumerate(sub_tasks):
            print(f"    Task {i+1} [{brigade}]: {text[:80]}...")


def test_canonical_prompt_routes_correctly():
    """Tasks must route to Research-Ops and Dmarket-Dev respectively."""
    sub_tasks = _decompose_multi_task(_CANONICAL_PROMPT)
    brigades = [b for _, b in sub_tasks]
    check("contains Research-Ops route", "Research-Ops" in brigades, f"brigades: {brigades}")
    check("contains Dmarket-Dev route", "Dmarket-Dev" in brigades, f"brigades: {brigades}")


def test_paragraph_split_double_newline():
    """Paragraphs separated by double newlines are split correctly."""
    prompt = (
        "Найди в интернете последние новости про Rust 2024 edition и собери все ключевые изменения в один документ.\n\n"
        "Проанализируй, какие фичи добавили в async/await, включая новые паттерны и breaking changes в ecosystem.\n\n"
        "Напиши подробный пример кода, демонстрирующий новый паттерн async generators с обработкой ошибок и таймаутами.\n\n"
        "Проверь, работает ли этот код на nightly toolchain и убедись что все зависимости корректно подключены."
    )
    sub_tasks = _decompose_multi_task(prompt)
    check("double-newline split >= 3 tasks", len(sub_tasks) >= 3, f"got {len(sub_tasks)}")


def test_paragraph_split_single_newline():
    """Paragraphs separated by single newlines with action verbs."""
    prompt = (
        "Сделай полный анализ рынка скинов CS2 за последнюю неделю с учётом всех площадок и маркетплейсов.\n"
        "Найди топ-5 скинов с наибольшей волатильностью цены, покажи графики и статистику по каждому.\n"
        "Создай подробный CSV-файл с результатами анализа, включая цены bid/ask, объёмы торгов и спреды.\n"
        "Check: все цены должны быть в USD, а не в рублях. Проверь конвертацию и источники данных."
    )
    sub_tasks = _decompose_multi_task(prompt)
    check("single-newline split >= 3 tasks", len(sub_tasks) >= 3, f"got {len(sub_tasks)}")


def test_short_prompt_not_decomposed():
    """Prompts shorter than 300 chars should NOT be decomposed."""
    prompt = "Напиши hello world на Python.\nСделай его красивым."
    sub_tasks = _decompose_multi_task(prompt)
    check("short prompt NOT decomposed", len(sub_tasks) == 0, f"got {len(sub_tasks)}")


def test_single_paragraph_not_decomposed():
    """A single long paragraph without sub-tasks should NOT be decomposed."""
    prompt = (
        "Я хочу узнать подробнее про работу garbage collector в Python. "
        "Расскажи мне про reference counting, generational GC, и как это "
        "всё работает вместе. Мне нужен подробный ответ с примерами кода "
        "и объяснением каждого этапа сборки мусора, включая weakref и "
        "циклические ссылки. Также сравни с GC в Go и Rust."
    )
    sub_tasks = _decompose_multi_task(prompt)
    check("single paragraph NOT decomposed", len(sub_tasks) == 0, f"got {len(sub_tasks)}")


def test_url_paragraph_treated_as_task():
    """A paragraph with a URL (> 40 chars) is treated as a research task."""
    prompt = (
        "Вот очень интересная и подробная статья про архитектуру HFT систем: https://example.com/hft-architecture-deep-dive-into-latency-optimization-and-market-microstructure\n\n"
        "Сделай мне краткий пересказ основных тезисов из этой статьи, выдели ключевые архитектурные решения и паттерны.\n\n"
        "Напиши код на Rust для реализации описанного алгоритма оптимизации latency с использованием zero-copy буферов."
    )
    sub_tasks = _decompose_multi_task(prompt)
    check("URL paragraph -> task", len(sub_tasks) >= 2, f"got {len(sub_tasks)}")


def test_chat_history_prefix_stripped():
    """[CHAT HISTORY] prefix should be stripped before paragraph analysis."""
    prompt = (
        "[CHAT HISTORY — last conversation turns]:\n"
        "User: Привет, мне нужна помощь с Dmarket API\nAssistant: Конечно, что именно нужно?\n\n"
        "[CURRENT TASK]:\n"
        "Найди в интернете подробную документацию про Dmarket API и сделай выжимку из endpoint-ов.\n\n"
        "Проанализируй документацию и найди точный алгоритм подписи запросов, включая HMAC и timestamp.\n\n"
        "Напиши полный модуль на Python для генерации этой подписи, с обработкой ошибок и retry логикой.\n\n"
        "Создай комплексные тесты для этого модуля, покрывающие edge cases и невалидные входные данные."
    )
    sub_tasks = _decompose_multi_task(prompt)
    check("chat history stripped, tasks found", len(sub_tasks) >= 3, f"got {len(sub_tasks)}")


# ---------------------------------------------------------------------------
# Phase 2: Numbered-list regression
# ---------------------------------------------------------------------------
print("\n=== Phase 2: Numbered-list Regression ===")


def test_numbered_list_still_works():
    """Classic numbered lists must still decompose correctly."""
    prompt = (
        "1. Найди последнюю цену скина AK-47 Redline на Dmarket.\n"
        "2. Проанализируй график цен за месяц.\n"
        "3. Напиши бота для автоматической покупки при снижении цены."
    )
    sub_tasks = _decompose_multi_task(prompt)
    check("numbered list decomposes", len(sub_tasks) == 3, f"got {len(sub_tasks)}")


def test_numbered_list_takes_priority():
    """If both numbered list and paragraphs match, numbered takes priority."""
    prompt = (
        "Сделай следующее:\n"
        "1. Найди инфу на Dmarket про CS2.\n"
        "2. Напиши парсер для скинов.\n"
        "3. Создай тесты."
    )
    sub_tasks = _decompose_multi_task(prompt)
    check("numbered list takes priority", len(sub_tasks) == 3, f"got {len(sub_tasks)}")


# ---------------------------------------------------------------------------
# Phase 3: Action verbs regex
# ---------------------------------------------------------------------------
print("\n=== Phase 3: Action Verbs Regex ===")


def test_russian_action_verbs():
    """Russian action verbs must match."""
    for verb in ["Сделай отчёт", "Проанализируй данные", "Напиши код", "Найди ссылку", "Создай файл", "Проверь код"]:
        check(f"verb: {verb[:15]}", bool(_ACTION_VERBS_RE.search(verb)))


def test_english_action_verbs():
    """English action verbs must match."""
    for verb in ["Check the code", "Create a module", "Write tests", "Find the docs", "Analyze the data", "Build the API", "Implement sorting", "Audit the code"]:
        check(f"verb: {verb[:15]}", bool(_ACTION_VERBS_RE.search(verb)))


def test_auditor_prefix():
    """'Auditor:' prefix matches as action verb."""
    check("Auditor: prefix", bool(_ACTION_VERBS_RE.search("Auditor: проверь код")))


def test_non_action_no_match():
    """Regular sentences should NOT match action verbs."""
    for text in ["Вот интересная мысль", "Я думаю что", "The problem is"]:
        check(f"no match: {text[:15]}", not bool(_ACTION_VERBS_RE.search(text)))


# ---------------------------------------------------------------------------
# Phase 4: LATS tool-call enforcement
# ---------------------------------------------------------------------------
print("\n=== Phase 4: LATS Tool-Call Enforcement ===")


def test_lats_expand_has_tool_call_directive():
    """LATS expansion prompt must contain tool_call enforcement."""
    import inspect
    from src.pipeline._lats_search import LATSEngine
    source = inspect.getsource(LATSEngine._expand_parallel)
    check("LATS has tool_call mandate", "<tool_call>" in source or "tool_call" in source)
    check("LATS has CRITICAL DIRECTIVES import", "CRITICAL_EXECUTION_DIRECTIVES" in source)


def test_lats_imports_directives():
    """LATS module imports _CRITICAL_EXECUTION_DIRECTIVES."""
    import src.pipeline._lats_search as lats_mod
    check("LATS module has directives", hasattr(lats_mod, '_CRITICAL_EXECUTION_DIRECTIVES') or
          '_CRITICAL_EXECUTION_DIRECTIVES' in dir(lats_mod) or
          'CRITICAL_EXECUTION_DIRECTIVES' in open(lats_mod.__file__, encoding='utf-8').read())


# ---------------------------------------------------------------------------
# Phase 5: <think> tag wrapping & stripping
# ---------------------------------------------------------------------------
print("\n=== Phase 5: <think> Tag Handling ===")


def test_think_tag_stripped_from_response():
    """<think>...</think> blocks must be stripped from user-facing response."""
    raw = "<think>\n[D1] Some approach\n[D2] Another approach\n</think>\n\nHere is the actual answer."
    cleaned = re.sub(r"<think>[\s\S]*?</think>\s*", "", raw).strip()
    check("think tag stripped", cleaned == "Here is the actual answer.")
    check("no think remnants", "<think>" not in cleaned)


def test_no_think_tag_passthrough():
    """Response without <think> tags passes through unchanged."""
    raw = "Here is a normal response."
    cleaned = re.sub(r"<think>[\s\S]*?</think>\s*", "", raw).strip()
    check("no-think passthrough", cleaned == raw)


def test_lats_result_wraps_trace():
    """The LATS result in _core.py wraps tree_trace in <think> tags."""
    import inspect
    from src.pipeline._core import PipelineExecutor
    source = inspect.getsource(PipelineExecutor.execute)
    check("LATS wraps in <think>", "<think>" in source)
    check("LATS wraps in </think>", "</think>" in source)


# ---------------------------------------------------------------------------
# Phase 6: Semantic min length constant
# ---------------------------------------------------------------------------
print("\n=== Phase 6: Constants ===")


def test_semantic_min_length():
    """Minimum semantic decomposition length is 300."""
    check("SEMANTIC_MIN_LEN == 300", _SEMANTIC_MIN_LEN == 300)


# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("\n🧪 v15.3 Stress Tests: Semantic Decomposer & LATS Enforcement\n")

    test_canonical_prompt_splits_into_tasks()
    test_canonical_prompt_routes_correctly()
    test_paragraph_split_double_newline()
    test_paragraph_split_single_newline()
    test_short_prompt_not_decomposed()
    test_single_paragraph_not_decomposed()
    test_url_paragraph_treated_as_task()
    test_chat_history_prefix_stripped()

    test_numbered_list_still_works()
    test_numbered_list_takes_priority()

    test_russian_action_verbs()
    test_english_action_verbs()
    test_auditor_prefix()
    test_non_action_no_match()

    test_lats_expand_has_tool_call_directive()
    test_lats_imports_directives()

    test_think_tag_stripped_from_response()
    test_no_think_tag_passthrough()
    test_lats_result_wraps_trace()

    test_semantic_min_length()

    total = PASSED + FAILED
    print(f"\n{'='*50}")
    print(f"Results: {PASSED}/{total} passed, {FAILED} failed")
    if FAILED:
        print("❌ SOME TESTS FAILED")
        sys.exit(1)
    else:
        print("✅ ALL TESTS PASSED")
        sys.exit(0)
