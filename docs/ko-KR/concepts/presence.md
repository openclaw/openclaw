---
summary: "OpenClaw presence entries가 어떻게 생성되고, merge되고, 표시되는지"
read_when:
  - Instances 탭 디버깅
  - Duplicate 또는 stale instance rows 조사
  - Gateway WS connect 또는 system-event beacons 변경
title: "Presence"
---

# Presence

OpenClaw "presence"는 lightweight, best‑effort 보기입니다:

- **Gateway** 자체, 및
- **Gateway에 연결된 clients** (mac app, WebChat, CLI, 등)

Presence는 주로 macOS app의 **Instances** 탭을 렌더링하고 빠른 operator visibility를 제공하는 데 사용됩니다.

## Presence 필드 (무엇이 나타나는가)

Presence entries는 다음과 같은 필드를 갖는 구조화된 객체입니다:

- `instanceId` (optional but strongly recommended): stable client identity (usually `connect.client.instanceId`)
- `host`: human‑friendly host name
- `ip`: best‑effort IP address
- `version`: client version string
- `deviceFamily` / `modelIdentifier`: hardware hints
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: "초 since last user input" (알려진 경우)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: last update 타임스탐프 (ms since epoch)

## Producers (presence가 올 곳)

Presence entries는 여러 소스에서 생성되고 **merged**됩니다.

### 1) Gateway self entry

Gateway는 항상 시작 시 "self" entry를 seed하여 UIs가 어떤 clients가 연결되기 전에도 gateway host를 보여줍니다.

### 2) WebSocket connect

모든 WS client는 `connect` 요청으로 시작합니다. Successful handshake에서 Gateway는 그 연결에 대한 presence entry를 upserts합니다.

#### One‑off CLI 명령이 표시되지 않는 이유

CLI는 종종 short, one‑off 명령에 대해 연결됩니다. Instances list를 spamming하지 않으려면, `client.mode === "cli"`는 **not** presence entry로 변환됩니다.

### 3) `system-event` beacons

Clients는 `system-event` 메서드를 통해 richer periodic beacons을 보낼 수 있습니다. Mac app은 이를 사용하여 host name, IP, 및 `lastInputSeconds`를 보고합니다.

### 4) Node connects (role: node)

Node가 `role: node`로 Gateway WebSocket을 통해 연결할 때, Gateway는 그 노드에 대한 presence entry를 upserts합니다 (다른 WS clients와 같은 흐름).

## Merge + dedupe 규칙 (왜 `instanceId`가 중요한가)

Presence entries는 단일 in‑memory map에 저장됩니다:

- Entries는 **presence key**로 keyed됩니다.
- 최고 key는 restarts를 survive하는 stable `instanceId` (from `connect.client.instanceId`)입니다.
- Keys는 case‑insensitive입니다.

Client가 stable `instanceId` 없이 reconnect하는 경우, 그것은 **duplicate** row로 나타날 수 있습니다.

## TTL 및 bounded size

Presence는 intentionally ephemeral입니다:

- **TTL:** 5분보다 오래된 entries는 pruned됩니다
- **Max entries:** 200 (oldest dropped first)

이는 list를 fresh하게 유지하고 unbounded memory growth를 피합니다.

## Remote/tunnel caveat (loopback IPs)

Client가 SSH tunnel / local port forward를 통해 연결할 때, Gateway는 remote address를 `127.0.0.1`로 볼 수 있습니다. Good client‑reported IP를 덮어쓰지 않으려면, loopback remote addresses는 무시됩니다.

## Consumers

### macOS Instances 탭

macOS app은 `system-presence`의 출력을 렌더링하고 last update의 나이에 기반한 small status indicator (Active/Idle/Stale)를 적용합니다.

## 디버깅 팁

- Raw list를 보려면 Gateway에 대해 `system-presence`을 호출합니다.
- Duplicates를 보는 경우:
  - clients가 handshake에서 stable `client.instanceId`를 send하는지 확인합니다
  - periodic beacons가 같은 `instanceId`를 사용하는지 확인합니다
  - connection‑derived entry가 `instanceId`를 missing하는지 확인합니다 (duplicates are expected)
