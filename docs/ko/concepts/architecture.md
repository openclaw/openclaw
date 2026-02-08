---
summary: "WebSocket 게이트웨이 아키텍처, 구성 요소 및 클라이언트 흐름"
read_when:
  - 게이트웨이 프로토콜, 클라이언트 또는 전송을 작업할 때
title: "게이트웨이 아키텍처"
x-i18n:
  source_path: concepts/architecture.md
  source_hash: 14079136faa267d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:41Z
---

# 게이트웨이 아키텍처

마지막 업데이트: 2026-01-22

## 개요

- 단일 장기 실행 **Gateway(게이트웨이)** 가 모든 메시징 표면을 소유합니다 (Baileys 를 통한 WhatsApp, grammY 를 통한 Telegram, Slack, Discord, Signal, iMessage, WebChat).
- 제어 플레인 클라이언트 (macOS 앱, CLI, 웹 UI, 자동화)는 구성된 바인드 호스트 (기본값 `127.0.0.1:18789`) 에서 **WebSocket** 을 통해 Gateway(게이트웨이) 에 연결합니다.
- **노드** (macOS / iOS / Android / headless) 또한 **WebSocket** 을 통해 연결하지만, 명시적인 캡스/명령과 함께 `role: node` 을 선언합니다.
- 호스트당 하나의 Gateway(게이트웨이); WhatsApp 세션을 여는 유일한 위치입니다.
- **캔버스 호스트** (기본값 `18793`) 는 에이전트가 편집 가능한 HTML 과 A2UI 를 제공합니다.

## 구성 요소 및 흐름

### Gateway(게이트웨이) (데몬)

- 프로바이더 연결을 유지합니다.
- 타입이 지정된 WS API (요청, 응답, 서버 푸시 이벤트) 를 노출합니다.
- JSON Schema 에 대해 인바운드 프레임을 검증합니다.
- `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron` 과 같은 이벤트를 방출합니다.

### 클라이언트 (mac 앱 / CLI / 웹 관리자)

- 클라이언트당 하나의 WS 연결.
- 요청을 전송합니다 (`health`, `status`, `send`, `agent`, `system-presence`).
- 이벤트를 구독합니다 (`tick`, `agent`, `presence`, `shutdown`).

### 노드 (macOS / iOS / Android / headless)

- `role: node` 과 함께 **동일한 WS 서버** 에 연결합니다.
- `connect` 에 디바이스 ID 를 제공하며; 페어링은 **디바이스 기반** (역할 `node`) 이고
  승인은 디바이스 페어링 저장소에 유지됩니다.
- `canvas.*`, `camera.*`, `screen.record`, `location.get` 과 같은 명령을 노출합니다.

프로토콜 세부 사항:

- [Gateway protocol](/gateway/protocol)

### WebChat

- 채팅 기록과 전송을 위해 Gateway WS API 를 사용하는 정적 UI 입니다.
- 원격 설정에서는 다른 클라이언트와 동일한 SSH / Tailscale 터널을 통해 연결합니다.

## 연결 수명 주기 (단일 클라이언트)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## 와이어 프로토콜 (요약)

- 전송: WebSocket, JSON 페이로드를 포함한 텍스트 프레임.
- 첫 번째 프레임은 **반드시** `connect` 여야 합니다.
- 핸드셰이크 이후:
  - 요청: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 이벤트: `{type:"event", event, payload, seq?, stateVersion?}`
- `OPENCLAW_GATEWAY_TOKEN` (또는 `--token`) 가 설정된 경우, `connect.params.auth.token` 이
  일치해야 하며 그렇지 않으면 소켓이 닫힙니다.
- 부작용이 있는 메서드 (`send`, `agent`) 에 대해서는 안전한 재시도를 위해
  멱등성 키가 필요합니다; 서버는 단기 수명의 중복 제거 캐시를 유지합니다.
- 노드는 `role: "node"` 와 함께 `connect` 에 캡스/명령/권한을 포함해야 합니다.

## 페어링 + 로컬 신뢰

- 모든 WS 클라이언트 (운영자 + 노드) 는 `connect` 에 **디바이스 ID** 를 포함합니다.
- 새로운 디바이스 ID 는 페어링 승인이 필요하며; Gateway(게이트웨이) 는 이후 연결을 위한 **디바이스 토큰** 을 발급합니다.
- **로컬** 연결 (loopback 또는 게이트웨이 호스트 자체의 tailnet 주소) 은
  동일 호스트 UX 를 원활하게 유지하기 위해 자동 승인될 수 있습니다.
- **비로컬** 연결은 `connect.challenge` 논스를 서명해야 하며
  명시적인 승인이 필요합니다.
- Gateway 인증 (`gateway.auth.*`) 은 로컬이든 원격이든 **모든** 연결에 여전히 적용됩니다.

세부 사항: [Gateway protocol](/gateway/protocol), [Pairing](/channels/pairing),
[Security](/gateway/security).

## 프로토콜 타이핑 및 코드 생성

- TypeBox 스키마가 프로토콜을 정의합니다.
- JSON Schema 는 해당 스키마에서 생성됩니다.
- Swift 모델은 JSON Schema 에서 생성됩니다.

## 원격 액세스

- 권장: Tailscale 또는 VPN.
- 대안: SSH 터널

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- 동일한 핸드셰이크 + 인증 토큰이 터널을 통해 적용됩니다.
- 원격 설정에서 WS 에 대해 TLS + 선택적 핀닝을 활성화할 수 있습니다.

## 운영 스냅샷

- 시작: `openclaw gateway` (포그라운드, stdout 로 로그 출력).
- 상태 확인: WS 를 통한 `health` (또한 `hello-ok` 에 포함됨).
- 감독: 자동 재시작을 위한 launchd / systemd.

## 불변 조건

- 정확히 하나의 Gateway(게이트웨이) 가 호스트당 단일 Baileys 세션을 제어합니다.
- 핸드셰이크는 필수이며; JSON 이 아니거나 connect 가 아닌 첫 프레임은 즉시 종료됩니다.
- 이벤트는 재생되지 않으며; 클라이언트는 공백 발생 시 새로 고침해야 합니다.
