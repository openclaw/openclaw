# Regression Guard Patterns

Common anti-patterns that cause quality metric regressions in AI/ML pipelines,
and how to guard against them.

---

## Pattern 1: Mode/Config Switch "Same Accuracy" Claim

**What happens:** Developer switches from mode A to mode B claiming "same accuracy"
based on a small test. Full pipeline shows significant metric drop.

**Examples seen:**

- MAIPID Sprint 10: Grid 2x2 mode "same as single" (tested: 39 vs 38 tags).
  Full pipeline: single=68, grid=56 (-18% recall). Grid reverted.

**Guard:**

```python
def test_batch_mode_is_single(self) -> None:
    """batch_mode must be 'single' — grid drops ISA recall 68->56 (-18%).
    Benchmark: single=68 tags vs grid_2x2=56 tags on SPEC-00-page-50.png.
    """
    import inspect, pipeline.core as mod
    src = inspect.getsource(mod)
    match = re.search(r'batch_mode\s*=\s*["\'](\w+)["\']', src)
    assert match and match.group(1) == "single", "batch_mode must be 'single'"
```

**Rule:** Always benchmark the full pipeline before claiming "same accuracy."
Unit test results ≠ full pipeline results.

---

## Pattern 2: Quality Filter Hurts Recall

**What happens:** Developer adds a filter to "improve quality" (e.g., confidence floor,
minimum length, strict regex). Filter removes false positives but also removes
true positives, dropping recall below baseline.

**Examples seen:**

- MAIPID Sprint 10: Added `confidence < 0.5` filter → 68 tags dropped to 57.
- MAIPID Sprint 10: Added 4-char minimum on ISA tags → valid short tags rejected.
- MAIPID Sprint 10: Circle masking → loop numbers outside circle boundary removed.

**Guard:**

```python
def test_no_confidence_floor(self) -> None:
    """Low-confidence items must not be filtered — Sprint9 baseline had no floor."""
    reader = ISATagReader()
    result = reader._parse_vlm_response('[{"tag": "FT-001", "confidence": 0.3}]')
    assert len(result) == 1, "Low-confidence items should pass through"
```

**Rule:** When adding quality filters, measure recall before AND after on the benchmark image.
If recall drops, the filter is too aggressive.

---

## Pattern 3: Falsy Empty List Check

**What happens:** `if some_list:` is used to check if results exist. An empty list `[]`
is falsy, triggering fallback logic intended only for `None` (no results).

**Examples seen:**

- MAIPID Sprint 10: `if gemini_connections:` → empty list `[]` triggered
  O(n²) proximity fallback → 26,865 connections instead of ~447.

**Guard:**

```python
def test_connection_fallback_only_on_none(self) -> None:
    """Fallback must not trigger on empty list — only on None."""
    import inspect, pipeline.graph_builder as mod
    src = inspect.getsource(mod)
    # Must use 'is not None' not truthy check
    assert "is not None" in src, "Use 'is not None', not 'if connections:'"
```

**Rule:** For "did this step produce results?" checks, always use `is not None`
not truthiness. `[]` means "ran but found nothing"; `None` means "did not run."

---

## Pattern 4: Shared Config Between Incompatible Components

**What happens:** A global config key (e.g., `VISION_MODEL`) is reused by components
that require a different provider. Component silently uses wrong model.

**Examples seen:**

- MAIPID Sprint 10: `MAIPID_VISION_MODEL=gemini-2.5-flash` leaked into `ISATagReader`
  (OpenAI-only). Result: OpenAI API called with Gemini model name → error.

**Guard:**

```python
def test_openai_component_uses_openai_model(self) -> None:
    """ISATagReader must use openai_model, not vision_model."""
    from pipeline.config import PipelineConfig
    cfg = PipelineConfig(openai_model="gpt-4o-mini", vision_model="gemini-2.5-flash")
    reader = ISATagReader(model=cfg.openai_model)
    assert "gemini" not in reader.model.lower(), "ISATagReader must not use Gemini model"
```

**Rule:** Add separate config fields for each provider. Do not share env vars across
components from different API providers.

---

## Pattern 5: Missing Request Parameter in Cache Key

**What happens:** Cache key omits a request parameter that changes the result.
Subsequent requests with different parameters get a stale cached result.

**Examples seen:**

- MAIPID Sprint 10: Cache key = `image + prompt_version` (no `detection_mode`).
  Hybrid mode request returned vision-mode cached result → 0 ISA tags.

**Guard:**

```python
def test_cache_key_includes_all_mode_params(self) -> None:
    """Cache key must include all parameters that affect the result."""
    import inspect, app as app_mod
    src = inspect.getsource(app_mod)
    line = next(l for l in src.splitlines() if 'make_key' in l and 'cache_key' in l)
    assert 'detection_mode' in line, "Cache key must include detection_mode"
    assert 'prompt_version' in line, "Cache key must include prompt_version"
```

**Rule:** Any request parameter that produces different output for the same input
MUST be included in the cache key.

---

## Benchmark Discipline Rules

1. **Measure before changing** — run full pipeline before any parameter change
2. **Measure after changing** — run full pipeline on same test image after change
3. **Document both numbers** — commit message or test docstring must include before/after
4. **Full pipeline ≠ unit test** — always measure end-to-end on the real benchmark image
5. **Deduplication changes metric meaning** — if you add dedup, re-baseline the number

## Guard Test Anatomy

Every guard test should contain:

```python
def test_<setting>_is_<value>(self) -> None:
    """<setting> must be <value>.

    Reason: <why this value was chosen>
    Evidence: <before/after benchmark numbers>
    DO NOT change without full benchmark + updating this test.
    """
    # Assertion that fails if value changes
    assert current_value == expected_value, (
        f"<setting> is {current_value!r} but must be <value>. "
        "<reason>. Run full pipeline benchmark before changing."
    )
```
