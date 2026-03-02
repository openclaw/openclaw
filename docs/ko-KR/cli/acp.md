---
summary: "IDE 통합을 위한 ACP 브리지 실행"
read_when:
  - ACP 기반 IDE 통합을 설정할 때
  - ACP 세션 라우팅을 Gateway 로 디버깅할 때
title: "acp"
---

# acp

OpenClaw Gateway 와 통신하는 [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 브리지를 실행합니다.

이 명령은 IDE 에 대해 ACP 를 stdio 로 처리하고 WebSocket 을 통해 Gateway 로 프롬프트를 전달합니다. Gateway 세션 키에 ACP 세션을 매핑하여 유지합니다.

## 사용법

```bash
openclaw acp

# 원격 Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# 원격 Gateway (파일에서 토큰)
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 기존 세션 키에 연결
openclaw acp --session agent:main:main

# 라벨로 연결 (이미 존재해야 함)
openclaw acp --session-label "support inbox"

# 첫 프롬프트 전에 세션 키 초기화
openclaw acp --session agent:main:main --reset-session
```

## ACP 클라이언트 (디버깅)

IDE 없이 브리지를 검증하기 위해 기본 제공 ACP 클라이언트를 사용합니다.
ACP 브리지를 생성하고 프롬프트를 대화형으로 입력하도록 합니다.

```bash
openclaw acp client

# 생성된 브리지를 원격 Gateway 로 지정
openclaw acp client --server-args --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# 서버 명령 무시 (기본값: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

권한 모델 (클라이언트 디버그 모드):

- 자동 승인은 허용 목록 기반이며 신뢰할 수 있는 핵심 도구 ID 만 적용합니다.
- `read` 자동 승인은 현재 작업 디렉토리로 범위 지정됩니다 (`--cwd` 설정 시).
- 알 수 없는/핵심이 아닌 도구 이름, 범위 외 읽기 및 위험한 도구는 항상 명시적 프롬프트 승인이 필요합니다.
- 서버 제공 `toolCall.kind` 는 신뢰할 수 없는 메타데이터로 처리됩니다 (인증 출처 아님).

## 이 기능을 사용하는 방법

IDE (또는 기타 클라이언트) 가 Agent Client Protocol 을 사용하고 OpenClaw Gateway 세션을 구동하려고 할 때 ACP 를 사용합니다.

1. Gateway 가 실행 중인지 확인합니다 (로컬 또는 원격).
2. Gateway 대상을 구성합니다 (구성 또는 플래그).
3. IDE 를 `openclaw acp` 를 stdio 로 실행하도록 지정합니다.

예시 구성 (지속):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

예시 직접 실행 (구성 쓰기 없음):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
# 로컬 프로세스 안전을 위해 선호됨
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
```

## 에이전트 선택

ACP 는 에이전트를 직접 선택하지 않습니다. Gateway 세션 키로 라우팅합니다.

특정 에이전트를 대상으로 하기 위해 에이전트 범위의 세션 키를 사용합니다:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

각 ACP 세션은 단일 Gateway 세션 키에 매핑됩니다. 하나의 에이전트는 많은 세션을 가질 수 있습니다. ACP 는 키를 무시하거나 라벨을 무시하지 않으면 격리된 `acp:<uuid>` 세션으로 기본값을 설정합니다.

## Zed 편집기 설정

`~/.config/zed/settings.json` 에서 커스텀 ACP 에이전트를 추가하거나 Zed 의 설정 UI 를 사용합니다:

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

특정 Gateway 또는 에이전트를 대상으로 하려면:

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

Zed 에서 에이전트 패널을 열고 "OpenClaw ACP" 를 선택하여 스레드를 시작합니다.

## 세션 매핑

기본적으로 ACP 세션은 `acp:` 접두사가 있는 격리된 Gateway 세션 키를 얻습니다.
알려진 세션을 재사용하려면 세션 키 또는 라벨을 전달합니다:

- `--session <key>`: 특정 Gateway 세션 키를 사용합니다.
- `--session-label <label>`: 라벨로 기존 세션을 해결합니다.
- `--reset-session`: 해당 키에 대한 새로운 세션 ID 를 생성합니다 (동일 키, 새 트랜스크립트).

ACP 클라이언트가 메타데이터를 지원하면 세션당 무시할 수 있습니다:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

[/concepts/session](/concepts/session) 에서 세션 키에 대해 자세히 알아봅니다.

## 옵션

- `--url <url>`: Gateway WebSocket URL (기본값: gateway.remote.url 구성됨).
- `--token <token>`: Gateway 인증 토큰.
- `--token-file <path>`: 파일에서 Gateway 인증 토큰을 읽습니다.
- `--password <password>`: Gateway 인증 비밀번호.
- `--password-file <path>`: 파일에서 Gateway 인증 비밀번호를 읽습니다.
- `--session <key>`: 기본 세션 키.
- `--session-label <label>`: 해결할 기본 세션 라벨.
- `--require-existing`: 세션 키/라벨이 없으면 실패합니다.
- `--reset-session`: 첫 사용 전에 세션 키를 초기화합니다.
- `--no-prefix-cwd`: 프롬프트에 작업 디렉토리를 접두사로 하지 않습니다.
- `--verbose, -v`: stderr 로의 상세 로깅.

보안 참고:

- `--token` 및 `--password` 는 일부 시스템에서 로컬 프로세스 목록에서 보일 수 있습니다.
- `--token-file`/`--password-file` 또는 환경 변수 (`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD`) 를 선호합니다.

### `acp client` 옵션

- `--cwd <dir>`: ACP 세션의 작업 디렉토리.
- `--server <command>`: ACP 서버 명령 (기본값: `openclaw`).
- `--server-args <args...>`: ACP 서버로 전달된 추가 인수.
- `--server-verbose`: ACP 서버에서 상세 로깅을 활성화합니다.
- `--verbose, -v`: 상세 클라이언트 로깅.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/acp.md
workflow: 15
