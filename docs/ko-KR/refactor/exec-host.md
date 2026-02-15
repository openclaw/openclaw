---
summary: "Refactor plan: exec host routing, node approvals, and headless runner"
read_when:
  - Designing exec host routing or exec approvals
  - Implementing node runner + UI IPC
  - Adding exec host security modes and slash commands
title: "Exec Host Refactor"
x-i18n:
  source_hash: 53a9059cbeb1f3f1dbb48c2b5345f88ca92372654fef26f8481e651609e45e3a
---

# Exec 호스트 리팩터링 계획

## 목표

- `exec.host` + `exec.security`를 추가하여 **샌드박스**, **게이트웨이** 및 **노드** 전반에 걸쳐 실행을 라우팅합니다.
- 기본값을 **안전하게** 유지: 명시적으로 활성화하지 않는 한 호스트 간 실행이 없습니다.
- 실행을 로컬 IPC를 통해 선택적 UI(macOS 앱)를 사용하여 **헤드리스 실행자 서비스**로 분할합니다.
- **에이전트별** 정책, 허용 목록, 질문 모드 및 노드 바인딩을 제공합니다.
- 허용 목록과 함께* 또는 *없이\_ 작동하는 **질문 모드**를 지원합니다.
- 크로스 플랫폼: Unix 소켓 + 토큰 인증(macOS/Linux/Windows 패리티).

## 논골

- 레거시 허용 목록 마이그레이션 또는 레거시 스키마 지원이 없습니다.
- 노드 실행에 대한 PTY/스트리밍이 없습니다(집계된 출력만 해당).
- 기존 브리지 + 게이트웨이를 넘어서는 새로운 네트워크 계층이 없습니다.

## 결정(잠김)

- **구성 키:** `exec.host` + `exec.security` (에이전트별 재정의가 허용됨).
- **승격:** 게이트웨이 전체 액세스를 위한 별칭으로 `/elevated`를 유지합니다.
- **기본값 묻기:** `on-miss`.
- **승인 저장소:** `~/.openclaw/exec-approvals.json` (JSON, 레거시 마이그레이션 없음).
- **러너:** 헤드리스 시스템 서비스; UI 앱은 승인을 위해 Unix 소켓을 호스팅합니다.
- **노드 ID:** 기존 `nodeId`를 사용합니다.
- **소켓 인증:** Unix 소켓 + 토큰(크로스 플랫폼); 필요한 경우 나중에 분할하세요.
- **노드 호스트 상태:** `~/.openclaw/node.json` (노드 ID + 페어링 토큰).
- **macOS exec 호스트:** macOS 앱 내에서 `system.run`를 실행합니다. 노드 호스트 서비스는 로컬 IPC를 통해 요청을 전달합니다.
- **XPC 도우미 없음:** Unix 소켓 + 토큰 + 피어 검사를 고수합니다.

## 주요 개념

### 호스트

- `sandbox`: Docker exec(현재 동작).
- `gateway`: 게이트웨이 호스트에서 실행됩니다.
- `node`: 브리지를 통해 노드 실행기에서 실행합니다(`system.run`).

### 보안 모드

- `deny`: 항상 차단합니다.
- `allowlist`: 일치하는 항목만 허용합니다.
- `full`: 모든 것을 허용합니다(상승된 것과 동일).

### 질문 모드

- `off`: 묻지 마세요.
- `on-miss`: 허용 목록이 일치하지 않는 경우에만 묻습니다.
- `always`: 매번 물어보세요.

Ask는 허용 목록과 **독립적**입니다. 허용 목록은 `always` 또는 `on-miss`와 함께 사용할 수 있습니다.

### 정책 해결(임원당)

1. `exec.host`(도구 매개변수 → 에이전트 재정의 → 전역 기본값)를 해결합니다.
2. `exec.security` 및 `exec.ask`를 해결합니다(동일한 우선순위).
3. 호스트가 `sandbox`인 경우 로컬 샌드박스 실행을 진행합니다.
4. 호스트가 `gateway` 또는 `node`인 경우 해당 호스트에 보안을 적용하고 정책을 요청합니다.

## 기본 안전

- 기본 `exec.host = sandbox`.
- `gateway` 및 `node`에 대한 기본값 `exec.security = deny`.
- 기본값 `exec.ask = on-miss` (보안이 허용하는 경우에만 관련됨).
- 노드 바인딩이 설정되지 않은 경우 **에이전트는 모든 노드를 대상으로 할 수 있습니다**. 단, 정책에서 허용하는 경우에만 가능합니다.

## 구성 표면

### 도구 매개변수

- `exec.host` (선택 사항): `sandbox | gateway | node`.
- `exec.security` (선택 사항): `deny | allowlist | full`.
- `exec.ask` (선택 사항): `off | on-miss | always`.
- `exec.node` (선택): `host=node` 시 사용할 노드 ID/이름.

### 구성 키(전역)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (기본 노드 바인딩)

### 구성 키(에이전트당)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 별칭

- `/elevated on` = 에이전트 세션에 대해 `tools.exec.host=gateway`, `tools.exec.security=full`를 설정합니다.
- `/elevated off` = 에이전트 세션에 대한 이전 실행 설정을 복원합니다.

## 승인 저장소(JSON)

경로: `~/.openclaw/exec-approvals.json`

목적:

- **실행 호스트**(게이트웨이 또는 노드 실행기)에 대한 로컬 정책 + 허용 목록.
- UI를 사용할 수 없는 경우 대체를 요청하세요.
- UI 클라이언트용 IPC 자격 증명.

제안된 스키마(v1):

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

참고:

- 레거시 허용 목록 형식이 없습니다.
- `askFallback`는 `ask`가 필수이고 UI에 접근할 수 없는 경우에만 적용됩니다.
- 파일 권한 : `0600`.

## 러너 서비스(헤드리스)

### 역할

- `exec.security` + `exec.ask`를 로컬에서 시행합니다.
- 시스템 명령을 실행하고 출력을 반환합니다.
- 실행 수명 주기에 대한 브리지 이벤트를 내보냅니다(선택 사항이지만 권장됨).

### 서비스 수명주기

- macOS에서 실행/데몬; Linux/Windows의 시스템 서비스.
- 승인 JSON은 실행 호스트에 대해 로컬입니다.
- UI는 로컬 Unix 소켓을 호스팅합니다. 주자는 요청 시 연결됩니다.

## UI 통합(macOS 앱)

### IPC

- `~/.openclaw/exec-approvals.sock` (0600)의 Unix 소켓.
- `exec-approvals.json`(0600)에 저장된 토큰입니다.
- 피어 확인: 동일한 UID만 가능합니다.
- 챌린지/응답: nonce + HMAC(token, request-hash)로 재생을 방지합니다.
- 짧은 TTL(예: 10초) + 최대 페이로드 + 속도 제한.

### 질문 흐름(macOS 앱 실행 호스트)

1. 노드 서비스는 게이트웨이로부터 `system.run`를 수신합니다.
2. 노드 서비스는 로컬 소켓에 연결하고 프롬프트/실행 요청을 보냅니다.
3. 앱은 피어 + 토큰 + HMAC + TTL의 유효성을 검사한 다음 필요한 경우 대화 상자를 표시합니다.
4. 앱은 UI 컨텍스트에서 명령을 실행하고 출력을 반환합니다.
5. 노드 서비스는 출력을 게이트웨이로 반환합니다.

UI가 누락된 경우:

- `askFallback` (`deny|allowlist|full`)를 적용합니다.

### 다이어그램(SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## 노드 ID + 바인딩

- 브릿지 페어링에서 기존 `nodeId`를 사용합니다.
- 바인딩 모델:
  - `tools.exec.node`는 에이전트를 특정 노드로 제한합니다.
  - 설정되지 않은 경우 에이전트는 모든 노드를 선택할 수 있습니다(정책은 여전히 ​​기본값을 적용합니다).
- 노드 선택 해결:
  - `nodeId` 완전 일치
  - `displayName` (정규화됨)
  - `remoteIp`
  - `nodeId` 접두어(>= 6자)

## 이벤트

### 이벤트를 보는 사람

- 시스템 이벤트는 **세션별**이며 다음 프롬프트에서 상담사에게 표시됩니다.
- 게이트웨이 인메모리 큐(`enqueueSystemEvent`)에 저장됩니다.

### 이벤트 텍스트

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 선택적 출력 꼬리
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### 교통

옵션 A(권장):

- 러너는 브리지 `event` 프레임 `exec.started` / `exec.finished`을 보냅니다.
- 게이트웨이 `handleBridgeEvent`는 이를 `enqueueSystemEvent`에 매핑합니다.

옵션 B:

- 게이트웨이 `exec` 도구는 수명 주기를 직접 처리합니다(동기식만 해당).

## 실행 흐름

### 샌드박스 호스트

- 기존 `exec` 동작(샌드박스 해제 시 Docker 또는 호스트).
- PTY는 비샌드박스 모드에서만 지원됩니다.

### 게이트웨이 호스트

- 게이트웨이 프로세스는 자체 머신에서 실행됩니다.
- 로컬 `exec-approvals.json`(보안/질문/허용 목록)을 시행합니다.

### 노드 호스트

- 게이트웨이는 `system.run`를 사용하여 `node.invoke`를 호출합니다.
- 러너는 현지 승인을 시행합니다.
- Runner는 집계된 stdout/stderr를 반환합니다.
- 시작/종료/거부를 위한 선택적 브리지 이벤트.

## 출력 캡

- **200k**에서 stdout+stderr을 결합한 캡; 이벤트를 위해 **꼬리 20k**를 유지하세요.
- 명확한 접미사로 잘라냅니다(예: `"… (truncated)"`).

## 슬래시 명령

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 에이전트별, 세션별 재정의; 구성을 통해 저장되지 않는 한 비영구적입니다.
- `/elevated on|off|ask|full`는 `host=gateway security=full`에 대한 바로가기로 남아 있습니다(`full`는 승인을 건너뜁니다).

## 크로스 플랫폼 스토리

- 러너 서비스는 이식 가능한 실행 대상입니다.
- UI는 선택사항입니다. 누락된 경우 `askFallback`가 적용됩니다.
- Windows/Linux는 동일한 승인 JSON + 소켓 프로토콜을 지원합니다.

## 구현 단계

### 1단계: 구성 + 실행 라우팅

- `exec.host`, `exec.security`, `exec.ask`, `exec.node`에 대한 구성 스키마를 추가합니다.
- `exec.host`을 준수하도록 도구 배관을 업데이트합니다.
- `/exec` 슬래시 명령을 추가하고 `/elevated` 별칭을 유지합니다.

### 2단계: 승인 저장소 + 게이트웨이 시행

- `exec-approvals.json` 리더/라이터를 구현합니다.
- `gateway` 호스트에 대해 허용 목록 + 요청 모드를 적용합니다.
- 출력 캡을 추가합니다.

### 3단계: 노드 실행기 시행

- 허용 목록 + 요청을 시행하도록 노드 실행기를 업데이트합니다.
- macOS 앱 UI에 Unix 소켓 프롬프트 브리지를 추가합니다.
- `askFallback`를 연결합니다.

### 4단계: 이벤트

- 실행 수명주기에 대한 노드 → 게이트웨이 브리지 이벤트를 추가합니다.
- 에이전트 프롬프트를 `enqueueSystemEvent`에 매핑합니다.

### 5단계: UI 개선

- Mac 앱: 허용 목록 편집기, 에이전트별 전환기, 정책 UI 요청.
- 노드 바인딩 제어(선택 사항).

## 테스트 계획

- 단위 테스트: 허용 목록 일치(glob + 대소문자 구분 안 함).
- 단위 테스트: 정책 해결 우선 순위(도구 매개변수 → 에이전트 재정의 → 전역).
- 통합 테스트: 노드 실행기 거부/허용/요청 흐름.
- 브리지 이벤트 테스트: 노드 이벤트 → 시스템 이벤트 라우팅.

## 공개 위험

- UI 사용 불가: `askFallback`가 준수되는지 확인하세요.
- 장기 실행 명령: 시간 초과 + 출력 제한에 의존합니다.
- 다중 노드 모호성: 노드 바인딩이나 명시적인 노드 매개변수가 아닌 이상 오류가 발생합니다.

## 관련 문서

- [실행 도구](/tools/exec)
- [실행 승인](/tools/exec-approvals)
- [노드](/nodes)
- [승격 모드](/tools/elevated)
