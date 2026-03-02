---
summary: "WhatsApp 그룹 메시지 처리 동작 및 구성 (mentionPatterns 는 여러 표면에 공유됨)"
read_when:
  - 그룹 메시지 규칙 또는 언급 변경 중
title: "그룹 메시지"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/group-messages.md
  workflow: 15
---

# 그룹 메시지 (WhatsApp Web 채널)

목표: Clawd 가 WhatsApp 그룹에 앉아서 pinged 될 때만 깨어나고 해당 스레드를 개인 DM 세션과 별개로 유지합니다.

참고: `agents.list[].groupChat.mentionPatterns` 은 이제 Telegram/Discord/Slack/iMessage 에서도 사용됩니다. 이 문서는 WhatsApp 특정 동작에 중점을 둡니다. 다중 에이전트 설정의 경우 에이전트별로 `agents.list[].groupChat.mentionPatterns` 을 설정하거나 (또는 글로벌 폴백으로 `messages.groupChat.mentionPatterns` 사용) 합니다.

## 구현됨 (2025-12-03)

- 활성화 모드: `mention` (기본) 또는 `always`. `mention` 은 ping 을 필요로 합니다 (실제 WhatsApp @-mentions via `mentionedJids`, regex 패턴 또는 텍스트 어디든지 봇의 E.164). `always` 는 모든 메시지에서 에이전트를 깨우지만 의미 있는 값을 추가할 수 있을 때만 회신해야 합니다. 그렇지 않으면 자동 토큰 `NO_REPLY` 을 반환합니다. 기본값은 구성에서 설정할 수 있으며 (`channels.whatsapp.groups`) `/activation` 을 통해 그룹별로 재정의될 수 있습니다. `channels.whatsapp.groups` 이 설정되면 그룹 허용 목록으로도 작동합니다 (모두 허용하려면 `"*"` 포함).
- 그룹 정책: `channels.whatsapp.groupPolicy` 는 그룹 메시지를 수락하는지 여부를 제어합니다 (`open|disabled|allowlist`). `allowlist` 는 `channels.whatsapp.groupAllowFrom` 을 사용합니다 (폴백: 명시적 `channels.whatsapp.allowFrom`). 기본값은 `allowlist` (발신자를 추가할 때까지 차단됨).
- 그룹별 세션: 세션 키는 `agent:<agentId>:whatsapp:group:<jid>` 처럼 보이므로 `/verbose on` 또는 `/think high` (standalone 메시지로 전송됨) 와 같은 명령은 해당 그룹으로 범위가 지정되고 개인 DM 상태는 건드리지 않습니다. 하트비트는 그룹 스레드에 대해 건너뜁니다.
- 컨텍스트 주입: **pending 만** 그룹 메시지 (기본 50 개) - 실행을 트리거하지 **않은** 메시지 - `[Chat messages since your last reply - for context]` 아래에 접두사가 붙고 트리거 줄은 `[Current message - respond to this]` 아래에 있습니다. 세션에 이미 있는 메시지는 다시 주입되지 않습니다.
- 발신자 표시: 이제 모든 그룹 배치는 `[from: Sender Name (+E164)]` 로 끝나므로 Pi 는 누가 말하는지 알 수 있습니다.
- 일시적/view-once: 우리는 텍스트/언급을 추출하기 전에 그것들을 펴므로 그 안의 ping 은 여전히 트리거합니다.
- 그룹 시스템 프롬프트: 그룹 세션의 첫 번째 회전에서 (그리고 `/activation` 이 모드를 변경할 때마다) 우리는 짧은 blurb 을 시스템 프롬프트에 주입합니다. 예를 들어 `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` 메타데이터를 사용할 수 없으면 여전히 에이전트에게 그룹 채팅이라고 알려줍니다.

## 구성 예 (WhatsApp)

WhatsApp 이 텍스트 본문에서 시각적 `@` 을 제거할 때도 display-name ping 이 작동하도록 `~/.openclaw/openclaw.json` 에 `groupChat` 블록을 추가합니다:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

참고:

- 정규식은 대소문자를 구분하지 않습니다. 이들은 `@openclaw` 와 같은 display-name ping 과 `+`/spaces 가 있거나 없는 원본 번호를 다룹니다.
- WhatsApp 은 누군가 연락처를 탭할 때 여전히 `mentionedJids` 를 통해 정식 언급을 보내므로 숫자 폴백은 거의 필요하지 않지만 유용한 안전망입니다.

### 활성화 명령 (소유자 전용)

그룹 채팅 명령을 사용합니다:

- `/activation mention`
- `/activation always`

`channels.whatsapp.allowFrom` 의 소유자 번호 (또는 설정되지 않을 때 봇의 자체 E.164) 만 이를 변경할 수 있습니다. 그룹에서 standalone 메시지로 `/status` 를 전송하여 현재 활성화 모드를 봅니다.

## 사용 방법

1. WhatsApp 계정 (OpenClaw 를 실행하는 계정) 을 그룹에 추가합니다.
2. `@openclaw …` (또는 번호 포함). `groupPolicy: "open"` 을 설정하지 않으면 허용 목록에 있는 발신자만 트리거할 수 있습니다.
3. 에이전트 프롬프트는 최근 그룹 컨텍스트와 후행 `[from: …]` 마커를 포함하므로 올바른 사람을 처리할 수 있습니다.
4. 세션 수준 지시어 (`/verbose on`, `/think high`, `/new` 또는 `/reset`, `/compact`) 는 해당 그룹의 세션에만 적용됩니다. standalone 메시지로 전송하여 등록합니다. 개인 DM 세션은 독립적으로 유지됩니다.

## 테스트 / 검증

- 수동 smoke:
  - 그룹에서 `@openclaw` ping 을 전송하고 발신자 이름을 참조하는 회신을 확인합니다.
  - 두 번째 ping 을 전송하고 이력 블록이 포함되고 다음 회전에서 지워지는지 확인합니다.
- Gateway 로그를 확인합니다 (`--verbose` 로 실행) 하여 `from: <groupJid>` 및 `[from: …]` suffix 를 보여주는 `inbound web message` 항목을 봅니다.

## 알려진 고려사항

- 하트비트는 의도적으로 그룹에 대해 건너뛰어 시끄러운 브로드캐스트를 피합니다.
- 에코 억제는 결합된 배치 문자열을 사용합니다. 언급 없이 동일한 텍스트를 두 번 전송하면 첫 번째만 응답을 받습니다.
- 세션 저장소 항목은 세션 저장소 (`~/.openclaw/agents/<agentId>/sessions/sessions.json` 기본값) 에 `agent:<agentId>:whatsapp:group:<jid>` 로 나타납니다. 누락된 항목은 단지 그룹이 아직 실행을 트리거하지 않았다는 의미입니다.
- 그룹의 입력 표시기는 `agents.defaults.typingMode` (기본: mention 이 없을 때 `message`) 를 따릅니다.
