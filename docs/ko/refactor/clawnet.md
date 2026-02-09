---
summary: "Clawnet 리팩터: 네트워크 프로토콜, 역할, 인증, 승인, 아이덴티티 통합"
read_when:
  - 노드 + 운영자 클라이언트를 위한 통합 네트워크 프로토콜을 계획할 때
  - 디바이스 전반의 승인, 페어링, TLS, 프레즌스를 재설계할 때
title: "Clawnet 리팩터"
---

# Clawnet 리팩터 (프로토콜 + 인증 통합)

## 인사

안녕하세요 Peter — 아주 좋은 방향입니다. 더 단순한 UX 와 더 강력한 보안을 동시에 열어줍니다.

## 목적

다음을 하나로 묶은 단일하고 엄밀한 문서입니다.

- 현재 상태: 프로토콜, 플로우, 신뢰 경계.
- 문제점: 승인, 멀티 홉 라우팅, UI 중복.
- 제안하는 신규 상태: 하나의 프로토콜, 범위가 있는 역할, 통합 인증/페어링, TLS 핀닝.
- 아이덴티티 모델: 안정적인 ID + 귀여운 슬러그.
- 마이그레이션 계획, 리스크, 미해결 질문.

## 목표 (논의에서 도출)

- 모든 클라이언트(mac 앱, CLI, iOS, Android, 헤드리스 노드)를 위한 하나의 프로토콜.
- 모든 네트워크 참여자는 인증 및 페어링됨.
- 역할의 명확화: 노드 vs 운영자.
- 중앙화된 승인, 사용자가 있는 위치로 라우팅.
- 모든 원격 트래픽에 대한 TLS 암호화 + 선택적 핀닝.
- 최소한의 코드 중복.
- 하나의 머신은 UI 에서 한 번만 표시됨(중복 UI/노드 엔트리 없음).

## 비목표(명시적)

- 기능 분리 제거(최소 권한은 여전히 필요).
- 범위 검사 없이 전체 Gateway(게이트웨이) 제어 플레인 노출.
- 인증을 사람 친화적 레이블에 의존하도록 변경(슬러그는 비보안 요소로 유지).

---

# 현재 상태 (As‑Is)

## 두 가지 프로토콜

### 1. Gateway WebSocket (제어 플레인)

- 전체 API 표면: 구성, 채널, 모델, 세션, 에이전트 실행, 로그, 노드 등.
- 기본 바인드: loopback. 원격 접근은 SSH/Tailscale 사용.
- 인증: `connect` 를 통한 토큰/비밀번호.
- TLS 핀닝 없음(loopback/터널에 의존).
- 코드:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (노드 전송)

- 제한된 허용 목록 표면, 노드 아이덴티티 + 페어링.
- TCP 위 JSONL; 선택적 TLS + 인증서 지문 핀닝.
- TLS 는 디스커버리 TXT 에 지문을 광고.
- 코드:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## 현재 제어 플레인 클라이언트

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- macOS 앱 UI → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- 브라우저 제어는 자체 HTTP 제어 서버 사용.

## 현재 노드

- 노드 모드의 macOS 앱이 Gateway bridge 에 연결 (`MacNodeBridgeSession`).
- iOS/Android 앱이 Gateway bridge 에 연결.
- 페어링 + 노드별 토큰은 gateway 에 저장.

## 현재 승인 플로우 (exec)

- 에이전트가 Gateway 를 통해 `system.run` 사용.
- Gateway 가 bridge 를 통해 노드를 호출.
- 노드 런타임이 승인 여부를 결정.
- UI 프롬프트는 mac 앱에서 표시(노드 == mac 앱일 때).
- 노드가 `invoke-res` 를 Gateway 로 반환.
- 멀티 홉, UI 가 노드 호스트에 종속됨.

## 현재 프레즌스 + 아이덴티티

- WS 클라이언트로부터 Gateway 프레즌스 엔트리.
- bridge 로부터 노드 프레즌스 엔트리.
- mac 앱은 동일 머신에 대해 두 개의 엔트리를 표시할 수 있음(UI + 노드).
- 노드 아이덴티티는 페어링 스토어에, UI 아이덴티티는 별도로 저장.

---

# 문제점 / 페인 포인트

- 두 개의 프로토콜 스택을 유지해야 함(WS + Bridge).
- 원격 노드의 승인: 프롬프트가 사용자가 있는 곳이 아니라 노드 호스트에 표시됨.
- TLS 핀닝은 bridge 에만 존재; WS 는 SSH/Tailscale 에 의존.
- 아이덴티티 중복: 동일 머신이 여러 인스턴스로 표시됨.
- 역할이 모호함: UI + 노드 + CLI 의 기능 경계가 불분명.

---

# 제안하는 신규 상태 (Clawnet)

## 하나의 프로토콜, 두 가지 역할

역할 + 범위를 갖는 단일 WS 프로토콜.

- **역할: node** (기능 호스트)
- **역할: operator** (제어 플레인)
- operator 를 위한 선택적 **scope**:
  - `operator.read` (상태 + 조회)
  - `operator.write` (에이전트 실행, 전송)
  - `operator.admin` (구성, 채널, 모델)

### 역할별 동작

**Node**

- 기능 등록 가능(`caps`, `commands`, 권한).
- `invoke` 명령 수신 가능(`system.run`, `camera.*`, `canvas.*`, `screen.record` 등).
- 이벤트 전송 가능: `voice.transcript`, `agent.request`, `chat.subscribe`.
- config/models/channels/sessions/agent 제어 플레인 API 호출 불가.

**Operator**

- scope 로 제한된 전체 제어 플레인 API.
- 모든 승인 수신.
- OS 작업을 직접 실행하지 않으며, 노드로 라우팅.

### 핵심 규칙

역할은 디바이스 단위가 아니라 연결 단위입니다. 하나의 디바이스가 두 역할을 각각 별도의 연결로 열 수 있습니다.

---

# 통합 인증 + 페어링

## 클라이언트 아이덴티티

모든 클라이언트는 다음을 제공합니다.

- `deviceId` (디바이스 키에서 파생된 안정적 ID).
- `displayName` (사람 친화적 이름).
- `role` + `scope` + `caps` + `commands`.

## 페어링 플로우 (통합)

- 클라이언트가 미인증 상태로 연결.
- Gateway 가 해당 `deviceId` 에 대한 **페어링 요청** 생성.
- operator 가 프롬프트를 수신하여 승인/거부.
- Gateway 가 다음에 바인딩된 자격 증명 발급:
  - 디바이스 공개 키
  - 역할
  - scope
  - 기능/명령
- 클라이언트는 토큰을 저장하고 인증된 상태로 재연결.

## 디바이스 바인딩 인증 (베어러 토큰 재사용 방지)

권장: 디바이스 키페어.

- 디바이스는 한 번만 키페어 생성.
- `deviceId = fingerprint(publicKey)`.
- Gateway 가 nonce 전송; 디바이스가 서명; Gateway 가 검증.
- 토큰은 문자열이 아니라 공개 키에 발급됨(소유 증명).

대안:

- mTLS(클라이언트 인증서): 가장 강력하지만 운영 복잡도 증가.
- 단기 베어러 토큰은 임시 단계로만 사용(빠른 로테이션 + 조기 폐기).

## 무음 승인(SSH 휴리스틱)

약한 연결 고리가 되지 않도록 정확히 정의해야 합니다. 다음 중 하나를 선호합니다.

- **로컬 전용**: loopback/Unix 소켓을 통한 연결 시 자동 페어링.
- **SSH 챌린지**: Gateway 가 nonce 를 발급하고, 클라이언트가 SSH 로 이를 가져와 증명.
- **물리적 존재 윈도우**: Gateway 호스트 UI 에서 로컬 승인 후 짧은 시간(예: 10분) 동안 자동 페어링 허용.

자동 승인은 항상 로그 및 기록합니다.

---

# TLS 전면 적용 (개발 + 운영)

## 기존 bridge TLS 재사용

현재 TLS 런타임 + 지문 핀닝을 사용합니다.

- `src/infra/bridge/server/tls.ts`
- `src/node-host/bridge-client.ts` 의 지문 검증 로직

## WS 에 적용

- WS 서버가 동일한 인증서/키 + 지문으로 TLS 지원.
- WS 클라이언트는 선택적으로 지문 핀닝 가능.
- 디스커버리는 모든 엔드포인트에 대해 TLS + 지문을 광고.
  - 디스커버리는 위치 힌트일 뿐, 신뢰 앵커가 아님.

## 이유

- 기밀성을 SSH/Tailscale 에 덜 의존.
- 원격 모바일 연결을 기본적으로 안전하게 만듦.

---

# 승인 재설계 (중앙화)

## 현재

승인은 노드 호스트(mac 앱 노드 런타임)에서 발생. 프롬프트는 노드가 실행 중인 곳에 표시됨.

## 제안

승인은 **Gateway 호스팅**, UI 는 operator 클라이언트로 전달.

### 새로운 플로우

1. Gateway 가 `system.run` 의도(에이전트)를 수신.
2. Gateway 가 승인 레코드 생성: `approval.requested`.
3. operator UI 들에 프롬프트 표시.
4. 승인 결정이 Gateway 로 전송: `approval.resolve`.
5. 승인되면 Gateway 가 노드 명령 호출.
6. 노드가 실행 후 `invoke-res` 반환.

### 승인 시맨틱(강화)

- 모든 operator 에 브로드캐스트; 활성 UI 만 모달 표시(나머지는 토스트).
- 첫 번째 결정이 승리; 이후 결정은 이미 처리됨으로 거부.
- 기본 타임아웃: N 초 후 거부(예: 60초), 사유 로그.
- 해결에는 `operator.approvals` scope 필요.

## 장점

- 프롬프트가 사용자가 있는 곳(mac/폰)에 표시됨.
- 원격 노드에 대해 일관된 승인.
- 노드 런타임은 헤드리스 유지; UI 의존성 제거.

---

# 역할 명확화 예시

## iPhone 앱

- **Node 역할**: 마이크, 카메라, 음성 채팅, 위치, 푸시‑투‑톡.
- 선택적 **operator.read**: 상태 및 채팅 조회.
- 명시적으로 활성화된 경우에만 **operator.write/admin**.

## macOS 앱

- 기본적으로 operator 역할(제어 UI).
- “Mac node” 활성화 시 node 역할(system.run, 화면, 카메라).
- 두 연결 모두 동일한 deviceId 사용 → UI 에서 단일 엔트리로 병합.

## CLI

- 항상 operator 역할.
- scope 는 서브커맨드로부터 파생:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - 승인 + 페어링 → `operator.approvals` / `operator.pairing`

---

# 아이덴티티 + 슬러그

## 안정적 ID

인증에 필수이며 변경되지 않음.
권장:

- 키페어 지문(공개 키 해시).

## 귀여운 슬러그(랍스터 테마)

사람을 위한 레이블일 뿐입니다.

- 예: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Gateway 레지스트리에 저장되며 편집 가능.
- 충돌 처리: `-2`, `-3`.

## UI 그룹화

역할 전반에 걸쳐 동일한 `deviceId` → 단일 “인스턴스” 행:

- 배지: `operator`, `node`.
- 기능 + 마지막 접속 시간 표시.

---

# 마이그레이션 전략

## Phase 0: 문서화 + 정렬

- 이 문서 공개.
- 모든 프로토콜 호출 + 승인 플로우 인벤토리화.

## Phase 1: WS 에 역할/scope 추가

- `connect` 파라미터에 `role`, `scope`, `deviceId` 확장.
- node 역할에 대한 허용 목록 게이팅 추가.

## Phase 2: Bridge 호환성

- bridge 유지.
- 병렬로 WS node 지원 추가.
- 구성 플래그 뒤에 기능 배치.

## Phase 3: 중앙 승인

- WS 에 승인 요청 + 해결 이벤트 추가.
- mac 앱 UI 를 업데이트하여 프롬프트 표시 + 응답.
- 노드 런타임에서 UI 프롬프트 제거.

## Phase 4: TLS 통합

- bridge TLS 런타임을 사용하여 WS 에 TLS 구성 추가.
- 클라이언트에 핀닝 추가.

## Phase 5: bridge 폐기

- iOS/Android/mac 노드를 WS 로 마이그레이션.
- 안정화 후 bridge 제거(그 전까지는 폴백 유지).

## Phase 6: 디바이스 바인딩 인증

- 모든 비로컬 연결에 키 기반 아이덴티티 요구.
- 폐기 + 로테이션 UI 추가.

---

# 보안 노트

- 역할/허용 목록은 Gateway 경계에서 강제.
- operator scope 없이는 “전체” API 접근 불가.
- 모든 연결은 페어링 필수.
- TLS + 핀닝으로 모바일 MITM 리스크 감소.
- SSH 무음 승인은 편의 기능이며, 여전히 기록 + 폐기 가능.
- 디스커버리는 신뢰 앵커가 아님.
- 기능 클레임은 플랫폼/타입별 서버 허용 목록에 대해 검증됨.

# 스트리밍 + 대용량 페이로드(노드 미디어)

WS 제어 플레인은 소형 메시지에는 적합하지만, 노드는 다음도 처리합니다.

- 카메라 클립
- 화면 녹화
- 오디오 스트림

옵션:

1. WS 바이너리 프레임 + 청킹 + 백프레셔 규칙.
2. 별도의 스트리밍 엔드포인트(TLS + 인증 유지).
3. 미디어 집약 명령에 대해서는 bridge 를 더 오래 유지하고 마지막에 마이그레이션.

드리프트를 피하기 위해 구현 전에 하나를 선택해야 합니다.

# 기능 + 명령 정책

- 노드가 보고하는 기능/명령은 **클레임**으로 취급.
- Gateway 가 플랫폼별 허용 목록을 강제.
- 신규 명령은 operator 승인 또는 명시적 허용 목록 변경 필요.
- 변경 사항은 타임스탬프와 함께 감사.

# 감사 + 속도 제한

- 로그: 페어링 요청, 승인/거부, 토큰 발급/로테이션/폐기.
- 페어링 스팸 및 승인 프롬프트에 속도 제한을 적용합니다.

# 프로토콜 위생

- 명시적 프로토콜 버전 + 오류 코드.
- 재연결 규칙 + 하트비트 정책.
- 프레즌스 TTL 및 마지막 접속 의미론.

---

# 미해결 질문

1. 하나의 디바이스에서 두 역할 실행: 토큰 모델
   - 역할별(node vs operator) 별도 토큰 권장.
   - 동일 deviceId, 다른 scope; 폐기 명확화.

2. operator scope 세분화
   - read/write/admin + approvals + pairing(최소 기능).
   - 이후 기능별 scope 고려.

3. 토큰 로테이션 + 폐기 UX
   - 역할 변경 시 자동 로테이션.
   - deviceId + 역할 기준 폐기 UI.

4. 디스커버리
   - 기존 Bonjour TXT 를 확장하여 WS TLS 지문 + 역할 힌트 포함.
   - 위치 힌트로만 취급.

5. 크로스‑네트워크 승인
   - 모든 operator 클라이언트에 브로드캐스트; 활성 UI 가 모달 표시.
   - 첫 응답이 승리; Gateway 가 원자성 보장.

---

# 요약 (TL;DR)

- 현재: WS 제어 플레인 + Bridge 노드 전송.
- 고충: 승인 + 중복 + 두 개의 스택.
- 제안: 명시적 역할 + scope 를 갖는 하나의 WS 프로토콜, 통합 페어링 + TLS 핀닝, Gateway 호스팅 승인, 안정적 디바이스 ID + 귀여운 슬러그.
- 결과: 더 단순한 UX, 더 강력한 보안, 중복 감소, 더 나은 모바일 라우팅.
