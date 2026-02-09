---
summary: "OpenClaw presence 항목이 어떻게 생성, 병합, 표시되는지에 대한 설명"
read_when:
  - Instances 탭을 디버깅할 때
  - 중복되거나 오래된 인스턴스 행을 조사할 때
  - Gateway WS 연결 또는 시스템 이벤트 비콘을 변경할 때
title: "Presence"
---

# Presence

OpenClaw 'presence'는 다음에 대한 가볍고 최선의 노력(best‑effort) 기반 뷰입니다.

- **Gateway(게이트웨이)** 자체, 그리고
- **Gateway에 연결된 클라이언트**(mac 앱, WebChat, CLI 등)

Presence는 주로 macOS 앱의 **Instances** 탭을 렌더링하고
운영자에게 빠른 가시성을 제공하는 데 사용됩니다.

## Presence 필드(표시되는 항목)

Presence 항목은 다음과 같은 필드를 갖는 구조화된 객체입니다.

- `instanceId` (선택 사항이지만 강력히 권장됨): 안정적인 클라이언트 식별자(일반적으로 `connect.client.instanceId`)
- `host`: 사람이 읽기 쉬운 호스트 이름
- `ip`: 최선의 노력 기반 IP 주소
- `version`: 클라이언트 버전 문자열
- `deviceFamily` / `modelIdentifier`: 하드웨어 힌트
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: '마지막 사용자 입력 이후 경과 시간(초)'(알 수 있는 경우)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: 마지막 업데이트 타임스탬프(epoch 이후 ms)

## Producers(presence가 생성되는 위치)

Presence 항목은 여러 소스에서 생성되며 **병합**됩니다.

### 1. Gateway 자체 항목

Gateway는 시작 시 항상 'self' 항목을 시드로 생성하므로,
아직 클라이언트가 연결되지 않았더라도 UI에 게이트웨이 호스트가 표시됩니다.

### 2. WebSocket 연결

모든 WS 클라이언트는 `connect` 요청으로 시작합니다. 핸드셰이크가
성공하면 Gateway는 해당 연결에 대한 presence 항목을 업서트합니다.

#### 일회성 CLI 명령이 표시되지 않는 이유

CLI는 종종 짧은 일회성 명령을 위해 연결됩니다. Instances 목록이
과도하게 늘어나는 것을 방지하기 위해 `client.mode === "cli"`는
presence 항목으로 **변환되지 않습니다**.

### 3. `system-event` 비콘

클라이언트는 `system-event` 메서드를 통해 더 풍부한 주기적 비콘을
보낼 수 있습니다. mac 앱은 이를 사용해 호스트 이름, IP, 그리고
`lastInputSeconds`를 보고합니다.

### 4. 노드 연결(role: node)

노드가 `role: node`로 Gateway WebSocket에 연결되면,
Gateway는 해당 노드에 대한 presence 항목을 업서트합니다
(다른 WS 클라이언트와 동일한 흐름).

## 병합 + 중복 제거 규칙(`instanceId`가 중요한 이유)

Presence 항목은 단일 인메모리 맵에 저장됩니다.

- 항목은 **presence 키**로 식별됩니다.
- 가장 좋은 키는 재시작 후에도 유지되는 안정적인 `instanceId`
  (`connect.client.instanceId`에서 제공됨)입니다.
- 키는 대소문자를 구분하지 않습니다.

클라이언트가 안정적인 `instanceId` 없이 재연결하면
**중복** 행으로 표시될 수 있습니다.

## TTL 및 크기 제한

Presence는 의도적으로 일시적입니다.

- **TTL:** 5분보다 오래된 항목은 제거됩니다.
- **최대 항목 수:** 200개(가장 오래된 항목부터 제거)

이를 통해 목록을 신선하게 유지하고 메모리의 무한한 증가를 방지합니다.

## 원격/터널 주의 사항(loopback IP)

클라이언트가 SSH 터널 또는 로컬 포트 포워딩을 통해 연결되면,
Gateway는 원격 주소를 `127.0.0.1`로 인식할 수 있습니다. 정상적인 클라이언트 보고 IP를 덮어쓰는 것을 방지하기 위해
loopback 원격 주소는 무시됩니다.

## Consumers

### macOS Instances 탭

macOS 앱은 `system-presence`의 출력을 렌더링하고,
마지막 업데이트의 경과 시간에 따라 작은 상태 표시기
(Active/Idle/Stale)를 적용합니다.

## 디버깅 팁

- 원시 목록을 보려면 Gateway를 대상으로 `system-presence`를 호출하십시오.
- 중복이 보이는 경우:
  - 클라이언트가 핸드셰이크에서 안정적인 `client.instanceId`를 보내는지 확인하십시오.
  - 주기적 비콘이 동일한 `instanceId`를 사용하는지 확인하십시오.
  - 연결에서 파생된 항목에 `instanceId`가 누락되어 있는지 확인하십시오
    (이 경우 중복은 예상된 동작입니다).
