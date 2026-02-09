---
summary: "슬래시 명령어: 텍스트 vs 네이티브, 구성, 지원되는 명령어"
read_when:
  - 채팅 명령어 사용 또는 구성 시
  - 명령어 라우팅 또는 권한 디버깅 시
title: "슬래시 명령어"
---

# 슬래시 명령어

명령어는 Gateway(게이트웨이)에서 처리됩니다. 대부분의 명령어는 `/` 로 시작하는 **단독** 메시지로 보내야 합니다.
호스트 전용 bash 채팅 명령어는 `! <cmd>` 를 사용합니다(`/bash <cmd>` 는 별칭).

서로 관련된 두 가지 시스템이 있습니다:

- **명령어**: 단독 `/...` 메시지.
- **지시어**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - 지시어는 모델이 메시지를 보기 전에 제거됩니다.
  - 일반 채팅 메시지(지시어 전용이 아님)에서는 ‘인라인 힌트’로 취급되며 세션 설정을 **유지하지 않습니다**.
  - 지시어 전용 메시지(메시지에 지시어만 포함)에서는 세션에 유지되며 확인 응답을 반환합니다.
  - 지시어는 **승인된 발신자**(채널 허용 목록/페어링 + `commands.useAccessGroups`)에게만 적용됩니다.
    승인되지 않은 발신자의 경우 지시어는 일반 텍스트로 처리됩니다.

또한 몇 가지 **인라인 단축키**가 있습니다(허용 목록/승인된 발신자만): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
이들은 즉시 실행되며, 모델이 메시지를 보기 전에 제거되고 나머지 텍스트는 정상 흐름으로 계속 처리됩니다.

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

- `commands.text` (기본값 `true`)은 채팅 메시지에서 `/...` 파싱을 활성화합니다.
  - 네이티브 명령어가 없는 표면(WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams)에서는 이를 `false` 로 설정하더라도 텍스트 명령어가 계속 동작합니다.
- `commands.native` (기본값 `"auto"`)는 네이티브 명령어를 등록합니다.
  - 자동: Discord/Telegram 에서는 켜짐; Slack 에서는 꺼짐(슬래시 명령어를 추가할 때까지); 네이티브 지원이 없는 프로바이더에서는 무시됩니다.
  - 프로바이더별로 재정의하려면 `channels.discord.commands.native`, `channels.telegram.commands.native`, 또는 `channels.slack.commands.native` 를 설정합니다(bool 또는 `"auto"`).
  - `false` 은 시작 시 Discord/Telegram 에서 이전에 등록된 명령어를 지웁니다. Slack 명령어는 Slack 앱에서 관리되며 자동으로 제거되지 않습니다.
- `commands.nativeSkills` (기본값 `"auto"`)는 지원되는 경우 **skill** 명령어를 네이티브로 등록합니다.
  - 자동: Discord/Telegram 에서는 켜짐; Slack 에서는 꺼짐(Slack 는 skill 당 슬래시 명령어를 생성해야 함).
  - 프로바이더별로 재정의하려면 `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, 또는 `channels.slack.commands.nativeSkills` 를 설정합니다(bool 또는 `"auto"`).
- `commands.bash` (기본값 `false`)는 `! <cmd>` 가 호스트 셸 명령어를 실행하도록 활성화합니다(`/bash <cmd>` 는 별칭; `tools.elevated` 허용 목록 필요).
- `commands.bashForegroundMs` (기본값 `2000`)는 bash 가 백그라운드 모드로 전환하기 전에 대기하는 시간을 제어합니다(`0` 는 즉시 백그라운드로 전환).
- `commands.config` (기본값 `false`)는 `/config` 를 활성화합니다(`openclaw.json` 읽기/쓰기).
- `commands.debug` (기본값 `false`)는 `/debug` 를 활성화합니다(런타임 전용 재정의).
- `commands.useAccessGroups` (기본값 `true`)는 명령어에 대한 허용 목록/정책을 강제합니다.

## 명령어 목록

텍스트 + 네이티브(활성화된 경우):

- `/help`
- `/commands`
- `/skill <name> [input]` (이름으로 skill 실행)
- `/status` (현재 상태 표시; 사용 가능할 때 현재 모델 프로바이더의 사용량/할당량 포함)
- `/allowlist` (허용 목록 항목 나열/추가/제거)
- `/approve <id> allow-once|allow-always|deny` (exec 승인 프롬프트 해결)
- `/context [list|detail|json]` (“컨텍스트” 설명; `detail` 는 파일별 + 도구별 + skill 별 + 시스템 프롬프트 크기 표시)
- `/whoami` (발신자 id 표시; 별칭: `/id`)
- `/subagents list|stop|log|info|send` (현재 세션의 서브 에이전트 실행 검사/중지/로그/메시지)
- `/config show|get|set|unset` (구성을 디스크에 유지, 소유자 전용; `commands.config: true` 필요)
- `/debug show|set|unset|reset` (런타임 재정의, 소유자 전용; `commands.debug: true` 필요)
- `/usage off|tokens|full|cost` (응답별 사용량 푸터 또는 로컬 비용 요약)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS 제어; [/tts](/tts) 참고)
  - Discord: 네이티브 명령어는 `/voice` (Discord 는 `/tts` 를 예약함); 텍스트 `/tts` 는 계속 동작합니다.
- `/stop`
- `/restart`
- `/dock-telegram` (별칭: `/dock_telegram`) (Telegram 으로 응답 전환)
- `/dock-discord` (별칭: `/dock_discord`) (Discord 로 응답 전환)
- `/dock-slack` (별칭: `/dock_slack`) (Slack 으로 응답 전환)
- `/activation mention|always` (그룹 전용)
- `/send on|off|inherit` (소유자 전용)
- `/reset` 또는 `/new [model]` (선택적 모델 힌트; 나머지는 그대로 전달됨)
- `/think <off|minimal|low|medium|high|xhigh>` (모델/프로바이더별 동적 선택; 별칭: `/thinking`, `/t`)
- `/verbose on|full|off` (별칭: `/v`)
- `/reasoning on|off|stream` (별칭: `/reason`; 켜져 있으면 `Reasoning:` 접두사가 붙은 별도 메시지를 전송; `stream` = Telegram 초안 전용)
- `/elevated on|off|ask|full` (별칭: `/elev`; `full` 는 exec 승인을 건너뜀)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (`/exec` 를 보내 현재 상태 표시)
- `/model <name>` (별칭: `/models`; 또는 `agents.defaults.models.*.alias` 에서 `/<alias>`)
- `/queue <mode>` (`debounce:2s cap:25 drop:summarize` 같은 옵션 포함; 현재 설정을 보려면 `/queue` 전송)
- `/bash <command>` (호스트 전용; `! <command>` 의 별칭; `commands.bash: true` + `tools.elevated` 허용 목록 필요)

텍스트 전용:

- `/compact [instructions]` ([/concepts/compaction](/concepts/compaction) 참고)
- `! <command>` (호스트 전용; 한 번에 하나; 장기 실행 작업에는 `!poll` + `!stop` 사용)
- `!poll` (출력/상태 확인; 선택적 `sessionId` 허용; `/bash poll` 도 동작)
- `!stop` (실행 중인 bash 작업 중지; 선택적 `sessionId` 허용; `/bash stop` 도 동작)

참고 사항:

- 명령어는 명령어와 인자 사이에 선택적 `:` 를 허용합니다(예: `/think: high`, `/send: on`, `/help:`).
- `/new <model>` 는 모델 별칭, `provider/model`, 또는 프로바이더 이름(유사 매칭)을 허용합니다; 일치 항목이 없으면 텍스트를 메시지 본문으로 처리합니다.
- 프로바이더 사용량의 전체 분해 내역은 `openclaw status --usage` 를 사용하십시오.
- `/allowlist add|remove` 는 `commands.config=true` 가 필요하며 채널 `configWrites` 를 준수합니다.
- `/usage` 는 응답별 사용량 푸터를 제어합니다; `/usage cost` 는 OpenClaw 세션 로그에서 로컬 비용 요약을 출력합니다.
- `/restart` 는 기본적으로 비활성화되어 있습니다; 활성화하려면 `commands.restart: true` 를 설정하십시오.
- `/verbose` 는 디버깅과 추가 가시성을 위한 것입니다; 일반 사용에서는 **꺼두는 것**이 좋습니다.
- `/reasoning` (및 `/verbose`)는 그룹 환경에서 위험합니다: 의도하지 않은 내부 추론이나 도구 출력을 노출할 수 있습니다. 특히 그룹 채팅에서는 꺼두는 것을 권장합니다.
- **빠른 경로:** 허용 목록에 있는 발신자의 명령어 전용 메시지는 즉시 처리됩니다(큐 + 모델 우회).
- **그룹 멘션 게이팅:** 허용 목록에 있는 발신자의 명령어 전용 메시지는 멘션 요구 사항을 우회합니다.
- **인라인 단축키(허용 목록에 있는 발신자만):** 일부 명령어는 일반 메시지에 포함되어도 동작하며, 모델이 나머지 텍스트를 보기 전에 제거됩니다.
  - 예: `hey /status` 는 상태 응답을 트리거하며, 나머지 텍스트는 정상 흐름으로 계속 처리됩니다.
- 현재: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- 승인되지 않은 명령어 전용 메시지는 조용히 무시되며, 인라인 `/...` 토큰은 일반 텍스트로 처리됩니다.
- **Skill 명령어:** `user-invocable` skill 은 슬래시 명령어로 노출됩니다. 이름은 `a-z0-9_` 로 정규화됩니다(최대 32자); 충돌 시 숫자 접미사가 붙습니다(예: `_2`).
  - `/skill <name> [input]` 는 이름으로 skill 을 실행합니다(네이티브 명령어 제한으로 skill 당 명령어를 만들 수 없을 때 유용).
  - 기본적으로 skill 명령어는 모델로 정상 요청으로 전달됩니다.
  - Skill 은 선택적으로 `command-dispatch: tool` 를 선언하여 명령어를 도구로 직접 라우팅할 수 있습니다(결정적, 모델 없음).
  - 예: `/prose` (OpenProse 플러그인) — [OpenProse](/prose) 참고.
- **네이티브 명령어 인자:** Discord 는 동적 옵션에 대해 자동완성을 사용합니다(필수 인자를 생략하면 버튼 메뉴 표시). Telegram 과 Slack 은 명령어가 선택지를 지원하고 인자를 생략하면 버튼 메뉴를 표시합니다.

## 사용 표면(어디에 무엇이 표시되는지)

- **프로바이더 사용량/할당량**(예: “Claude 80% left”)은 사용량 추적이 활성화된 경우 현재 모델 프로바이더에 대해 `/status` 에 표시됩니다.
- **응답별 토큰/비용**은 `/usage off|tokens|full` 로 제어됩니다(일반 응답에 추가됨).
- `/model status` 는 사용량이 아니라 **모델/인증/엔드포인트**에 관한 것입니다.

## 모델 선택(`/model`)

`/model` 는 지시어로 구현되어 있습니다.

예시:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

참고 사항:

- `/model` 및 `/model list` 는 간결한 번호 매김 선택기(모델 패밀리 + 사용 가능한 프로바이더)를 표시합니다.
- `/model <#>` 는 해당 선택기에서 선택합니다(가능한 경우 현재 프로바이더를 우선).
- `/model status` 는 구성된 프로바이더 엔드포인트(`baseUrl`)와 API 모드(`api`)를 포함한 상세 보기를 표시합니다.

## 디버그 재정의

`/debug` 는 **런타임 전용** 구성 재정의(메모리, 디스크 아님)를 설정할 수 있게 합니다. 소유자 전용입니다. 기본적으로 비활성화되어 있으며 `commands.debug: true` 로 활성화합니다.

예시:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

참고 사항:

- 재정의는 새 구성 읽기에 즉시 적용되지만 `openclaw.json` 에 기록되지는 않습니다.
- 모든 재정의를 지우고 디스크상의 구성으로 되돌리려면 `/debug reset` 를 사용하십시오.

## 구성 업데이트

`/config` 는 디스크상의 구성(`openclaw.json`)에 기록합니다. 소유자 전용입니다. 기본적으로 비활성화되어 있으며 `commands.config: true` 로 활성화합니다.

예시:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

참고 사항:

- 기록 전에 구성이 검증되며, 유효하지 않은 변경은 거부됩니다.
- `/config` 업데이트는 재시작 후에도 유지됩니다.

## 표면별 참고 사항

- **텍스트 명령어**는 일반 채팅 세션에서 실행됩니다(다이렉트 메시지는 `main` 를 공유하고, 그룹은 자체 세션을 가짐).
- **네이티브 명령어**는 격리된 세션을 사용합니다:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (`channels.slack.slashCommand.sessionPrefix` 로 접두사 구성 가능)
  - Telegram: `telegram:slash:<userId>` (`CommandTargetSessionKey` 를 통해 채팅 세션을 대상으로 지정)
- **`/stop`** 는 현재 실행을 중단할 수 있도록 활성 채팅 세션을 대상으로 합니다.
- **Slack:** `channels.slack.slashCommand` 는 단일 `/openclaw` 스타일 명령어에 대해 여전히 지원됩니다. `commands.native` 를 활성화하면 기본 제공 명령어마다 하나의 Slack 슬래시 명령어를 생성해야 합니다(`/help` 와 동일한 이름). Slack 의 명령어 인자 메뉴는 일시적 Block Kit 버튼으로 제공됩니다.
