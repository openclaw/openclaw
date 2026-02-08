---
read_when:
    - 채팅 명령 사용 또는 구성
    - 명령 라우팅 또는 권한 디버깅
summary: '슬래시 명령: 텍스트 대 기본, 구성 및 지원되는 명령'
title: 슬래시 명령
x-i18n:
    generated_at: "2026-02-08T16:15:52Z"
    model: gtx
    provider: google-translate
    source_hash: ca0deebf89518e8c62828fbb9bf4621c5fff8ab86ccb22e37da61a28f9a7886a
    source_path: tools/slash-commands.md
    workflow: 15
---

# 슬래시 명령

명령은 게이트웨이에 의해 처리됩니다. 대부분의 명령은 다음과 같이 전송되어야 합니다. **독립형** 다음으로 시작하는 메시지 `/`.
호스트 전용 bash chat 명령은 다음을 사용합니다. `! <cmd>` (와 함께 `/bash <cmd>` 별칭으로).

두 가지 관련 시스템이 있습니다.

- **명령**: 독립형 `/...` 메시지.
- **지시문**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - 모델이 메시지를 보기 전에 지시어가 메시지에서 제거됩니다.
  - 일반 채팅 메시지(지시문만 포함되지 않음)에서는 "인라인 힌트"로 처리되며 다음을 수행합니다. **~ 아니다** 세션 설정을 유지합니다.
  - 지시어 전용 메시지(메시지에는 지시어만 포함됨)에서는 세션이 유지되고 승인으로 응답합니다.
  - 지시문은 다음에 대해서만 적용됩니다. **승인된 발신자** (채널 허용 목록/페어링 플러스 `commands.useAccessGroups`).
    승인되지 않은 발신자는 일반 텍스트로 처리되는 지시문을 봅니다.

또한 몇 가지가 있습니다 **인라인 단축키** (허용 목록에 있거나 승인된 발신자만 해당): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
즉시 실행되고 모델이 메시지를 보기 전에 제거되며 나머지 텍스트는 일반 흐름을 통해 계속됩니다.

## 구성

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (기본 `true`) 구문 분석을 활성화합니다. `/...` 채팅 메시지에서.
  - 기본 명령이 없는 표면(WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams)에서는 이를 다음과 같이 설정하더라도 텍스트 명령이 계속 작동합니다. `false`.
- `commands.native` (기본 `"auto"`)는 기본 명령을 등록합니다.
  - 자동: Discord/Telegram의 경우 켜짐; Slack의 경우 꺼짐(슬래시 명령을 추가할 때까지) 기본 지원이 없는 공급자의 경우 무시됩니다.
  - 세트 `channels.discord.commands.native`, `channels.telegram.commands.native`, 또는 `channels.slack.commands.native` 공급자별로 재정의하려면(bool 또는 `"auto"`).
  - `false` 시작 시 Discord/Telegram에 이전에 등록된 명령을 지웁니다. Slack 명령은 Slack 앱에서 관리되며 자동으로 제거되지 않습니다.
- `commands.nativeSkills` (기본 `"auto"`) 레지스터 **기능** 지원되는 경우 기본적으로 명령을 실행합니다.
  - 자동: Discord/Telegram의 경우 켜짐; Slack의 경우 꺼짐(Slack에서는 스킬별로 슬래시 명령을 생성해야 함)
  - 세트 `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, 또는 `channels.slack.commands.nativeSkills` 공급자별로 재정의하려면(bool 또는 `"auto"`).
- `commands.bash` (기본 `false`) 활성화 `! <cmd>` 호스트 셸 명령을 실행하려면(`/bash <cmd>` 별칭입니다. 필요하다 `tools.elevated` 허용 목록).
- `commands.bashForegroundMs` (기본 `2000`)는 bash가 백그라운드 모드로 전환하기 전에 기다리는 시간을 제어합니다(`0` 배경은 즉시).
- `commands.config` (기본 `false`) 활성화 `/config` (읽기/쓰기 `openclaw.json`).
- `commands.debug` (기본 `false`) 활성화 `/debug` (런타임 전용 재정의).
- `commands.useAccessGroups` (기본 `true`)는 명령에 대한 허용 목록/정책을 시행합니다.

## 명령 목록

텍스트 + 네이티브(활성화된 경우):

- `/help`
- `/commands`
- `/skill <name> [input]` (이름으로 스킬 실행)
- `/status` (현재 상태 표시, 사용 가능한 경우 현재 모델 공급자에 대한 공급자 사용량/할당량 포함)
- `/allowlist` (허용 목록 항목 나열/추가/제거)
- `/approve <id> allow-once|allow-always|deny` (임원 승인 프롬프트 해결)
- `/context [list|detail|json]` (“컨텍스트”를 설명합니다; `detail` 파일별 + 도구별 + 스킬별 + 시스템 프롬프트 크기 표시)
- `/whoami` (발신자 ID 표시, 별칭: `/id`)
- `/subagents list|stop|log|info|send` (현재 세션에 대한 하위 에이전트 실행을 검사, 중지, 기록 또는 메시지 전송)
- `/config show|get|set|unset` (디스크에 구성 유지, 소유자 전용, 필요 `commands.config: true`)
- `/debug show|set|unset|reset` (런타임 재정의, 소유자 전용, 필수 `commands.debug: true`)
- `/usage off|tokens|full|cost` (응답별 사용량 바닥글 또는 로컬 비용 요약)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS 제어, 참조 [/tts](/tts))
  - 불일치: 기본 명령은 `/voice` (디스코드 보유 `/tts`); 텍스트 `/tts` 여전히 작동합니다.
- `/stop`
- `/restart`
- `/dock-telegram` (별명: `/dock_telegram`) (답장을 텔레그램으로 전환)
- `/dock-discord` (별명: `/dock_discord`) (답글을 Discord로 전환)
- `/dock-slack` (별명: `/dock_slack`) (Slack으로 응답 전환)
- `/activation mention|always` (그룹만 해당)
- `/send on|off|inherit` (소유자 전용)
- `/reset` 또는 `/new [model]` (선택적 모델 힌트, 나머지는 전달됨)
- `/think <off|minimal|low|medium|high|xhigh>` (모델/공급자별 동적 선택, 별칭: `/thinking`, `/t`)
- `/verbose on|full|off` (별명: `/v`)
- `/reasoning on|off|stream` (별명: `/reason`; 켜져 있으면 접두사가 붙은 별도의 메시지를 보냅니다. `Reasoning:`; `stream` = 텔레그램 초안만 해당)
- `/elevated on|off|ask|full` (별명: `/elev`; `full` 실행 승인을 건너뜁니다)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (보내다 `/exec` 현재를 보여주기 위해)
- `/model <name>` (별명: `/models`; 또는 `/<alias>` ~에서 `agents.defaults.models.*.alias`)
- `/queue <mode>` (그리고 다음과 같은 옵션도 있습니다. `debounce:2s cap:25 drop:summarize`; 보내다 `/queue` 현재 설정을 보려면)
- `/bash <command>` (호스트 전용, 별칭 `! <command>`; 필요하다 `commands.bash: true` + `tools.elevated` 허용 목록)

텍스트 전용:

- `/compact [instructions]` (보다 [/개념/압축](/concepts/compaction))
- `! <command>` (호스트 전용, 한 번에 하나씩, 사용 `!poll` + `!stop` 장기 실행 작업의 경우)
- `!poll` (출력/상태 확인, 선택 사항 허용) `sessionId`; `/bash poll` 또한 작동합니다)
- `!stop` (실행 중인 bash 작업을 중지하고 선택 사항을 허용합니다. `sessionId`; `/bash stop` 또한 작동합니다)

참고:

- 명령은 선택 사항을 허용합니다. `:` 명령과 인수 사이(예: `/think: high`, `/send: on`, `/help:`).
- `/new <model>` 모델 별칭을 허용합니다. `provider/model`또는 공급자 이름(퍼지 일치) 일치하는 항목이 없으면 텍스트가 메시지 본문으로 처리됩니다.
- 전체 공급자 사용량 분석을 보려면 다음을 사용하세요. `openclaw status --usage`.
- `/allowlist add|remove` 필요하다 `commands.config=true` 그리고 명예 채널 `configWrites`.
- `/usage` 응답별 사용 바닥글을 제어합니다. `/usage cost` OpenClaw 세션 로그에서 로컬 비용 요약을 인쇄합니다.
- `/restart` 기본적으로 비활성화되어 있습니다. 세트 `commands.restart: true` 그것을 활성화합니다.
- `/verbose` 디버깅 및 추가 가시성을 위한 것입니다. 그것을 유지 **끄다** 정상적인 사용 시.
- `/reasoning` (그리고 `/verbose`)은 그룹 설정에서 위험합니다. 노출할 의도가 없었던 내부 추론이나 도구 출력이 드러날 수 있습니다. 특히 그룹 채팅에서는 사용하지 않는 것이 좋습니다.
- **빠른 경로:** 허용 목록에 있는 발신자의 명령 전용 메시지는 즉시 처리됩니다(우회 대기열 + 모델).
- **그룹 언급 게이팅:** 허용 목록에 있는 발신자의 명령 전용 메시지는 멘션 요구 사항을 우회합니다.
- **인라인 바로가기(허용 목록에 있는 발신자만 해당):** 특정 명령은 일반 메시지에 포함될 때도 작동하며 모델이 나머지 텍스트를 보기 전에 제거됩니다.
  - 예: `hey /status` 상태 응답을 트리거하고 나머지 텍스트는 일반 흐름을 통해 계속됩니다.
- 현재: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- 승인되지 않은 명령 전용 메시지는 자동으로 무시되며 인라인으로 처리됩니다. `/...` 토큰은 일반 텍스트로 처리됩니다.
- **스킬 명령:** `user-invocable` 스킬은 슬래시 명령으로 노출됩니다. 이름은 다음으로 삭제됩니다. `a-z0-9_` (최대 32자); 충돌에는 숫자 접미사가 붙습니다(예: `_2`).
  - `/skill <name> [input]` 이름별로 스킬을 실행합니다(기본 명령 제한이 스킬별 명령을 방지할 때 유용함).
  - 기본적으로 스킬 명령은 일반 요청으로 모델에 전달됩니다.
  - 스킬은 선택적으로 선언할 수 있습니다. `command-dispatch: tool` 명령을 도구로 직접 라우팅합니다(결정적, 모델 없음).
  - 예: `/prose` (OpenProse 플러그인) — 참조 [오픈프로즈](/prose).
- **기본 명령 인수:** Discord는 동적 옵션(및 필수 인수를 생략한 경우 버튼 메뉴)에 자동 완성을 사용합니다. Telegram과 Slack은 명령이 선택 사항을 지원하고 인수를 생략한 경우 버튼 메뉴를 표시합니다.

## 사용 표면(어디에서 무엇을 표시하는지)

- **공급자 사용량/할당량** (예: “Claude 80% 남음”)이 `/status` 사용 추적이 활성화된 경우 현재 모델 공급자에 대한 것입니다.
- **응답별 토큰/비용** 에 의해 제어됩니다 `/usage off|tokens|full` (일반 답변에 첨부됨)
- `/model status` 에 관한 것입니다 **모델/인증/엔드포인트**, 사용법이 아닙니다.

## 모델선정(`/model`)

`/model` 지시문으로 구현됩니다.

예:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

참고:

- `/model` 그리고 `/model list` 간결하고 번호가 매겨진 선택기(모델 계열 + 사용 가능한 공급자)를 표시합니다.
- `/model <#>` 해당 선택기에서 선택합니다(가능한 경우 현재 공급자를 선호합니다).
- `/model status` 구성된 제공자 엔드포인트(`baseUrl`) 및 API 모드(`api`) 가능한 경우.

## 디버그 재정의

`/debug` 당신이 설정할 수 있습니다 **런타임 전용** 구성 재정의(디스크가 아닌 메모리) 소유자 전용. 기본적으로 비활성화되어 있습니다. 활성화 `commands.debug: true`.

예:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

참고:

- 재정의는 새 구성 읽기에 즉시 적용되지만 **~ 아니다** 에게 편지를 쓰다 `openclaw.json`.
- 사용 `/debug reset` 모든 재정의를 지우고 온디스크 구성으로 돌아갑니다.

## 구성 업데이트

`/config` 온디스크 구성에 기록합니다(`openclaw.json`). 소유자 전용. 기본적으로 비활성화되어 있습니다. 활성화 `commands.config: true`.

예:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

참고:

- 구성은 쓰기 전에 검증됩니다. 잘못된 변경 사항은 거부됩니다.
- `/config` 다시 시작해도 업데이트가 유지됩니다.

## 표면 노트

- **텍스트 명령** 일반 채팅 세션에서 실행(DM 공유 `main`, 그룹에는 자체 세션이 있습니다).
- **기본 명령** 격리된 세션을 사용합니다.
  - 불화: `agent:<agentId>:discord:slash:<userId>`
  - 느슨하게: `agent:<agentId>:slack:slash:<userId>` (접두사 구성 가능 `channels.slack.slashCommand.sessionPrefix`)
  - 전보: `telegram:slash:<userId>` (다음을 통해 채팅 세션을 타겟팅합니다. `CommandTargetSessionKey`)
- **`/stop`** 현재 실행을 중단할 수 있도록 활성 채팅 세션을 대상으로 합니다.
- **느슨하게: ** `channels.slack.slashCommand` 단일 항목에 대해서는 여전히 지원됩니다. `/openclaw`-스타일 명령. 활성화하면 `commands.native`, 기본 제공 명령당 하나의 Slack 슬래시 명령을 생성해야 합니다( `/help`). Slack의 명령 인수 메뉴는 임시 블록 키트 버튼으로 제공됩니다.
