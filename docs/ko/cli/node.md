---
summary: "`openclaw node`에 대한 CLI 레퍼런스(헤드리스 node 호스트)"
read_when:
  - 헤드리스 node 호스트 실행 시
  - system.run을 위해 macOS가 아닌 node를 페어링할 때
title: "node"
---

# `openclaw node`

Gateway(게이트웨이) WebSocket에 연결하고 이 머신에서
`system.run` / `system.which`을(를) 노출하는 **헤드리스 node 호스트**를 실행합니다.

## 왜 node 호스트를 사용하나요?

네트워크 내의 **다른 머신에서 명령을 실행**하도록 에이전트를 사용하되,
해당 머신에 전체 macOS 컴패니언 앱을 설치하지 않으려는 경우 node 호스트를 사용합니다.

일반적인 사용 사례:

- 원격 Linux/Windows 박스(빌드 서버, 실험실 머신, NAS)에서 명령 실행.
- exec를 Gateway(게이트웨이)에서 **샌드박스화된** 상태로 유지하면서, 승인된 실행을 다른 호스트에 위임.
- 자동화 또는 CI node를 위한 가볍고 헤드리스한 실행 대상 제공.

실행은 여전히 node 호스트의 **exec 승인**과 에이전트별 허용 목록에 의해 보호되므로,
명령 접근을 범위화하고 명시적으로 유지할 수 있습니다.

## 브라우저 프록시(무설정)

node에서 `browser.enabled`이 비활성화되지 않은 경우,
node 호스트는 자동으로 브라우저 프록시를 광고합니다. 이를 통해 추가 구성 없이 해당 node에서 브라우저 자동화를 사용할 수 있습니다.

필요한 경우 node에서 비활성화합니다:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## 실행(포그라운드)

```bash
openclaw node run --host <gateway-host> --port 18789
```

옵션:

- `--host <host>`: Gateway WebSocket 호스트(기본값: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket 포트(기본값: `18789`)
- `--tls`: Gateway(게이트웨이) 연결에 TLS 사용
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문(sha256)
- `--node-id <id>`: node id 재정의(페어링 토큰 초기화)
- `--display-name <name>`: node 표시 이름 재정의

## 서비스(백그라운드)

헤드리스 node 호스트를 사용자 서비스로 설치합니다.

```bash
openclaw node install --host <gateway-host> --port 18789
```

옵션:

- `--host <host>`: Gateway WebSocket 호스트(기본값: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket 포트(기본값: `18789`)
- `--tls`: Gateway(게이트웨이) 연결에 TLS 사용
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문(sha256)
- `--node-id <id>`: node id 재정의(페어링 토큰 초기화)
- `--display-name <name>`: node 표시 이름 재정의
- `--runtime <runtime>`: 서비스 런타임(`node` 또는 `bun`)
- `--force`: 이미 설치된 경우 재설치/덮어쓰기

서비스 관리:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

서비스를 사용하지 않는 포그라운드 node 호스트에는 `openclaw node run`를 사용합니다.

서비스 명령은 기계 판독 가능한 출력을 위해 `--json`을(를) 허용합니다.

## 페어링

첫 연결 시 Gateway(게이트웨이)에 보류 중인 node 페어 요청이 생성됩니다.
다음에서 승인합니다:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

node 호스트는 node id, 토큰, 표시 이름 및 Gateway(게이트웨이) 연결 정보를
`~/.openclaw/node.json`에 저장합니다.

## Exec 승인

`system.run`은(는) 로컬 exec 승인에 의해 제한됩니다:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`(Gateway(게이트웨이)에서 편집)
