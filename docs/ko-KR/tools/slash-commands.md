---
summary: "Slash commands: text vs native, config, and supported commands"
read_when:
  - Using or configuring chat commands
  - Debugging command routing or permissions
title: "Slash Commands"
x-i18n:
  source_hash: 6efd749e590cbb945ee1eec77fabf279920389fe21df9fb338bf4dbff75f4a2a
---

# 슬래시 명령

명령은 게이트웨이에 의해 처리됩니다. 대부분의 명령은 `/`로 시작하는 **독립형** 메시지로 전송되어야 합니다.
호스트 전용 bash 채팅 명령은 `! <cmd>`(별칭으로 `/bash <cmd>` 사용)를 사용합니다.

두 가지 관련 시스템이 있습니다.

- **명령**: 독립형 `/...` 메시지.
- **지침**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - 지시어는 모델이 보기 전에 메시지에서 제거됩니다.
  - 일반 채팅 메시지(지시문만 포함되지 않음)에서는 "인라인 힌트"로 처리되며 세션 설정을 지속하지 **않습니다**.
  - 지시어 전용 메시지(메시지에는 지시어만 포함)에서는 세션이 유지되고 확인으로 응답합니다.
  - 지시어는 **승인된 발신자**에게만 적용됩니다. `commands.allowFrom`가 설정되어 있으면 이것이 유일한 것입니다.
    허용 목록이 사용되었습니다. 그렇지 않으면 승인은 채널 허용 목록/페어링 및 `commands.useAccessGroups`에서 이루어집니다.
    승인되지 않은 발신자는 일반 텍스트로 처리되는 지시문을 봅니다.

몇 가지 **인라인 바로가기**(허용 목록에 있거나 승인된 발신자만 해당)도 있습니다: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
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
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

- `commands.text`(기본값 `true`)는 채팅 메시지에서 `/...` 구문 분석을 활성화합니다.
  - 기본 명령이 없는 표면(WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams)에서는 이를 `false`로 설정하더라도 텍스트 명령이 계속 작동합니다.
- `commands.native` (기본값 `"auto"`)은 기본 명령을 등록합니다.
  - 자동: Discord/Telegram의 경우 켜짐; Slack의 경우 꺼짐(슬래시 명령을 추가할 때까지) 기본 지원이 없는 공급자의 경우 무시됩니다.
  - `channels.discord.commands.native`, `channels.telegram.commands.native` 또는 `channels.slack.commands.native`를 공급자별로 재정의하도록 설정합니다(bool 또는 `"auto"`).
  - `false`는 시작 시 Discord/Telegram에 이전에 등록된 명령어를 삭제합니다. Slack 명령은 Slack 앱에서 관리되며 자동으로 제거되지 않습니다.
- `commands.nativeSkills` (기본값 `"auto"`) 지원 시 **스킬** 명령을 기본적으로 등록합니다.
  - 자동: Discord/Telegram의 경우 켜짐; Slack의 경우 꺼짐(Slack에서는 스킬별로 슬래시 명령을 생성해야 함)
  - `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` 또는 `channels.slack.commands.nativeSkills`를 공급자별로 재정의하도록 설정합니다(bool 또는 `"auto"`).
- `commands.bash` (기본값 `false`)는 `! <cmd>`가 호스트 셸 명령을 실행할 수 있도록 합니다(`/bash <cmd>`는 별칭이며 `tools.elevated` 허용 목록이 필요합니다).
- `commands.bashForegroundMs` (기본값 `2000`)는 bash가 백그라운드 모드로 전환하기 전에 대기하는 시간을 제어합니다(`0`는 즉시 백그라운드).
- `commands.config` (기본값 `false`)는 `/config`를 활성화합니다(`openclaw.json` 읽기/쓰기).
- `commands.debug`(기본값 `false`)는 `/debug`(런타임 전용 재정의)를 활성화합니다.
- `commands.allowFrom`(선택 사항)는 명령 승인을 위해 공급자별 허용 목록을 설정합니다. 구성되면 다음과 같습니다.
  명령 및 지시어에 대한 유일한 인증 소스(채널 허용 목록/페어링 및 `commands.useAccessGroups`
  무시됩니다). 전역 기본값으로 `"*"`를 사용하세요. 공급자별 키가 이를 재정의합니다.
- `commands.useAccessGroups` (기본값 `true`)는 `commands.allowFrom`가 설정되지 않은 경우 명령에 대한 허용 목록/정책을 시행합니다.

## 명령 목록

텍스트 + 네이티브(활성화된 경우):

- `/help`
- `/commands`
- `/skill <name> [input]` (이름으로 스킬 실행)
- `/status` (현재 상태 표시, 사용 가능한 경우 현재 모델 공급자에 대한 공급자 사용량/할당량 포함)
- `/allowlist` (허용 목록 항목 나열/추가/제거)
- `/approve <id> allow-once|allow-always|deny` (exec 승인 프롬프트 해결)
- `/context [list|detail|json]` ("컨텍스트" 설명; `detail`는 파일별 + 도구별 + 스킬별 + 시스템 프롬프트 크기를 표시합니다.)
- `/whoami` (발신자 ID 표시, 별칭: `/id`)
- `/subagents list|stop|log|info|send` (현재 세션에 대해 하위 에이전트 실행을 검사, 중지, 기록 또는 메시지 표시)
- `/config show|get|set|unset` (디스크에 대한 구성 유지, 소유자 전용, `commands.config: true` 필요)
- `/debug show|set|unset|reset` (런타임 재정의, 소유자 전용, `commands.debug: true` 필요)
- `/usage off|tokens|full|cost` (응답별 사용량 바닥글 또는 로컬 비용 요약)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS 제어, [/tts](/tts) 참조)
  - Discord: 기본 명령은 `/voice`입니다(Discord는 `/tts`를 보유합니다). 텍스트 `/tts`는 여전히 작동합니다.
- `/stop`
- `/restart`
- `/dock-telegram` (별칭: `/dock_telegram`) (답글을 텔레그램으로 전환)
- `/dock-discord` (별칭: `/dock_discord`) (답글을 Discord로 전환)
- `/dock-slack` (별칭: `/dock_slack`) (응답을 Slack으로 전환)
- `/activation mention|always` (그룹 전용)
- `/send on|off|inherit` (소유자 전용)
- `/reset` 또는 `/new [model]` (선택적 모델 힌트; 나머지는 통과됨)
- `/think <off|minimal|low|medium|high|xhigh>` (모델/공급자별 동적 선택, 별칭: `/thinking`, `/t`)
- `/verbose on|full|off` (별칭: `/v`)
- `/reasoning on|off|stream` (별칭: `/reason`; 켜져 있는 경우 접두어 `Reasoning:`가 붙은 별도의 메시지를 보냅니다. `stream` = 텔레그램 초안에만 해당)
- `/elevated on|off|ask|full` (별칭: `/elev`; `full`는 실행 승인을 건너뜁니다.)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (현재를 표시하려면 `/exec` 전송)
- `/model <name>` (별칭: `/models`; 또는 `agents.defaults.models.*.alias`의 `/<alias>`)
- `/queue <mode>` (`debounce:2s cap:25 drop:summarize`와 같은 옵션 추가, 현재 설정을 보려면 `/queue` 전송)
- `/bash <command>` (호스트 전용, `! <command>`의 별칭, `commands.bash: true` + `tools.elevated` 허용 목록 필요)

텍스트 전용:

- `/compact [instructions]` ([/concepts/compaction](/concepts/compaction) 참조)
- `! <command>` (호스트 전용, 한 번에 하나씩, 장기 실행 작업의 경우 `!poll` + `!stop` 사용)
- `!poll` (출력 / 상태 확인, 선택 사항인 `sessionId` 허용, `/bash poll`도 작동함)
- `!stop` (실행 중인 bash 작업을 중지하고 선택 사항인 `sessionId`를 허용합니다. `/bash stop`도 작동합니다)

참고:

- 명령은 명령과 인수 사이에 선택적인 `:`를 허용합니다(예: `/think: high`, `/send: on`, `/help:`).
- `/new <model>`는 모델 별칭 `provider/model` 또는 공급자 이름(퍼지 일치)을 허용합니다. 일치하는 항목이 없으면 텍스트가 메시지 본문으로 처리됩니다.
- 전체 공급자 사용량 분석을 보려면 `openclaw status --usage`를 사용하세요.
- `/allowlist add|remove`에는 `commands.config=true`가 필요하며 `configWrites` 채널을 따릅니다.
- `/usage`는 응답별 사용 바닥글을 제어합니다. `/usage cost`는 OpenClaw 세션 로그에서 로컬 비용 요약을 인쇄합니다.
- `/restart`는 기본적으로 비활성화되어 있습니다. 활성화하려면 `commands.restart: true`를 설정하세요.
- `/verbose`는 디버깅 및 추가 가시성을 의미합니다. 일반적인 사용 중에는 **꺼져** 유지하세요.
- `/reasoning`(및 `/verbose`)는 그룹 설정에서 위험합니다. 노출할 의도가 없었던 내부 추론이나 도구 출력이 드러날 수 있습니다. 특히 그룹 채팅에서는 사용하지 않는 것이 좋습니다.
- **빠른 경로:** 허용 목록에 있는 발신자의 명령 전용 메시지는 즉시 처리됩니다(우회 대기열 + 모델).
- **그룹 멘션 게이팅:** 허용 목록에 있는 발신자의 명령 전용 메시지는 멘션 요구 사항을 우회합니다.
- **인라인 바로가기(허용 목록에 있는 발신자만 해당):** 특정 명령은 일반 메시지에 포함될 때도 작동하며 모델이 나머지 텍스트를 보기 전에 제거됩니다.
  - 예: `hey /status`는 상태 응답을 트리거하고 나머지 텍스트는 일반적인 흐름을 통해 계속됩니다.
- 현재: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- 승인되지 않은 명령 전용 메시지는 자동으로 무시되며 인라인 `/...` 토큰은 일반 텍스트로 처리됩니다.
- **스킬 명령어:** `user-invocable` 스킬은 슬래시 명령어로 노출됩니다. 이름은 `a-z0-9_`로 정리됩니다(최대 32자). 충돌에는 숫자 접미사가 붙습니다(예: `_2`).
  - `/skill <name> [input]` 이름으로 스킬을 실행합니다(기본 명령 제한이 스킬별 명령을 방지할 때 유용함).
  - 기본적으로 스킬 명령은 일반 요청으로 모델에 전달됩니다.
  - 스킬은 `command-dispatch: tool`를 선택적으로 선언하여 명령을 도구(결정론적, 모델 없음)로 직접 라우팅할 수 있습니다.
  - 예: `/prose` (OpenProse 플러그인) — [OpenProse](/prose)를 참조하세요.
- **기본 명령 인수:** Discord는 동적 옵션(및 필수 인수를 생략한 경우 버튼 메뉴)에 자동 완성을 사용합니다. Telegram과 Slack은 명령이 선택 사항을 지원하고 인수를 생략한 경우 버튼 메뉴를 표시합니다.

## 사용 표면(무엇이 어디에 표시되는지)

- **공급자 사용량/할당량**(예: "Claude 80% 남음")은 사용량 추적이 활성화된 경우 현재 모델 공급자에 대한 `/status`에 표시됩니다.
- **응답별 토큰/비용**은 `/usage off|tokens|full`(일반 응답에 추가됨)에 의해 제어됩니다.
- `/model status`는 사용법이 아닌 **모델/인증/엔드포인트**에 관한 것입니다.

## 모델 선택 (`/model`)

`/model`는 지시문으로 구현됩니다.

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

- `/model` 및 `/model list`는 번호가 매겨진 컴팩트한 선택기(모델 제품군 + 사용 가능한 공급자)를 보여줍니다.
- `/model <#>` 해당 선택기에서 선택합니다(가능한 경우 현재 공급자를 선호합니다).
- `/model status`는 구성된 제공자 엔드포인트(`baseUrl`) 및 API 모드(`api`)를 포함한 세부 보기를 표시합니다.

## 디버그 재정의

`/debug`를 사용하면 **런타임 전용** 구성 재정의(디스크가 아닌 메모리)를 설정할 수 있습니다. 소유자 전용. 기본적으로 비활성화되어 있습니다. `commands.debug: true`로 활성화하세요.

예:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

참고:

- 재정의는 새 구성 읽기에 즉시 적용되지만 `openclaw.json`에 쓰지 **않습니다**.
- 모든 재정의를 지우고 온디스크 구성으로 돌아가려면 `/debug reset`를 사용하세요.

## 구성 업데이트

`/config`는 온디스크 구성(`openclaw.json`)에 씁니다. 소유자 전용. 기본적으로 비활성화되어 있습니다. `commands.config: true`로 활성화하세요.

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
- `/config` 업데이트는 다시 시작해도 지속됩니다.

## 표면 노트

- **텍스트 명령**은 일반 채팅 세션에서 실행됩니다(DM은 `main`를 공유하고 그룹은 자체 세션을 갖습니다).
- **기본 명령**은 격리된 세션을 사용합니다.
  - 불화: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (`channels.slack.slashCommand.sessionPrefix`를 통해 접두사 구성 가능)
  - 텔레그램: `telegram:slash:<userId>` (`CommandTargetSessionKey`를 통해 채팅 세션을 대상으로 함)
- **`/stop`** 현재 실행을 중단할 수 있도록 활성 채팅 세션을 대상으로 합니다.
- **Slack:** `channels.slack.slashCommand`는 단일 `/openclaw` 스타일 명령에 대해 계속 지원됩니다. `commands.native`를 활성화하는 경우 내장 명령당 하나의 Slack 슬래시 명령을 생성해야 합니다(`/help`와 동일한 이름). Slack의 명령 인수 메뉴는 임시 블록 키트 버튼으로 제공됩니다.
