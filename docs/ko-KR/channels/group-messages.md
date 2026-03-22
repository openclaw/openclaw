---
summary: "WhatsApp 그룹 메시지 처리의 동작 및 구성 (mentionPatterns 는 여러 플랫폼에서 공유)"
read_when:
  - 그룹 메시지 규칙이나 멘션을 변경하는 경우
title: "그룹 메시지"
x-i18n:
  source_path: docs/channels/group-messages.md
---

# 그룹 메시지 (WhatsApp 웹 채널)

목표: Clawd 가 WhatsApp 그룹에 참여하고, 핑될 때만 깨어나고, 해당 스레드를 개인 DM 세션과 별도로 유지합니다.

참고: `agents.list[].groupChat.mentionPatterns` 는 현재 Telegram/Discord/Slack/iMessage 에서도 사용됩니다. 이 문서는 WhatsApp 전용 동작에 초점을 맞춥니다. 다중 에이전트 설정의 경우 에이전트별로 `agents.list[].groupChat.mentionPatterns` 를 설정하세요 (또는 전역 폴백으로 `messages.groupChat.mentionPatterns` 를 사용하세요).

## 현재 구현 (2025-12-03)

- 활성화 모드: `mention` (기본값) 또는 `always`. `mention` 은 핑을 필요로 합니다 (`mentionedJids` 를 통한 실제 WhatsApp @멘션, 안전한 정규식 패턴, 또는 봇의 E.164 가 텍스트 어디에나). `always` 는 모든 메시지에서 에이전트를 깨우지만 의미 있는 가치를 추가할 수 있을 때만 응답해야 합니다. 그렇지 않으면 무음 토큰 `NO_REPLY` 를 반환합니다. 기본값은 구성 (`channels.whatsapp.groups`) 에서 설정할 수 있으며 `/activation` 을 통해 그룹별로 재정의할 수 있습니다. `channels.whatsapp.groups` 가 설정되면 그룹 허용 목록으로도 작동합니다 (모두 허용하려면 `"*"` 를 포함).
- 그룹 정책: `channels.whatsapp.groupPolicy` 는 그룹 메시지 수락 여부를 제어합니다 (`open|disabled|allowlist`). `allowlist` 는 `channels.whatsapp.groupAllowFrom` 을 사용합니다 (폴백: 명시적 `channels.whatsapp.allowFrom`). 기본값은 `allowlist` 입니다 (발신자를 추가할 때까지 차단).
- 그룹별 세션: 세션 키는 `agent:<agentId>:whatsapp:group:<jid>` 형태입니다. `/verbose on` 또는 `/think high` 같은 명령 (독립 메시지로 전송) 은 해당 그룹에만 적용됩니다. 개인 DM 상태는 영향을 받지 않습니다. 그룹 스레드에서는 하트비트가 건너뛰어집니다.
- 컨텍스트 주입: 실행을 트리거하지 않은 **대기 중인** 그룹 메시지 (기본 50 개) 는 `[Chat messages since your last reply - for context]` 하위에 접두사로 붙고, 트리거 줄은 `[Current message - respond to this]` 하위에 있습니다. 이미 세션에 있는 메시지는 다시 주입되지 않습니다.
- 발신자 표시: 모든 그룹 배치는 이제 `[from: Sender Name (+E164)]` 로 끝나 Pi 가 누가 말하고 있는지 알 수 있습니다.
- 에페메럴/한번 보기: 텍스트/멘션 추출 전에 언래핑하므로 그 안의 핑도 트리거됩니다.
- 그룹 시스템 프롬프트: 그룹 세션의 첫 턴 (그리고 `/activation` 이 모드를 변경할 때마다) 에 시스템 프롬프트에 짧은 설명을 주입합니다. 메타데이터가 없으면 그룹 채팅이라는 것만 에이전트에게 알립니다.

## 구성 예시 (WhatsApp)

WhatsApp 이 텍스트 본문에서 시각적 `@` 를 제거할 때에도 표시 이름 핑이 작동하도록 `~/.openclaw/openclaw.json` 에 `groupChat` 블록을 추가합니다:

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

- 정규식은 대소문자를 구분하지 않으며 다른 구성 정규식 표면과 동일한 안전 정규식 가드레일을 사용합니다. 유효하지 않은 패턴과 안전하지 않은 중첩 반복은 무시됩니다.
- WhatsApp 은 누군가 연락처를 탭할 때 `mentionedJids` 를 통해 정식 멘션을 여전히 보내므로 번호 폴백은 거의 필요하지 않지만 유용한 안전장치입니다.

### 활성화 명령 (소유자 전용)

그룹 채팅 명령을 사용합니다:

- `/activation mention`
- `/activation always`

소유자 번호 (`channels.whatsapp.allowFrom` 에서, 설정되지 않은 경우 봇의 자체 E.164) 만 변경할 수 있습니다. 그룹에서 독립 메시지로 `/status` 를 보내면 현재 활성화 모드를 볼 수 있습니다.

## 사용 방법

1. OpenClaw 를 실행하는 WhatsApp 계정을 그룹에 추가합니다.
2. `@openclaw …` 을 말합니다 (또는 번호를 포함). `groupPolicy: "open"` 으로 설정하지 않는 한 허용된 발신자만 트리거할 수 있습니다.
3. 에이전트 프롬프트에 최근 그룹 컨텍스트와 후행 `[from: …]` 마커가 포함되어 올바른 사람에게 응답할 수 있습니다.
4. 세션 수준 지시문 (`/verbose on`, `/think high`, `/new` 또는 `/reset`, `/compact`) 은 해당 그룹의 세션에만 적용됩니다. 독립 메시지로 보내야 등록됩니다. 개인 DM 세션은 독립적입니다.

## 테스트/검증

- 수동 스모크:
  - 그룹에서 `@openclaw` 핑을 보내고 발신자 이름을 참조하는 응답을 확인합니다.
  - 두 번째 핑을 보내고 히스토리 블록이 포함된 후 다음 턴에 지워지는지 확인합니다.
- Gateway 로그 (`--verbose` 로 실행) 에서 `from: <groupJid>` 와 `[from: …]` 접미사를 보여주는 `inbound web message` 항목을 확인합니다.

## 알려진 고려 사항

- 그룹에 대해 노이즈가 많은 브로드캐스트를 피하기 위해 하트비트는 의도적으로 건너뛰어집니다.
- 에코 억제는 결합된 배치 문자열을 사용합니다. 멘션 없이 동일한 텍스트를 두 번 보내면 첫 번째만 응답을 받습니다.
- 세션 저장소 항목은 세션 저장소 (기본적으로 `~/.openclaw/agents/<agentId>/sessions/sessions.json`) 에 `agent:<agentId>:whatsapp:group:<jid>` 로 나타납니다. 항목이 없으면 그룹이 아직 실행을 트리거하지 않았다는 뜻입니다.
- 그룹의 타이핑 인디케이터는 `agents.defaults.typingMode` 를 따릅니다 (기본값: 멘션되지 않을 때 `message`).
