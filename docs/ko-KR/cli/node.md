---
summary: "헤드리스 노드 호스트를 위한 CLI 참조"
read_when:
  - 헤드리스 노드 호스트를 실행할 때
  - system.run 에 대해 비 macOS 노드를 페어링할 때
title: "node"
---

# `openclaw node`

Gateway WebSocket 에 연결하고 이 기계에서 `system.run` / `system.which` 을 노출하는 **헤드리스 노드 호스트** 를 실행합니다.

## 노드 호스트를 사용하는 이유?

다른 기계에서 명령을 **실행** 하려고 할 때 노드 호스트를 사용합니다 (전체 macOS 동반 앱을 설치하지 않고).

일반적인 사용 사례:

- 원격 Linux/Windows 상자에서 명령 실행 (빌드 서버, 랩 기계, NAS).
- Gateway 에서 실행을 **샌드박스** 로 유지하지만 승인된 실행을 다른 호스트로 위임.
- 자동화 또는 CI 노드에 대한 경량의 헤드리스 실행 대상 제공.

## 실행 (포어그라운드)

```bash
openclaw node run --host <gateway-host> --port 18789
```

옵션:

- `--host <host>`: Gateway WebSocket 호스트 (기본값: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket 포트 (기본값: `18789`)
- `--tls`: Gateway 연결에 TLS 사용
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문 (sha256)
- `--node-id <id>`: 노드 id 무시 (페어링 토큰 지우기)
- `--display-name <name>`: 노드 표시 이름 무시

## 서비스 (백그라운드)

헤드리스 노드 호스트를 사용자 서비스로 설치합니다.

```bash
openclaw node install --host <gateway-host> --port 18789
```

옵션:

- `--host <host>`: Gateway WebSocket 호스트 (기본값: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket 포트 (기본값: `18789`)
- `--tls`: Gateway 연결에 TLS 사용
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문 (sha256)
- `--node-id <id>`: 노드 id 무시 (페어링 토큰 지우기)
- `--display-name <name>`: 노드 표시 이름 무시
- `--runtime <runtime>`: 서비스 런타임 (`node` 또는 `bun`)
- `--force`: 이미 설치된 경우 재설치/덮어쓰기

서비스 관리:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

포어그라운드 노드 호스트는 `openclaw node run` 을 사용합니다 (서비스 아님).

서비스 명령은 머신이 읽을 수 있는 출력을 위해 `--json` 을 허용합니다.

## 페어링

첫 번째 연결은 Gateway 에서 대기 중인 노드 쌍 요청을 생성합니다.
다음을 통해 승인합니다:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

노드 호스트는 노드 ID, 토큰, 표시 이름 및 Gateway 연결 정보를 `~/.openclaw/node.json` 에 저장합니다.

## 실행 승인

`system.run` 은 로컬 실행 승인으로 게이트됩니다:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (Gateway 에서 편집)

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/node.md
workflow: 15
