---
name: regression-guard
description: "AI/ML 파이프라인의 성능 회귀를 방지하는 가드 테스트 생성 및 관리 스킬. 다음 상황에 사용: (1) 파이프라인 파라미터(배치모드, confidence threshold, 알고리즘 파라미터 등) 변경 전후, (2) 성능 최적화 작업이 품질 지표에 영향을 줄 수 있을 때, (3) 벤치마크 세션 이후 결과를 코드로 고정할 때, (4) 회귀 방지 테스트 파일(test_regression_guard.py) 신규 생성 또는 업데이트, (5) 회귀 방지/regression guard/벤치마크 고정/파라미터 잠금 키워드. Prevents quality metric regressions in AI pipelines by creating guard tests, documenting baselines, and enforcing critical settings via pytest."
---

# Regression Guard Skill

AI/ML 파이프라인에서 성능 회귀를 자동으로 차단하는 가드 테스트 생성 및 관리.

## 핵심 개념

**회귀 가드 테스트** = 벤치마크 수치를 코드로 고정한 테스트.
파라미터가 변경되면 즉시 실패 → 개발자에게 "이 설정은 이유가 있어" 알림.

## 빠른 시작

### 1. 신규 프로젝트 — 가드 파일 생성

```bash
# 스캐폴드만 (baseline 나중에 채움)
python C:\MAIBOT\skills\regression-guard\scripts\init_guards.py \
    --project-dir C:\TEST\MYPROJECT

# baseline.json이 있으면 자동 생성
python C:\MAIBOT\skills\regression-guard\scripts\init_guards.py \
    --project-dir C:\TEST\MYPROJECT \
    --benchmark-json benchmarks/baseline.json
```

### 2. 기존 프로젝트 — 수동 가드 추가

`tests/test_regression_guard.py`에 직접 추가 (아래 템플릿 사용).

### 3. 파라미터 변경 전 체크리스트

```
□ 전체 파이프라인 벤치마크 실행 (before)
□ 수치 기록 (symbols, ISA tags, time 등)
□ 변경 적용
□ 전체 파이프라인 벤치마크 재실행 (after)
□ before/after 비교 → 회귀 없으면 가드 테스트 업데이트
□ 회귀 있으면 변경 롤백 또는 설계 재검토
```

## 가드 테스트 작성 패턴

### 설정 값 고정

```python
def test_<setting>_is_locked(self) -> None:
    """<setting> must be <value>.

    Reason: <왜 이 값인가>
    Evidence: <before=X, after=Y on <benchmark_image>>
    DO NOT change without full pipeline benchmark + updating this test.
    """
    from my_module import MyClass
    obj = MyClass()
    assert obj.<setting> == <value>, (
        f"<setting> is {obj.<setting>!r}, expected <value>. "
        "<reason>"
    )
```

### 소스코드 패턴 고정 (클래스 없는 경우)

```python
def test_no_confidence_floor(self) -> None:
    import inspect, my_module as mod
    src = inspect.getsource(mod)
    # 특정 패턴이 없어야 함
    assert "confidence < 0.5" not in src, "confidence floor removes recall"
```

### 캐시 키 완전성 검증

```python
def test_cache_key_includes_mode(self) -> None:
    import inspect, app as app_mod
    src = inspect.getsource(app_mod)
    line = next(l for l in src.splitlines() if 'make_key' in l and 'cache_key' in l)
    assert 'detection_mode' in line, (
        "Cache key must include detection_mode — "
        "missing it returns stale results for different modes"
    )
```

## 주요 패턴 5가지 (과거 회귀 사례 포함)

`references/guard-patterns.md` 참조 — 다음 패턴 포함:

1. Mode/Config Switch "Same Accuracy" Claim
2. Quality Filter Hurts Recall
3. Falsy Empty List Check (`if list:` vs `if list is not None:`)
4. Shared Config Between Incompatible Components
5. Missing Request Parameter in Cache Key

## MAIPID 프로젝트 현재 가드

`C:\TEST\MAIPID\tests\test_pipeline_regression.py` (9개 테스트):

| 테스트                                   |     보호하는 설정      | 근거                      |
| ---------------------------------------- | :--------------------: | ------------------------- |
| `test_batch_mode_is_single_not_grid`     | `batch_mode="single"`  | grid 2x2: -18% ISA recall |
| `test_no_confidence_floor`               | confidence filter 없음 | floor=0.5: -16% recall    |
| `test_cache_key_includes_detection_mode` |     cache key 포함     | 없으면 0 ISA tags 반환    |
| `test_hough_param2_default`              |     `param2=0.50`      | Sprint9 최적값            |
| `test_isa_tag_pattern_*`                 |  digit range `{2,6}`   | 2자리 루프 필요           |
| `test_hough_min/max_radius`              |     min=10, max=55     | 노이즈/병합 방지          |

실행: `pytest tests/test_pipeline_regression.py -v`

## 벤치마크 기록 규칙

변경마다 다음을 기록:

```
before: symbols=371, ISA=64, time=82s (commit f69c90a)
after:  symbols=206, ISA=64, time=30s (commit xxxxxxx)
reason: GenericUpgrader FP threshold 강화
```

위 기록을 **테스트 docstring**에 포함 → 코드가 곧 문서.

## 회귀 발생 시 대응

1. `pytest tests/test_regression_guard.py -v` → 어떤 가드가 실패했는지 확인
2. 실패 메시지에 있는 "reason" 읽기
3. 해당 변경이 의도적이라면:
   - 전체 파이프라인 재벤치마크 실행
   - before/after 수치 확인
   - 가드 테스트 업데이트 (새 기준값 + 증거 docstring)
4. 의도적이지 않다면: 롤백
