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
- 2026-06-18: 전체 문서 생성 완료 (3-agent 팀 x2 라운드)
  - A001-PRD, A002-market-analysis, A003-business-strategy
  - D001-architecture, D002-detailed-design
  - I001-tiktok-developer-setup (7단계 가이드)
  - I002-development-plan
  - KANBAN.md (55 tasks, 7 columns) in Obsidian
- 2026-06-18: \_DASHBOARD.md 등록, \_MASTER_DASHBOARD.md 업데이트

## 핵심 발견

- **TikTok 댓글 쓰기 API 없음** — 읽기 전용 (Content Posting API에 comment reply 미포함)
- MVP 전략 변경: 댓글 분석 + AI 초안 → Discord 알림 → 셀러 수동 붙여넣기

## 결정사항

- 브랜드명: Tikly (TikTok + Reply)
- 프로젝트명: MAITOK (MAI 시리즈 #12)
- MAIBEAUTY(베트남 화장품) 시너지 활용
- MVP: 읽기+분석+초안 생성 (쓰기 API 없으므로)

## 다음 액션

- TikTok Developer 계정 생성 (https://developers.tiktok.com/signup)
- Sandbox API 테스트 (댓글 읽기 기능 + rate limit 확인)
- TikTok API 업데이트 모니터링 (댓글 쓰기 엔드포인트 추가 여부)
- 지니님 추가 분석 후 개발 착수 ("더 분석 후 진행")
