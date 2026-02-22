````markdown
---
summary: "`openclaw node` (헤드리스 노드 호스트)의 CLI 참조"
read_when:
  - 헤드리스 노드 호스트 실행
  - 시스템 실행을 위한 비 macOS 노드 페어링
title: "node"
---

# `openclaw node`

게이트웨이 WebSocket 에 연결하고 이 머신에서 `system.run` / `system.which` 를 노출하는 **헤드리스 노드 호스트**를 실행합니다.

## 노드 호스트를 사용하는 이유?

노드 호스트를 사용하면 에이전트가 전체 macOS 동반 앱을 설치하지 않고 네트워크 내의 다른 머신에서 **명령어를 실행**할 수 있습니다.

일반적인 사용 사례:

- 원격 Linux/Windows 서버(빌드 서버, 연구실 머신, NAS)에서 명령어 실행.
- 실행을 게이트웨이에서 **샌드박스 격리**한 상태로 유지하면서 승인된 실행을 다른 호스트에 위임.
- 자동화 또는 CI 노드를 위한 가볍고 헤드리스 실행 타겟 제공.

실행은 여전히 노드 호스트의 **실행 승인**과 에이전트별 허용 목록으로 보호되므로, 명령 액세스를 범위 지정하고 명확하게 유지할 수 있습니다.

## 브라우저 프록시 (제로 구성)

노드 호스트는 `browser.enabled` 가 노드에서 비활성화되지 않은 경우 자동으로 브라우저 프록시를 광고합니다. 이를 통해 에이전트는 추가 구성 없이 해당 노드에서 브라우저 자동화를 사용할 수 있습니다.

필요할 경우 노드에서 비활성화하세요:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```
````

## 실행 (포그라운드)

```bash
openclaw node run --host <gateway-host> --port 18789
```

옵션:

- `--host <host>`: 게이트웨이 WebSocket 호스트 (기본값: `127.0.0.1`)
- `--port <port>`: 게이트웨이 WebSocket 포트 (기본값: `18789`)
- `--tls`: 게이트웨이 연결에 TLS 사용
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문 (sha256)
- `--node-id <id>`: 노드 id 재정의 (페어링 토큰 삭제)
- `--display-name <name>`: 노드 표시 이름 재정의

## 서비스 (백그라운드)

헤드리스 노드 호스트를 사용자 서비스로 설치합니다.

```bash
openclaw node install --host <gateway-host> --port 18789
```

옵션:

- `--host <host>`: 게이트웨이 WebSocket 호스트 (기본값: `127.0.0.1`)
- `--port <port>`: 게이트웨이 WebSocket 포트 (기본값: `18789`)
- `--tls`: 게이트웨이 연결에 TLS 사용
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문 (sha256)
- `--node-id <id>`: 노드 id 재정의 (페어링 토큰 삭제)
- `--display-name <name>`: 노드 표시 이름 재정의
- `--runtime <runtime>`: 서비스 런타임 (`node` 또는 `bun`)
- `--force`: 이미 설치된 경우 재설치/덮어쓰기

서비스 관리:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

포그라운드 노드 호스트(서비스 없음)에는 `openclaw node run`을 사용합니다.

서비스 명령어는 머신 판독 가능한 출력용으로 `--json`을 허용합니다.

## 페어링

첫 연결은 게이트웨이에 보류 중인 노드 페어 요청을 생성합니다. 다음을 통해 승인하세요:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

노드 호스트는 `~/.openclaw/node.json`에 노드 id, 토큰, 표시 이름 및 게이트웨이 연결 정보를 저장합니다.

## 실행 승인

`system.run`은 로컬 실행 승인으로 보호됩니다:

- `~/.openclaw/exec-approvals.json`
- [실행 승인](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (게이트웨이에서 편집)

```

```
