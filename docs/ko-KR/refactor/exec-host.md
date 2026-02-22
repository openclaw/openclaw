---
summary: "리팩터 계획: exec 호스트 라우팅, 노드 승인, 헤드리스 러너"
read_when:
  - exec 호스트 라우팅 또는 exec 승인을 설계할 때
  - 노드 러너 + UI IPC 구현 시
  - exec 호스트 보안 모드 및 슬래시 명령 추가 시
title: "Exec 호스트 리팩터"
---

# Exec 호스트 리팩터 계획

## 목표

- **샌드박스**, **게이트웨이**, **노드** 전반에 걸쳐 실행을 라우팅하기 위해 `exec.host` + `exec.security` 추가.
- 기본값을 **안전하게** 유지: 명시적으로 활성화하지 않으면 호스트 간 실행 금지.
- 실행을 **헤드리스 러너 서비스**로 분리하고, 로컬 IPC를 통해 선택적 UI (macOS 앱) 추가.
- **에이전트별** 정책, 허용 목록, 묻기 모드 및 노드 바인딩 제공.
- 허용 목록 _유무에 상관없이_ 작동하는 **묻기 모드** 지원.
- 크로스 플랫폼: 유닉스 소켓 + 토큰 인증 (macOS/Linux/Windows 지원).

## 비목표

- 레거시 허용 목록 마이그레이션 또는 레거시 스키마 지원 없음.
- 노드 exec에 대한 PTY/스트리밍 없음 (집계된 출력만 제공).
- 기존 Bridge + Gateway에 더해 새로운 네트워크 레이어 없음.

## 결정 사항 (고정)

- **설정 키:** `exec.host` + `exec.security` (에이전트별 덮어쓰기 허용).
- **승격:** 게이트웨이 전체 액세스에 대한 별칭으로 `/elevated` 유지.
- **묻기 기본 값:** `on-miss`.
- **승인 저장소:** `~/.openclaw/exec-approvals.json` (JSON, 레거시 마이그레이션 없음).
- **러너:** 헤드리스 시스템 서비스; UI 앱은 승인을 위한 유닉스 소켓 호스팅.
- **노드 아이덴티티:** 기존 `nodeId` 사용.
- **소켓 인증:** 유닉스 소켓 + 토큰 (크로스 플랫폼); 필요시 나중에 분리.
- **노드 호스트 상태:** `~/.openclaw/node.json` (노드 ID + 페어링 토큰).
- **macOS exec 호스트:** macOS 앱 내에서 `system.run` 실행; 노드 호스트 서비스가 요청을 로컬 IPC를 통해 전달.
- **XPC 헬퍼 없음:** 유닉스 소켓 + 토큰 + 피어 검사로 유지.

## 주요 개념

### 호스트

- `sandbox`: Docker 실행 (현재 동작).
- `gateway`: 게이트웨이 호스트에서 실행.
- `node`: Bridge를 통해 노드 러너에서 실행 (`system.run`).

### 보안 모드

- `deny`: 항상 차단.
- `allowlist`: 일치하는 항목만 허용.
- `full`: 모든 것 허용 (승격과 동등).

### 묻기 모드

- `off`: 절대 묻지 않음.
- `on-miss`: 허용 목록이 일치하지 않을 때만 묻기.
- `always`: 매번 묻기.

묻기는 허용 목록과 **독립적**이며, 허용 목록은 `always` 또는 `on-miss`와 함께 사용할 수 있습니다.

### 정책 해결 (exec별)

1. `exec.host`를 해결 (도구 파라미터 → 에이전트 덮어쓰기 → 전역 기본값).
2. `exec.security` 및 `exec.ask` 해결 (동일한 우선순위).
3. 호스트가 `sandbox`인 경우, 로컬 샌드박스 exec을 진행.
4. 호스트가 `gateway` 또는 `node`인 경우, 해당 호스트에서 보안 + 묻기 정책 적용.

## 기본 안전

- 기본 `exec.host = sandbox`.
- `gateway` 및 `node`에 대한 기본 `exec.security = deny`.
- 기본 `exec.ask = on-miss` (보안이 허용할 경우에만 관련됨).
- 노드 바인딩이 설정되지 않은 경우, **에이전트는 정책이 허용하는 경우에만** 임의의 노드를 대상으로 할 수 있습니다.

## 설정 표면

### 도구 파라미터

- `exec.host` (선택): `sandbox | gateway | node`.
- `exec.security` (선택): `deny | allowlist | full`.
- `exec.ask` (선택): `off | on-miss | always`.
- `exec.node` (선택): `host=node`일 때 사용할 노드 ID/이름.

### 설정 키 (전역)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (기본 노드 바인딩)

### 설정 키 (에이전트별)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 별칭

- `/elevated on` = 에이전트 세션에 대해 `tools.exec.host=gateway`, `tools.exec.security=full`로 설정.
- `/elevated off` = 에이전트 세션에 대한 이전 exec 설정 복원.

## 승인 저장소 (JSON)

경로: `~/.openclaw/exec-approvals.json`

목적:

- **Execution host** (게이트웨이 또는 노드 런너)에 대한 로컬 정책 + 허용 목록.
- UI가 없을 때 묻기 대체.
- UI 클라이언트를 위한 IPC 인증 정보.

제안된 스키마 (v1):

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

참고 사항:

- 레거시 허용 목록 형식 없음.
- `askFallback`은 `ask`가 필요하고 UI에 접근할 수 없을 때만 적용.
- 파일 권한: `0600`.

## 러너 서비스 (헤드리스)

### 역할

- 로컬에서 `exec.security` + `exec.ask` 강제 실행.
- 시스템 명령어를 실행하고 출력을 반환.
- exec 수명 주기에 대한 Bridge 이벤트 발행 (선택적이지만 권장).

### 서비스 수명 주기

- macOS에서는 Launchd/데몬; Linux/Windows에서는 시스템 서비스.
- 승인 JSON은 실행 호스트에 로컬.
- UI는 로컬 유닉스 소켓을 호스팅하며, 러너는 필요할 때 연결.

## UI 통합 (macOS 앱)

### IPC

- `~/.openclaw/exec-approvals.sock`에서 유닉스 소켓 (0600).
- `exec-approvals.json`에 저장된 토큰 (0600).
- 피어 검사: 동일 UID만 허용.
- 챌린지/응답: 재생 방지를 위한 nonce + HMAC(토큰, 요청 해시).
- 짧은 TTL (예: 10초) + 최대 페이로드 + 속도 제한.

### 묻기 흐름 (macOS 앱 exec 호스트)

1. 게이트웨이로부터 `system.run`을 수신하는 노드 서비스.
2. 노드 서비스는 로컬 소켓에 연결해 프롬프트/exec 요청을 보냄.
3. 앱은 피어 + 토큰 + HMAC + TTL을 검증한 후 필요 시 대화 상자 표시.
4. 앱은 UI 컨텍스트에서 명령을 실행하고 출력을 반환.
5. 노드 서비스는 게이트웨이에 출력을 반환.

UI가 없을 경우:

- `askFallback` 적용 (`deny|allowlist|full`).

### 다이어그램 (SCI)

```
에이전트 -> 게이트웨이 -> 브리지 -> 노드 서비스 (TS)
                             |  IPC (UDS + 토큰 + HMAC + TTL)
                             v
                         Mac 앱 (UI + TCC + system.run)
```

## 노드 아이덴티티 + 바인딩

- Bridge 페어링에서 기존 `nodeId` 사용.
- 바인딩 모델:
  - `tools.exec.node`는 에이전트를 특정 노드로 제한.
  - 설정되지 않았을 경우, 에이전트는 임의의 노드를 선택할 수 있음 (정책이 기본값을 강제하는 경우에만).
- 노드 선택 해결:
  - `nodeId` 정확한 일치
  - `displayName` (정규화됨)
  - `remoteIp`
  - `nodeId` 접두사 (>= 6자)

## 이벤트 처리

### 이벤트를 보는 사람

- 시스템 이벤트는 **세션별**이며, 에이전트는 다음 프롬프트에서 확인.
- 게이트웨이의 메모리 내 큐에 저장 (`enqueueSystemEvent`).

### 이벤트 텍스트

- `Exec 시작됨 (노드=<id>, id=<runId>)`
- `Exec 완료됨 (노드=<id>, id=<runId>, 코드=<code>)` + 선택적 출력 꼬리
- `Exec 거부됨 (노드=<id>, id=<runId>, <이유>)`

### 전송

옵션 A (권장):

- Runner는 Bridge `event` 프레임 `exec.started` / `exec.finished` 전송.
- 게이트웨이 `handleBridgeEvent`가 이를 `enqueueSystemEvent`로 매핑.

옵션 B:

- 게이트웨이 `exec` 도구가 수명 주기를 직접 처리 (동기식만).

## Exec 흐름

### 샌드박스 호스트

- 기존 `exec` 동작 (Docker 또는 비샌드박스 모드에서 호스트 실행).
- PTY는 비샌드박스 모드에서만 지원됨.

### 게이트웨이 호스트

- 게이트웨이 프로세스는 자체 머신에서 실행.
- 로컬 `exec-approvals.json` 강제 적용 (보안/묻기/허용 목록).

### 노드 호스트

- 게이트웨이는 `system.run`과 함께 `node.invoke` 호출.
- 러너는 로컬 승인을 강제.
- 러너는 집계된 stdout/stderr을 반환.
- 시작/완료/거부에 대해 선택적인 Bridge 이벤트.

## 출력 제한

- 결합된 stdout+stderr을 **200k**로 제한; 이벤트용으로 **꼬리 20k** 유지.
- 명확한 접미사로 절단 (예: `"… (truncated)"`).

## 슬래시 명령어

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 에이전트별, 세션별 오버라이드; 설정을 통해 저장되지 않으면 비휘발성 아님.
- `/elevated on|off|ask|full`은 여전히 `host=gateway security=full`의 바로 가기 (승인 건너뛰기와 `full` 포함).

## 크로스 플랫폼 이야기

- 러너 서비스는 휴대 가능한 실행 대상.
- UI는 선택 사항; 누락 시 `askFallback` 적용.
- Windows/Linux도 동일한 승인 JSON + 소켓 프로토콜 지원.

## 구현 단계

### 1단계: 설정 + exec 라우팅

- `exec.host`, `exec.security`, `exec.ask`, `exec.node`를 위한 설정 스키마 추가.
- 도구 배관을 업데이트하여 `exec.host`를 존중.
- `/exec` 슬래시 명령어 추가하고 `/elevated` 별칭 유지.

### 2단계: 승인 저장소 + 게이트웨이 강제

- `exec-approvals.json` 리더/라이터 구현.
- `게이트웨이` 호스트에 허용 목록 + 묻기 모드 강제.
- 출력 제한 추가.

### 3단계: 노드 러너 강제

- 노드 러너 업데이트하여 허용 목록 + 묻기 강제.
- macOS 앱 UI에 유닉스 소켓 프롬프트 브리지 추가.
- `askFallback` 연결.

### 4단계: 이벤트

- exec 수명 주기를 위한 노드 → 게이트웨이 Bridge 이벤트 추가.
- 에이전트 프롬프트용으로 `enqueueSystemEvent`로 매핑.

### 5단계: UI 연마

- Mac 앱: 허용 목록 편집기, 에이전트별 스위처, 묻기 정책 UI.
- 노드 바인딩 컨트롤 (선택 사항).

## 테스트 계획

- 단위 테스트: 허용 목록 일치 (글로브 + 대소문자 구분하지 않음).
- 단위 테스트: 정책 해결 우선순위 (도구 파라미터 → 에이전트 덮어쓰기 → 전역).
- 통합 테스트: 노드 러너 거부/허용/묻기 흐름.
- Bridge 이벤트 테스트: 노드 이벤트 → 시스템 이벤트 라우팅.

## 열린 위험 요소

- UI 사용 불가: `askFallback`이 존중되는지 확인.
- 장시간 실행 명령: 타임아웃 + 출력 제한에 의존.
- 다중 노드 모호성: 노드 바인딩 또는 명시적 노드 파라미터가 없을 경우 에러.

## 관련 문서

- [Exec 도구](/tools/exec)
- [Exec 승인](/tools/exec-approvals)
- [노드](/nodes)
- [승격 모드](/tools/elevated)
