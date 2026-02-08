---
read_when:
    - 헤드리스 노드 호스트 실행
    - system.run을 위해 비 macOS 노드 페어링
summary: '`openclaw node`(헤드리스 노드 호스트)에 대한 CLI 참조'
title: 마디
x-i18n:
    generated_at: "2026-02-08T15:53:38Z"
    model: gtx
    provider: google-translate
    source_hash: a8b1a57712663e2285c9ecd306fe57d067eb3e6820d7d8aec650b41b022d995a
    source_path: cli/node.md
    workflow: 15
---

# `openclaw node`

실행 **헤드리스 노드 호스트** Gateway WebSocket에 연결하여 노출합니다.
`system.run` / `system.which` 이 기계에.

## 노드 호스트를 사용하는 이유는 무엇입니까?

에이전트가 원하는 경우 노드 호스트를 사용하십시오. **다른 컴퓨터에서 명령 실행** 당신의
전체 macOS 동반 앱을 설치하지 않고도 네트워크에 연결할 수 있습니다.

일반적인 사용 사례:

- 원격 Linux/Windows 상자(빌드 서버, 랩 머신, NAS)에서 명령을 실행합니다.
- 계속 임원 **샌드박스 처리된** 게이트웨이에 있지만 승인된 실행을 다른 호스트에 위임합니다.
- 자동화 또는 CI 노드를 위한 경량의 헤드리스 실행 대상을 제공합니다.

처형은 여전히 ​​​​에 의해 보호됩니다. **임원 승인** 및 에이전트별 허용 목록
노드 호스트이므로 명령 액세스 범위를 명시적으로 유지할 수 있습니다.

## 브라우저 프록시(제로 구성)

노드 호스트는 다음과 같은 경우 자동으로 브라우저 프록시를 광고합니다. `browser.enabled` 아니다
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

- `--host <host>`: 게이트웨이 WebSocket 호스트(기본값: `127.0.0.1`)
- `--port <port>`: 게이트웨이 WebSocket 포트(기본값: `18789`)
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

- `--host <host>`: 게이트웨이 WebSocket 호스트(기본값: `127.0.0.1`)
- `--port <port>`: 게이트웨이 WebSocket 포트(기본값: `18789`)
- `--tls`: 게이트웨이 연결에 TLS를 사용합니다.
- `--tls-fingerprint <sha256>`: 예상 TLS 인증서 지문(sha256)
- `--node-id <id>`: 노드 ID 재정의(페어링 토큰 삭제)
- `--display-name <name>`: 노드 표시 이름을 재정의합니다.
- `--runtime <runtime>`: 서비스 런타임(`node` 또는 `bun`)
- `--force`: 이미 설치된 경우 다시 설치/덮어쓰기

서비스 관리:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

사용 `openclaw node run` 포그라운드 노드 호스트의 경우(서비스 없음)

서비스 명령이 허용됩니다. `--json` 기계가 읽을 수 있는 출력을 위해.

## 편성

첫 번째 연결은 게이트웨이에서 보류 중인 노드 쌍 요청을 생성합니다.
다음을 통해 승인하세요.

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

노드 호스트는 노드 ID, 토큰, 표시 이름 및 게이트웨이 연결 정보를 저장합니다.
`~/.openclaw/node.json`.

## 임원 승인

`system.run` 현지 임원의 승인을 받아 관리됩니다.

- `~/.openclaw/exec-approvals.json`
- [임원 승인](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (게이트웨이에서 편집)
