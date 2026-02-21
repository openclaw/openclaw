---
summary: "슬래시 명령어: 텍스트 대 네이티브, 설정, 지원되는 명령어"
read_when:
  - 채팅 명령어 사용 또는 설정
  - 명령어 라우팅 또는 권한 문제 해결
title: "슬래시 명령어"
---

# 슬래시 명령어

명령어는 게이트웨이에 의해 처리됩니다. 대부분의 명령은 `/`로 시작하는 **독립형** 메시지로 보내야 합니다. 호스트 전용 bash 채팅 명령은 `! <cmd>`를 사용하며 `/bash <cmd>`는 대체 명령어로 사용됩니다.

관련된 두 가지 시스템이 있습니다:

- **명령어**: 독립된 `/...` 메시지입니다.
- **지침**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - 지침은 모델이 메시지를 보기 전에 제거됩니다.
  - 일반 채팅 메시지(단일 지침이 아님)에서는 "인라인 힌트"로 처리되며 세션 설정에 영구적이지 않습니다.
  - 단일 지침 메시지(지침만 포함된 메시지)에서는 세션에 영구적으로 남고 확인응답과 함께 회신됩니다.
  - 지침은 **인증된 발신자**에게만 적용됩니다. `commands.allowFrom`이 설정되어 있으면 이것만 허용 목록으로 사용되며, 그렇지 않은 경우 채널 허용 목록/페어링과 `commands.useAccessGroups`가 적용됩니다.
    인증되지 않은 발신자는 지침을 일반 텍스트로 처리합니다.

일부 **인라인 단축키**도 있습니다 (허용된 발신자만): `/help`, `/commands`, `/status`, `/whoami` (`/id`). 이들은 즉시 실행되며, 모델이 메시지를 보기 전에 제거되고 나머지 텍스트는 일반 흐름을 통해 계속됩니다.

## 설정

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

- `commands.text` (기본값 `true`)는 채팅 메시지에서 `/...`를 파싱할 수 있게 합니다.
  - 네이티브 명령어가 없는 환경(WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams)에서도 텍스트 명령어는 이 설정을 `false`로 해도 작동합니다.
- `commands.native` (기본값 `"auto"`)는 네이티브 명령어를 등록합니다.
  - 자동: Discord/Telegram에서는 켜짐; Slack에서는 꺼짐(슬래시 명령어 추가 시까지); 네이티브 지원이 없는 프로바이더에게는 무시됩니다.
  - `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native`를 통해 프로바이더별로 설정을 오버라이드(불리언 또는 `"auto"`)할 수 있습니다.
  - `false`는 시작 시 Discord/Telegram의 이전에 등록된 명령어를 지웁니다. Slack 명령어는 Slack 앱 내에서 관리되며 자동으로 제거되지 않습니다.
- `commands.nativeSkills` (기본값 `"auto"`)는 지원되는 경우 **스킬** 명령어를 네이티브로 등록합니다.
  - 자동: Discord/Telegram에서는 켜짐; Slack에서는 꺼짐(스킬당 슬래시 명령어 생성 필요).
  - `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, `channels.slack.commands.nativeSkills`를 통해 프로바이더별로 설정을 오버라이드(불리언 또는 `"auto"`)할 수 있습니다.
- `commands.bash` (기본값 `false`)는 `! <cmd>`를 통해 호스트 쉘 명령어 실행을 가능케 합니다(`/bash <cmd>`는 대체 명령어; `tools.elevated` 허용 목록 필요).
- `commands.bashForegroundMs` (기본값 `2000`)는 bash가 백그라운드 모드로 전환되기 전 대기 시간을 제어합니다 (`0`은 즉시 백그라운드로 전환).
- `commands.config` (기본값 `false`)는 `/config`를 가능케 합니다 (`openclaw.json` 읽기/쓰기).
- `commands.debug` (기본값 `false`)는 `/debug`를 가능케 합니다 (런타임 전용 오버라이드).
- `commands.allowFrom` (선택 사항)은 명령어 인증을 위한 프로바이더별 허용 목록을 설정합니다. 구성된 경우, 이는 명령어와 지침에 대한 유일한 인증 소스가 되며 (채널 허용 목록/페어링 및 `commands.useAccessGroups`는 무시됩니다). 전체 기본값으로 `"*"`을 사용하고, 프로바이더별 키가 이를 오버라이드합니다.
- `commands.useAccessGroups` (기본값 `true`)는 `commands.allowFrom`이 설정되어 있지 않을 때 명령어에 대한 허용 목록/정책을 적용합니다.

## 명령어 목록

텍스트 + 네이티브 (활성화된 경우):

- `/help`
- `/commands`
- `/skill <name> [input]` (스킬 이름으로 실행)
- `/status` (현재 상태 표시; 사용 가능한 경우 현재 모델 프로바이더의 사용/쿼터 포함)
- `/allowlist` (허용 목록 항목 나열/추가/제거)
- `/approve <id> allow-once|allow-always|deny` (실행 승인 요청 해결)
- `/context [list|detail|json]` ("컨텍스트" 설명; `detail`은 파일별, 도구별, 스킬별, 시스템 프롬프트 크기 표시)
- `/export-session [path]` (별칭: `/export`) (현재 세션을 시스템 프롬프트 전체와 함께 HTML로 내보내기)
- `/whoami` (발신자 id 표시; 별칭: `/id`)
- `/session ttl <duration|off>` (TTL 같은 세션 수준 설정 관리)
- `/subagents list|kill|log|info|send|steer|spawn` (현재 세션의 서브-에이전트 실행을 검사, 제어 또는 생성)
- `/agents` (이 세션의 스레드 바인딩된 에이전트 목록)
- `/focus <target>` (Discord: 이 스레드 또는 새 스레드를 세션/서브에이전트 대상에 바인딩)
- `/unfocus` (Discord: 현재 스레드 바인딩 제거)
- `/kill <id|#|all>` (이 세션의 실행 중인 서브-에이전트 하나 또는 전체를 즉시 중단; 확인 메시지 없음)
- `/steer <id|#> <message>` (실행 중인 서브-에이전트를 즉시 방향 제어: 가능한 경우 실행 중, 그렇지 않으면 현재 작업을 중단하고 방향 메시지로 다시 시작)
- `/tell <id|#> <message>` (`/steer`의 별칭)
- `/config show|get|set|unset` (디스크에 설정 유지, 소유자 전용; `commands.config: true` 필요)
- `/debug show|set|unset|reset` (런타임 오버라이드, 소유자 전용; `commands.debug: true` 필요)
- `/usage off|tokens|full|cost` (응답별 사용 요약 또는 현지 비용 요약)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS 제어; [/tts](/ko-KR/tts) 참조)
  - Discord: 네이티브 명령어는 `/voice`임 (Discord는 `/tts`를 예약); 텍스트 `/tts`도 여전히 작동.
- `/stop`
- `/restart`
- `/dock-telegram` (별칭: `/dock_telegram`) (답변을 Telegram으로 전환)
- `/dock-discord` (별칭: `/dock_discord`) (답변을 Discord로 전환)
- `/dock-slack` (별칭: `/dock_slack`) (답변을 Slack으로 전환)
- `/activation mention|always` (그룹 전용)
- `/send on|off|inherit` (소유자 전용)
- `/reset` 또는 `/new [model]` (선택적 모델 힌트; 나머지는 그대로 전달)
- `/think <off|minimal|low|medium|high|xhigh>` (모델/프로바이더에 따른 동적 선택; 별칭: `/thinking`, `/t`)
- `/verbose on|full|off` (별칭: `/v`)
- `/reasoning on|off|stream` (별칭: `/reason`; "on"일 때는 "Reasoning:"으로 시작하는 별도 메시지를 전송; `stream` = Telegram 임시 저장 전용)
- `/elevated on|off|ask|full` (별칭: `/elev`; `full`은 실행 승인을 건너뜀)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (현재 설정을 보여주려면 `/exec`을 전송)
- `/model <name>` (별칭: `/models`; 또는 `agents.defaults.models.*.alias`에서 `/<alias>`)
- `/queue <mode>` (옵션으로 `debounce:2s cap:25 drop:summarize`; 현재 설정을 보려면 `/queue`를 전송)
- `/bash <command>` (호스트 전용; `! <command>`의 별칭; `commands.bash: true` + `tools.elevated` 허용 목록 필요)

텍스트 전용:

- `/compact [instructions]` ([/concepts/compaction](/ko-KR/concepts/compaction) 참조)
- `! <command>` (호스트 전용; 한 번에 하나씩; 장기 실행 작업에는 `!poll` + `!stop` 사용)
- `!poll` (출력 / 상태 확인; 선택적 `sessionId` 수락; `/bash poll`도 작동)
- `!stop` (실행 중인 bash 작업 정지; 선택적 `sessionId` 수락; `/bash stop`도 작동)

참고 사항:

- 명령어는 명령어와 인수 사이에 선택적 `:`를 수용합니다(예: `/think: high`, `/send: on`, `/help:`).
- `/new <model>`은 모델 별칭, `provider/model`, 또는 프로바이더 이름(불명확한 일치 가능)을 수용합니다. 일치하는 항목이 없으면 텍스트는 메시지 본문으로 처리됩니다.
- 프로바이더 사용 내역의 전체 분석을 원한다면 `openclaw status --usage`를 사용하세요.
- `/allowlist add|remove`는 `commands.config=true`가 필요하며 채널 `configWrites`를 존중합니다.
- `/usage`는 응답별 사용 요약을 제어하며, `/usage cost`는 OpenClaw 세션 로그에서 현지 비용 요약을 출력합니다.
- `/restart`는 기본적으로 활성화되어 있습니다; 비활성화하려면 `commands.restart: false`를 설정하세요.
- Discord 전용 네이티브 명령어: `/vc join|leave|status`는 음성 채널을 제어합니다 (`channels.discord.voice`와 네이티브 명령어 필요; 텍스트로는 사용 불가).
- Discord 스레드 바인딩 명령어 (`/focus`, `/unfocus`, `/agents`, `/session ttl`)는 유효한 스레드 바인딩이 활성화되어 있어야 합니다 (`session.threadBindings.enabled` 및/또는 `channels.discord.threadBindings.enabled`).
- `/verbose`는 디버깅 및 추가 가시성을 목적으로 하며, 일반 사용 시는 **비활성화** 상태로 유지하세요.
- `/reasoning`(및 `/verbose`)는 그룹 설정에서는 위험할 수 있습니다: 내부 추론이나 의도하지 않은 도구 출력이 드러날 수 있습니다. 특히 그룹 채팅에서는 비활성화를 권장합니다.
- **빠른 경로:** 허용된 발신자로부터의 명령 전용 메시지는 즉시 처리됩니다 (대기열 및 모델을 우회).
- **그룹 멘션 게이팅:** 허용된 발신자로부터의 명령 전용 메시지는 멘션 요구사항을 우회합니다.
- **인라인 단축키 (허용된 발신자 전용):** 특정 명령어는 일반 메시지에 포함되었을 때도 작동하며, 모델이 남은 텍스트를 보기 전에 제거됩니다.
  - 예: `hey /status`는 상태 응답을 트리거하며, 나머지 텍스트는 일반 흐름을 통해 처리됩니다.
- 현재: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- 인증되지 않은 명령 전용 메시지는 묵시적으로 무시되며, 인라인 `/...` 토큰은 일반 텍스트로 처리됩니다.
- **스킬 명령어:** `사용자가 호출할 수 있는` 스킬은 슬래시 명령어로 노출됩니다. 이름은 `a-z0-9_`로 정규화되며(최대 32자); 충돌이 발생하면 숫자 접미사를 붙입니다(예: `_2`).
  - `/skill <name> [input]`은 이름으로 스킬을 실행합니다 (네이티브 명령어 제한이 스킬별 명령을 방해할 때 유용함).
  - 기본적으로, 스킬 명령어는 일반 요청으로 모델에 전달됩니다.
  - 스킬은 `명령-전달: 도구`를 선언하여 명령어를 도구로 직접 라우팅할 수 있습니다 (결정론적, 모델 없음).
  - 예: `/prose` (OpenProse 플러그인) — [OpenProse](/ko-KR/prose) 참조.
- **네이티브 명령어 인수:** Discord는 동적 옵션의 자동 완성을 사용하며, 필수 인수를 생략할 때 버튼 메뉴를 사용합니다. Telegram과 Slack은 명령이 선택지를 지원할 때 버튼 메뉴를 보여주며 인수를 생략합니다.

## 사용 표면 (어디에 무엇이 나타나는가)

- **프로바이더 사용/쿼터** (예: "Claude 80% 남음")는 사용 추적이 활성화된 경우 현재 모델 프로바이더에 대해 `/status`에 표시됩니다.
- **응답별 토큰/비용**은 `/usage off|tokens|full`로 제어되며 일반 응답에 추가됩니다.
- `/model status`는 **모델/인증/엔드포인트**에 관한 것이며, 사용량에 관한 것은 아닙니다.

## 모델 선택 (`/model`)

`/model`은 지침으로 구현됩니다.

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

- `/model` 및 `/model list`는 간단하고 번호가 매겨진 선택자를 표시합니다 (모델 계열 + 사용 가능한 프로바이더).
- Discord에서 `/model` 및 `/models`는 프로바이더 및 모델 드롭다운과 제출 단계가 있는 인터랙티브 선택기를 엽니다.
- `/model <#>`는 그 선택자에서 선택하여, 가능한 경우 현재 프로바이더를 선호합니다.
- `/model status`는 구성된 프로바이더 엔드포인트 (`baseUrl`)와 API 모드 (`api`)를 포함한 자세한 뷰를 표시합니다.

## 디버그 오버라이드

`/debug`는 **런타임 전용** 설정 오버라이드를 설정할 수 있게 해줍니다 (메모리, 디스크 아님). 소유자 전용. 기본적으로 비활성화됨; `commands.debug: true`로 활성화합니다.

예:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

참고:

- 오버라이드는 새로운 설정 읽기에 즉시 적용되지만, `openclaw.json`에 쓰이지 **않습니다**.
- `/debug reset`을 사용하여 모든 오버라이드를 지우고 디스크 상의 설정으로 돌아갑니다.

## 설정 업데이트

`/config`는 디스크에 있는 설정 파일 (`openclaw.json`)에 작성합니다. 소유자 전용. 기본적으로 비활성화되어 있으며, `commands.config: true`로 활성화합니다.

예:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

참고:

- 설정은 작성 전에 유효성이 검사되며, 유효하지 않은 변경은 거부됩니다.
- `/config` 업데이트는 재시작 시에도 유지됩니다.

## 표면 관련 메모

- **텍스트 명령어**는 일반 채팅 세션에서 실행됩니다 (다이렉트 메시지는 `main`을 공유하고, 그룹은 자체 세션을 가짐).
- **네이티브 명령어**는 격리된 세션을 사용합니다:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (접두사는 `channels.slack.slashCommand.sessionPrefix`로 구성 가능)
  - Telegram: `telegram:slash:<userId>` (채팅 세션을 `CommandTargetSessionKey`로 대상으로 함)
- **`/stop`**은 활성 채팅 세션을 대상으로 하여 현재 실행을 중단할 수 있습니다.
- **Slack:** `channels.slack.slashCommand`는 여전히 단일 `/openclaw` 스타일 명령어에 대해 지원됩니다. `commands.native`를 활성화하면, 내장 명령어당 하나의 Slack 슬래시 명령어를 생성해야 합니다 (`/help`와 동일한 이름). Slack의 명령 인수 메뉴는 임시 Block Kit 버튼으로 제공됩니다.
