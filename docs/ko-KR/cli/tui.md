---
summary: "`openclaw tui` CLI 레퍼런스 (Gateway에 연결된 터미널 UI)"
read_when:
  - Gateway용 터미널 UI를 사용하고 싶을 때 (원격 호환)
  - 스크립트에서 url/token/session을 전달하고 싶을 때
title: "tui"
x-i18n:
  source_path: "docs/cli/tui.md"
---

# `openclaw tui`

Gateway에 연결된 터미널 UI를 엽니다.

관련 문서:

- TUI 가이드: [TUI](/web/tui)

참고:

- `tui`는 가능한 경우 설정된 Gateway 인증 SecretRef를 토큰/비밀번호 인증에 사용합니다 (`env`/`file`/`exec` 프로바이더).
- 설정된 에이전트 워크스페이스 디렉터리 내부에서 실행하면, TUI는 해당 에이전트를 세션 키 기본값으로 자동 선택합니다 (`--session`이 명시적으로 `agent:<id>:...`인 경우 제외).

## 예시

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
# 에이전트 워크스페이스 내에서 실행 시, 해당 에이전트를 자동으로 추론합니다
openclaw tui --session bugfix
```
