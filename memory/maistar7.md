---
type: project-memory
project: MAISTAR7
tags: [vietnam, hr, matching, korean-business]
related:
  - "[[vietnam-beauty|MAIBEAUTY - 화장품 사업]]"
  - "[[maicon|MAICON - 로컬 서비스]]"
---

# MAISTAR7 — 프로젝트 메모리

## 기본 정보

| 항목       | 내용                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| 프로젝트명 | MAISTAR7                                                                                                                    |
| 설명       | 베트남 한국기업 ↔ 베트남 인력 AI 매칭 (OpenClaw 매니저)                                                                     |
| 로컬 경로  | `C:\TEST\MAISTAR7`                                                                                                          |
| 문서 경로  | `C:\TEST\MAISTAR7\docs\`                                                                                                    |
| Obsidian   | `C:\Users\jini9\OneDrive\Documents\JINI_SYNC\01.PROJECT\08.MAISTAR7\` (Junction → `C:\TEST\MAISTAR7`, OneDrive 동기화 제외) |
| GitHub     | TBD                                                                                                                         |
| 시작일     | 2026-02-11                                                                                                                  |
| 상태       | 🟢 기획 완료, MVP 개발 대기                                                                                                 |

## 핵심 방향: 마이봇(개발) vs MAISTAR7 매니저(운영) 완전 분리

> **2026-02-11 확정 → 2026-02-11 업데이트: MVP부터 별도 OpenClaw 인스턴스로 독립 운영**

```
마이봇 (OpenClaw #1)              MAISTAR7 매니저 (OpenClaw #2)
├── 지니님 개인 비서                ├── 기업 ↔ 카카오톡 (한국어)
├── MAIBEAUTY 개발                 ├── 인력 ↔ Zalo (베트남어)
├── MAISTAR7 개발                  ├── 자동 매칭/알림
└── Discord 소통                   └── 24시간 채용 자동화 (Railway/VPS)
```

### 구현 방식

- **마이봇** = 개발/기획 담당 (코드 작성, 테스트, 배포)
- **MAISTAR7 매니저** = 별도 OpenClaw 인스턴스, 독립 운영, 플랫폼의 실제 AI 매니저
  - 자체 채널 연결 (Zalo, 카카오톡)
  - 자체 메모리 (기업/인력 데이터)
  - 자체 크론 잡 (매칭, 리포트)
  - 서버: Railway 또는 VPS ($10~50/월)
  - 마이봇과 완전 분리 — 개발 시에만 마이봇이 코드 작성, 운영은 독립

> ⚠️ **이전 방식 폐기**: "Phase 1에서 MAIBOT에 스킬 추가 → Phase 2에서 분리" 방식 폐기.  
> MVP부터 독립 인스턴스로 시작한다.

### OpenClaw 인프라 활용

| 기능         | OpenClaw 기존 인프라                  | 추가 비용 |
| ------------ | ------------------------------------- | --------- |
| 멀티채널     | Zalo, 카카오톡, 텔레그램, Discord     | $0        |
| 크론 잡      | 매일 매칭, 주간 리포트, 리드 재활성화 | $0        |
| 도구 호출    | DB/API/웹 조회, 매칭                  | $0        |
| 메모리       | 기업/인력 프로필, 대화 히스토리       | $0        |
| 서브에이전트 | 대량 매칭, 이력서 분석 병렬           | $0        |
| TTS/STT      | 면접 보조                             | $0        |

## 타겟

- **기업**: 베트남 하노이/호치민 진출 한국 중소기업 (~9,000개)
- **인력**: 한국어 가능 베트남 인력 (사무직, 생산직, 프리랜서, 파트타임, 통번역 전부)
- **초기 집중**: 호치민 중소기업 50개 + 인력 500명

## AI 차별화

- 이력서 한↔베 자동 번역 (킬러 피처)
- AI 적합도 스코어링 (벡터 매칭)
- 24시간 AI 매니저 (메신저 기반, 앱 불필요)
- 한국어 능력 AI 평가
- 면접 보조 (실시간 통역)

## 수익 모델

- Phase 1: 채용 수수료 (성공 기반) + 무료 AI 매니저 체험
- Phase 2: AI 매니저 구독 ($79~499/월) + 프리미엄 AI 매칭
- Phase 3: 대시보드 SaaS + 인력 파견

## 기술 스택

- **코어**: 독립 OpenClaw 인스턴스 (MAISTAR7 매니저) + maistar7-recruiter 스킬
- **배포**: Railway (OpenClaw Gateway + FastAPI + PostgreSQL)
- **백엔드**: FastAPI (Python) + PostgreSQL + pgvector
- **파일**: Cloudflare R2 (MAIBEAUTY 재활용)
- **AI**: Claude API (OpenClaw 기본 모델)
- **Admin**: Next.js or FastAPI + Jinja2 (Phase 2)

## 진행 기록

| 날짜       | 내용                                                               |
| ---------- | ------------------------------------------------------------------ |
| 2026-02-11 | 프로젝트 시작, 초기 문서 4종 작성 (A001, A002, D001, D002, STATUS) |
| 2026-02-11 | **OpenClaw 매니저 방식 채택** — 전체 문서 v2 업데이트              |

## 결정사항

- 2026-02-11: 초기 타겟은 호치민 중소 한국기업, MVP 수익 모델은 채용 수수료
- 2026-02-11: AI 에이전트 자동화 방향 확정 (초기: LangChain/n8n 스타일)
- **2026-02-11: OpenClaw 매니저 방식 채택 (방향 전환)**
  - 별도 AI 에이전트 구축 ❌ → OpenClaw = 코어 매니저 ✅
  - 별도 앱/웹 ❌ → 메신저만 (카카오톡 + Zalo) ✅
  - n8n 워크플로우 ❌ → OpenClaw 크론 잡 ✅
- **2026-02-11: MVP부터 별도 OpenClaw 인스턴스로 독립 운영 결정**
  - "MAIBOT에 스킬 추가" 방식 폐기 → MVP부터 독립 인스턴스
  - MAISTAR7 매니저 = OpenClaw #2 (Railway/VPS, $10~50/월)
  - 마이봇 = 개발만 담당, 운영은 완전 분리
  - 자체 채널(Zalo, 카카오톡), 자체 메모리, 자체 크론 잡

---

_Last updated: 2026-02-11_
