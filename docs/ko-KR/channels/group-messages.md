---
summary: "WhatsApp 그룹 메시지 처리 동작 및 설정 (mentionPatterns는 여러 채널에서 공유됨)"
read_when:
  - 그룹 메시지 규칙 또는 멘션 변경
title: "Group Messages"
---

# 그룹 메시지 (WhatsApp 웹 채널)

목표: Clawd를 WhatsApp 그룹에 참여시키고, 핑이 올 때만 깨어나게 하며, 해당 스레드를 개인 다이렉트 메시지 세션과 분리하는 것입니다.

참고: `agents.list[].groupChat.mentionPatterns`는 이제 Telegram/Discord/Slack/iMessage에서도 사용됩니다. 이 문서는 WhatsApp 전용 동작에 초점을 맞춥니다. 멀티 에이전트 설정의 경우 에이전트별로 `agents.list[].groupChat.mentionPatterns`를 설정하거나, 전역 폴백으로 `messages.groupChat.mentionPatterns`를 사용하세요.

## 구현된 기능 (2025-12-03)

- 활성화 모드: `mention` (기본값) 또는 `always`. `mention`은 핑이 필요합니다 (실제 WhatsApp @멘션 via `mentionedJids`, 정규식 패턴, 또는 봇의 E.164 번호가 텍스트에 포함). `always`는 모든 메시지에 에이전트를 깨우지만, 의미 있는 가치를 더할 수 있을 때만 응답하며 그렇지 않으면 무음 토큰 `NO_REPLY`를 반환합니다. 기본값은 설정(`channels.whatsapp.groups`)에서 지정하고, `/activation`을 통해 그룹별로 재정의할 수 있습니다. `channels.whatsapp.groups`가 설정되면 그룹 허용 목록으로도 작동합니다 (모든 그룹을 허용하려면 `"*"`를 포함하세요).
- 그룹 정책: `channels.whatsapp.groupPolicy`는 그룹 메시지 수락 여부를 제어합니다 (`open|disabled|allowlist`). `allowlist`는 `channels.whatsapp.groupAllowFrom` (폴백: 명시적 `channels.whatsapp.allowFrom`)을 사용합니다. 기본값은 `allowlist` (발신자를 추가할 때까지 차단됨)입니다.
- 그룹별 세션: 세션 키는 `agent:<agentId>:whatsapp:group:<jid>` 형태이므로 `/verbose on` 또는 `/think high` (독립 메시지로 전송) 같은 명령은 해당 그룹에 한정되며, 개인 다이렉트 메시지 상태에는 영향을 주지 않습니다. 그룹 스레드에서는 하트비트가 건너뛰어집니다.
- 컨텍스트 주입: 실행을 트리거하지 _않은_ **대기 중인** 그룹 메시지 (기본 50개)가 `[Chat messages since your last reply - for context]` 아래에 접두사로 추가되고, 트리거된 메시지는 `[Current message - respond to this]` 아래에 표시됩니다. 이미 세션에 있는 메시지는 다시 주입되지 않습니다.
- 발신자 표시: 모든 그룹 배치는 이제 `[from: Sender Name (+E164)]`로 끝나므로 Pi가 누가 말하고 있는지 알 수 있습니다.
- 임시/한 번 보기: 텍스트/멘션을 추출하기 전에 언래핑하므로 그 안의 핑도 트리거됩니다.
- 그룹 시스템 프롬프트: 그룹 세션의 첫 턴에서 (그리고 `/activation`이 모드를 변경할 때마다) 시스템 프롬프트에 짧은 설명이 주입됩니다. 예: `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` 메타데이터를 사용할 수 없는 경우에도 에이전트에게 그룹 채팅임을 알려줍니다.

## 설정 예제 (WhatsApp)

`~/.openclaw/openclaw.json`에 `groupChat` 블록을 추가하여 WhatsApp이 텍스트 본문에서 시각적 `@`를 제거할 때에도 표시 이름 핑이 작동하도록 합니다:

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

- 정규식은 대소문자를 구분하지 않으며, `@openclaw`과 같은 표시 이름 핑과 `+`/공백 유무에 관계없이 원시 번호를 모두 처리합니다.
- WhatsApp은 누군가가 연락처를 탭할 때 `mentionedJids`를 통해 표준 멘션을 보내므로, 번호 폴백은 거의 필요하지 않지만 유용한 안전망입니다.

### 활성화 명령 (소유자 전용)

그룹 채팅 명령을 사용하세요:

- `/activation mention`
- `/activation always`

소유자 번호 (`channels.whatsapp.allowFrom`에서 가져오거나, 미설정 시 봇의 자체 E.164)만 이를 변경할 수 있습니다. 그룹에서 독립 메시지로 `/status`를 전송하면 현재 활성화 모드를 확인할 수 있습니다.

## 사용 방법

1. OpenClaw를 실행하는 WhatsApp 계정을 그룹에 추가합니다.
2. `@openclaw …`라고 말합니다 (또는 번호를 포함). `groupPolicy: "open"`을 설정하지 않는 한 허용 목록에 있는 발신자만 트리거할 수 있습니다.
3. 에이전트 프롬프트에는 최근 그룹 컨텍스트와 후행 `[from: …]` 마커가 포함되어 올바른 사람에게 응답할 수 있습니다.
4. 세션 수준 지시어 (`/verbose on`, `/think high`, `/new` 또는 `/reset`, `/compact`)는 해당 그룹의 세션에만 적용됩니다. 등록되도록 독립 메시지로 전송하세요. 개인 다이렉트 메시지 세션은 독립적으로 유지됩니다.

## 테스트 / 검증

- 수동 스모크 테스트:
  - 그룹에서 `@openclaw` 핑을 보내고 발신자 이름을 참조하는 응답이 오는지 확인합니다.
  - 두 번째 핑을 보내고 히스토리 블록이 포함된 후 다음 턴에서 지워지는지 확인합니다.
- 게이트웨이 로그 (`--verbose`로 실행)를 확인하여 `from: <groupJid>`와 `[from: …]` 접미사가 표시되는 `inbound web message` 항목을 확인합니다.

## 알려진 고려 사항

- 시끄러운 브로드캐스트를 방지하기 위해 그룹에서는 하트비트가 의도적으로 건너뛰어집니다.
- 에코 억제는 결합된 배치 문자열을 사용합니다. 멘션 없이 동일한 텍스트를 두 번 보내면 첫 번째에만 응답합니다.
- 세션 저장소 항목은 세션 저장소 (기본값: `~/.openclaw/agents/<agentId>/sessions/sessions.json`)에 `agent:<agentId>:whatsapp:group:<jid>`로 나타납니다. 항목이 없으면 그룹에서 아직 실행이 트리거되지 않은 것입니다.
- 그룹에서의 타이핑 인디케이터는 `agents.defaults.typingMode` (멘션되지 않았을 때 기본값: `message`)를 따릅니다.
