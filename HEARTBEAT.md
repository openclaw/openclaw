# HEARTBEAT.md - Periodic Maintenance Tasks

## Purpose

하트비트 체크 시 실행할 작업. 가이드가 아닌 **실행 항목**.

## ⚠️ 중복 방지 규칙

- **Daily/Weekly/Monthly 크론 작업은 크론 스케줄러가 정해진 시각에 1회 트리거한다.**
- **하트비트에서는 크론 작업을 직접 실행하지 않는다.** 하트비트는 "Every Heartbeat" 섹션만 수행.
- 하트비트 역할: Active Tracking (이슈 추적 등 상태 변화 감지) + 이상 징후 알림만.

---

## Every Heartbeat (매시간)

### Active Tracking

#### GitHub Issue #16688 — Discord Voice Message Bug

- **URL:** https://github.com/openclaw/openclaw/issues/16688
- **상태:** Open, @jheeanny가 fix/workaround 작업 중
- **할 일:** 새 댓글/PR 올라오면 지니님께 Discord로 알림
- **완료 조건:** 이슈 Closed 또는 fix PR 머지됨

---

## Daily (크론으로 실행)

### AI 수익화 브리핑 (매일 03:00 KST)

- 최신 AI 수익화 트렌드, 디스커버리/프로프리에터리 수익 분석, AI SaaS 시장 동향 조사
- Obsidian 노트 + Discord DM 보고

### AI 기술 브리핑 (매일 03:05 KST)

- 최신 AI 기술 뉴스, X(트위터) 토론, 주요 모델 출시/업데이트, 빅테크 동향
- Obsidian 노트 + Discord DM 보고

### MAIBOT 업데이트 체크 (매일 03:10 KST)

- upstream fetch + 주요 변경사항 요약 + pnpm audit 보안 점검
- Obsidian 노트 + Discord DM 보고

### 🔬 테크 인텔리전스 (매일 04:00 KST)

- 각 프로젝트 기술 스택 관련 최신 동향 리서치
- 적용 가능한 인사이트 → 해당 프로젝트 memory에 기록
- Obsidian 노트 + Discord DM 보고

### 💼 사업화 인텔리전스 (매일 04:30 KST)

- 각 프로젝트 사업 시장 관련 최신 동향 리서치
- 경쟁사/신규 서비스 동향 + 수익화 기회 발견
- Obsidian 노트 + Discord DM 보고

### 💊 약 리마인더 (매일 05:30 KST)

- 고혈압약 복용 알림

### 🧠 Mnemo 볼트 보강 (매일 05:00 KST)

- `cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"; python scripts/daily_enrich.py`
- 새 노트 자동: type/project/related/태그/백링크 + 그래프 재빌드 + 임베딩 갱신
- **이슈 있을 때만 알림**

### 🌅 모닝 브리핑 (매일 06:00 KST)

- 전체 프로젝트 git status 확인
- GitHub 추적 이슈 새 댓글 확인
- 오늘 요일 기준 주간 작업 실행
- 우선순위 작업 정리 → Discord DM 보고

### 🔍 오후 순찰 (매일 12:00 KST)

- GitHub 이슈 추적
- 각 프로젝트 git status
- MAIBOT 빌드 확인
- 임시 파일 정리
- **이슈 있을 때만 알림** (정상이면 조용히)

---

## Weekly (크론으로 실행)

### 📊 주간 리뷰 (매주 월요일 07:00 KST)

- MEMORY.md 전체 프로젝트 진행 점검
- 각 프로젝트 최근 커밋 (7일)
- \_MASTER_DASHBOARD.md 업데이트
- KPI 대시보드 갱신 (kpi-collector.ps1 → \_KPI_DASHBOARD.md)
- pnpm test:coverage (MAIBOT, ≥70% threshold)
- pnpm audit (보안)
- 주간 종합 리포트 → Discord DM

### Wednesday: Dependency Health

- pnpm audit → 보안 취약점 확인
- pnpm outdated → 중요 업데이트 확인

### Friday: Documentation Sync

- docs/ 변경사항 확인
- CHANGELOG.md 업데이트 필요 여부

---

## Monthly (First Monday)

- Full test suite
- .secrets.baseline 확인
- 700 LOC 초과 파일 확인
- skills/ 폴더 패턴 점검

---

## Conditional Tasks

### On Error Patterns

- **Repeated Errors** (3+ occurrences): 근본 원인 조사
- **Test Flakiness**: 안정화 또는 known flake 문서화
- **Build Time Increase** (>20%): 프로파일링

### On New Channel Integration

- docs/channels/ 업데이트
- .github/labeler.yml 업데이트
- AGENTS.md 문서화

---

## Implementation Note

**실행 우선.** 판단이 애매한 작업은 스킵해도 됨. 목표는 건강 유지, 관료주의가 아님.

**EXFOLIATE!** — 가치 없는 작업은 이 파일에서 제거하라.

---

_Last reviewed: 2026-02-20_
