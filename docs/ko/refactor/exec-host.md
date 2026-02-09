---
summary: "리팩터링 계획: exec 호스트 라우팅, 노드 승인, 헤드리스 러너"
read_when:
  - exec 호스트 라우팅 또는 exec 승인을 설계할 때
  - 노드 러너 + UI IPC 를 구현할 때
  - exec 호스트 보안 모드와 슬래시 명령을 추가할 때
title: "Exec 호스트 리팩터링"
---

# Exec 호스트 리팩터링 계획

## 목표

- **sandbox**, **gateway**, **node** 전반에서 실행을 라우팅하기 위해 `exec.host` + `exec.security` 를 추가합니다.
- 기본값을 **안전**하게 유지합니다. 명시적으로 활성화하지 않는 한 호스트 간 실행은 허용하지 않습니다.
- 실행을 **헤드리스 러너 서비스**로 분리하고, 로컬 IPC 를 통해 선택적 UI (macOS 앱) 를 제공합니다.
- **에이전트별** 정책, 허용 목록, ask 모드, 노드 바인딩을 제공합니다.
- 허용 목록과 _함께_ 또는 _없이_ 작동하는 **ask 모드**를 지원합니다.
- 크로스 플랫폼: Unix 소켓 + 토큰 인증 (macOS/Linux/Windows 동등성).

## Non-goals

- 레거시 허용 목록 마이그레이션 또는 레거시 스키마 지원 없음.
- 노드 exec 에 대한 PTY/스트리밍 없음 (집계된 출력만).
- 기존 Bridge + Gateway 를 넘어서는 새로운 네트워크 레이어 없음.

## 결정 사항 (고정)

- **구성 키:** `exec.host` + `exec.security` (에이전트별 재정의 허용).
- **권한 상승:** gateway 전체 접근의 별칭으로 `/elevated` 를 유지합니다.
- **Ask 기본값:** `on-miss`.
- **승인 저장소:** `~/.openclaw/exec-approvals.json` (JSON, 레거시 마이그레이션 없음).
- **러너:** 헤드리스 시스템 서비스; UI 앱은 승인을 위한 Unix 소켓을 호스팅합니다.
- **노드 식별:** 기존 `nodeId` 를 사용합니다.
- **소켓 인증:** Unix 소켓 + 토큰 (크로스 플랫폼); 필요 시 이후 분리합니다.
- **노드 호스트 상태:** `~/.openclaw/node.json` (노드 id + 페어링 토큰).
- **macOS exec 호스트:** macOS 앱 내부에서 `system.run` 를 실행합니다. 노드 호스트 서비스는 로컬 IPC 를 통해 요청을 전달합니다.
- **XPC 헬퍼 없음:** Unix 소켓 + 토큰 + 피어 체크를 유지합니다.

## 핵심 개념

### 호스트

- `sandbox`: Docker exec (현재 동작).
- `gateway`: gateway 호스트에서 exec.
- `node`: Bridge 를 통해 노드 러너에서 exec (`system.run`).

### 보안 모드

- `deny`: 항상 차단.
- `allowlist`: 일치하는 경우만 허용.
- `full`: 모두 허용 (권한 상승과 동등).

### Ask 모드

- `off`: 묻지 않음.
- `on-miss`: 허용 목록이 일치하지 않을 때만 질문.
- `always`: 매번 질문.

Ask 는 허용 목록과 **독립적**입니다. 허용 목록은 `always` 또는 `on-miss` 와 함께 사용할 수 있습니다.

### 정책 해석 (exec 당)

1. `exec.host` 를 해석합니다 (도구 매개변수 → 에이전트 재정의 → 전역 기본값).
2. `exec.security` 및 `exec.ask` 를 해석합니다 (동일한 우선순위).
3. 호스트가 `sandbox` 이면 로컬 샌드박스 exec 를 진행합니다.
4. 호스트가 `gateway` 또는 `node` 이면 해당 호스트에서 보안 + ask 정책을 적용합니다.

## 기본 안전성

- 기본값 `exec.host = sandbox`.
- `gateway` 및 `node` 에 대한 기본값 `exec.security = deny`.
- 기본값 `exec.ask = on-miss` (보안이 허용하는 경우에만 관련).
- 노드 바인딩이 설정되지 않은 경우 **에이전트는 어떤 노드든 대상 지정 가능**하지만, 정책이 이를 허용해야 합니다.

## 구성 표면

### 도구 매개변수

- `exec.host` (선택): `sandbox | gateway | node`.
- `exec.security` (선택): `deny | allowlist | full`.
- `exec.ask` (선택): `off | on-miss | always`.
- `exec.node` (선택): `host=node` 인 경우 사용할 노드 id/이름.

### 구성 키 (전역)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (기본 노드 바인딩)

### 구성 키 (에이전트별)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 별칭

- `/elevated on` = 에이전트 세션에 대해 `tools.exec.host=gateway`, `tools.exec.security=full` 를 설정합니다.
- `/elevated off` = 에이전트 세션의 이전 exec 설정을 복원합니다.

## 승인 저장소 (JSON)

경로: `~/.openclaw/exec-approvals.json`

목적:

- **실행 호스트**(gateway 또는 노드 러너) 를 위한 로컬 정책 + 허용 목록.
- UI 를 사용할 수 없을 때의 ask 대체 수단.
- UI 클라이언트를 위한 IPC 자격 증명.

제안 스키마 (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Notes:

- 레거시 허용 목록 형식 없음.
- `askFallback` 는 `ask` 이 필요하고 UI 에 접근할 수 없을 때만 적용됩니다.
- 파일 권한: `0600`.

## 러너 서비스 (헤드리스)

### 역할

- 로컬에서 `exec.security` + `exec.ask` 를 강제합니다.
- 시스템 명령을 실행하고 출력을 반환합니다.
- exec 수명주기에 대한 Bridge 이벤트를 발행합니다 (선택 사항이지만 권장).

### 서비스 수명주기

- macOS 에서는 Launchd/데몬, Linux/Windows 에서는 시스템 서비스.
- 승인 JSON 은 실행 호스트에 로컬로 존재합니다.
- UI 는 로컬 Unix 소켓을 호스팅하며, 러너는 필요 시 연결합니다.

## UI 통합 (macOS 앱)

### IPC

- `~/.openclaw/exec-approvals.sock` 의 Unix 소켓 (0600).
- `exec-approvals.json` 에 저장된 토큰 (0600).
- 피어 체크: 동일 UID 만 허용.
- 챌린지/응답: 재생 공격 방지를 위해 nonce + HMAC(token, request-hash).
- 짧은 TTL (예: 10초) + 최대 페이로드 + 속도 제한.

### Ask 흐름 (macOS 앱 exec 호스트)

1. 노드 서비스가 gateway 로부터 `system.run` 를 수신합니다.
2. 노드 서비스가 로컬 소켓에 연결하고 프롬프트/exec 요청을 전송합니다.
3. 앱이 피어 + 토큰 + HMAC + TTL 을 검증한 뒤 필요 시 대화상자를 표시합니다.
4. 앱이 UI 컨텍스트에서 명령을 실행하고 출력을 반환합니다.
5. 노드 서비스가 출력을 gateway 로 반환합니다.

UI 가 없는 경우:

- `askFallback` (`deny|allowlist|full`) 를 적용합니다.

### 다이어그램 (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## 노드 식별 + 바인딩

- Bridge 페어링의 기존 `nodeId` 를 사용합니다.
- 바인딩 모델:
  - `tools.exec.node` 는 에이전트를 특정 노드로 제한합니다.
  - 설정되지 않은 경우 에이전트는 어떤 노드든 선택할 수 있습니다 (정책은 기본값을 계속 강제).
- 노드 선택 해석:
  - `nodeId` 정확 일치
  - `displayName` (정규화)
  - `remoteIp`
  - `nodeId` 접두사 (>= 6자)

## 이벤트

### 이벤트를 볼 수 있는 대상

- 시스템 이벤트는 **세션별**이며 다음 프롬프트에서 에이전트에게 표시됩니다.
- gateway 인메모리 큐 (`enqueueSystemEvent`) 에 저장됩니다.

### 이벤트 텍스트

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 선택적 출력 꼬리
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### 전송

옵션 A (권장):

- 러너가 Bridge `event` 프레임 `exec.started` / `exec.finished` 를 전송합니다.
- gateway `handleBridgeEvent` 가 이를 `enqueueSystemEvent` 로 매핑합니다.

옵션 B:

- gateway `exec` 도구가 수명주기를 직접 처리합니다 (동기식만).

## Exec 흐름

### 샌드박스 호스트

- 기존 `exec` 동작 (Docker 또는 비샌드박스 시 호스트).
- PTY 는 비샌드박스 모드에서만 지원됩니다.

### Gateway 호스트

- gateway 프로세스가 자체 머신에서 실행됩니다.
- 로컬 `exec-approvals.json` (보안/ask/허용 목록) 를 강제합니다.

### 노드 호스트

- gateway 가 `system.run` 와 함께 `node.invoke` 를 호출합니다.
- 러너가 로컬 승인을 강제합니다.
- 러너가 집계된 stdout/stderr 를 반환합니다.
- 시작/종료/거부에 대한 선택적 Bridge 이벤트.

## 출력 상한

- stdout+stderr 합계를 **200k** 로 제한하고, 이벤트에는 **꼬리 20k** 를 유지합니다.
- 명확한 접미사로 잘라냅니다 (예: `"… (truncated)"`).

## 슬래시 명령

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 에이전트별, 세션별 재정의이며 구성으로 저장하지 않는 한 비영구적입니다.
- `/elevated on|off|ask|full` 는 `full` 로 승인을 건너뛰는 `host=gateway security=full` 의 바로가기로 유지됩니다.

## 크로스 플랫폼 스토리

- 러너 서비스는 이식 가능한 실행 대상입니다.
- UI 는 선택 사항이며, 없는 경우 `askFallback` 이 적용됩니다.
- Windows/Linux 는 동일한 승인 JSON + 소켓 프로토콜을 지원합니다.

## 구현 단계

### 1단계: 구성 + exec 라우팅

- `exec.host`, `exec.security`, `exec.ask`, `exec.node` 에 대한 구성 스키마를 추가합니다.
- 도구 플러밍을 업데이트하여 `exec.host` 를 준수합니다.
- `/exec` 슬래시 명령을 추가하고 `/elevated` 별칭을 유지합니다.

### 2단계: 승인 저장소 + gateway 강제

- `exec-approvals.json` 리더/라이터를 구현합니다.
- `gateway` 호스트에 대해 허용 목록 + ask 모드를 강제합니다.
- 출력 상한을 추가합니다.

### 3단계: 노드 러너 강제

- 노드 러너를 업데이트하여 허용 목록 + ask 를 강제합니다.
- macOS 앱 UI 로의 Unix 소켓 프롬프트 브리지를 추가합니다.
- `askFallback` 를 연결합니다.

### 4단계: 이벤트

- exec 수명주기에 대한 노드 → gateway Bridge 이벤트를 추가합니다.
- 에이전트 프롬프트를 위해 `enqueueSystemEvent` 로 매핑합니다.

### 5단계: UI 폴리시

- Mac 앱: 허용 목록 편집기, 에이전트별 전환기, ask 정책 UI.
- 노드 바인딩 제어 (선택 사항).

## 테스트 계획

- 단위 테스트: 허용 목록 매칭 (glob + 대소문자 무시).
- 단위 테스트: 정책 해석 우선순위 (도구 매개변수 → 에이전트 재정의 → 전역).
- 통합 테스트: 노드 러너 거부/허용/ask 흐름.
- Bridge 이벤트 테스트: 노드 이벤트 → 시스템 이벤트 라우팅.

## 공개 위험

- UI 가용성: `askFallback` 이 준수되는지 확인합니다.
- 장시간 실행 명령: 타임아웃 + 출력 상한에 의존합니다.
- 다중 노드 모호성: 노드 바인딩 또는 명시적 노드 매개변수가 없으면 오류 처리합니다.

## 관련 문서

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
