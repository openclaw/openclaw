# HEARTBEAT.md - Periodic Maintenance Tasks

## Purpose

하트비트 체크 시 실행할 작업. 가이드가 아닌 **실행 항목**.

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

### 🌅 모닝 브리핑 (매일 08:00 KST)

- 전체 프로젝트 git status 확인
- GitHub 추적 이슈 새 댓글 확인
- 오늘 요일 기준 주간 작업 실행
- 우선순위 작업 정리 → Discord DM 보고

### 🔍 오후 순찰 (매일 14:00 KST)

- GitHub 이슈 추적
- 각 프로젝트 git status
- MAIBOT 빌드 확인
- 임시 파일 정리
- **이슈 있을 때만 알림** (정상이면 조용히)

---

## Weekly (크론으로 실행)

### 📊 주간 리뷰 (매주 월요일 09:00 KST)

- MEMORY.md 전체 프로젝트 진행 점검
- 각 프로젝트 최근 커밋 (7일)
- \_MASTER_DASHBOARD.md 업데이트
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
