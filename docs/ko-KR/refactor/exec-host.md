---
summary: "리팩터 계획: exec host 라우팅, 노드 승인, headless runner"
read_when:
  - Designing exec host routing or exec approvals
  - Implementing node runner + UI IPC
  - Adding exec host security modes and slash commands
title: "Exec Host 리팩터"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/refactor/exec-host.md
  workflow: 15
---

# Exec host 리팩터 계획

## 목표

- `exec.host` + `exec.security`를 추가하여 **sandbox**, **gateway**, **node** 전체에서 실행을 라우팅합니다.
- 기본값을 **안전하게** 유지합니다: 명시적으로 활성화되지 않는 한 교차-호스트 실행이 없습니다.
- 실행을 **headless runner 서비스**로 분할하고 선택적 UI (macOS 앱)를 로컬 IPC를 통해 제공합니다.
- **에이전트별** 정책, 허용 목록, ask 모드 및 노드 바인딩을 제공합니다.
- **ask 모드**가 허용 목록이 있거나 없이 작동하는 것을 지원합니다.
- 교차-플랫폼: Unix 소켓 + 토큰 인증 (macOS/Linux/Windows 패리티).

## 비목표

- 레거시 허용 목록 마이그레이션 또는 레거시 스키마 지원 없음.
- 노드 exec에 대한 PTY/스트리밍 없음 (집계된 출력만).
- 기존 Bridge + Gateway를 넘어서는 새로운 네트워크 계층 없음.

## 결정 (잠금됨)

- **Config 키:** `exec.host` + `exec.security` (에이전트별 재정의 허용).
- **Elevation:** `/elevated`를 gateway 전체 액세스의 별칭으로 유지합니다.
- **Ask 기본값:** `on-miss`.
- **승인 저장소:** `~/.openclaw/exec-approvals.json` (JSON, 레거시 마이그레이션 없음).
- **Runner:** headless 시스템 서비스; UI 앱이 승인용 Unix 소켓을 호스팅합니다.
- **노드 신원:** 기존 `nodeId`를 사용합니다.
- **Socket 인증:** Unix 소켓 + 토큰 (교차-플랫폼); 필요한 경우 나중에 분할합니다.
- **노드 호스트 상태:** `~/.openclaw/node.json` (노드 id + 페어링 토큰).
- **macOS exec host:** macOS 앱 내에서 `system.run`을 실행합니다; 노드 호스트 서비스가 로컬 IPC를 통해 요청을 전달합니다.
- **XPC helper 없음:** Unix 소켓 + 토큰 + peer checks를 고수합니다.

## 주요 개념

### Host

- `sandbox`: Docker exec (현재 동작).
- `gateway`: gateway 호스트에서 exec.
- `node`: Bridge를 통한 노드 runner에서 exec (`system.run`).

### 보안 모드

- `deny`: 항상 차단합니다.
- `allowlist`: 매치만 허용합니다.
- `full`: 모든 것을 허용합니다 (elevated와 동등).

### Ask 모드

- `off`: 절대 묻지 않음.
- `on-miss`: 허용 목록이 일치하지 않을 때만 묻습니다.
- `always`: 매번 묻습니다.

Ask는 허용 목록과 **독립적**입니다; 허용 목록은 `always` 또는 `on-miss`와 함께 사용할 수 있습니다.

### 정책 해결 (exec별)

1. `exec.host` 해결 (tool 매개변수 → agent 재정의 → 전역 기본값).
2. `exec.security` 및 `exec.ask` 해결 (동일한 우선순위).
3. host가 `sandbox`이면 로컬 sandbox exec을 진행합니다.
4. host가 `gateway` 또는 `node`이면 해당 호스트에 보안 + ask 정책을 적용합니다.

## 기본 안전성

- 기본 `exec.host = sandbox`.
- `gateway` 및 `node`에 대한 기본 `exec.security = deny`.
- 기본 `exec.ask = on-miss` (보안이 허용할 경우에만 관련).
- 노드 바인딩이 설정되지 않으면, **에이전트는 모든 노드를 대상으로 지정할 수 있음**, 하지만 정책이 허용할 경우에만.

## Config 표면

### Tool 매개변수

- `exec.host` (선택사항): `sandbox | gateway | node`.
- `exec.security` (선택사항): `deny | allowlist | full`.
- `exec.ask` (선택사항): `off | on-miss | always`.
- `exec.node` (선택사항): `host=node`일 때 사용할 노드 id/이름.

### Config 키 (전역)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (기본 노드 바인딩)

### Config 키 (에이전트별)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 별칭

- `/elevated on` = agent 세션에 대해 `tools.exec.host=gateway`, `tools.exec.security=full`을 설정합니다.
- `/elevated off` = agent 세션에 대해 이전 exec 설정을 복원합니다.

## 승인 저장소 (JSON)

경로: `~/.openclaw/exec-approvals.json`

목적:

- **실행 호스트**(gateway 또는 노드 runner)에 대한 로컬 정책 + 허용 목록.
- UI를 사용할 수 없을 때 ask 폴백.
- UI 클라이언트에 대한 IPC 자격 증명.

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

노트:

- 레거시 허용 목록 형식이 없습니다.
- `askFallback`은 `ask`가 필요하고 UI에 도달할 수 없을 때만 적용됩니다.
- 파일 권한: `0600`.

## Runner 서비스 (headless)

### 역할

- 로컬에서 `exec.security` + `exec.ask`를 적용합니다.
- 시스템 명령을 실행하고 출력을 반환합니다.
- exec 라이프사이클에 대해 Bridge 이벤트를 내보냅니다 (선택사항이지만 권장).

### 서비스 라이프사이클

- macOS에서 Launchd/daemon; Linux/Windows에서 시스템 서비스.
- 승인 JSON은 실행 호스트에 로컬입니다.
- UI가 로컬 Unix 소켓을 호스팅합니다; runners가 필요에 따라 연결합니다.

## UI 통합 (macOS 앱)

### IPC

- `~/.openclaw/exec-approvals.sock` (0600)의 Unix 소켓.
- `exec-approvals.json`에 저장된 토큰 (0600).
- Peer 검사: 동일한 UID만.
- Challenge/응답: nonce + HMAC(token, request-hash)으로 재생 방지.
- 짧은 TTL (예: 10초) + 최대 페이로드 + rate limit.

### Ask 흐름 (macOS 앱 exec host)

1. 노드 서비스가 gateway에서 `system.run`을 받습니다.
2. 노드 서비스가 로컬 소켓에 연결하고 프롬프트/exec 요청을 보냅니다.
3. 앱이 peer + 토큰 + HMAC + TTL을 검증한 다음 필요한 경우 대화상자를 표시합니다.
4. 앱이 UI 컨텍스트에서 명령을 실행하고 출력을 반환합니다.
5. 노드 서비스가 gateway에 출력을 반환합니다.

UI가 누락된 경우:

- `askFallback` (`deny|allowlist|full`)을 적용합니다.

### 다이어그램 (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## 노드 신원 + 바인딩

- Bridge 페어링에서 기존 `nodeId`를 사용합니다.
- 바인딩 모델:
  - `tools.exec.node`는 에이전트를 특정 노드로 제한합니다.
  - 설정되지 않으면, 에이전트는 모든 노드를 선택할 수 있음 (정책이 여전히 기본값을 적용).
- 노드 선택 해결:
  - `nodeId` 정확히 일치
  - `displayName` (정규화됨)
  - `remoteIp`
  - `nodeId` 접두사 (>= 6 문자)

## Eventing

### 이벤트를 본 사람

- 시스템 이벤트는 **세션별**이고 다음 프롬프트에서 에이전트에 표시됩니다.
- gateway 메모리 내 큐에 저장됨 (`enqueueSystemEvent`).

### 이벤트 텍스트

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 선택적 출력 꼬리
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### 전송

옵션 A (권장):

- Runner가 Bridge `event` 프레임 `exec.started` / `exec.finished`를 보냅니다.
- Gateway `handleBridgeEvent`이 이를 `enqueueSystemEvent`에 매핑합니다.

옵션 B:

- Gateway `exec` 도구가 라이프사이클을 직접 처리합니다 (동기만).

## Exec 흐름

### Sandbox host

- 기존 `exec` 동작 (Docker 또는 비-샌드박스 시 호스트).
- PTY는 비-sandbox 모드에서만 지원됩니다.

### Gateway host

- Gateway 프로세스가 자신의 머신에서 실행됩니다.
- 로컬 `exec-approvals.json`을 적용합니다 (보안/ask/허용 목록).

### Node host

- Gateway가 `node.invoke`를 `system.run`으로 호출합니다.
- Runner가 로컬 승인을 적용합니다.
- Runner가 집계된 stdout/stderr을 반환합니다.
- 시작/종료/거부에 대한 선택적 Bridge 이벤트.

## 출력 상한선

- 결합된 stdout+stderr를 **200k**로 제한; **tail 20k**를 이벤트에 유지합니다.
- 명확한 접미사로 자르기 (예: `"… (truncated)"`).

## Slash 명령

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 에이전트별, 세션별 재정의; config를 통해 저장하지 않는 한 비-영구적.
- `/elevated on|off|ask|full`은 `host=gateway security=full`의 바로가기로 남아있습니다 (승인을 건너뛰는 `full` 포함).

## 교차-플랫폼 스토리

- Runner 서비스는 휴대용 실행 대상입니다.
- UI는 선택사항; 누락된 경우, `askFallback`이 적용됩니다.
- Windows/Linux는 동일한 승인 JSON + 소켓 프로토콜을 지원합니다.

## 구현 단계

### Phase 1: config + exec 라우팅

- `exec.host`, `exec.security`, `exec.ask`, `exec.node`에 대한 config 스키마를 추가합니다.
- tool 배관을 `exec.host`를 존중하도록 업데이트합니다.
- `/exec` slash 명령을 추가하고 `/elevated` 별칭을 유지합니다.

### Phase 2: 승인 저장소 + gateway 적용

- `exec-approvals.json` 판독기/작성기를 구현합니다.
- `gateway` host에 대한 허용 목록 + ask 모드를 적용합니다.
- 출력 상한선을 추가합니다.

### Phase 3: 노드 runner 적용

- 노드 runner를 허용 목록 + ask를 적용하도록 업데이트합니다.
- macOS 앱 UI에 Unix 소켓 프롬프트 브리지를 추가합니다.
- `askFallback`를 연결합니다.

### Phase 4: 이벤트

- exec 라이프사이클에 대해 노드 → gateway Bridge 이벤트를 추가합니다.
- agent 프롬프트에 대해 `enqueueSystemEvent`에 매핑합니다.

### Phase 5: UI 광택

- Mac 앱: 허용 목록 편집기, 에이전트별 전환기, ask 정책 UI.
- 노드 바인딩 컨트롤 (선택사항).

## 테스트 계획

- 단위 테스트: 허용 목록 일치 (glob + 대소문자-구분되지 않음).
- 단위 테스트: 정책 해결 우선순위 (tool 매개변수 → agent 재정의 → 전역).
- 통합 테스트: 노드 runner deny/allow/ask 흐름.
- Bridge 이벤트 테스트: 노드 이벤트 → 시스템 이벤트 라우팅.

## 열린 위험

- UI 불가용성: `askFallback`이 존중되는지 확인합니다.
- 장시간 실행되는 명령: 타임아웃 + 출력 상한선에 의존합니다.
- 다중-노드 모호성: 노드 바인딩 또는 명시적 노드 매개변수가 아닌 경우 오류.

## 관련 문서

- [Exec tool](/tools/exec)
- [Exec 승인](/tools/exec-approvals)
- [노드](/nodes)
- [Elevated mode](/tools/elevated)
