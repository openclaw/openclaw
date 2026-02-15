---
summary: "CLI reference for `openclaw node` (headless node host)"
read_when:
  - Running the headless node host
  - Pairing a non-macOS node for system.run
title: "node"
x-i18n:
  source_hash: a8b1a57712663e2285c9ecd306fe57d067eb3e6820d7d8aec650b41b022d995a
---

# `openclaw node`

Gateway WebSocket에 연결하고 노출하는 **헤드리스 노드 호스트**를 실행합니다.
`system.run` / `system.which` 이 머신에 있습니다.

## 노드 호스트를 사용하는 이유는 무엇인가요?

에이전트가 **다른 컴퓨터에서 명령을 실행**하도록 하려는 경우 노드 호스트를 사용합니다.
전체 macOS 동반 앱을 설치하지 않고도 네트워크에 연결할 수 있습니다.

일반적인 사용 사례:

- 원격 Linux/Windows 상자(빌드 서버, 랩 머신, NAS)에서 명령을 실행합니다.
- 게이트웨이에서 실행 **샌드박스**를 유지하지만 승인된 실행을 다른 호스트에 위임합니다.
- 자동화 또는 CI 노드를 위한 경량의 헤드리스 실행 대상을 제공합니다.

실행은 여전히 **실행 승인** 및 에이전트별 허용 목록에 의해 보호됩니다.
노드 호스트이므로 명령 액세스 범위를 명시적으로 유지할 수 있습니다.

## 브라우저 프록시(제로 구성)

`browser.enabled`가 아닌 경우 노드 호스트는 자동으로 브라우저 프록시를 광고합니다.
노드에서 비활성화되었습니다. 이렇게 하면 에이전트가 해당 노드에서 브라우저 자동화를 사용할 수 있습니다.
추가 구성 없이.

필요한 경우 노드에서 비활성화합니다.

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## 실행(전경)

```bash
openclaw node run --host <gateway-host> --port 18789
```

옵션:

- `--host <host>`: 게이트웨이 WebSocket 호스트 (기본값: `127.0.0.1`)
- `--port <port>`: 게이트웨이 WebSocket 포트 (기본값: `18789`)
- `--tls`: 게이트웨이 연결에 TLS를 사용합니다.
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문(sha256)
- `--node-id <id>`: 노드 ID 재정의(페어링 토큰 삭제)
- `--display-name <name>`: 노드 표시 이름을 재정의합니다.

## 서비스(백그라운드)

헤드리스 노드 호스트를 사용자 서비스로 설치합니다.

```bash
openclaw node install --host <gateway-host> --port 18789
```

옵션:

- `--host <host>`: 게이트웨이 WebSocket 호스트 (기본값: `127.0.0.1`)
- `--port <port>`: 게이트웨이 WebSocket 포트 (기본값: `18789`)
- `--tls`: 게이트웨이 연결에 TLS를 사용합니다.
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문(sha256)
- `--node-id <id>`: 노드 ID 재정의(페어링 토큰 삭제)
- `--display-name <name>`: 노드 표시 이름을 재정의합니다.
- `--runtime <runtime>`: 서비스 런타임 (`node` 또는 `bun`)
- `--force`: 이미 설치되어 있는 경우 재설치/덮어쓰기

서비스 관리:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

포그라운드 노드 호스트(서비스 없음)에는 `openclaw node run`를 사용합니다.

서비스 명령은 기계가 읽을 수 있는 출력에 대해 `--json`를 허용합니다.

## 페어링

첫 번째 연결은 게이트웨이에서 보류 중인 노드 쌍 요청을 생성합니다.
다음을 통해 승인하세요.

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

노드 호스트는 노드 ID, 토큰, 표시 이름 및 게이트웨이 연결 정보를 저장합니다.
`~/.openclaw/node.json`.

## 임원 승인

`system.run`는 현지 임원 승인에 의해 관리됩니다.

- `~/.openclaw/exec-approvals.json`
- [실행 승인](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (게이트웨이에서 편집)
