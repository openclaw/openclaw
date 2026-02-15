---
summary: "Behavior and config for WhatsApp group message handling (mentionPatterns are shared across surfaces)"
read_when:
  - Changing group message rules or mentions
title: "Group Messages"
x-i18n:
  source_hash: 181a72f12f5021af77c2e4c913120f711e0c0bc271d218d75cb6fe80dab675bb
---

# 그룹 메시지(WhatsApp 웹 채널)

목표: Clawd가 WhatsApp 그룹에 앉아 핑이 울릴 때만 깨어나고 해당 스레드를 개인 DM 세션과 별도로 유지하도록 합니다.

참고: `agents.list[].groupChat.mentionPatterns`는 이제 Telegram/Discord/Slack/iMessage에서도 사용됩니다. 이 문서는 WhatsApp 관련 동작에 중점을 둡니다. 다중 에이전트 설정의 경우 에이전트별로 `agents.list[].groupChat.mentionPatterns`를 설정합니다(또는 `messages.groupChat.mentionPatterns`를 전역 폴백으로 사용).

## 구현 내용 (2025-12-03)

- 활성화 모드: `mention`(기본값) 또는 `always`. `mention`에는 핑이 필요합니다(`mentionedJids`를 통한 실제 WhatsApp @멘션, 정규식 패턴 또는 텍스트의 봇의 E.164). `always` 모든 메시지에서 에이전트를 깨우지만 의미 있는 값을 추가할 수 있는 경우에만 응답해야 합니다. 그렇지 않으면 자동 토큰 `NO_REPLY`을 반환합니다. 기본값은 구성(`channels.whatsapp.groups`)에서 설정하고 `/activation`를 통해 그룹별로 재정의할 수 있습니다. `channels.whatsapp.groups`가 설정되면 그룹 허용 목록 역할도 합니다(모두 허용하려면 `"*"` 포함).
- 그룹 정책: `channels.whatsapp.groupPolicy`는 그룹 메시지 허용 여부를 제어합니다(`open|disabled|allowlist`). `allowlist`는 `channels.whatsapp.groupAllowFrom`를 사용합니다(대체: 명시적 `channels.whatsapp.allowFrom`). 기본값은 `allowlist`입니다(발신자를 추가할 때까지 차단됨).
- 그룹별 세션: 세션 키는 `agent:<agentId>:whatsapp:group:<jid>`와 유사하므로 `/verbose on` 또는 `/think high`(독립형 메시지로 전송됨)와 같은 명령은 해당 그룹으로 범위가 지정됩니다. 개인 DM 상태는 그대로 유지됩니다. 그룹 스레드의 경우 하트비트를 건너뜁니다.
- 컨텍스트 삽입: 실행을 트리거하지 _않은_ **보류 전용** 그룹 메시지(기본값 50)는 `[Chat messages since your last reply - for context]` 아래에 접두사가 붙고, `[Current message - respond to this]` 아래에 트리거 라인이 붙습니다. 이미 세션에 있는 메시지는 다시 삽입되지 않습니다.
- 발신자 표시: 이제 모든 그룹 배치는 `[from: Sender Name (+E164)]`로 끝나므로 Pi는 누가 말하고 있는지 알 수 있습니다.
- 임시/한 번 보기: 텍스트/멘션을 추출하기 전에 래핑을 해제하므로 그 안의 핑이 계속 트리거됩니다.
- 그룹 시스템 프롬프트: 그룹 세션의 첫 번째 차례에서(그리고 `/activation`가 모드를 변경할 때마다) 시스템 프롬프트에 `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`와 같은 짧은 설명을 삽입합니다. 메타데이터를 사용할 수 없는 경우에도 에이전트에게 그룹 채팅임을 알립니다.

## 구성 예시(WhatsApp)

`groupChat` 블록을 `~/.openclaw/openclaw.json`에 추가하면 WhatsApp이 텍스트 본문에서 시각적인 `@`를 제거하는 경우에도 표시 이름 핑이 작동합니다.

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

- 정규 표현식은 대소문자를 구분하지 않습니다. `@openclaw`와 같은 표시 이름 핑과 `+`/공백이 있거나 없는 원시 번호를 다룹니다.
- WhatsApp은 누군가가 연락처를 탭할 때 여전히 `mentionedJids`를 통해 표준 멘션을 전송하므로 번호 대체는 거의 필요하지 않지만 유용한 안전망입니다.

### 활성화 명령(소유자 전용)

그룹 채팅 명령을 사용하십시오.

- `/activation mention`
- `/activation always`

소유자 번호(`channels.whatsapp.allowFrom` 또는 설정되지 않은 경우 봇 자체 E.164)만 이를 변경할 수 있습니다. 현재 활성화 모드를 보려면 그룹에 독립형 메시지로 `/status`를 보냅니다.

## 사용방법

1. 그룹에 WhatsApp 계정(OpenClaw를 실행하는 계정)을 추가하세요.
2. `@openclaw …`라고 말하세요(또는 번호 포함). `groupPolicy: "open"`를 설정하지 않는 한 허용 목록에 있는 발신자만 트리거할 수 있습니다.
3. 에이전트 프롬프트에는 최근 그룹 컨텍스트와 후행 `[from: …]` 마커가 포함되어 올바른 사람을 지정할 수 있습니다.
4. 세션 수준 지시어(`/verbose on`, `/think high`, `/new` 또는 `/reset`, `/compact`)는 해당 그룹의 세션에만 적용됩니다. 등록할 수 있도록 독립형 메시지로 보냅니다. 귀하의 개인 DM 세션은 독립적으로 유지됩니다.

## 테스트/검증

- 수동 연기:
  - 그룹에 `@openclaw` 핑을 보내고 보낸 사람 이름을 참조하는 응답을 확인합니다.
  - 두 번째 핑을 보내고 기록 블록이 포함되어 있는지 확인한 후 다음 차례에 지워집니다.
- 게이트웨이 로그를 확인하여(`--verbose`로 실행) `from: <groupJid>` 및 `[from: …]` 접미사를 표시하는 `inbound web message` 항목을 확인하세요.

## 알려진 고려사항

- 시끄러운 방송을 피하기 위해 그룹의 하트비트는 의도적으로 건너뜁니다.
- 에코 억제는 결합된 배치 문자열을 사용합니다. 언급 없이 동일한 텍스트를 두 번 보내면 첫 번째 사람만 응답을 받게 됩니다.
- 세션 저장소 항목은 세션 저장소에 `agent:<agentId>:whatsapp:group:<jid>`로 표시됩니다(기본적으로 `~/.openclaw/agents/<agentId>/sessions/sessions.json`). 누락된 항목은 그룹이 아직 실행을 트리거하지 않았음을 의미합니다.
- 그룹의 입력 표시는 `agents.defaults.typingMode`를 따릅니다(언급되지 않은 경우 기본값: `message`).
