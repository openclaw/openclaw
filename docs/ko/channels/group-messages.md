---
read_when:
    - 그룹 메시지 규칙 또는 멘션 변경
summary: WhatsApp 그룹 메시지 처리를 위한 동작 및 구성(멘션 패턴은 여러 표면에서 공유됨)
title: 그룹 메시지
x-i18n:
    generated_at: "2026-02-08T15:46:45Z"
    model: gtx
    provider: google-translate
    source_hash: 181a72f12f5021af77c2e4c913120f711e0c0bc271d218d75cb6fe80dab675bb
    source_path: channels/group-messages.md
    workflow: 15
---

# 그룹 메시지(WhatsApp 웹 채널)

목표: Clawd가 WhatsApp 그룹에 앉아 핑이 울릴 때만 깨어나고 해당 스레드를 개인 DM 세션과 별도로 유지하도록 합니다.

메모: `agents.list[].groupChat.mentionPatterns` 이제 Telegram/Discord/Slack/iMessage에서도 사용됩니다. 이 문서는 WhatsApp 관련 동작에 중점을 둡니다. 다중 에이전트 설정의 경우 다음을 설정하십시오. `agents.list[].groupChat.mentionPatterns` 에이전트당(또는 `messages.groupChat.mentionPatterns` 글로벌 폴백으로).

## 구현 내용 (2025-12-03)

- 활성화 모드: `mention` (기본값) 또는 `always`. `mention` 핑이 필요합니다(실제 WhatsApp @멘션을 통해 `mentionedJids`, 정규식 패턴 또는 텍스트의 어느 위치에나 봇의 E.164). `always` 모든 메시지에서 에이전트를 깨우지만 의미 있는 값을 추가할 수 있는 경우에만 응답해야 합니다. 그렇지 않으면 자동 토큰을 반환합니다. `NO_REPLY`. 기본값은 구성(`channels.whatsapp.groups`) 다음을 통해 그룹별로 재정의됩니다. `/activation`. 언제 `channels.whatsapp.groups` 설정되면 그룹 허용 목록으로도 작동합니다(포함 `"*"` 모두 허용합니다).
- 그룹 정책: `channels.whatsapp.groupPolicy` 그룹 메시지 수락 여부를 제어합니다(`open|disabled|allowlist`). `allowlist` 용도 `channels.whatsapp.groupAllowFrom` (대체: 명시적 `channels.whatsapp.allowFrom`). 기본값은 `allowlist` (발신자를 추가할 때까지 차단됨)
- 그룹별 세션: 세션 키는 다음과 같습니다. `agent:<agentId>:whatsapp:group:<jid>` 그래서 다음과 같은 명령 `/verbose on` 또는 `/think high` (독립형 메시지로 전송됨)은 해당 그룹으로 범위가 지정됩니다. 개인 DM 상태는 그대로 유지됩니다. 그룹 스레드의 경우 하트비트를 건너뜁니다.
- 컨텍스트 주입: **보류 전용** 그룹 메시지(기본값 50) _하지 않았다_ 실행 트리거는 아래에 접두어로 붙습니다. `[Chat messages since your last reply - for context]`, 아래에 트리거 라인이 있음 `[Current message - respond to this]`. 이미 세션에 있는 메시지는 다시 삽입되지 않습니다.
- 발신자 표시: 이제 모든 그룹 배치는 다음으로 끝납니다. `[from: Sender Name (+E164)]` 그래서 파이는 누가 말하고 있는지 알 수 있습니다.
- 임시/한 번 보기: 텍스트/멘션을 추출하기 전에 래핑을 해제하므로 해당 내부의 핑이 계속 트리거됩니다.
- 그룹 시스템 프롬프트: 그룹 세션이 처음 시작될 때(그리고 언제든지 `/activation` 모드 변경) 시스템 프롬프트에 다음과 같은 짧은 설명을 삽입합니다. `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` 메타데이터를 사용할 수 없는 경우에도 상담원에게 그룹 채팅임을 알립니다.

## 구성 예(WhatsApp)

추가 `groupChat` 차단하다 `~/.openclaw/openclaw.json` 따라서 WhatsApp이 시각적 요소를 제거하는 경우에도 표시 이름 핑이 작동합니다. `@` 텍스트 본문에서:

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

- 정규 표현식은 대소문자를 구분하지 않습니다. 그들은 다음과 같은 표시 이름 핑을 다룹니다. `@openclaw` 그리고 유무에 관계없이 원시 숫자 `+`/공백.
- WhatsApp은 여전히 ​​다음을 통해 정식 언급을 보냅니다. `mentionedJids` 누군가가 연락처를 탭하면 번호 대체가 거의 필요하지 않지만 유용한 안전망입니다.

### 활성화 명령(소유자 전용)

그룹 채팅 명령을 사용하십시오.

- `/activation mention`
- `/activation always`

소유자 번호만(출처: `channels.whatsapp.allowFrom`또는 설정되지 않은 경우 봇의 자체 E.164)가 이를 변경할 수 있습니다. 보내다 `/status` 현재 활성화 모드를 보려면 그룹의 독립 실행형 메시지로 표시됩니다.

## 사용방법

1. WhatsApp 계정(OpenClaw를 실행하는 계정)을 그룹에 추가하세요.
2. 말하다 `@openclaw …` (또는 번호를 포함하세요). 별도로 설정하지 않는 한 허용 목록에 있는 발신자만 트리거할 수 있습니다. `groupPolicy: "open"`. 
3. 상담원 프롬프트에는 최근 그룹 상황과 후행 내용이 포함됩니다. `[from: …]` 올바른 사람을 지칭할 수 있도록 표시합니다.
4. 세션 수준 지시문(`/verbose on`, `/think high`, `/new` 또는 `/reset`, `/compact`) 해당 그룹의 세션에만 적용됩니다. 등록할 수 있도록 독립형 메시지로 보냅니다. 귀하의 개인 DM 세션은 독립적으로 유지됩니다.

## 테스트/검증

- 수동 연기:
  - 보내기 `@openclaw` 그룹에 핑을 보내고 보낸 사람 이름을 참조하는 응답을 확인하세요.
  - 두 번째 핑을 보내고 기록 블록이 포함되어 있는지 확인한 후 다음 차례에 지워집니다.
- 게이트웨이 로그를 확인하십시오(다음으로 실행 `--verbose`) 보려고 `inbound web message` 표시되는 항목 `from: <groupJid>` 그리고 `[from: …]` 접미사.

## 알려진 고려사항

- 시끄러운 방송을 피하기 위해 그룹의 하트비트는 의도적으로 건너뜁니다.
- 에코 억제는 결합된 배치 문자열을 사용합니다. 언급 없이 동일한 텍스트를 두 번 보내면 첫 번째 사람만 응답을 받게 됩니다.
- 세션 저장소 항목은 다음과 같이 나타납니다. `agent:<agentId>:whatsapp:group:<jid>` 세션 저장소(`~/.openclaw/agents/<agentId>/sessions/sessions.json` 기본적으로); 누락된 항목은 그룹이 아직 실행을 트리거하지 않았음을 의미합니다.
- 그룹의 입력 표시기는 다음과 같습니다. `agents.defaults.typingMode` (기본: `message` 언급되지 않은 경우).
