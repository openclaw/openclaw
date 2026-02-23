---
name: coding-agent
description: "⚠️ DEPRECATED — hybrid-coding 스킬로 통합됨. 이 스킬 대신 hybrid-coding을 사용하세요. Redirect: 코딩 작업 위임, PR 리뷰, 리팩토링, 멀티에이전트 → hybrid-coding 스킬."
metadata:
  openclaw:
    emoji: "🧩"
    requires:
      anyBins: ["claude"]
---

# ⚠️ DEPRECATED — hybrid-coding으로 통합

이 스킬은 **hybrid-coding** 스킬에 통합되었습니다 (2026-02-24).

모든 코딩 작업 위임은 `skills/hybrid-coding/SKILL.md`를 참조하세요.

통합된 기능:

- Claude Code / Codex / Pi 에이전트 호출
- PTY 모드, 백그라운드 실행, 프로세스 관리
- 3-Layer 멀티에이전트 아키텍처
- PR 리뷰 (worktree 패턴)
- 병렬 이슈 수정
- 검증 단계 (tsc + vitest)
- 진행 상황 보고 규칙
