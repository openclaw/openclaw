---
title: Sandbox vs Tool Policy vs Elevated
summary: "도구가 차단되는 이유: 샌드박스 런타임, 도구 허용/차단 정책, Elevated exec 게이트"
read_when: "'sandbox jail' 에 걸렸거나 도구/Elevated 거부를 보았고 변경해야 할 정확한 구성 키가 필요할 때."
status: active
---

# Sandbox vs Tool Policy vs Elevated

OpenClaw 에는 서로 관련되지만 서로 다른 세 가지 제어가 있습니다:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) 는 **도구가 어디에서 실행되는지** (Docker vs 호스트) 를 결정합니다.
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) 는 **어떤 도구가 사용 가능/허용되는지** 를 결정합니다.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) 는 샌드박스 상태일 때 호스트에서 실행하기 위한 **exec 전용 탈출구** 입니다.

## 빠른 디버그

Inspector 를 사용하여 OpenClaw 가 _실제로_ 무엇을 하고 있는지 확인하십시오:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

다음이 출력됩니다:

- 유효한 샌드박스 모드/범위/워크스페이스 접근
- 현재 세션이 샌드박스화되어 있는지 여부 (메인 vs 비메인)
- 유효한 샌드박스 도구 허용/차단 (그리고 에이전트/글로벌/기본 중 어디에서 왔는지)
- Elevated 게이트와 수정용 키 경로

## Sandbox: 도구가 실행되는 위치

샌드박스화는 `agents.defaults.sandbox.mode` 로 제어됩니다:

- `"off"`: 모든 것이 호스트에서 실행됩니다.
- `"non-main"`: 비메인 세션만 샌드박스화됩니다 (그룹/채널에서 흔한 '깜짝' 상황).
- `"all"`: 모든 것이 샌드박스화됩니다.

전체 매트릭스 (범위, 워크스페이스 마운트, 이미지) 는 [Sandboxing](/gateway/sandboxing) 을 참고하십시오.

### 바인드 마운트 (보안 빠른 점검)

- `docker.binds` 는 샌드박스 파일시스템을 _관통_ 합니다: 마운트한 항목은 설정한 모드 (`:ro` 또는 `:rw`) 로 컨테이너 내부에서 보입니다.
- 모드를 생략하면 기본값은 읽기-쓰기입니다; 소스/시크릿에는 `:ro` 를 선호하십시오.
- `scope: "shared"` 는 에이전트별 바인드를 무시합니다 (글로벌 바인드만 적용).
- `/var/run/docker.sock` 를 바인딩하면 사실상 샌드박스에 호스트 제어를 넘기는 것입니다; 의도적으로만 수행하십시오.
- 워크스페이스 접근 (`workspaceAccess: "ro"`/`"rw"`) 은 바인드 모드와 독립적입니다.

## Tool policy: 어떤 도구가 존재/호출 가능한지

두 가지 레이어가 중요합니다:

- **Tool profile**: `tools.profile` 및 `agents.list[].tools.profile` (기본 허용 목록)
- **Provider tool profile**: `tools.byProvider[provider].profile` 및 `agents.list[].tools.byProvider[provider].profile`
- **글로벌/에이전트별 도구 정책**: `tools.allow`/`tools.deny` 및 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider 도구 정책**: `tools.byProvider[provider].allow/deny` 및 `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox 도구 정책** (샌드박스화된 경우에만 적용): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 및 `agents.list[].tools.sandbox.tools.*`

Rules of thumb:

- `deny` 가 항상 우선합니다.
- `allow` 가 비어 있지 않으면, 나머지는 모두 차단된 것으로 취급됩니다.
- 도구 정책은 하드 스톱입니다: `/exec` 는 거부된 `exec` 도구를 재정의할 수 없습니다.
- `/exec` 는 권한 있는 발신자에 대해 세션 기본값만 변경하며, 도구 접근 권한을 부여하지 않습니다.
  Provider 도구 키는 `provider` (예: `google-antigravity`) 또는 `provider/model` (예: `openai/gpt-5.2`) 를 허용합니다.

### 도구 그룹 (단축 표현)

도구 정책 (글로벌, 에이전트, 샌드박스) 은 여러 도구로 확장되는 `group:*` 항목을 지원합니다:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

사용 가능한 그룹:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: 모든 내장 OpenClaw 도구 (프로바이더 플러그인 제외)

## Elevated: exec 전용 '호스트에서 실행'

Elevated 는 추가 도구를 부여하지 않으며, `exec` 에만 영향을 미칩니다.

- 샌드박스 상태라면, `/elevated on` (또는 `exec` 와 `elevated: true`) 가 호스트에서 실행됩니다 (승인이 여전히 적용될 수 있음).
- 세션에 대해 exec 승인을 건너뛰려면 `/elevated full` 를 사용하십시오.
- 이미 직접 실행 중이라면, Elevated 는 사실상 무동작입니다 (여전히 게이트됨).
- Elevated 는 **Skill 범위가 아니며** 도구 허용/차단을 **재정의하지 않습니다**.
- `/exec` 는 Elevated 와 별개입니다. 권한 있는 발신자에 대해 세션별 exec 기본값만 조정합니다.

게이트:

- 활성화: `tools.elevated.enabled` (및 선택적으로 `agents.list[].tools.elevated.enabled`)
- 발신자 허용 목록: `tools.elevated.allowFrom.<provider>` (및 선택적으로 `agents.list[].tools.elevated.allowFrom.<provider>`)

자세한 내용은 [Elevated Mode](/tools/elevated) 를 참고하십시오.

## 일반적인 'sandbox jail' 해결 방법

### 'Tool X 가 샌드박스 도구 정책에 의해 차단됨'

수정 키 (하나 선택):

- 샌드박스 비활성화: `agents.defaults.sandbox.mode=off` (또는 에이전트별 `agents.list[].sandbox.mode=off`)
- 샌드박스 내부에서 도구 허용:
  - `tools.sandbox.tools.deny` 에서 제거 (또는 에이전트별 `agents.list[].tools.sandbox.tools.deny`)
  - 또는 `tools.sandbox.tools.allow` 에 추가 (또는 에이전트별 허용)

### '메인이라고 생각했는데 왜 샌드박스인가요?'

`"non-main"` 모드에서는 그룹/채널 키가 _메인_ 이 아닙니다. 메인 세션 키 (`sandbox explain` 에 표시됨) 를 사용하거나 모드를 `"off"` 로 전환하십시오.
