---
read_when:
    - ACP 기반 IDE 통합 설정
    - 게이트웨이로의 ACP 세션 라우팅 디버깅
summary: IDE 통합을 위해 ACP 브리지 실행
title: acp
x-i18n:
    generated_at: "2026-02-08T15:49:58Z"
    model: gtx
    provider: google-translate
    source_hash: 0c09844297da250bc1a558423e7e534d6b6be9045de12d797c07ecd64a0c63ed
    source_path: cli/acp.md
    workflow: 15
---

# acp

OpenClaw 게이트웨이와 통신하는 ACP(에이전트 클라이언트 프로토콜) 브리지를 실행합니다.

이 명령은 IDE용 stdio를 통해 ACP를 말하고 프롬프트를 게이트웨이에 전달합니다.
WebSocket을 통해. 이는 ACP 세션을 게이트웨이 세션 키에 매핑된 상태로 유지합니다.

## 용법

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP 클라이언트(디버그)

내장된 ACP 클라이언트를 사용하여 IDE 없이 브리지의 상태를 확인하세요.
ACP 브리지를 생성하고 대화형으로 프롬프트를 입력할 수 있습니다.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## 이것을 사용하는 방법

IDE(또는 다른 클라이언트)가 에이전트 클라이언트 프로토콜을 말하고 원하는 경우 ACP를 사용하십시오.
OpenClaw Gateway 세션을 구동하는 데 사용됩니다.

1. 게이트웨이가 실행 중인지 확인하십시오(로컬 또는 원격).
2. 게이트웨이 대상(구성 또는 플래그)을 구성합니다.
3. IDE를 실행하도록 지정 `openclaw acp` 스튜디오를 통해.

구성 예시(지속형):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

직접 실행 예시(구성 쓰기 없음):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## 에이전트 선택

ACP는 상담원을 직접 선택하지 않습니다. 게이트웨이 세션 키로 라우팅합니다.

에이전트 범위 세션 키를 사용하여 특정 에이전트를 대상으로 지정합니다.

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

각 ACP 세션은 단일 게이트웨이 세션 키에 매핑됩니다. 하나의 에이전트가 여러 개를 가질 수 있음
세션; ACP는 기본적으로 격리됨 `acp:<uuid>` 재정의하지 않는 한 세션
키 또는 라벨.

## Zed 편집기 설정

사용자 정의 ACP 에이전트 추가 `~/.config/zed/settings.json` (또는 Zed의 설정 UI 사용):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

특정 게이트웨이 또는 에이전트를 대상으로 지정하려면 다음을 수행하세요.

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

Zed에서 에이전트 패널을 열고 "OpenClaw ACP"를 선택하여 스레드를 시작합니다.

## 세션 매핑

기본적으로 ACP 세션은 격리된 게이트웨이 세션 키를 가져옵니다. `acp:` 접두사.
알려진 세션을 재사용하려면 세션 키나 라벨을 전달하세요.

- `--session <key>`: 특정 게이트웨이 세션 키를 사용합니다.
- `--session-label <label>`: 레이블별로 기존 세션을 해결합니다.
- `--reset-session`: 해당 키에 대한 새로운 세션 ID를 생성합니다(동일한 키, 새 기록).

ACP 클라이언트가 메타데이터를 지원하는 경우 세션별로 재정의할 수 있습니다.

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

세션 키에 대해 자세히 알아보세요. [/개념/세션](/concepts/session).

## 옵션

- `--url <url>`: 게이트웨이 WebSocket URL(구성 시 기본값은 Gateway.remote.url)입니다.
- `--token <token>`: 게이트웨이 인증 토큰입니다.
- `--password <password>`: 게이트웨이 인증 비밀번호입니다.
- `--session <key>`: 기본 세션 키.
- `--session-label <label>`: 확인할 기본 세션 레이블입니다.
- `--require-existing`: 세션 키/레이블이 없으면 실패합니다.
- `--reset-session`: 처음 사용하기 전에 세션 키를 재설정하세요.
- `--no-prefix-cwd`: 프롬프트 앞에 작업 디렉터리를 붙이지 마세요.
- `--verbose, -v`: stderr에 대한 자세한 로깅.

### `acp client` 옵션

- `--cwd <dir>`: ACP 세션의 작업 디렉터리입니다.
- `--server <command>`: ACP 서버 명령(기본값: `openclaw`).
- `--server-args <args...>`: ACP 서버에 추가 인수가 전달되었습니다.
- `--server-verbose`: ACP 서버에서 자세한 로깅을 활성화합니다.
- `--verbose, -v`: 자세한 클라이언트 로깅.
