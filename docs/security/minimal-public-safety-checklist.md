# Minimal safety checklist (public-facing)

This page summarizes a **minimal, opinion-free baseline** that can be shared publicly.
It is intentionally generic so it can be adapted by other users without exposing internal deployment details.

## Goal

Keep tool-enabled assistants from taking unsafe actions when handling untrusted content.

## Minimal hardening rules

1. **Trust boundary first, never by model text alone**
   - Treat web/API/fetched/forwarded content as potentially untrusted.
   - Do not execute shell, filesystem, or service-control commands directly from fetched text.

2. **Require explicit operator approval for destructive actions**
   - Destructive command categories (delete/write/system-restart/control-plane actions) should require a separate approval path.
   - Default: block by default, allow only with a documented approval reason.

3. **Keep secrets out of user-visible channels**
   - Do not paste tokens/API keys into logs or external posts.
   - Apply redaction before publishing to issues/notes/chats.

4. **Keep access scoped and isolated**
   - Use pairing/allowlists for inbound messages.
   - Use tighter session scope when many users are possible.
   - Limit high-risk tools to dedicated operator agents.

5. **Reduce blast radius for untrusted workflows**
   - Prefer read-only summary workflows before write/execution workflows.
   - If external content must be ingested, run through a non-privileged path first.

6. **Prefer explicit “not trusted” handling for external input**
   - Mark web/imported content as untrusted and skip instruction execution in that path.
   - Use allow/deny lists for filesystem/network surfaces.

## Lightweight operational pattern

A safe rollout usually has three layers:

- **Ingress gate:** who can invoke, where, and at what permission level.
- **Execution gate:** dangerous operations are blocked until approved.
- **Publish gate:** sensitive output is sanitized before external posting.

## What to publish in open repos

For public templates/docs, include:

- policy principles (above)
- non-sensitive command categories
- example of approval workflow

Avoid publishing environment- or tenant-specific values, internal token names, or exact bypass traces.

## 운영 체크리스트 (공개 템플릿용)

- **오너 승인 필요 케이스(예외)**
  - 공개 게시 전 토큰/비밀값 마스킹 검증
  - 외부 입력에서 명령형 문자열이 보이는 경우 승인 경로로 격리
  - `SAFE_EXEC_ALLOW_DANGEROUS=1` 실행은 승인 사유(`SAFE_EXEC_APPROVAL_NOTE`) 필수

- **월간 점검 항목**
  - 명령/문자열 차단 규칙 오탐·미탐 사례 1건 이상 점검
  - 토큰 패턴 업데이트(신규 형식 추가 필요 여부)
  - `public_publish_guard` 마스킹 로그(`replaced` 카운트) 확인
