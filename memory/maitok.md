---
type: project-memory
project: MAITOK
tags: [tiktok, comments, ai, marketing, tikly]
related:
  - "[[vietnam-beauty|MAIBEAUTY - 화장품 사업]]"
  - "[[business-intelligence|비즈니스 인텔리전스]]"
---

# MAITOK (Tikly)

- **시작일:** 2026-02-18
- **브랜드:** Tikly
- **로컬:** C:\TEST\MAITOK
- **GitHub:** https://github.com/jini92/MAITOK
- **Obsidian:** 01.PROJECT/12.MAITOK
- **상태:** 🟢 진행중

## 목표

TikTok 셀러를 위한 AI 댓글 분석 + 자동 대댓글 서비스

- 댓글 감성분석 (긍정/부정/질문/스팸/구매의도)
- 반자동 대댓글 (AI 초안 → 셀러 승인)
- 일일 댓글 요약 리포트
- 타겟: TikTok Shop 셀러 (한국/베트남, 뷰티 우선)

## 진행상황

- 2026-02-18: 프로젝트 초기화 (로컬/GitHub/Obsidian/메모리)
- 2026-02-18: 전체 문서 생성 완료 (3-agent 팀 x2 라운드)
  - A001-PRD, A002-market-analysis, A003-business-strategy
  - D001-architecture, D002-detailed-design
  - I001-tiktok-developer-setup (7단계 가이드)
  - I002-development-plan
  - KANBAN.md (55 tasks, 7 columns) in Obsidian
- 2026-02-18: \_DASHBOARD.md 등록, \_MASTER_DASHBOARD.md 업데이트
- 2026-02-24: **v0.1.0 구현 완료** (3-Layer 멀티에이전트 아키텍처 테스트베드)
  - TikTok Research API 클라이언트 (댓글 조회, OAuth 토큰 갱신, Rate Limit 관리)
  - Adaptive Comment Poller (영상 나이별 2분/5분/30분 자동 조절)
  - AI 파이프라인 (감성분석 + 다국어 대댓글 생성, Claude Sonnet)
  - Discord 알림 서비스 (새 댓글 Embed + 일일 요약 통계)
  - SQLite 스키마 (comments, replies, seller_config, watched_videos)
  - Fastify HTTP 서버 + Health check API
  - 테스트: 3 tests passed (vitest), tsc --noEmit 통과
  - 개발 방식: Claude Code CLI Sonnet × 2 병렬 에이전트

## 핵심 발견

- **TikTok 댓글 쓰기 API 없음** — 읽기 전용 (Content Posting API에 comment reply 미포함)
- MVP 전략 변경: 댓글 분석 + AI 초안 → Discord 알림 → 셀러 수동 붙여넣기

## 결정사항

- 브랜드명: Tikly (TikTok + Reply)
- 프로젝트명: MAITOK (MAI 시리즈 #12)
- MAIBEAUTY(베트남 화장품) 시너지 활용
- MVP: 읽기+분석+초안 생성 (쓰기 API 없으므로)

## 기술 스택

| 영역    | 선택                            |
| ------- | ------------------------------- |
| Runtime | Node.js 22+ (TypeScript, ESM)   |
| DB      | SQLite (better-sqlite3)         |
| LLM     | Claude Sonnet via Anthropic SDK |
| HTTP    | Fastify 5                       |
| Test    | Vitest 3                        |
| Notify  | Discord Webhook                 |

## 다음 액션

- TikTok Developer 계정 생성 (https://developers.tiktok.com/signup)
- Sandbox API 테스트 (댓글 읽기 기능 + rate limit 확인)
- TikTok API 업데이트 모니터링 (댓글 쓰기 엔드포인트 추가 여부)
- Phase 1 MVP 완성: 실제 TikTok API 연동 + E2E 테스트
- Phase 2: Browser Automation 자동 게시
