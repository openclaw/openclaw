# MAIPID — AI PID 도면 인식 및 분석

## 기본 정보

- **시작일:** 2026-03-09
- **로컬:** `C:\TEST\MAIPID`
- **GitHub:** https://github.com/jini92/MAIPID (private)
- **Obsidian:** `01.PROJECT/17.MAIPID`
- **상태:** 🟢 진행중
- **언어:** Python (FastAPI + OpenCV + PyTorch + EasyOCR)

## 프로젝트 개요

AI 기반 PID(Piping and Instrumentation Diagram) 도면 인식 및 분석 도구.
공장/플랜트 PID 도면에서 심볼(밸브, 계기, 장비), 배관, 텍스트를 자동 인식하고 구조화된 데이터로 추출.

## 기술 스택

- Backend: Python 3.11+, FastAPI, uvicorn
- Vision: OpenCV, PyTorch, torchvision (YOLOv8/Faster R-CNN)
- OCR: EasyOCR, Tesseract
- Test: pytest, pytest-asyncio

## 개발 환경

- 로컬 경로: `C:\TEST\MAIPID`
- 에이전트: `.claude/agents/` (vision-engineer, ocr-specialist, api-engineer)
- MCP: context7

## 생태계 연결

- MAIPnID: 기존 P&ID PoC 프로젝트 — 기술 연속성
- MAITCAD: CAD 도면 분석 기술 공유
- MAIAX: 스마트제조 공정 데이터 연동
- MAIPatent: 공정 관련 특허 도면 분석

## 배포 정보

- **Railway URL:** https://maipid-production.up.railway.app
- **Swagger UI:** https://maipid-production.up.railway.app/docs
- **Railway 프로젝트:** https://railway.com/project/b7b54818-250a-431f-9e3b-2ebf333a64d2
- **환경변수:** GEMINI_API_KEY, MAIPID_VISION_MODEL=gemini-2.5-flash, PYTHONPATH=/app/src

## 진행 기록

- 2026-03-09: 프로젝트 초기화 (풀셋업)
- 2026-03-09: Sprint 1 완료 — Gemini 2.5 Flash 통합, EasyOCR 검증, 28개 심볼 검출
- 2026-03-09~10: Sprint 2 완료 — Retry 로직, bbox 정규화, 그래프 최적화, 입력 검증, OCR ROI
- 2026-03-10: Sprint 3 완료 — Few-shot 프롬프트, 구조화 출력, 온톨로지 수정, 배치 처리
- 2026-03-10: Sprint 4 완료 — Docker, CI/CD, Web UI (Vite+React), LRU 캐시
- 2026-03-10: Railway 클라우드 배포 완료 (S4-T07)

## Sprint 5 — V3 파이프라인 (2026-03-10)

### 근본 원인 & 해결

- **문제**: Gemini에게 bbox 좌표를 요구 → 등간격 그리드 환각
- **해결**: Gemini 역할을 심볼 목록 + 연결 관계로 재정의, bbox는 OCR 위치에서 추출

### 구현 완료

1. ✅ V3 프롬프트 (`SYMBOL_DETECTION_PROMPT_V3`) — bbox 없이 symbols + connections + process_lines
2. ✅ V3 응답 파서 (`_parse_v3_response`, `_parse_v3_json`) — 새 JSON 구조 처리
3. ✅ SymbolLocator (`pipeline/locator.py`) — Gemini 태그 → OCR 텍스트 위치 매핑
4. ✅ Graph Builder — `gemini_connections` 파라미터, V3 ID 해석
5. ✅ ISA 5.1 태그 파서 강화 — OCR 아티팩트 처리 (`FT\n11389`, `~P3B-HE`)
6. ✅ App 통합 — `prompt_version=v3` 파라미터, `connections_source` 응답
7. ✅ 시각화 — 연결선, 심볼 타입별 색상, 범례
8. ✅ 커밋 & Railway 배포

### 테스트 결과 (A-001_pid_sample.png)

| 메트릭          | V2 (기존)       | V3 (개선)                                                        |
| --------------- | --------------- | ---------------------------------------------------------------- |
| 연결 수         | 469 (proximity) | 23 (Gemini)                                                      |
| 심볼 수         | ~28             | 29                                                               |
| 온톨로지 해석률 | 100%            | 86.2%                                                            |
| OCR 위치 매칭   | N/A             | 24/29 (83%)                                                      |
| 심볼 타입       | Valve 위주      | 6종 (BallValve, ControlValve, Instrument, Meter, Valve, Unknown) |

### API 사용법

```
POST /api/v1/analyze?prompt_version=v3
# V3 응답에 connections_source: "gemini" 필드 포함
```

## Sprint 7 — 온톨로지 해석률 개선 (2026-03-11)

### 변경 사항

1. **`mapper.py` 5단계 `_resolve_class`**: semantic token matching 추가 (공백/하이픈/CamelCase 정규화)
2. **`mapper.py` ISA fallback post-processing**: Unknown 심볼을 인근 OCR 텍스트의 ISA prefix로 재분류 (60+ prefix 지원)
3. **`registry.py` 20+ 신규 OWL 클래스**: HandSwitch, FlowSwitch, PressureGauge, LevelGauge, PressureElement 등
4. **alias 대폭 확장**: ISA 2자 코드(FT,PI,LV,HS,HV...) + 공백 포함 패턴('flow transmitter', 'control valve' 등)
5. **테스트 367개 통과**: ISA fallback 동작 검증

### 결과

- 온톨로지 해석률: **86.2% → 95%+** (목표 달성)
- commit: `7ba9f53`

## Sprint 7 — 실시간 테스트 결과 (2026-03-11)

### 테스트 파이프라인

- **서버**: `marine-prairie` 세션, uvicorn, http://127.0.0.1:8765
- **API 파싱 수정**: `call_api.py` result/detail 중첩 구조 처리 완료
- **발견 버그**: Gemini `max_output_tokens=8192` 초과 시 JSON truncation → 16384 필요
  - `src/maipid/config.py` 수정 예정 (미적용)

### 실제 P&ID 분석 결과

| 도면            | 모델             | 심볼 | 해석률 | 비고                       |
| --------------- | ---------------- | ---- | ------ | -------------------------- |
| A-001 샘플      | GPT-4o V3        | 11   | 100%   | Sprint 7 매퍼 재처리       |
| SPEC-00-page-50 | Gemini 2.5 Flash | 270  | 100%   | 실제 산업 P&ID (Figure 12) |

### 이미지 분류 (SPEC-00 샘플셋)

- page-01: 커버페이지
- page-35: 텍스트 문서 (Equipment ID 표)
- page-45: Plot Plan (평면도) — P&ID 아님
- page-50: **실제 P&ID** ✅ (생산 계통도, Figure 12)
- page-52: **실제 P&ID** ✅

### 신규 스크립트

- `scripts/gemini_direct_test.py` — Gemini API 직접 호출
- `scripts/test_page50.py` — page-50 전체 파이프라인 테스트
- `scripts/sprint7_viz.py` — Sprint 7 매퍼로 기존 결과 재처리 시각화

## 다음 액션

- [x] V3 온톨로지 해석률 개선 (86.2% → 95%+) ✅ 2026-03-11
- [x] SymbolLocator 매칭 정확도 개선 ✅ 2026-03-11 (83% → 95%+, fuzzy/merge)
- [x] Neo4j 라이브 드라이버 통합 ✅ 2026-03-11 (neo4j_writer.py, ENV 기반 on/off)
- [x] CHANGELOG v0.6.0 작성 ✅ 2026-03-11
- [x] **[완료]** `config.py` max_output_tokens 8192 → 16384 수정 ✅ 2026-03-11
- [x] **[Sprint 8 P0]** GeometricDetector + Sprint 7 OntologyMapper 통합 ✅ 2026-03-11
  - viz_geometric.png 방식(30개+ 검출)에 Sprint 7 100% 해석률 결합
  - API 비용 없는 완전 오픈소스 파이프라인 목표
  - 미달 시 Hybrid Vision으로 보완 (P2로 격하)
- [ ] Ground Truth 라벨링 (A-001 30+ 심볼)
- [ ] S3-T01: LLM 벤치마크 (Qwen vs GPT-4V vs Claude 3모델 비교)
- [ ] S4-T06: 데모 영상/GIF 제작
- [ ] GitHub Pages Web UI와 Railway API 연동 확인

## Sprint 8 방향성 결정 (2026-03-11 지니님 검토)

### 핵심 인사이트

- `viz_geometric.png` = Detection 최강: HoughCircles(계기 ~11개) + Contour(밸브 ~20개) = **30개+ 픽셀 정확도**
- `viz_geometric_final.png` = 위치 정확 + OWL 분류 통합 최고 결과물
- Sprint 7 OntologyMapper = 100% 온톨로지 해석률
- **GeometricDetector + Sprint 7 Mapper = Sprint 8 P0 목표**
- Hybrid Vision (Gemini+GPT-4o)는 P2로 격하 (GeomDetector 미달 시 보완)

## Sprint 8 — GeometricDetector + HYBRID 모드 (2026-03-11)

### 구현 완료

1. **DetectionMode enum**: `VISION` / `GEOMETRIC` / `HYBRID` (config.py)
2. **`analyze_geometric()`**: OpenCV only, API $0, 123심볼/172ms (core.py)
3. **`analyze_hybrid()`**: GeomDetector(위치) + VLM(분류) 병렬 + proximity 매칭 (core.py)
4. **`_merge_hybrid_detections()`**: 100px threshold, 소스 태깅 (hybrid_matched/geo_only/vlm_only)
5. **Truncated JSON repair**: `_parse_v3_json()` bracket balancing
6. **max_tokens 8192→16384**: Gemini JSON truncation 해결
7. **app.py**: `detection_mode` 쿼리 파라미터 지원

### 커밋

```
4ef7021  fix(vision): truncated JSON repair
34b82c0  feat(sprint8): HYBRID detection mode
34850fe  docs(sprint8): T007 evaluation report
138b3be  feat(sprint8): GeometricDetector pipeline + DetectionMode
0661714  docs(sprint8): D005 + I006
```

### 테스트: 448 passed, 3 skipped (+42 신규)

### 협의체 평가 (T007): C+ (67/100)

- Detection B+ / Classification D / System A-
- 근본 문제: **EasyOCR가 ISA 태그 0건 인식** (단일 숫자 노이즈만)

### HYBRID 실 테스트 (SPEC-00-page-50)

| 모드                     | 심볼    | OWL 클래스 | 해석률   | 연결    | 비용        |
| ------------------------ | ------- | ---------- | -------- | ------- | ----------- |
| geometric                | 123     | 2종        | 100%     | 1056    | $0          |
| **hybrid (GPT-4o-mini)** | **132** | **10종**   | **100%** | **239** | **~$0.005** |

### VLM V3 호환성 발견

- **GPT-4o-mini**: ✅ V3 JSON 안정 — HYBRID 최적 모델
- **GPT-4o**: ❌ JSON 파싱 실패
- **Gemini 2.5 Flash**: ❌ JSON 파싱 실패

### 10종 OWL 분류 (HYBRID)

Valve 89, Instrument 35, Pump 1, ControlValve 1, FlowTransmitter 1, PressureTransmitter 1, Tank 1, Compressor 1, FlowController 1, LevelTransmitter 1

## Sprint 9 — ISATagReader + 원 검출 최적화 (2026-03-11)

### 구현 완료

1. **ISATagReader** (`src/maipid/pipeline/isa_reader.py`): VLM ROI ISA 태그 인식 (GPT-4o-mini)
2. **3-Layer Ensemble** (`shape_classifier.py` + `shacl_validator.py`): 12 shape rules + 8 SHACL constraints
3. **HoughCircles 최적화**: param2=0.85→0.50, minR=18→10, maxR=45→55, minDist=40→30
4. **ISA to OWL 매핑**: 32개 ISA 코드 (PI, PT, FT, FI, FE, RO, TI, TE, LT, PIC 등)

### 핵심 결과 (SPEC-00-page-50)

| 지표          | Sprint 8 | Sprint 9        | 변화 |
| ------------- | -------- | --------------- | ---- |
| 원 검출       | 3        | **138**         | 46x  |
| ISA 태그 인식 | 0        | **122** (88.4%) | ∞    |
| OWL 클래스    | 10       | **20**          | 2x   |
| 심볼 수       | 132      | **207**         | 1.6x |
| 테스트        | 448      | **541**         | +93  |

### ISA 인식 실측 벤치마크

- **GPT-4o-mini VLM ROI**: 6/6 = 100% (3개 원에서 ISA 태그 완벽 인식)
- **EasyOCR**: 0% (6px 텍스트 인식 불가)
- 근본 원인: P&ID 계기원 텍스트 ~6px → CRAFT detector minimum 미달

### 파라미터 최적화 전략

- **옵션 B 채택**: "넓게 검출 → 온톨로지 필터" (지니님 2026-03-11 제안)
- Grid search 17 configs → scoring (instruments*10 - FP*3 + quality\*5)

### 커밋

```
a5345f8  docs(sprint9): T009 final report + visualization
ab116aa  perf(circles): HoughCircles optimization 3→138 circles
118b64a  fix(isa_reader): float bbox to int conversion
31facf6  feat(sprint9b): ISATagReader VLM ROI + PaddleOCR fallback
94a338b  docs(survey): S001 ISA tag recognition survey
be988df  docs(sprint9): T008 3-layer ensemble test results
8bd547b  feat(sprint9): 3-layer ensemble ShapeClassifier + SHACLValidator
ad152a8  docs(sprint9): I007 3-Layer ensemble plan
```

### 발견된 이슈

- ISATagReader 결과가 `properties['tag']`에 미저장 — `detection.symbol_type`에만 반영
- 원 중복 검출 (같은 위치 다른 반지름) → deduplication 필요
- VLM only 태그 (`FCV-101`) vs OCR 노이즈 (`3`, `35"`)

## 다음 액션

- [ ] **[P0]** ISA 태그를 `properties`에 올바르게 저장
- [ ] **[P0]** 원 중복 제거 (deduplication by proximity)
- [ ] **[P1]** 배치 테스트 (13 P&ID 전체, Sprint 9 파이프라인)
- [ ] **[P1]** Connection 필터링 (384 → ~50)
- [ ] **[P2]** PaddleOCR-VL 로컬 테스트 (RTX 4070S GPU)
- [ ] **[P2]** Ground Truth 수동 레이블
- [ ] **[백로그]** S3-T01: LLM 벤치마크

## 보류 중 (계획만)

- [ ] **타일 분할 Detection** — Ground Truth + YOLO 이후
- [ ] **OCR ROI 크롭+확대**: ISA 인식률 개선 시도

## PC GPU 확인 (2026-03-11)

- **RTX 4070 SUPER 12GB VRAM**, CUDA 12.6, RAM 32GB
- PaddleOCR-VL (0.9B) ~2GB, GOT-OCR2.0 ~1.5GB — 모두 실행 가능

## Sprint 10 — Code Review 수정 + ISA 회귀 복구 (2026-03-12)

### 커밋 체인 (master)

`8cdc91e` → `77e7775` → `ced742f` → `3068657` → `3bf22f9` → `70358e3`(reverted) → `f69c90a` → `68474d1` → `481fd81`

### 완료 사항

1. **Code Review 12개 이슈 수정** (commit `8cdc91e`): SEC-02~06, ERR-01~02, ARCH-01, PERF-01~02, FE-01~02
2. **커버리지 향상** 69.29% → 75.46% +152 tests (commit `77e7775`)
3. **버그 3종 수정** (commits `ced742f`, `3068657`):
   - vision_model 쿼리파라미터 pipeline config 미반영
   - ISATagReader/GenericUpgrader가 Gemini 모델명 사용 → openai_model 필드 분리
   - gemini_connections 빈 리스트 → O(n²) 폭발 (`is not None` 체크로 해결)
4. **ISA 필터 과다 복구** (commit `3bf22f9`): confidence floor 제거, digit range `\d{2,6}`, 원형 마스킹 제거, Sprint 9 프롬프트 복원
5. **grid mode 검증 후 단일 모드 복원** (commit `f69c90a`): single=68 ISA tags > grid2x2=56 (+21% recall)
6. **Regression Guard 테스트 9개** `tests/test_pipeline_regression.py` (commit `68474d1`)
7. **Sprint 10 벤치마크 문서** `docs/T010-Sprint10-Final-Results.md` (commit `481fd81`)

### Sprint 10 벤치마크 결과 (SPEC-00-page-50, hybrid mode)

| 지표              | Sprint 9 | Sprint 10 |
| ----------------- | :------: | :-------: |
| 심볼 수           |   206    |  371 ❌   |
| OWL 클래스        |    24    |   28 ✅   |
| ISA 태그 (unique) |   ~61    |   64 ✅   |
| 커넥션            |   383    |    486    |
| 처리 시간         |  30.5s   |  82s ❌   |
| 테스트 수         |   541    |  918 ✅   |

### Sprint 10 핵심 발견

- Sprint 9 ISA 122개 = **중복 포함 수치**. dedup 후 ~61개 ≈ 현재 64개 (실제 회귀 없음)
- 심볼 과다(371 vs 206): Gemini V3가 235개 탐지 → 오탐 의심
- 처리시간 82s: ISA single 145 API calls × ~0.47s = 병목

---

## ⚠️ 회귀 방지 가이드 (MAIBOT 필독)

**이 섹션은 MAIPID 작업 시 반드시 확인해야 하는 결정 목록입니다.**
아래 항목을 변경할 때는 반드시 전체 파이프라인 벤치마크를 실행하고 결과를 문서화하세요.

### 🔒 변경 금지 항목 (Regression Guard 테스트로 보호됨)

| 항목                    |                   현재 값                   | 변경 금지 이유                                     | 테스트                                           |
| ----------------------- | :-----------------------------------------: | -------------------------------------------------- | ------------------------------------------------ |
| `batch_mode`            |                 `"single"`                  | grid 2x2: 56 tags vs single: 68 tags (-18% recall) | `test_batch_mode_is_single_not_grid`             |
| confidence floor        |                  **없음**                   | floor=0.5 추가 시 57개로 감소 (-16%)               | `test_no_confidence_floor_in_parse_vlm_response` |
| `hough_param2`          |                   `0.50`                    | 0.45→151 circles(과다), 0.55→115(과소)             | `test_hough_param2_default`                      |
| `ISA_TAG_PATTERN` digit |                   `{2,6}`                   | 2자리 루프(LG-17) 필요                             | `test_isa_tag_pattern_allows_two_digit_loops`    |
| cache key               | `content + prompt_version + detection_mode` | detection_mode 없으면 hybrid→vision 캐시 오염      | `test_cache_key_includes_detection_mode`         |

### ⚡ 과거 회귀 사례 (반복 금지)

#### 회귀 #1: Grid mode로 단일 모드 교체 (2026-03-12)

- **무슨 일**: Sprint 10에서 "grid 2x2 = single과 동일 정확도"를 주장하며 `batch_mode="grid"`로 변경
- **실제 결과**: grid 2x2 = 56 ISA tags vs single = 68 ISA tags (-18% recall)
- **교훈**: 소규모 테스트(39 vs 38)와 전체 파이프라인 테스트(68 vs 56)는 결과가 다름. **항상 전체 파이프라인으로 측정**
- **방지책**: `test_batch_mode_is_single_not_grid`

#### 회귀 #2: ISA confidence floor 추가 (2026-03-12)

- **무슨 일**: ISA 품질 향상을 위해 `confidence < 0.5` 필터 추가
- **실제 결과**: 57개로 감소 (Sprint 9 기준 ~61개보다 적음)
- **교훈**: Sprint 9 baseline은 confidence 필터 없이 122개(중복포함). 필터 추가는 recall을 낮춤
- **방지책**: `test_no_confidence_floor_in_parse_vlm_response`

#### 회귀 #3: gemini_connections 빈 리스트 처리 (2026-03-11)

- **무슨 일**: `if gemini_connections:` → 빈 리스트가 falsy → O(n²) proximity fallback 발동
- **실제 결과**: connection 26,865개 폭발 (정상: ~447개)
- **교훈**: 빈 리스트 체크는 `is not None`으로 해야 함
- **방지책**: 현재 코드 `if gemini_connections is not None:` (변경 금지)

#### 회귀 #4: ISATagReader에 Gemini 모델명 사용 (2026-03-11)

- **무슨 일**: `MAIPID_VISION_MODEL=gemini-2.5-flash`가 ISATagReader에 전달됨
- **실제 결과**: ISATagReader가 OpenAI API에 Gemini 모델명으로 호출 → 오류
- **교훈**: ISATagReader/GenericUpgrader는 OpenAI 전용. vision_model 환경변수를 공유하면 안됨
- **방지책**: `PipelineConfig.openai_model` 필드 분리 (변경 금지)

#### 회귀 #5: 캐시 키에 detection_mode 누락 (2026-03-12)

- **무슨 일**: 캐시 키 = `image + prompt_version`만 → hybrid 모드 요청이 vision 캐시 반환
- **실제 결과**: ISA 태그 0개 (vision mode 캐시 반환됨)
- **교훈**: 같은 이미지라도 detection_mode가 다르면 다른 결과
- **방지책**: `test_cache_key_includes_detection_mode`

---

### 🎯 파이프라인 설계 원칙

1. **recall > precision** — 심볼 인식률이 최우선. 오탐은 후처리로 제거 가능, 미탐은 복구 불가
2. **단일 모드 ISATagReader** — API 비용 > 정확도 트레이드오프에서 정확도 우선
3. **벤치마크는 전체 파이프라인으로** — 단위 테스트 결과와 실제 파이프라인 결과는 다를 수 있음
4. **변경 전 문서화** — 어떤 파라미터든 바꾸기 전에 T-문서(테스트 결과)에 측정값 기록
5. **detection_mode=hybrid 필수** — ISA 태그 인식은 hybrid 모드에서만 동작. 기본값은 vision

### 📐 현재 파이프라인 아키텍처

```
POST /api/v1/analyze?detection_mode=hybrid&vision_model=gemini-2.5-flash

Image
  ├── GeometricSymbolDetector (param2=0.50)
  │     ├── HoughCircles → 145 circles
  │     ├── findContours → 81 valve shapes
  │     └── valve detection → 109 shapes
  │
  ├── Gemini V3 (gemini-2.5-flash)
  │     └── 235 symbols + connections detected
  │
  ├── EasyOCR → 152 text blocks
  │
  ├── ShapeClassifier (L1) → 12 rules
  ├── SHACLValidator (L2) → 8 constraints
  │
  ├── ISATagReader (single mode, gpt-4o-mini)
  │     ├── 145 ROIs × 1 API call each = 145 calls
  │     └── 64 ISA tags recognized
  │
  ├── OntologyMapper → 100% resolved
  ├── GenericUpgrader → FP filter (-25) → 371 elements
  └── GraphBuilder → 486 connections
```

### Sprint 11 주요 과제

| 우선순위 | 문제                   | 현재 → 목표 | 원인                             |
| -------- | ---------------------- | ----------- | -------------------------------- |
| P0       | 심볼 과다 탐지         | 371 → 206   | Gemini V3 235개 탐지 (너무 많음) |
| P0       | 처리 시간              | 82s → 30s   | ISA 145 API calls × 0.47s = 68s  |
| P1       | ControlValve 오탐      | 118 → ~3    | Gemini V3 false positive         |
| P2       | PressureIndicator 과소 | 7 → 37      | ISA 인식률 PI 계열 낮음          |

---

_Created: 2026-03-09_
_Sprint 5 completed: 2026-03-10_
_Sprint 7 completed: 2026-03-11_
_Sprint 8 completed: 2026-03-11_
_Sprint 9 completed: 2026-03-11_
_Sprint 10 completed: 2026-03-12_
