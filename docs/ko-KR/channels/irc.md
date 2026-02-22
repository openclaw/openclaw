---
title: IRC
description: OpenClaw를 IRC 채널 및 다이렉트 메시지에 연결합니다.
---

OpenClaw를 클래식 채널 (`#room`) 및 다이렉트 메시지에서 사용하려면 IRC를 사용하십시오. IRC는 확장 플러그인으로 제공되지만, `channels.irc` 아래에 있는 메인 설정에서 설정됩니다.

## 빠른 시작

1. `~/.openclaw/openclaw.json`에서 IRC 설정을 활성화합니다.
2. 최소한 다음 항목을 설정하십시오:

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

3. 게이트웨이를 시작/재시작합니다:

```bash
openclaw gateway run
```

## 보안 기본값

- `channels.irc.dmPolicy`의 기본값은 `"pairing"`입니다.
- `channels.irc.groupPolicy`의 기본값은 `"allowlist"`입니다.
- `groupPolicy="allowlist"`인 경우, 허용된 채널을 정의하기 위해 `channels.irc.groups`를 설정합니다.
- TLS (`channels.irc.tls=true`)를 사용하십시오. 평문 전송을 의도적으로 수락하지 않는 한 사용하십시오.

## 접근 제어

IRC 채널에는 두 개의 별도 "게이트"가 있습니다:

1. **채널 접근** (`groupPolicy` + `groups`): 봇이 채널에서 메시지를 수락할지 여부.
2. **발신자 접근** (`groupAllowFrom` / 채널별 `groups["#channel"].allowFrom`): 해당 채널 내에서 봇을 트리거할 수 있는 사람.

설정 키:

- 다이렉트 메시지 허용 목록 (DM 발신자 접근): `channels.irc.allowFrom`
- 그룹 발신자 허용 목록 (채널 발신자 접근): `channels.irc.groupAllowFrom`
- 채널별 제어 (채널 + 발신자 + 멘션 규칙): `channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"`은 구성되지 않은 채널을 허용하지만, 기본적으로는 여전히 멘션 게이트가 설정되어 있음

허용 목록 항목은 닉네임 또는 `nick!user@host` 형식을 사용할 수 있습니다.

### 흔한 문제: `allowFrom`은 채널이 아닌 다이렉트 메시지를 위한 것

다음과 같은 로그를 보는 경우:

- `irc: drop group sender alice!ident@host (policy=allowlist)`

이는 발신자가 **그룹/채널** 메시지에 허용되지 않았음을 의미합니다. 다음과 같이 수정합니다:

- `channels.irc.groupAllowFrom` 설정 (모든 채널에 대해 전역 설정), 또는
- 채널별 발신자 허용 목록 설정: `channels.irc.groups["#channel"].allowFrom`

예(봇과 대화하기 위해 `#tuirc-dev`에서 누구든지 허용):

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

## 응답 트리거 (멘션)

채널이 허용되더라도 (`groupPolicy` + `groups`를 통해) 발신자가 허용된다면, OpenClaw는 기본적으로 그룹 컨텍스트에서 **멘션 게이트**에 따라 동작합니다.

이는 메시지에 봇과 일치하는 멘션 패턴이 포함되지 않는 한 `drop channel … (missing-mention)`과 같은 로그를 볼 수 있음을 의미합니다.

IRC 채널에서 **멘션 없이** 봇이 응답하도록 하려면, 해당 채널에 대한 멘션 게이트를 비활성화하십시오:

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

또는 **모든** IRC 채널을 허용하고 (채널별 허용 목록 없음) 여전히 멘션 없이 응답하려면:

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

## 보안 주의사항 (공개 채널에 권장됨)

공개 채널에서 `allowFrom: ["*"]`를 허용하면 누구나 봇을 프롬프트 할 수 있습니다. 위험을 줄이기 위해 해당 채널의 도구를 제한하십시오.

### 채널 내 모든 사용자를 위한 동일한 도구

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

### 발신자별로 다른 도구 (소유자가 더 많은 권한을 가짐)

`toolsBySender`를 사용하여 `"*"`에 더 엄격한 정책을 적용하고 자신의 닉네임에 느슨한 정책을 적용하십시오:

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

메모:

- `toolsBySender` 키는 닉네임 (예: `"eigen"`) 또는 강력한 신원 확인을 위한 전체 호스트 마스크 (`"eigen!~eigen@174.127.248.171"`)일 수 있습니다.
- 첫 번째로 일치하는 발신자 정책이 우선한다; `"*"`는 대체 와일드카드입니다.

그룹 접근과 멘션 게이트의 작동 방식 및 상호작용에 대한 자세한 내용은: [/channels/groups](/ko-KR/channels/groups)을 참조하십시오.

## NickServ

NickServ에 연결한 후 식별하려면:

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

연결 시 선택적 일회성 등록:

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

닉네임이 등록된 후에는 REGISTER 시도가 반복되지 않도록 `register`를 비활성화하십시오.

## 환경 변수

기본 계정 지원:

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

- 봇이 연결은 되었지만 채널에서 전혀 응답하지 않으면, `channels.irc.groups` **및** 멘션 게이트가 메시지를 차단하는지 확인하십시오 (`missing-mention`). 핑 없이 응답하게 하려면, 채널에 대해 `requireMention:false`를 설정하십시오.
- 로그인 실패 시, 닉네임 가능 여부 및 서버 비밀번호를 확인하십시오.
- 사용자 정의 네트워크에서 TLS가 실패하면, 호스트/포트 및 인증서 설정을 확인하십시오.
