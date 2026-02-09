---
summary: "IDE 통합을 위한 ACP 브리지를 실행합니다"
read_when:
  - ACP 기반 IDE 통합을 설정할 때
  - Gateway(게이트웨이)로의 ACP 세션 라우팅을 디버깅할 때
title: "acp"
---

# acp

OpenClaw Gateway(게이트웨이)와 통신하는 ACP (Agent Client Protocol) 브리지를 실행합니다.

이 명령은 IDE 를 위해 stdio 상에서 ACP 를 사용하여 통신하고, 프롬프트를 WebSocket 을 통해 Gateway(게이트웨이)로 전달합니다. ACP 세션을 Gateway(게이트웨이) 세션 키에 매핑하여 유지합니다.

## Usage

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

## ACP client (debug)

내장된 ACP 클라이언트를 사용하여 IDE 없이 브리지를 간단히 점검할 수 있습니다.
ACP 브리지를 생성하고 프롬프트를 대화형으로 입력할 수 있게 합니다.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## How to use this

IDE (또는 다른 클라이언트)가 Agent Client Protocol 을 사용하고, OpenClaw Gateway(게이트웨이) 세션을 구동하려는 경우 ACP 를 사용하십시오.

1. Gateway(게이트웨이)가 실행 중인지 확인합니다 (로컬 또는 원격).
2. Gateway(게이트웨이) 대상(구성 또는 플래그)을 설정합니다.
3. IDE 가 stdio 를 통해 `openclaw acp` 를 실행하도록 지정합니다.

예시 구성(영구 저장):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

직접 실행 예시(구성 파일 미작성):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

ACP 는 에이전트를 직접 선택하지 않습니다. Gateway(게이트웨이) 세션 키로 라우팅합니다.

특정 에이전트를 대상으로 하려면 에이전트 범위의 세션 키를 사용하십시오:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

각 ACP 세션은 단일 Gateway(게이트웨이) 세션 키에 매핑됩니다. 하나의 에이전트는 여러 세션을 가질 수 있으며, 키 또는 레이블을 재정의하지 않는 한 ACP 는 기본적으로 격리된 `acp:<uuid>` 세션을 사용합니다.

## Zed editor setup

`~/.config/zed/settings.json` 에 사용자 정의 ACP 에이전트를 추가하십시오 (또는 Zed 의 Settings UI 를 사용하십시오):

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

특정 Gateway(게이트웨이) 또는 에이전트를 대상으로 하려면 다음을 사용하십시오:

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

Zed 에서 Agent 패널을 열고 “OpenClaw ACP” 를 선택하여 스레드를 시작합니다.

## Session mapping

기본적으로 ACP 세션은 `acp:` 접두사가 있는 격리된 Gateway(게이트웨이) 세션 키를 받습니다.
알려진 세션을 재사용하려면 세션 키 또는 레이블을 전달하십시오:

- `--session <key>`: 특정 Gateway(게이트웨이) 세션 키를 사용합니다.
- `--session-label <label>`: 레이블로 기존 세션을 해석합니다.
- `--reset-session`: 해당 키에 대해 새로운 세션 id 를 발급합니다 (같은 키, 새 트랜스크립트).

ACP 클라이언트가 메타데이터를 지원하는 경우, 세션별로 재정의할 수 있습니다:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

세션 키에 대한 자세한 내용은 [/concepts/session](/concepts/session) 을 참고하십시오.

## Options

- `--url <url>`: Gateway(게이트웨이) WebSocket URL (구성된 경우 gateway.remote.url 이 기본값입니다).
- `--token <token>`: Gateway(게이트웨이) 인증 토큰.
- `--password <password>`: Gateway(게이트웨이) 인증 비밀번호.
- `--session <key>`: 기본 세션 키.
- `--session-label <label>`: 해석할 기본 세션 레이블.
- `--require-existing`: 세션 키/레이블이 존재하지 않으면 실패합니다.
- `--reset-session`: 최초 사용 전에 세션 키를 재설정합니다.
- `--no-prefix-cwd`: 작업 디렉토리로 프롬프트를 접두하지 않습니다.
- `--verbose, -v`: stderr 로 상세 로그를 출력합니다.

### `acp client` options

- `--cwd <dir>`: ACP 세션의 작업 디렉토리.
- `--server <command>`: ACP 서버 명령 (기본값: `openclaw`).
- `--server-args <args...>`: ACP 서버에 전달되는 추가 인수.
- `--server-verbose`: ACP 서버에서 상세 로그를 활성화합니다.
- `--verbose, -v`: 상세 클라이언트 로그입니다.
