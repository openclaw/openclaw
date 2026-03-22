---
title: IRC
summary: "IRC 플러그인 설정, 접근 제어, 문제 해결"
read_when:
  - OpenClaw 를 IRC 채널 또는 DM 에 연결하려는 경우
  - IRC 허용 목록, 그룹 정책, 멘션 게이팅을 구성하는 경우
x-i18n:
  source_path: docs/channels/irc.md
---

# IRC

클래식 채널 (`#room`) 과 다이렉트 메시지에서 OpenClaw 를 사용하려면 IRC 를 사용하세요.
IRC 는 확장 플러그인으로 제공되지만, 메인 구성의 `channels.irc` 하위에서 구성됩니다.

## 빠른 시작

1. `~/.openclaw/openclaw.json` 에서 IRC 구성을 활성화합니다.
2. 최소한 다음을 설정합니다:

```json5
{
  channels: {
    irc: {
      enabled: true,
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      nick: "openclaw-bot",
      channels: ["#openclaw"],
    },
  },
}
```

3. Gateway 를 시작/재시작합니다:

```bash
openclaw gateway run
```

## 보안 기본값

- `channels.irc.dmPolicy` 기본값은 `"pairing"` 입니다.
- `channels.irc.groupPolicy` 기본값은 `"allowlist"` 입니다.
- `groupPolicy="allowlist"` 에서는 허용된 채널을 정의하기 위해 `channels.irc.groups` 를 설정합니다.
- 의도적으로 평문 전송을 수락하지 않는 한 TLS (`channels.irc.tls=true`) 를 사용하세요.

## 접근 제어

IRC 채널에는 두 개의 별도 "게이트"가 있습니다:

1. **채널 접근** (`groupPolicy` + `groups`): 봇이 해당 채널의 메시지를 전혀 수락하는지 여부.
2. **발신자 접근** (`groupAllowFrom` / 채널별 `groups["#channel"].allowFrom`): 해당 채널 내에서 봇을 트리거할 수 있는 사람.

구성 키:

- DM 허용 목록 (DM 발신자 접근): `channels.irc.allowFrom`
- 그룹 발신자 허용 목록 (채널 발신자 접근): `channels.irc.groupAllowFrom`
- 채널별 제어 (채널 + 발신자 + 멘션 규칙): `channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"` 은 구성되지 않은 채널을 허용합니다 (**여전히 기본적으로 멘션 게이팅 적용**)

허용 목록 항목은 안정적인 발신자 ID (`nick!user@host`) 를 사용해야 합니다.
베어 닉네임 매칭은 변경 가능하며 `channels.irc.dangerouslyAllowNameMatching: true` 일 때만 활성화됩니다.

### 일반적인 실수: `allowFrom` 은 DM 용이지 채널용이 아님

다음과 같은 로그가 표시되면:

- `irc: drop group sender alice!ident@host (policy=allowlist)`

...이는 발신자가 **그룹/채널** 메시지에 대해 허용되지 않았다는 의미입니다. 다음 중 하나로 수정합니다:

- `channels.irc.groupAllowFrom` 설정 (모든 채널에 대해 전역), 또는
- 채널별 발신자 허용 목록 설정: `channels.irc.groups["#channel"].allowFrom`

예시 (`#tuirc-dev` 에서 누구나 봇과 대화할 수 있도록 허용):

```json55
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

채널이 허용되고 (`groupPolicy` + `groups` 를 통해) 발신자가 허용되어도, OpenClaw 는 그룹 컨텍스트에서 기본적으로 **멘션 게이팅**을 적용합니다.

즉, 메시지에 봇과 일치하는 멘션 패턴이 포함되지 않으면 `drop channel … (missing-mention)` 과 같은 로그가 표시될 수 있습니다.

IRC 채널에서 **멘션 없이** 봇이 응답하게 하려면 해당 채널의 멘션 게이팅을 비활성화합니다:

```json55
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

또는 **모든** IRC 채널을 허용하고 (채널별 허용 목록 없이) 멘션 없이 응답하려면:

```json55
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

## 보안 참고 (공개 채널 권장)

공개 채널에서 `allowFrom: ["*"]` 를 허용하면 누구나 봇에게 프롬프트할 수 있습니다.
위험을 줄이려면 해당 채널의 도구를 제한하세요.

### 채널 내 모든 사용자에게 동일한 도구

```json55
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

### 발신자별 다른 도구 (소유자가 더 많은 권한)

`toolsBySender` 를 사용하여 `"*"` 에 더 엄격한 정책을, 자신의 닉에 더 느슨한 정책을 적용합니다:

```json55
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
            "id:eigen": {
              deny: ["gateway", "nodes", "cron"],
            },
          },
        },
      },
    },
  },
}
```

참고 사항:

- `toolsBySender` 키는 IRC 발신자 ID 값에 `id:` 를 사용해야 합니다:
  `id:eigen` 또는 더 강력한 매칭을 위해 `id:eigen!~eigen@174.127.248.171`.
- 레거시 접두사 없는 키도 여전히 허용되며 `id:` 로만 매칭됩니다.
- 첫 번째 일치하는 발신자 정책이 적용됩니다. `"*"` 는 와일드카드 폴백입니다.

그룹 접근과 멘션 게이팅 (및 상호 작용 방식) 에 대한 자세한 내용은: [/channels/groups](/channels/groups) 를 참조하세요.

## NickServ

연결 후 NickServ 로 인증하려면:

```json5
{
  channels: {
    irc: {
      nickserv: {
        enabled: true,
        service: "NickServ",
        password: "your-nickserv-password",
      },
    },
  },
}
```

연결 시 선택적 일회성 등록:

```json5
{
  channels: {
    irc: {
      nickserv: {
        register: true,
        registerEmail: "bot@example.com",
      },
    },
  },
}
```

닉이 등록된 후 반복적인 REGISTER 시도를 피하기 위해 `register` 를 비활성화하세요.

## 환경 변수

기본 계정은 다음을 지원합니다:

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

- 봇이 연결되었지만 채널에서 응답하지 않는 경우, `channels.irc.groups` **와** 멘션 게이팅이 메시지를 드롭하는지 (`missing-mention`) 확인합니다. 핑 없이 응답하게 하려면 해당 채널에 `requireMention:false` 를 설정하세요.
- 로그인이 실패하면 닉 가용성과 서버 비밀번호를 확인합니다.
- 사용자 정의 네트워크에서 TLS 가 실패하면 호스트/포트 및 인증서 설정을 확인합니다.
