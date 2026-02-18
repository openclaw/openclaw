````markdown
---
summary: "IDE 통합을 위한 ACP 브리지 실행"
read_when:
  - ACP 기반의 IDE 통합 설정
  - 게이트웨이에 대한 ACP 세션 라우팅 디버깅
title: "acp"
---

# acp

OpenClaw 게이트웨이와 통신하는 ACP (에이전트 클라이언트 프로토콜) 브리지를 실행합니다.

이 명령어는 IDE를 위해 표준 입출력으로 ACP를 사용하여 게이트웨이로 프롬프트를 WebSocket을 통해 전달합니다. 또한 ACP 세션을 게이트웨이 세션 키에 매핑합니다.

## 사용법

```bash
openclaw acp

# 원격 게이트웨이
openclaw acp --url wss://gateway-host:18789 --token <token>

# 기존 세션 키에 연결
openclaw acp --session agent:main:main

# 레이블로 연결 (이미 존재해야 함)
openclaw acp --session-label "support inbox"

# 첫 번째 프롬프트 전에 세션 키 재설정
openclaw acp --session agent:main:main --reset-session
```
````

## ACP 클라이언트 (디버그)

내장된 ACP 클라이언트를 사용하여 IDE 없이 브리지를 무결성 검사합니다.
ACP 브리지를 스폰하고 상호작용적으로 프롬프트를 입력할 수 있습니다.

```bash
openclaw acp client

# 스폰된 브리지를 원격 게이트웨이에 연결
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# 서버 명령어 재정의 (기본값: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## 사용 방법

IDE (또는 기타 클라이언트)가 에이전트 클라이언트 프로토콜을 사용하고 OpenClaw 게이트웨이 세션을 실행하려는 경우 ACP를 사용하십시오.

1. 게이트웨이가 실행 중인지 확인하십시오 (로컬 또는 원격).
2. 게이트웨이 대상을 구성하십시오 (설정 또는 플래그).
3. IDE가 `openclaw acp`를 표준 입출력으로 실행하도록 지정하십시오.

예시 설정 (영구 저장):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

예시 직접 실행 (설정 기록 없음):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## 에이전트 선택

ACP는 에이전트를 직접 선택하지 않습니다. 게이트웨이 세션 키로 라우팅됩니다.

특정 에이전트를 대상으로 하려면 에이전트 범위의 세션 키를 사용하십시오:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

각 ACP 세션은 하나의 게이트웨이 세션 키에 매핑됩니다. 하나의 에이전트는 여러 세션을 가질 수 있으며, ACP는 키 또는 레이블을 재정의하지 않는 한 기본적으로 격리된 `acp:<uuid>` 세션을 사용합니다.

## Zed 편집기 설정

`~/.config/zed/settings.json`에 사용자 정의 ACP 에이전트를 추가하십시오 (또는 Zed의 설정 UI 사용):

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

특정 게이트웨이 또는 에이전트를 대상으로 하려면:

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

Zed에서 에이전트 패널을 열고 "OpenClaw ACP"를 선택하여 스레드를 시작하십시오.

## 세션 매핑

기본적으로, ACP 세션은 `acp:` 접두사가 붙은 격리된 게이트웨이 세션 키를 받습니다.
알려진 세션을 재사용하려면, 세션 키 또는 레이블을 전달하십시오:

- `--session <key>`: 특정 게이트웨이 세션 키 사용.
- `--session-label <label>`: 레이블로 기존 세션 해결.
- `--reset-session`: 해당 키에 대한 새 세션 ID 생성 (같은 키, 새 트랜스크립트).

ACP 클라이언트가 메타데이터를 지원하는 경우, 세션당 재정의할 수 있습니다:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

세션 키에 대한 자세한 내용은 [/concepts/session](/concepts/session)에서 알아보십시오.

## 옵션

- `--url <url>`: 게이트웨이 WebSocket URL (설정시 기본값은 gateway.remote.url).
- `--token <token>`: 게이트웨이 인증 토큰.
- `--password <password>`: 게이트웨이 인증 비밀번호.
- `--session <key>`: 기본 세션 키.
- `--session-label <label>`: 해결할 기본 세션 레이블.
- `--require-existing`: 세션 키/레이블이 존재하지 않으면 실패.
- `--reset-session`: 첫 사용 전에 세션 키 재설정.
- `--no-prefix-cwd`: 프롬프트에 작업 디렉토리를 접두사로 붙이지 않음.
- `--verbose, -v`: stderr에 자세한 로그 출력.

### `acp client` 옵션

- `--cwd <dir>`: ACP 세션의 작업 디렉토리.
- `--server <command>`: ACP 서버 명령어 (기본값: `openclaw`).
- `--server-args <args...>`: ACP 서버에 전달할 추가 인자.
- `--server-verbose`: ACP 서버에서 자세한 로깅 활성화.
- `--verbose, -v`: 클라이언트 자세한 로깅.

```

```
