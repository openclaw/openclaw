---
title: IRC
description: Connect OpenClaw to IRC channels and direct messages.
x-i18n:
  source_hash: 867fb1d7469886f1254397522a047d16ff31182bc64acf79831933e2a86e0785
---

클래식 채널(`#room`) 및 다이렉트 메시지에서 OpenClaw를 원할 때 IRC를 사용하세요.
IRC는 확장 플러그인으로 제공되지만 `channels.irc` 아래의 기본 구성에서 구성됩니다.

## 빠른 시작

1. `~/.openclaw/openclaw.json`에서 IRC 구성을 활성화합니다.
2. 최소한 다음을 설정하십시오.

```json
{
  "channels": {
    "irc": {
      "enabled": true,
      "host": "irc.libera.chat",
      "port": 6697,
      "tls": true,
      "nick": "openclaw-bot",
      "channels": ["#openclaw"]
    }
  }
}
```

3. 게이트웨이 시작/재시작:

```bash
openclaw gateway run
```

## 보안 기본값

- `channels.irc.dmPolicy`의 기본값은 `"pairing"`입니다.
- `channels.irc.groupPolicy`의 기본값은 `"allowlist"`입니다.
- `groupPolicy="allowlist"`로 `channels.irc.groups`를 설정하여 허용되는 채널을 정의합니다.
- 의도적으로 일반 텍스트 전송을 허용하지 않는 한 TLS(`channels.irc.tls=true`)를 사용하십시오.

## 접근 제어

IRC 채널에는 두 개의 별도 "게이트"가 있습니다.

1. **채널 액세스** (`groupPolicy` + `groups`): 봇이 채널의 메시지를 전혀 수락하는지 여부.
2. **발신자 액세스** (`groupAllowFrom` / 채널당 `groups["#channel"].allowFrom`): 해당 채널 내에서 봇을 트리거할 수 있는 사람.

구성 키:

- DM 허용 목록(DM 발신자 액세스): `channels.irc.allowFrom`
- 그룹 발신자 허용 목록(채널 발신자 액세스): `channels.irc.groupAllowFrom`
- 채널별 제어(채널 + 발신자 + 멘션 규칙): `channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"`는 구성되지 않은 채널을 허용합니다(**기본적으로 여전히 언급 제한됨**)

허용 목록 항목은 nick 또는 `nick!user@host` 형식을 사용할 수 있습니다.

### 일반적인 문제: `allowFrom`는 채널이 아닌 DM용입니다.

다음과 같은 로그가 표시되는 경우:

- `irc: drop group sender alice!ident@host (policy=allowlist)`

…발신자가 **그룹/채널** 메시지를 보낼 수 없다는 의미입니다. 다음 중 하나를 통해 문제를 해결하세요.

- `channels.irc.groupAllowFrom` 설정(모든 채널에 대해 전역) 또는
- 채널별 발신자 허용 목록 설정: `channels.irc.groups["#channel"].allowFrom`

예(`#tuirc-dev`의 모든 사람이 봇과 대화하도록 허용):

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#tuirc-dev": { allowFrom: ["*"] },
      },
    },
  },
}
```

## 응답 트리거(멘션)

채널이 허용되고(`groupPolicy` + `groups`를 통해) 발신자가 허용되는 경우에도 OpenClaw는 그룹 컨텍스트에서 기본적으로 **멘션 게이팅**을 사용합니다.

즉, 메시지에 봇과 일치하는 언급 패턴이 포함되어 있지 않으면 `drop channel … (missing-mention)`와 같은 로그가 표시될 수 있습니다.

**멘션 없이** IRC 채널에서 봇이 응답하도록 하려면 해당 채널에 대한 멘션 게이팅을 비활성화하세요.

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#tuirc-dev": {
          requireMention: false,
          allowFrom: ["*"],
        },
      },
    },
  },
}
```

또는 **모든** IRC 채널을 허용하고(채널별 허용 목록 없음) 언급 없이 계속 응답하려면 다음을 수행하세요.

```json5
{
  channels: {
    irc: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: false, allowFrom: ["*"] },
      },
    },
  },
}
```

## 보안 참고사항(공개 채널에 권장)

공개 채널에서 `allowFrom: ["*"]`를 허용하면 누구나 봇에게 메시지를 보낼 수 있습니다.
위험을 줄이려면 해당 채널에 대한 도구를 제한하십시오.

### 채널의 모든 사람에게 동일한 도구

```json5
{
  channels: {
    irc: {
      groups: {
        "#tuirc-dev": {
          allowFrom: ["*"],
          tools: {
            deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
          },
        },
      },
    },
  },
}
```

### 발신자마다 도구가 다름(소유자가 더 많은 권한을 얻음)

`toolsBySender`를 사용하여 `"*"`에 더 엄격한 정책을 적용하고 닉네임에 더 느슨한 정책을 적용합니다.

```json5
{
  channels: {
    irc: {
      groups: {
        "#tuirc-dev": {
          allowFrom: ["*"],
          toolsBySender: {
            "*": {
              deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
            },
            eigen: {
              deny: ["gateway", "nodes", "cron"],
            },
          },
        },
      },
    },
  },
}
```

참고:

- `toolsBySender` 키는 더 강력한 신원 일치를 위해 별명(예: `"eigen"`) 또는 전체 호스트 마스크(`"eigen!~eigen@174.127.248.171"`)일 수 있습니다.
- 첫 번째로 일치하는 보낸 사람 정책이 승리합니다. `"*"`는 와일드카드 대체입니다.

그룹 액세스와 멘션 게이팅(및 상호 작용 방식)에 대한 자세한 내용은 [/channels/groups](/channels/groups)를 참조하세요.

## 닉서브

연결 후 NickServ로 식별하려면:

```json
{
  "channels": {
    "irc": {
      "nickserv": {
        "enabled": true,
        "service": "NickServ",
        "password": "your-nickserv-password"
      }
    }
  }
}
```

연결 시 일회성 등록(선택 사항):

```json
{
  "channels": {
    "irc": {
      "nickserv": {
        "register": true,
        "registerEmail": "bot@example.com"
      }
    }
  }
}
```

반복적인 REGISTER 시도를 방지하려면 닉네임을 등록한 후 `register`를 비활성화하세요.

## 환경 변수

기본 계정은 다음을 지원합니다.

- `IRC_HOST`
- `IRC_PORT`
- `IRC_TLS`
- `IRC_NICK`
- `IRC_USERNAME`
- `IRC_REALNAME`
- `IRC_PASSWORD`
- `IRC_CHANNELS` (쉼표로 구분)
- `IRC_NICKSERV_PASSWORD`
- `IRC_NICKSERV_REGISTER_EMAIL`

## 문제 해결

- 봇이 연결되었지만 채널에서 응답하지 않는 경우 `channels.irc.groups` **및** 멘션 게이팅이 메시지를 삭제하는지 여부(`missing-mention`)를 확인하세요. 핑 없이 응답하도록 하려면 채널에 `requireMention:false`를 설정하세요.
- 로그인 실패 시 닉네임 유무와 서버 비밀번호를 확인하세요.
- 사용자 정의 네트워크에서 TLS가 실패하는 경우 호스트/포트 및 인증서 설정을 확인하십시오.
