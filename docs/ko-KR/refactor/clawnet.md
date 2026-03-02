---
summary: "Clawnet 리팩터: 네트워크 프로토콜, 역할, 인증, 승인, 신원 통합"
read_when:
  - Planning a unified network protocol for nodes + operator clients
  - Reworking approvals, pairing, TLS, and presence across devices
title: "Clawnet 리팩터"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/refactor/clawnet.md
  workflow: 15
---

# Clawnet 리팩터 (프로토콜 + 인증 통합)

## 안녕하세요

안녕하세요 Peter — 좋은 방향입니다. 이것은 더 간단한 UX + 더 강한 보안을 가능하게 합니다.

## 목적

다음을 위한 단일하고 엄격한 문서:

- 현재 상태: 프로토콜, 흐름, 신뢰 경계.
- 문제점: 승인, 다중-홉 라우팅, UI 중복.
- 제안된 새로운 상태: 하나의 프로토콜, 범위가 지정된 역할, 통합 인증/페어링, TLS 핀핑.
- 신원 모델: 안정적인 ID + 귀여운 슬러그.
- 마이그레이션 계획, 위험, 미해결 질문.

## 목표 (논의에서)

- 모든 클라이언트(Mac 앱, CLI, iOS, Android, 헤드리스 노드)를 위한 하나의 프로토콜.
- 모든 네트워크 참여자 인증 + 페어링됨.
- 역할 명확성: 노드 vs 운영자.
- 중앙 승인이 사용자가 있는 곳으로 라우팅됨.
- 모든 원격 트래픽에 대한 TLS 암호화 + 선택적 핀핑.
- 최소한의 코드 중복.
- 단일 머신이 한 번만 나타남 (UI/노드 중복 항목 없음).

## 비목표 (명시적)

- 기능 분리 제거 (여전히 최소 권한이 필요함).
- 범위 검사 없이 완전한 게이트웨이 제어 평면 노출.
- 인증을 인간 레이블(슬러그는 보안이 아님)에 종속시킴.

---

# 현재 상태 (현재)

## 두 가지 프로토콜

### 1) Gateway WebSocket (제어 평면)

- 완전한 API 표면: config, channels, models, sessions, agent runs, logs, nodes 등.
- 기본 바인드: loopback. SSH/Tailscale을 통한 원격 액세스.
- 인증: `connect`를 통한 토큰/비밀번호.
- TLS 핀핑 없음 (loopback/터널에 의존).
- 코드:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge (노드 전송)

- 좁은 허용 목록 표면, 노드 신원 + 페어링.
- TCP를 통한 JSONL; 선택적 TLS + 인증서 지문 핀핑.
- TLS는 발견 TXT에서 지문을 광고함.
- 코드:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## 현재 제어 평면 클라이언트

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`).
- macOS 앱 UI → Gateway WS (`GatewayConnection`).
- Web Control UI → Gateway WS.
- ACP → Gateway WS.
- Browser control은 자신의 HTTP 제어 서버를 사용합니다.

## 현재 노드

- 노드 모드의 macOS 앱이 Gateway bridge에 연결 (`MacNodeBridgeSession`).
- iOS/Android 앱이 Gateway bridge에 연결.
- 페어링 + 노드별 토큰이 게이트웨이에 저장됨.

## 현재 승인 흐름 (exec)

- Agent는 Gateway를 통해 `system.run`을 사용합니다.
- Gateway는 bridge를 통해 노드를 호출합니다.
- 노드 런타임이 승인을 결정합니다.
- UI 프롬프트가 Mac 앱에서 표시됨 (노드 == Mac 앱일 때).
- 노드가 `invoke-res`를 Gateway에 반환합니다.
- 다중-홉, UI가 노드 호스트에 연결됨.

## 현재 Presence + 신원

- Gateway presence 항목이 WS 클라이언트에서 생성됨.
- 노드 presence 항목이 bridge에서 생성됨.
- Mac 앱은 동일한 머신에 대해 두 개의 항목을 표시할 수 있음 (UI + 노드).
- 노드 신원은 페어링 저장소에 저장됨; UI 신원은 별도.

---

# 문제 / 문제점

- 두 개의 프로토콜 스택을 유지해야 함 (WS + Bridge).
- 원격 노드의 승인: 프롬프트가 노드 호스트에 나타남, 사용자가 있는 곳이 아님.
- TLS 핀핑은 bridge에만 존재함; WS는 SSH/Tailscale에 의존함.
- 신원 중복: 동일한 머신이 여러 인스턴스로 표시됨.
- 모호한 역할: UI + 노드 + CLI 기능이 명확하게 분리되지 않음.

---

# 제안된 새로운 상태 (Clawnet)

## 하나의 프로토콜, 두 가지 역할

역할 + 범위가 있는 단일 WS 프로토콜.

- **역할: 노드** (기능 호스트)
- **역할: 운영자** (제어 평면)
- 운영자의 선택적 **범위**:
  - `operator.read` (상태 + 보기)
  - `operator.write` (agent run, sends)
  - `operator.admin` (config, channels, models)

### 역할 동작

**노드**

- 기능(`caps`, `commands`, 권한)을 등록할 수 있음.
- `invoke` 명령(`system.run`, `camera.*`, `canvas.*`, `screen.record` 등)을 받을 수 있음.
- 이벤트를 보낼 수 있음: `voice.transcript`, `agent.request`, `chat.subscribe`.
- config/models/channels/sessions/agent 제어 평면 API를 호출할 수 없음.

**운영자**

- 범위로 제한된 완전한 제어 평면 API.
- 모든 승인을 받음.
- OS 동작을 직접 실행하지 않음; 노드로 라우팅함.

### 핵심 규칙

역할은 연결별이며, 디바이스별이 아님. 디바이스는 두 역할을 모두 별도로 열 수 있습니다.

---

# 통합 인증 + 페어링

## 클라이언트 신원

모든 클라이언트는 다음을 제공합니다:

- `deviceId` (안정적, 디바이스 키에서 파생됨).
- `displayName` (인간 이름).
- `role` + `scope` + `caps` + `commands`.

## 페어링 흐름 (통합)

- 클라이언트가 인증되지 않은 상태로 연결됨.
- Gateway는 해당 `deviceId`에 대한 **페어링 요청**을 생성합니다.
- 운영자가 프롬프트를 받음; 승인/거부.
- Gateway는 다음에 바인딩된 자격 증명을 발급합니다:
  - 디바이스 공개 키
  - 역할
  - 범위
  - 기능/명령
- 클라이언트가 토큰을 유지하고 인증된 상태로 다시 연결합니다.

## 디바이스-바운드 인증 (베어러 토큰 재생 방지)

선호: 디바이스 키 쌍.

- 디바이스는 한 번 키 쌍을 생성합니다.
- `deviceId = fingerprint(publicKey)`.
- Gateway가 nonce를 보냄; 디바이스가 서명; gateway가 검증.
- 토큰은 공개 키에 발급됨 (possession 증명), 문자열이 아님.

대안:

- mTLS (클라이언트 인증서): 가장 강력함, ops 복잡도 높음.
- 단기 베어러 토큰만 임시 단계로 (회전 + 조기 취소).

## 자동 승인 (SSH 휴리스틱)

약한 연결을 피하기 위해 정확히 정의하세요. 선호:

- **Local-only**: 클라이언트가 loopback/Unix 소켓을 통해 연결할 때 자동-페어링.
- **Challenge via SSH**: gateway가 nonce를 발급; 클라이언트가 SSH를 가져오기로 입증.
- **Physical presence window**: gateway 호스트 UI에서 로컬 승인 후, 짧은 창(예: 10분)에 대해 자동-페어링 허용.

항상 자동-승인을 기록합니다.

---

# TLS everywhere (개발 + 제품)

## 기존 bridge TLS 재사용

현재 TLS 런타임 + 지문 핀핑을 사용:

- `src/infra/bridge/server/tls.ts`
- `src/node-host/bridge-client.ts`의 지문 검증 로직

## WS에 적용

- WS 서버가 동일한 인증서/키 + 지문으로 TLS를 지원함.
- WS 클라이언트가 지문을 핀할 수 있음 (선택사항).
- Discovery가 모든 엔드포인트에 대해 TLS + 지문을 광고합니다.
  - Discovery는 로케이터 힌트일 뿐; 신뢰 앵커가 아님.

## 이유

- SSH/Tailscale에 대한 기밀성 의존도 감소.
- 원격 모바일 연결을 기본적으로 안전하게 만듭니다.

---

# 승인 재설계 (중앙화)

## 현재

승인은 노드 호스트(Mac 앱 노드 런타임)에서 발생합니다. 프롬프트가 노드가 실행되는 곳에 나타납니다.

## 제안

승인은 **gateway-호스트됨**, UI는 운영자 클라이언트에 전달됨.

### 새로운 흐름

1. Gateway가 `system.run` 의도(agent)를 받음.
2. Gateway가 승인 기록을 생성합니다: `approval.requested`.
3. 운영자 UI가 프롬프트를 표시합니다.
4. 승인 결정이 gateway로 전송됨: `approval.resolve`.
5. Gateway가 승인되면 노드 명령을 호출합니다.
6. 노드가 실행, `invoke-res`를 반환합니다.

### 승인 의미론 (강화)

- 모든 운영자에게 브로드캐스트; 활성 UI만 모달을 표시 (다른 UI는 토스트를 받음).
- 첫 번째 해결이 이기는 게임; gateway는 이미 해결된 것으로 후속 해결을 거부합니다.
- 기본 타임아웃: N초 후 거부(예: 60초), 이유를 기록합니다.
- 해결을 위해 `operator.approvals` 범위 필요.

## 이점

- 프롬프트가 사용자가 있는 곳(Mac/Phone)에 나타남.
- 원격 노드에 대한 일관된 승인.
- 노드 런타임이 headless 상태 유지; UI 의존성 없음.

---

# 역할 명확성 예제

## iPhone 앱

- **노드 역할**: 마이크, 카메라, 음성 채팅, 위치, 푸시-투-톡.
- 선택적 **operator.read**: 상태 및 채팅 보기.
- 선택적 **operator.write/admin**: 명시적으로 활성화할 때만.

## macOS 앱

- 기본적으로 운영자 역할 (제어 UI).
- "Mac node"가 활성화되면 노드 역할 (system.run, screen, camera).
- 두 연결에 대한 동일한 deviceId → 병합된 UI 항목.

## CLI

- 항상 운영자 역할.
- 범위는 하위 명령에서 파생됨:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - approvals + pairing → `operator.approvals` / `operator.pairing`

---

# 신원 + 슬러그

## 안정적인 ID

인증에 필요함; 절대 변경되지 않음.
선호:

- 키 쌍 지문 (공개 키 해시).

## 귀여운 슬러그 (lobster-themed)

인간 레이블일 뿐.

- 예: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Gateway 레지스트리에 저장, 편집 가능.
- 충돌 처리: `-2`, `-3`.

## UI 그룹화

역할 전체에서 동일한 `deviceId` → 단일 "Instance" 행:

- 배지: `operator`, `node`.
- 기능 + 마지막 표시를 표시합니다.

---

# 마이그레이션 전략

## Phase 0: 문서 + 정렬

- 이 문서를 게시합니다.
- 모든 프로토콜 호출 + 승인 흐름을 목록화합니다.

## Phase 1: WS에 역할/범위 추가

- `connect` 매개변수를 `role`, `scope`, `deviceId`로 확장.
- 노드 역할에 대한 허용 목록 게이팅 추가.

## Phase 2: Bridge 호환성

- Bridge를 계속 실행합니다.
- WS 노드 지원을 병렬로 추가.
- config 플래그 뒤의 기능을 게이트합니다.

## Phase 3: 중앙 승인

- WS에 승인 요청 + 해결 이벤트 추가.
- Mac 앱 UI를 프롬프트 + 응답으로 업데이트.
- 노드 런타임이 UI를 프롬프팅하는 것을 멈춥니다.

## Phase 4: TLS 통합

- bridge TLS 런타임을 사용하여 WS에 대한 TLS config 추가.
- 클라이언트에 핀핑 추가.

## Phase 5: Bridge 사용 중단

- iOS/Android/Mac 노드를 WS로 마이그레이션.
- bridge를 폴백으로 유지; 안정적일 때 제거.

## Phase 6: 디바이스-바운드 인증

- 모든 비-로컬 연결에 대해 키-기반 신원이 필요합니다.
- 취소 + 회전 UI 추가.

---

# 보안 노트

- 역할/허용 목록이 gateway 경계에서 적용됨.
- 클라이언트가 운영자 범위 없이 "완전한" API를 받지 않음.
- 페어링이 _모든_ 연결에 필요함.
- TLS + 핀핑은 모바일의 MITM 위험을 감소시킵니다.
- SSH 자동 승인은 편의성; 여전히 기록 + 취소 가능.
- Discovery는 절대 신뢰 앵커가 아님.
- 기능 요청은 서버 허용 목록에 대해 플랫폼/유형별로 검증됨.

# Streaming + 대용량 페이로드 (노드 미디어)

WS 제어 평면은 작은 메시지에 괜찮지만, 노드도:

- camera clips
- screen recordings
- audio streams

옵션:

1. WS binary frames + chunking + backpressure rules.
2. Separate streaming endpoint (여전히 TLS + 인증).
3. Keep bridge longer for media-heavy commands, 마지막에 마이그레이션.

구현 전에 드리프트를 피하기 위해 하나를 선택합니다.

# 기능 + 명령 정책

- 노드-보고된 caps/명령은 **요청**으로 취급됨.
- Gateway가 플랫폼별 허용 목록을 적용합니다.
- 새 명령은 운영자 승인 또는 명시적 허용 목록 변경이 필요합니다.
- 타임스탬프와 함께 변경 사항을 감사합니다.

# 감사 + 속도 제한

- 로그: 페어링 요청, 승인/거부, 토큰 발급/회전/취소.
- Rate-limit 페어링 스팸 및 승인 프롬프트.

# 프로토콜 위생

- 명시적 프로토콜 버전 + 오류 코드.
- 다시 연결 규칙 + 하트비트 정책.
- Presence TTL 및 마지막-표시 의미론.

---

# 미해결 질문

1. 두 역할을 모두 실행하는 단일 디바이스: 토큰 모델
   - 역할별로 별도의 토큰 권장 (노드 vs 운영자).
   - 동일한 deviceId; 다른 범위; 더 명확한 취소.

2. 운영자 범위 세분화
   - read/write/admin + approvals + pairing (최소 실행 가능).
   - 나중에 기능별 범위 고려.

3. 토큰 회전 + 취소 UX
   - 역할 변경 시 자동-회전.
   - deviceId + 역할별 취소할 UI.

4. Discovery
   - 현재 Bonjour TXT를 WS TLS 지문 + 역할 힌트로 확장합니다.
   - 로케이터 힌트만으로 취급합니다.

5. 교차-네트워크 승인
   - 모든 운영자 클라이언트에 브로드캐스트; 활성 UI가 모달을 표시합니다.
   - 첫 번째 응답이 이기는 게임; gateway가 원자성을 적용합니다.

---

# 요약 (TL;DR)

- 오늘: WS 제어 평면 + Bridge 노드 전송.
- 문제: 승인 + 중복 + 두 스택.
- 제안: 명시적 역할 + 범위가 있는 하나의 WS 프로토콜, 통합 페어링 + TLS 핀핑, gateway-호스트된 승인, 안정적인 디바이스 ID + 귀여운 슬러그.
- 결과: 더 간단한 UX, 더 강한 보안, 더 적은 중복, 더 나은 모바일 라우팅.
