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

## 다음 액션

- [ ] V3 온톨로지 해석률 개선 (86.2% → 95%+)
- [ ] SymbolLocator 매칭 정확도 개선 (partial text block 노이즈)
- [ ] S3-T01: LLM 벤치마크 (Qwen vs GPT-4V vs Claude 3모델 비교)
- [ ] Neo4j 라이브 드라이버 통합
- [ ] S4-T06: 데모 영상/GIF 제작
- [ ] GitHub Pages Web UI와 Railway API 연동 확인

---

_Created: 2026-03-09_
_Sprint 5 completed: 2026-03-10_
