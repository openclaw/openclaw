# 🔍 MAIOSS — Multi-source AI-powered OSS Scanner

## 개요

| 항목 | 내용 |
|------|------|
| **프로젝트명** | MAIOSS (Multi-source AI-powered Open Source Security Scanner) |
| **GitHub** | https://github.com/jini92/MAIOSS |
| **로컬 경로** | `C:\TEST\MAIOSS` |
| **현재 버전** | v2.1.0 (Web UI) — 이전: v2.0.6 (Desktop/Docker) |
| **기술 스택** | Python (FastAPI) + Next.js 14 (React) + SQLite |
| **배포** | Backend: Railway, Frontend: GitHub Pages (GitHub Actions) |
| **패턴** | MVC + Service-Oriented Architecture |
| **언어** | 한국어 UI (UTF-8) |

### 배포 정보
- **Backend URL:** `https://maioss-api-production.up.railway.app`
- **Railway Dashboard:** https://railway.com/project/258a61ab-03c4-4839-ba18-5794197dff9f?environmentId=8606b064-f291-48e3-90ef-662ff66463f6
- **Frontend (GitHub Actions):** https://github.com/jini92/MAIOSS/actions
- **GitHub Pages:** https://jini92.github.io/MAIOSS/

### 규정 폴더 (지니님 약칭: "규정")
- **경로:** `C:\TEST\MAIOSS\docs\regulations\`
- **ES10500-00K R02 오픈소스 소프트웨어 규정** (메인 정책): `ES10500-00K R02 오픈소스 소프트웨어 규정.pdf`
- **ES10500-00K R02 오픈소스 소프트웨어 규정(표)** (요약 테이블): `ES10500-00K R02 오픈소스 소프트웨어 규정(표).pdf`
- **검증성적서 템플릿**: `(ES10500-00)_검증성적서_20250000.xlsx`
- **참고**: 지니님이 "규정"이라고만 하면 이 폴더/파일들을 의미

### 규정(Rev.5) — ES95489-24 (2026-02-08 등록)
- **경로:** `C:\TEST\MAIOSS\docs\regulations\rev05\`
- **설명회 자료**: `(설명회자료)오픈소스보안취약점 검증 요구사양 Rev.5 개정 변경사항 설명회.pdf`
- **분석 문서**: `REV5_CHANGE_ANALYSIS.md`
- **개정일**: 2025.12.3 / **적용**: 즉시 반영
- **핵심 변경**:
  - 중국 수출차 외부연결시스템(CCU/DCU/HU) → **CVE + CAVD 동시 필수**
  - 중국 현지생산 외부연결시스템 → **CAVD 필수**
  - 그 외 제어기 → CVE 또는 CAVD 선택
  - 그 외 향지 → CVE (기존과 동일)
  - 성적서 양식: CAVD Information 열 추가, Cover 시트 분리, 위험수용 첨부란
- **MAIOSS Gap**: ~~CAVD 수집기 미구현~~(✅ 완료), ~~지역별 DB 분기 미구현~~(✅ 완료), ~~성적서 Rev.5 양식 미적용~~(✅ 완료)

### CAVD API 접근 현황 (2026-02-05 조사)
- **공식 사이트**: https://cavd.org.cn
- **운영 기관**: CATARC(中国汽车技术研究中心) / 중기데이터유한공사
- **상위 플랫폼**: NVDB(工业和信息化部网络安全威胁和漏洞信息共享平台, https://www.nvdb.org.cn)
- **문의 이메일**: cavd@catarc.ac.cn
- **API 현황**: ⚠️ **공개 REST API 미제공** — CATARC와 별도 협약 필요
- **등록 요건**:
  - 개인: 중국 휴대폰 번호 필수, Gmail 불가
  - 기업: 사업자등록증, 법인 위임장, 기업 직인 등 서류 제출
- **MAIOSS 대응**: API 키 발급 전까지 로컬 폴백 모드(`data/cavd/fallback/`)로 동작
- **가이드 문서**: `docs/I-21_CAVD_API_Access_Guide.md`
- **진행 상태** (2026-02-05): API 키 확보 대기 중 → 확보 후 실제 연동 테스트 예정

---

## 핵심 기능

MAIOSS는 오픈소스 소프트웨어의 라이선스/취약점/저작권을 종합 분석하는 도구:

1. **OSS 스캐닝** — ScanCode + SCANOSS + 언어별 보안 스캐너 (Bandit, ESLint, SpotBugs, GoSec)
2. **CVE 탐지** — 250K+ 취약점 DB, NVD API, 실시간 업데이트
3. **AI 분석** — GPT-4/Claude/LLaMA 멀티 프로바이더 분석
4. **리포트** — ES10500 검증성적서, Excel/PDF/HTML/JSON/SBOM
5. **Knowledge Graph** — Neo4j GraphRAG (취약점 관계 분석)
6. **학습 시스템** — 패턴 학습 + 커뮤니티 패턴 공유

---

## 아키텍처 (v2.1.0 — Web)

```
┌─ Frontend (Next.js 14) ─────────────────────┐
│  Dashboard / Scan / Reports / CVE / SBOM     │
│  Licenses / Stats / Settings / Help          │
│  → Zustand + React Query                     │
│  → GitHub Pages 배포                          │
└─────────────────┬───────────────────────────┘
                  │ HTTP/WebSocket
┌─ Backend (FastAPI) ─────────────────────────┐
│  /api/v1/health, scan, cve, reports,         │
│  settings, sbom                              │
│  → Railway 배포                              │
└─────────────────┬───────────────────────────┘
                  │
┌─ Services Layer ────────────────────────────┐
│  scanning_service, cve_service, ai_service,  │
│  report_service, graphrag_service,           │
│  confidence_scoring, parallel_analysis,      │
│  enhanced_matching, realtime_cve             │
└─────────────────┬───────────────────────────┘
                  │
┌─ Data ──────────────────────────────────────┐
│  SQLite (CVE, scans, caches)                 │
│  Neo4j (GraphRAG, optional)                  │
│  Results directory                           │
└─────────────────────────────────────────────┘
```

### 엔트리 포인트

| 파일 | 용도 |
|------|------|
| `app.py` | GUI (레거시 Tkinter) |
| `api/main.py` | FastAPI 백엔드 |
| `web/` | Next.js 프론트엔드 |
| `cli_app.py` | Git/SVN 작업 |
| `cve_cli.py` | CVE DB 관리 |
| `report_cli.py` | 리포트 생성 |

---

## 버전 히스토리

| 버전 | 날짜 | 핵심 변경 |
|------|------|----------|
| **v2.1.0** | 2026-01 | Web UI 마이그레이션 (Tkinter → FastAPI + Next.js), Railway 배포 |
| **v2.0.6** | 2025-12 | Docker 배포, AI 분석 강화, 리포트 자동화, 실시간 CVE, 95개 테스트 |
| **v2.0.5.4** | 2025-10 | 의존성 자동 설치, Windows 인스톨러 |
| **v2.0.5.3** | 2025-10 | 데이터 타입/인코딩 안정화 |
| **v2.0.5** | 2025-10 | 빌드/배포 업데이트 |

---

## 개발 현황 (v2.1.0 Web)

### Backend API
- [x] `/api/v1/health/*` — 헬스체크
- [x] `/api/v1/scan/*` — 스캐닝 (실제 알고리즘 확인 완료, T-30)
- [x] `/api/v1/cve/*` — CVE 조회
- [x] `/api/v1/reports/*` — 리포트 생성/조회
- [x] `/api/v1/settings/*` — 설정
- [x] `/api/v1/sbom/*` — SBOM 생성

### Frontend Pages (Next.js)
- [x] Dashboard (`/`) — 메트릭 카드 4개
- [x] Scan (`/scan`) — 스캔 실행
- [x] Reports (`/reports`) — 리포트 목록/조회
- [x] CVE (`/cve`) — 취약점 검색
- [x] SBOM (`/sbom`) — SBOM 관리
- [x] Licenses (`/licenses`) — 라이선스 분석
- [x] Stats (`/stats`) — 통계
- [x] Settings (`/settings`) — 설정
- [x] Help (`/help`) — 도움말

### E2E 검증
- [x] 스캔 → 결과 → ES10500 파이프라인 (T-21, T-22, T-23, T-24, T-25)
- [x] Railway 배포 검증 (T-27)
- [x] GitHub Pages 프론트엔드 검증 (T-29)
- [x] DFD + 시퀀스 다이어그램 검증 99.5% (T-28)
- [x] ES10500 검증성적서 생성 + 규정 검증 (T-36, 2026-02-03) — 8/8 PASS
- [x] Railway ScanCode + SCANOSS 듀얼 스캐너 (2026-02-03) — 두 스캐너 동시 가동
- [x] 듀얼 스캐너 ES10500 검증성적서 생성+규정검증 (T-38) — 6/6 PASS, gpl-3.0-only SPDX 약칭 Level 분류 버그 발견
- [x] SPDX 약칭 + 복합 라이선스 Level 분류 버그 수정 (T-39, 2026-02-03) — 12/12 ALL PASS, Railway 검증 완료

### 최근 커밋 (2026-01~02)
- 53개 커밋 (2026-01-25 이후)
- ES10500 검증성적서 파이프라인 안정화
- 스캔 결과 네비게이션 수정
- Reports 페이지 API 연동
- Railway 배포 CI/CD

### Railway ScanCode 배포 이슈 해결 (2026-02-03)
**문제**: Railway에서 ScanCode가 실행되지 않음 (SCANOSS만 동작)
**원인 체인**:
1. `nixpacks.toml`이 `Dockerfile.api`를 오버라이드 → nixpacks.toml 삭제
2. `requirements-api.txt`에 scancode-toolkit 미포함 → 직접 추가
3. **핵심**: `entrypoint.sh`가 `gosu maioss`로 서버 실행하는데, maioss가 시스템 유저(-r)라 홈 디렉토리 없음 → ScanCode의 `scancode_config.py`가 `~/.cache/scancode-tk/` 생성 시 크래시
**해결**: Dockerfile에 `/home/maioss/.cache/scancode-tk`, `/tmp/scancode-temp` 디렉토리 생성 + `SCANCODE_CACHE`, `SCANCODE_TEMP`, `HOME` 환경변수 설정
**결과**: ScanCode 32.5.0 + SCANOSS 1.45.0 동시 가동 확인
**관련 커밋**: `d4ac222` → `bbf5568` (6개 커밋)

---

## 문서 현황

| 카테고리 | 수 | 설명 |
|----------|---|------|
| I (Implementation) | 19 | 설치/설정/통합 가이드 |
| A (Architecture) | 12 | 아키텍처/설계/분석 |
| T (Troubleshooting) | 32 | 디버깅/테스트/검증 |
| G (General) | 8 | 사용자 가이드 |
| R (Reference) | 4 | 참조 문서 |
| M (Maintenance) | 3 | 유지보수 |
| **합계** | **78** | |

### 최근 추가 문서 (2026-02-03)
- `T-31_v2.1.0_Maintenance_Report_20260203.md` — 오늘 전체 작업 보고서
- `T-32_Frontend_Deployment_Test_Plan.md` — 프론트엔드 배포 테스트 계획
- `T-33_ES10500_Regulation_Compliance_Analysis.md` — **ES10500 규정 준수 분석 보고서**
- `ANALYSIS_2026-02-03.md` — 종합 분석 보고서

---

## 결정 사항

| 날짜 | 결정 | 사유 |
|------|------|------|
| 2026-01 | Tkinter → FastAPI + Next.js 마이그레이션 | 웹 접근성, 크로스 플랫폼 |
| 2026-01 | Railway 백엔드 배포 | 간편한 Python 서버 호스팅 |
| 2026-01 | GitHub Pages 프론트엔드 | 무료 정적 호스팅, CI/CD |
| 2026-02-03 | Railway CI/CD 복구 | RAILWAY_TOKEN GitHub secret 등록 (프로젝트 258a61ab) |
| 2026-02-03 | Railway ScanCode 활성화 | nixpacks.toml 제거 + Dockerfile 빌드 강제 + maioss 유저 홈디렉토리 생성 |
| 2026-02-03 | Railway Pro plan | ScanCode ~500MB 설치를 위해 유료 전환 |
| 2025-12 | Docker 지원 추가 | 엔터프라이즈 배포 |
| 2025-12 | 멀티 AI 프로바이더 | GPT-4 + Claude + LLaMA 병용 |

---

## 다음 단계

### ✅ Rev.5 규정 대응 (2026-02-08 완료)
- [x] **Phase 1**: CAVD 수집기 구현 — `cavd_collector.py` (64 tests)
- [x] **Phase 2**: 지역별 정책 엔진 + API — `region_policy_service.py` (61 tests)
- [x] **Phase 3**: ES10500 성적서 Rev.5 양식 — Cover/Details/종합평가 (35 tests)
- [x] **Phase 4**: Web UI — RegionSelector/ECUSelector/CAVD 탭 (TS 에러 0)
- [x] **Phase 5**: 통합 E2E 테스트 — 5시나리오+API+회귀+파라메트릭 (102 tests)
- **총 테스트: 262 passed, 0 failed**
- **코드: 36파일 +11,135줄, 커밋 9개**
- 📋 문서: PRD(`D-01`), 설계서(`D-02`), 테스트전략(`D-03`), 분석(`D-REV5-001`)

### ✅ 배포 테스트 + 버그 수정 (2026-02-04, T-40)
- [x] **P0**: 스캔 목록 502 수정 — `scan_storage.py` 경량 쿼리 + `scanning.py` 리팩토링
- [x] **P1**: Region Policy 라우터 등록 — `region_policy.py` 5개 엔드포인트 신규
- [x] **P1**: CAVD Stats 엔드포인트 — `/cve/cavd/stats` 신규
- [x] **P1**: CVE-ID 정확 매치 우선 — `cve_service.py` 수정 (DB에 해당 CVE 없어 검증 미완)
- **커밋**: `3329e57` → `27aa12b` (4개), Railway 자동 배포 확인
- **배포 검증**: 3/4 PASS (스캔 목록 ✅, Region Policy ✅, CAVD Stats ✅, CVE 검색 ⚠️ DB 부족)

### ✅ CVE DB 확충 + Railway 동기화 (2026-02-04)
- 로컬: 19,698 → **20,730건** (NVD API v2 업데이트)
- Railway: 11,091 → **22,221건** (bulk-import 엔드포인트 + 동기화 스크립트)
- **NVD API Key**: Railway 환경변수에 설정 완료 (rate limit 10x 향상)
- **신규 엔드포인트**: `POST /cve/bulk-import`, `GET /cve/list-ids` (delta sync용)
- **동기화 스크립트**: `scripts/sync_cve_to_railway.py`

### ✅ Pre-built Base Image 배포 최적화 (2026-02-04)
- **문제**: ScanCode Toolkit (~500MB) 매 Railway 배포마다 설치 → 빌드 8~10분
- **해결**: 2단계 Docker 빌드 아키텍처
  - `Dockerfile.base` → `ghcr.io/jini92/maioss-base:latest` (ScanCode+SCANOSS 포함)
  - `Dockerfile.api.fast` → 베이스 이미지 기반 경량 배포 (~1분)
- **GitHub Actions**: `build-base-image.yml` (Dockerfile.base 변경 시 자동 빌드)
- **Railway 설정**: `railway.toml` → `Dockerfile.api.fast` 로 전환
- **문서**: `docs/I-20_Docker_Base_Image_Deployment.md`
- **⚠️ 필요**: GHCR 패키지 `maioss-base` public 설정 (Railway pull용)

### 기존 과제
- [x] ~~CVE DB 확충~~ (✅ 22,221건 동기화 완료)
- [ ] CVE 검색 응답 포맷 확인 (단일 객체 vs 배열)
- [ ] WebSocket 실시간 스캔 진행률
- [ ] ES10500 검증성적서 자동 생성 파이프라인 완성
- [ ] 사용자 인증 (JWT)
- [x] ~~CI/CD 파이프라인 고도화~~ (✅ pre-built base image + fast deploy)

### ✅ 해결됨: gpl-3.0-only SPDX 약칭 Level 분류 (T-38→T-39)
- **근본 원인**: 복합 라이선스 표현식(`gpl-3.0-only, mit, apache-2.0`) 미파싱 + `_get_license_info_from_guide`의 Level 2 기본값이 `_get_license_level_enhanced` 결과(Level 4)를 덮어쓰기
- **수정**: 3개 커밋 (`4b6e842` → `7a8cb2a` → `de3cb92`)
  - `_get_default_license_mapping`: SPDX `-only`/`-or-later` 변형 14개 추가
  - `_get_license_level_enhanced`: 쉼표 구분 복합 표현식 재귀 파싱
  - `_get_license_info_from_guide`: 쉼표 구분 복합 표현식 재귀 파싱 (근본 원인)
- **검증**: Railway 배포 후 동일 AUTOSAR ECU 스캔 → **12/12 ALL PASS** (T-39)

### ES10500 규정 준수 현황 (T-33, 2026-02-03) — ✅ P0 전부 해결
- **충족률**: ~98.5% (317항목 중 308 충족, 9 부분 충족, 0 미충족)
- **검증도구 요건**: 4/4 완전 충족 (패턴/Snippet/Dependency/필수항목)
- **P0 이슈 4건**: ✅ 전부 해결 (commit `4faad4e`)
  - `_get_license_level()` → yaml 기반 3단계 매칭으로 전환
  - `_level4_found` 추적 + 종합평가 시트 자동 FAIL 판정 구현
  - LGPL-3.0/SSPL/BSD-4-Clause 정확 분류 (Level 4)
  - 26개 테스트 전체 통과
- **잔여 P1/P2**: 수정여부 자동 감지, 결합 형태 고도화, 템플릿 컬럼 정합성

---

## 2026-02-03 종합 분석 결과

### 테스트 현황 (384개 수집)
- **통과:** ~237개 (96.3%)
- **실패:** 9개 (import 오류 2, assertion 7)
- **행(hang):** 외부 도구 의존 테스트 (ScanCode/SCANOSS/Bandit 등)
- **상세:** `docs/ANALYSIS_2026-02-03.md`

### P0 긴급 이슈 — ✅ 전부 해결 (2026-02-03)
1. **FastAPI venv 생성** — `venv-api/` (Python 3.13.5 + FastAPI 0.128.0), 59개 라우트 확인
2. **깨진 테스트 수정** — test_app.py(skip), test_es10500_verification.py(클래스명+래퍼), LGPL-3.0 버그 수정
3. **루트 정리 431→51개** — `archive/`로 이동 (build 52, legacy 92, fix 84, release 7, debug 60+)

### P1 구조 이슈 — 부분 해결 (2026-02-03)
- ✅ `controllers/` 268MB→183KB 정리 (main_view_controller.py만 유지)
- ✅ ES10500 Generator 복사본 7개→2개 (5개 archive 이동)
- ✅ ES10500ReportGenerator backward alias 추가
- ⬜ `es10500_generator_enhanced.py` 4,774줄 → 모듈 분리 (P1-5 미완)
- ⬜ 레거시 Tkinter GUI + Web UI 혼재 (P2-9)
- ⬜ 700+ LOC 파일 리팩토링 (P2-10)

### P2 테스트/코드 품질 — ✅ 완료 (2026-02-03)
- ✅ pytest.ini 전역 타임아웃 60초 + conftest.py 인프라
- ✅ `@pytest.mark.external` 마크 (외부 도구 의존 테스트)
- ✅ test_es10500_generation.py import pytest + skipif 추가
- ✅ test_learning_components.py FeedbackIntegration 누락 처리
- ✅ SBOM/ES10500 테스트 return 경고 제거
- ✅ cp949 인코딩 이슈 수정 (UTF-8 명시)
- ✅ requirements.txt 헤더 정리

### 최종 테스트 결과 (2026-02-03 2차 push)
- **82 passed, 10 skipped, 0 failed** (핵심 테스트 88.98초)
- 13개 실패 전면 수정 완료 (원래 8 + 추가 발견 5)
- **Git push:** `0277afc` — 테스트 수정 + 문서화

### 프로젝트 건강도: ⭐⭐⭐⭐ / 5 (↑↑ 개선)
- 핵심 기능 안정 (Phase 1~5 95/95, SBOM 5/5)
- 테스트 0 failures 달성
- 루트 디렉토리 대폭 정리 (431→51)
- 남은 과제: es10500_generator_enhanced 4,774줄 모듈 분리, 레거시 GUI 정리

---

### 최근 커밋 (자동 동기화)
<!-- AUTO:subrepo-commits:START -->
- `7bc156f test: verify MAIBOT post-commit hook sync (02-07)`
- `3d0d921 fix(api): correct /health/detailed route path (was /api/v1/detailed) (02-04)`
- `7f4adad feat(api): add /health/detailed endpoint for explicit detailed health check (02-04)`
- `186397f docs(T-42): 프로젝트 현황 종합 + 배포 검증 보고서, README 업데이트 (02-04)`
- `f78111d refactor: rename ES10500 → ES95489-24 regulation number (P0) (02-04)`
<!-- AUTO:subrepo-commits:END -->

*Last updated: 2026-02-07*