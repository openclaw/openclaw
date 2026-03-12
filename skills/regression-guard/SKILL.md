---
name: regression-guard
description: "AI/ML 파이프라인의 성능 회귀를 방지하는 가드 테스트 생성 및 관리 스킬. 다음 상황에 사용: (1) 파이프라인 파라미터(배치모드, confidence threshold, 알고리즘 파라미터 등) 변경 전후, (2) 성능 최적화 작업이 품질 지표에 영향을 줄 수 있을 때, (3) 벤치마크 세션 이후 결과를 코드로 고정할 때, (4) 회귀 방지 테스트 파일(test_regression_guard.py) 신규 생성 또는 업데이트, (5) 회귀 방지/regression guard/벤치마크 고정/파라미터 잠금 키워드. Prevents quality metric regressions in AI pipelines by creating guard tests, documenting baselines, and enforcing critical settings via pytest."
---

# Regression Guard

AI/ML 파이프라인에서 성능 회귀를 자동으로 차단하는 가드 테스트 생성 및 관리.

## Core Concept

**회귀 가드 테스트** = 벤치마크 수치를 코드로 고정한 테스트.
파라미터가 변경되면 즉시 실패 → "이 설정은 이유가 있어" 알림.

## Quick Start

### New project — scaffold guard file

```bash
python <skill-dir>/scripts/init_guards.py --project-dir C:\TEST\MYPROJECT
# With existing baseline:
python <skill-dir>/scripts/init_guards.py --project-dir C:\TEST\MYPROJECT --benchmark-json benchmarks/baseline.json
```

### Existing project — add guard manually

Add to `tests/test_regression_guard.py` using the setting-lock pattern:

```python
def test_<setting>_is_locked(self) -> None:
    """<setting> must be <value>.
    Reason: <why>
    Evidence: before=X, after=Y on <benchmark>
    DO NOT change without full pipeline benchmark.
    """
    from my_module import MyClass
    assert MyClass().<setting> == <value>
```

## Parameter Change Checklist

1. Run full pipeline benchmark (before) → record metrics
2. Apply change
3. Re-run benchmark (after)
4. Compare → no regression? Update guard test with new baseline
5. Regression detected? Rollback or redesign

## Benchmark Record Format

```
before: symbols=371, ISA=64, time=82s (commit f69c90a)
after:  symbols=206, ISA=64, time=30s (commit xxxxxxx)
reason: GenericUpgrader FP threshold 강화
```

Include in test docstrings — code is documentation.

## References

- `references/guard-patterns.md` — 5 major guard patterns with real regression examples
- `references/maipid-guards.md` — MAIPID project current guard tests (9 tests)
- `references/response-playbook.md` — what to do when a guard test fails
