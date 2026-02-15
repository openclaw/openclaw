---
summary: "How OpenClaw presence entries are produced, merged, and displayed"
read_when:
  - Debugging the Instances tab
  - Investigating duplicate or stale instance rows
  - Changing gateway WS connect or system-event beacons
title: "Presence"
x-i18n:
  source_hash: c752c76a880878fed673d656db88beb5dbdeefff2491985127ad791521f97d00
---

# 존재감

OpenClaw "현재 상태"는 다음에 대한 경량의 최선의 노력 보기입니다.

- **게이트웨이** 자체 및
- **Gateway에 연결된 클라이언트**(mac app, WebChat, CLI 등)

현재 상태는 주로 macOS 앱의 **인스턴스** 탭을 렌더링하고
빠른 운영자 가시성을 제공합니다.

## 현재 상태 필드(표시되는 항목)

현재 상태 항목은 다음과 같은 필드가 포함된 구조화된 개체입니다.

- `instanceId` (선택 사항이지만 강력히 권장됨): 안정적인 클라이언트 ID(보통 `connect.client.instanceId`)
- `host`: 인간 친화적인 호스트 이름
- `ip`: 최선의 IP 주소
- `version`: 클라이언트 버전 문자열
- `deviceFamily` / `modelIdentifier`: 하드웨어 힌트
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: "마지막 사용자 입력 이후 초"(알고 있는 경우)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: 마지막 업데이트 타임스탬프(epoch 이후 ms)

## 프로듀서(존재감이 어디서 오는가)

현재 상태 항목은 여러 소스에서 생성되고 **병합**됩니다.

### 1) 게이트웨이 자체 진입

게이트웨이는 시작 시 항상 "자체" 항목을 시드하므로 UI에 게이트웨이 호스트가 표시됩니다.
클라이언트가 연결되기 전에도 마찬가지입니다.

### 2) 웹소켓 연결

모든 WS 클라이언트는 `connect` 요청으로 시작됩니다. 성공적인 핸드셰이크에서는
게이트웨이는 해당 연결에 대한 현재 상태 항목을 업데이트합니다.

#### 일회성 CLI 명령이 표시되지 않는 이유

CLI는 짧은 일회성 명령을 위해 연결되는 경우가 많습니다. 스팸메일을 방지하려면
인스턴스 목록, `client.mode === "cli"`는 존재 항목으로 바뀌지 **않습니다**.

### 3) `system-event` 비콘

클라이언트는 `system-event` 메소드를 통해 더욱 풍부한 주기적인 비콘을 보낼 수 있습니다. 맥
앱은 이를 사용하여 호스트 이름, IP 및 `lastInputSeconds`를 보고합니다.

### 4) 노드 연결(역할: 노드)

노드가 `role: node`를 사용하여 게이트웨이 WebSocket을 통해 연결하면 게이트웨이
해당 노드에 대한 존재 항목을 업데이트합니다(다른 WS 클라이언트와 동일한 흐름).

## 병합 + 중복 제거 규칙(`instanceId`이 중요한 이유)

현재 상태 항목은 단일 메모리 내 맵에 저장됩니다.

- 항목은 **현재 상태 키**로 입력됩니다.
- 가장 좋은 키는 다시 시작해도 살아남는 안정적인 `instanceId` (`connect.client.instanceId`에서)입니다.
- 키는 대소문자를 구분하지 않습니다.

클라이언트가 안정적인 `instanceId` 없이 다시 연결하는 경우
**중복** 행.

## TTL 및 제한된 크기

현재 상태는 의도적으로 일시적입니다.

- **TTL:** 5분보다 오래된 항목은 정리됩니다.
- **최대 항목 수:** 200(오래된 항목부터 삭제)

이렇게 하면 목록이 최신 상태로 유지되고 메모리가 무제한으로 늘어나는 것을 방지할 수 있습니다.

## 원격/터널 주의 사항(루프백 IP)

클라이언트가 SSH 터널/로컬 포트 전달을 통해 연결할 때 게이트웨이는 다음을 수행할 수 있습니다.
원격 주소는 `127.0.0.1`로 확인하세요. 클라이언트가 보고한 좋은 내용을 덮어쓰지 않으려면
IP, 루프백 원격 주소는 무시됩니다.

## 소비자

### macOS 인스턴스 탭

macOS 앱은 `system-presence`의 출력을 렌더링하고 작은 상태를 적용합니다.
마지막 업데이트 기간을 기준으로 한 표시기(활성/유휴/부실)입니다.

## 디버깅 팁

- 원시 목록을 보려면 게이트웨이에 대해 `system-presence`를 호출하십시오.
- 중복된 항목이 있는 경우:
  - 클라이언트가 핸드셰이크에서 안정적인 `client.instanceId`를 보내는지 확인합니다.
  - 주기적인 비콘이 동일한 것을 사용하는지 확인하세요 `instanceId`
  - 연결 파생 항목이 누락되었는지 확인합니다. `instanceId` (중복이 예상됨)
