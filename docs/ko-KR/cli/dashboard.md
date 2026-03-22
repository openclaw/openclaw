---
summary: "`openclaw dashboard` CLI 레퍼런스 (Control UI 열기)"
read_when:
  - 현재 토큰으로 Control UI를 열고 싶을 때
  - 브라우저를 실행하지 않고 URL만 출력하고 싶을 때
title: "dashboard"
x-i18n:
  source_path: "docs/cli/dashboard.md"
---

# `openclaw dashboard`

현재 인증 정보를 사용하여 Control UI를 엽니다.

```bash
openclaw dashboard
openclaw dashboard --no-open
```

참고:

- `dashboard`는 가능한 경우 설정된 `gateway.auth.token` SecretRef를 해석합니다.
- SecretRef 로 관리되는 토큰(해석 완료 또는 미해석)의 경우, `dashboard`는 터미널 출력, 클립보드 기록, 또는 브라우저 실행 인자에서 외부 시크릿이 노출되는 것을 방지하기 위해 토큰이 포함되지 않은 URL을 출력/복사/열기합니다.
- `gateway.auth.token`이 SecretRef로 관리되지만 현재 명령 경로에서 해석할 수 없는 경우, 유효하지 않은 토큰 자리표시자를 포함하는 대신 토큰이 없는 URL과 명확한 해결 안내를 출력합니다.
