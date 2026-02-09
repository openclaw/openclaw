---
summary: "WhatsApp 그룹 메시지 처리에 대한 동작과 구성 (mentionPatterns 는 모든 표면에서 공유됨)"
read_when:
  - 그룹 메시지 규칙 또는 멘션 변경 시
title: "그룹 메시지"
---

# 그룹 메시지 (WhatsApp 웹 채널)

목표: Clawd 가 WhatsApp 그룹에 참여하되, 핑을 받았을 때만 깨어나고 해당 스레드를 개인 다이렉트 메시지 세션과 분리하여 유지합니다.

참고: `agents.list[].groupChat.mentionPatterns` 은 이제 Telegram/Discord/Slack/iMessage 에서도 사용됩니다. 이 문서는 WhatsApp 전용 동작에 초점을 둡니다. 다중 에이전트 설정의 경우, 에이전트별로 `agents.list[].groupChat.mentionPatterns` 를 설정하거나 전역 폴백으로 `messages.groupChat.mentionPatterns` 을 사용하십시오.

## 구현된 사항 (2025-12-03)

- 활성화 모드: `mention` (기본값) 또는 `always`. `mention` 는 핑이 필요합니다 (실제 WhatsApp @-멘션을 `mentionedJids` 로 처리하거나, 정규식 패턴, 또는 텍스트 어디에든 봇의 E.164 번호가 포함된 경우). `always` 는 모든 메시지에서 에이전트를 깨우지만, 의미 있는 가치를 추가할 수 있을 때만 응답해야 하며 그렇지 않으면 무응답 토큰 `NO_REPLY` 를 반환합니다. 기본값은 구성(`channels.whatsapp.groups`)에서 설정할 수 있고, 그룹별로 `/activation` 을 통해 재정의할 수 있습니다. `channels.whatsapp.groups` 가 설정되면 그룹 허용 목록으로도 동작합니다 (`"*"` 을 포함하면 모두 허용).
- 그룹 정책: `channels.whatsapp.groupPolicy` 는 그룹 메시지 수신 여부를 제어합니다 (`open|disabled|allowlist`). `allowlist` 은 `channels.whatsapp.groupAllowFrom` 을 사용합니다 (폴백: 명시적 `channels.whatsapp.allowFrom`). 기본값은 `allowlist` 입니다 (발신자를 추가할 때까지 차단).
- 그룹별 세션: 세션 키는 `agent:<agentId>:whatsapp:group:<jid>` 와 같은 형태이므로, `/verbose on` 또는 `/think high` 와 같은 명령(단독 메시지로 전송)은 해당 그룹으로 범위가 지정됩니다. 개인 다이렉트 메시지 상태는 영향을 받지 않습니다. 그룹 스레드에서는 하트비트가 생략됩니다.
- 컨텍스트 주입: 실행을 트리거하지 않은 **대기 중만** 의 그룹 메시지(기본 50개)가 `[Chat messages since your last reply - for context]` 아래에 접두되어 포함되며, 트리거한 라인은 `[Current message - respond to this]` 아래에 포함됩니다. 이미 세션에 있는 메시지는 다시 주입되지 않습니다.
- 발신자 표기: 이제 모든 그룹 배치의 끝에는 `[from: Sender Name (+E164)]` 가 추가되어 Pi 가 누가 말하는지 알 수 있습니다.
- 일회성/보기 전용: 텍스트/멘션을 추출하기 전에 이를 해제하므로, 내부의 핑도 정상적으로 트리거됩니다.
- 그룹 시스템 프롬프트: 그룹 세션의 첫 턴(그리고 `/activation` 가 모드를 변경할 때마다)에 시스템 프롬프트에 `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` 와 같은 짧은 안내 문구를 주입합니다. 메타데이터를 사용할 수 없더라도 에이전트에게 그룹 채팅임을 알립니다.

## 구성 예시 (WhatsApp)

WhatsApp 이 텍스트 본문에서 시각적 `@` 를 제거하더라도 표시 이름 핑이 동작하도록, `~/.openclaw/openclaw.json` 에 `groupChat` 블록을 추가하십시오:

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

참고 사항:

- 정규식은 대소문자를 구분하지 않습니다. `@openclaw` 과 같은 표시 이름 핑과, `+`/공백의 포함 여부와 무관한 원시 번호를 모두 포괄합니다.
- WhatsApp 은 사용자가 연락처를 탭할 때 여전히 `mentionedJids` 를 통해 표준 멘션을 전송하므로 번호 폴백은 거의 필요 없지만, 유용한 안전장치입니다.

### 활성화 명령 (소유자 전용)

그룹 채팅 명령을 사용하십시오:

- `/activation mention`
- `/activation always`

변경은 소유자 번호(`channels.whatsapp.allowFrom` 에서 가져오며, 미설정 시 봇의 E.164)만 가능합니다. 현재 활성화 모드를 보려면 그룹에서 `/status` 을 단독 메시지로 전송하십시오.

## 사용 방법

1. WhatsApp 계정(OpenClaw 를 실행 중인 계정)을 그룹에 추가합니다.
2. `@openclaw …` 이라고 말하거나(또는 번호를 포함) 합니다. `groupPolicy: "open"` 를 설정하지 않는 한 허용 목록에 있는 발신자만 트리거할 수 있습니다.
3. 에이전트 프롬프트에는 최근 그룹 컨텍스트와 함께 올바른 상대에게 응답할 수 있도록 후미의 `[from: …]` 마커가 포함됩니다.
4. 세션 수준 지시자(`/verbose on`, `/think high`, `/new` 또는 `/reset`, `/compact`)는 해당 그룹의 세션에만 적용됩니다. 인식되도록 단독 메시지로 전송하십시오. 개인 다이렉트 메시지 세션은 독립적으로 유지됩니다.

## 테스트 / 검증

- Manual smoke:
  - 그룹에서 `@openclaw` 핑을 보내고 발신자 이름을 참조하는 응답이 오는지 확인합니다.
  - 두 번째 핑을 보내고, 히스토리 블록이 포함된 후 다음 턴에서 초기화되는지 확인합니다.
- Gateway 로그를 확인합니다(`--verbose` 로 실행). `from: <groupJid>` 와 `[from: …]` 접미사를 보여주는 `inbound web message` 항목을 확인하십시오.

## 알려진 고려 사항

- 소음이 많은 브로드캐스트를 피하기 위해 그룹에서는 하트비트를 의도적으로 생략합니다.
- 에코 억제는 결합된 배치 문자열을 사용합니다. 멘션 없이 동일한 텍스트를 두 번 보내면 첫 번째만 응답을 받습니다.
- 세션 저장소 항목은 세션 저장소에 `agent:<agentId>:whatsapp:group:<jid>` 형태로 나타납니다(기본값: `~/.openclaw/agents/<agentId>/sessions/sessions.json`). 항목이 없다는 것은 해당 그룹이 아직 실행을 트리거하지 않았음을 의미합니다.
- 그룹의 타이핑 표시기는 `agents.defaults.typingMode` 를 따릅니다(기본값: 멘션되지 않았을 때 `message`).
