---
summary: "채널 계정 (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (플러그인)/Signal/iMessage) 을 추가/제거하기 위한 CLI 참조"
read_when:
  - 채널 계정을 추가/제거하려고 할 때 (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (플러그인)/Signal/iMessage)
  - 채널 상태를 확인하거나 채널 로그를 tail 하려고 할 때
title: "channels"
---

# `openclaw channels`

채팅 채널 계정 및 Gateway 의 런타임 상태를 관리합니다.

관련 문서:

- 채널 가이드: [Channels](/channels/index)
- Gateway 구성: [Configuration](/gateway/configuration)

## 일반적인 명령

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## 계정 추가 / 제거

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

팁: `openclaw channels add --help` 는 채널별 플래그 (토큰, 앱 토큰, signal-cli 경로 등) 를 표시합니다.

플래그 없이 `openclaw channels add` 를 실행하면 대화형 마법사가 프롬프트할 수 있습니다:

- 선택한 채널당 계정 ID
- 이러한 계정의 선택적 표시 이름
- `지금 구성된 채널 계정을 에이전트에 바인딩합니까?`

바인딩을 지금 확인하면 마법사는 구성된 채널 계정을 소유해야 할 에이전트를 묻고 계정 범위의 라우팅 바인딩을 씁니다.

나중에 `openclaw agents bindings`, `openclaw agents bind` 및 `openclaw agents unbind` 를 사용하여 동일한 라우팅 규칙을 관리할 수 있습니다 ([agents](/cli/agents) 참조).

여전히 단일 계정 최상위 설정을 사용하고 있는 채널에 기본이 아닌 계정을 추가할 때 (아직 `channels.<channel>.accounts` 항목 없음), OpenClaw 는 계정 범위의 단일 계정 최상위 값을 `channels.<channel>.accounts.default` 로 이동한 다음 새 계정을 씁니다. 이는 원본 계정 동작을 유지하면서 다중 계정 형태로 이동합니다.

라우팅 동작은 일관성을 유지합니다:

- 기존 채널 전용 바인딩 (no `accountId`) 은 계속 기본 계정과 일치합니다.
- `channels add` 는 비대화형 모드에서 바인딩을 자동으로 생성하거나 다시 쓰지 않습니다.
- 대화형 설정은 선택적으로 계정 범위의 바인딩을 추가할 수 있습니다.

구성이 이미 혼합 상태 (명명된 계정 있음, `default` 누락, 최상위 단일 계정 값 아직 설정) 에 있으면 `openclaw doctor --fix` 를 실행하여 계정 범위의 값을 `accounts.default` 로 이동합니다.

## 로그인 / 로그아웃 (대화형)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 문제 해결

- `openclaw status --deep` 를 실행하여 광범위한 프로브를 수행합니다.
- 안내 수정을 위해 `openclaw doctor` 를 사용합니다.
- `openclaw channels list` 는 `Claude: HTTP 403 ... user:profile` 을 인쇄합니다 → 사용 스냅샷에는 `user:profile` 범위가 필요합니다. `--no-usage` 를 사용하거나 Claude 세션 키 (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`) 를 제공하거나 Claude Code CLI 를 통해 다시 인증합니다.

## 기능 프로브

제공자 기능 힌트 (의도/범위, 가능한 경우) 및 정적 기능 지원을 가져옵니다:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

참고:

- `--channel` 은 선택적입니다. 모든 채널을 나열하려면 생략합니다 (확장 포함).
- `--target` 은 `channel:<id>` 또는 원시 숫자 채널 ID 를 허용하며 Discord 에만 적용됩니다.
- 프로브는 제공자별입니다: Discord intents + optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; MS Teams app token + Graph roles/scopes (known 으로 주석 처리). 프로브가 없는 채널은 `Probe: unavailable` 을 보고합니다.

## 이름을 ID 로 해결

제공자 디렉토리를 사용하여 채널/사용자 이름을 ID 로 해결합니다:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

참고:

- `--kind user|group|auto` 를 사용하여 대상 유형을 강제합니다.
- 해결은 동일한 이름을 공유하는 여러 항목이 있을 때 활성 일치를 선호합니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/channels.md
workflow: 15
