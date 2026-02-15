---
title: Sandbox vs Tool Policy vs Elevated
summary: "Why a tool is blocked: sandbox runtime, tool allow/deny policy, and elevated exec gates"
read_when: "You hit 'sandbox jail' or see a tool/elevated refusal and want the exact config key to change."
status: active
x-i18n:
  source_hash: 863ea5e6d137dfb61f12bd686b9557d6df1fd0c13ba5f15861bf72248bc975f1
---

# 샌드박스 vs 도구 정책 vs 상승

OpenClaw에는 세 가지 관련(그러나 다른) 컨트롤이 있습니다.

1. **샌드박스** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`)는 **도구가 실행되는 위치**(Docker 대 호스트)를 결정합니다.
2. **도구 정책** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`)은 **사용 가능한/허용되는 도구**를 결정합니다.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`)는 샌드박스 처리 시 호스트에서 실행되는 **실행 전용 탈출 해치**입니다.

## 빠른 디버그

OpenClaw가 _실제로_ 무엇을 하고 있는지 보려면 검사기를 사용하세요.

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

다음과 같이 인쇄됩니다.

- 효과적인 샌드박스 모드/범위/작업 공간 액세스
- 세션이 현재 샌드박스 처리되어 있는지 여부(메인 및 비메인)
- 효과적인 샌드박스 도구 허용/거부(및 에이전트/전역/기본값에서 왔는지 여부)
- 높은 게이트와 수리용 열쇠 경로

## 샌드박스: 도구가 실행되는 곳

샌드박싱은 `agents.defaults.sandbox.mode`에 의해 제어됩니다.

- `"off"`: 모든 것이 호스트에서 실행됩니다.
- `"non-main"`: 기본이 아닌 세션만 샌드박스 처리됩니다(그룹/채널에 대한 일반적인 "놀라움").
- `"all"`: 모든 것이 샌드박스 처리됩니다.

전체 매트릭스(범위, 작업 공간 마운트, 이미지)는 [샌드박싱](/gateway/sandboxing)을 참조하세요.

### 바인드 마운트(보안 빠른 검사)

- `docker.binds` 샌드박스 파일 시스템을 _pierces_: 마운트한 모든 것이 설정한 모드(`:ro` 또는 `:rw`)로 컨테이너 내부에 표시됩니다.
- 모드를 생략하면 기본값은 읽기-쓰기입니다. 소스/비밀에는 `:ro`를 선호합니다.
- `scope: "shared"`는 에이전트별 바인딩을 무시합니다(전역 바인딩만 적용됨).
- `/var/run/docker.sock` 바인딩은 호스트 제어권을 샌드박스에 효과적으로 전달합니다. 의도적으로만 그렇게 하세요.
- 작업공간 액세스(`workspaceAccess: "ro"`/`"rw"`)는 바인드 모드와 무관합니다.

## 도구 정책: 존재하는 도구/호출 가능한 도구

두 가지 레이어가 중요합니다.

- **도구 프로필**: `tools.profile` 및 `agents.list[].tools.profile` (기본 허용 목록)
- **공급자 도구 프로필**: `tools.byProvider[provider].profile` 및 `agents.list[].tools.byProvider[provider].profile`
- **글로벌/에이전트별 도구 정책**: `tools.allow`/`tools.deny` 및 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **공급자 도구 정책**: `tools.byProvider[provider].allow/deny` 및 `agents.list[].tools.byProvider[provider].allow/deny`
- **샌드박스 도구 정책**(샌드박스가 적용된 경우에만 적용): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 및 `agents.list[].tools.sandbox.tools.*`

경험 법칙:

- `deny`는 항상 승리합니다.
- `allow`가 비어 있지 않으면 다른 모든 항목은 차단된 것으로 간주됩니다.
- 도구 정책은 강제 중지입니다. `/exec`는 거부된 `exec` 도구를 무시할 수 없습니다.
- `/exec`는 승인된 발신자에 대한 세션 기본값만 변경합니다. 도구 액세스 권한은 부여되지 않습니다.
  공급자 도구 키는 `provider`(예: `google-antigravity`) 또는 `provider/model`(예: `openai/gpt-5.2`)를 허용합니다.

### 도구 그룹(약칭)

도구 정책(글로벌, 에이전트, 샌드박스)은 여러 도구로 확장되는 `group:*` 항목을 지원합니다.

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
- `group:openclaw`: 모든 내장 OpenClaw 도구(제공자 플러그인 제외)

## 상승: 실행 전용 "호스트에서 실행"

Elevated는 추가 도구를 부여하지 **않습니다**. `exec`에만 영향을 미칩니다.

- 샌드박스를 사용하는 경우 `/elevated on`(또는 `elevated: true` 포함 `exec`)가 호스트에서 실행됩니다(승인은 계속 적용될 수 있음).
- 세션에 대한 실행 승인을 건너뛰려면 `/elevated full`를 사용하십시오.
- 이미 직접 실행 중인 경우 상승은 사실상 무작동입니다(여전히 게이트가 적용됨).
- 상승은 기술 범위가 **아님**이며 도구 허용/거부보다 우선 적용되지 **않습니다**.
- `/exec`는 고가와 별개입니다. 승인된 발신자에 대한 세션별 실행 기본값만 조정합니다.

게이트:

- 활성화: `tools.elevated.enabled` (및 선택적으로 `agents.list[].tools.elevated.enabled`)
- 발신자 허용 목록: `tools.elevated.allowFrom.<provider>` (선택적으로 `agents.list[].tools.elevated.allowFrom.<provider>`)

[승격된 모드](/tools/elevated)를 참조하세요.

## 일반적인 "샌드박스 감옥" 수정

### “샌드박스 도구 정책에 의해 도구 X가 차단되었습니다”

Fix-it 키(하나 선택):

- 샌드박스 비활성화: `agents.defaults.sandbox.mode=off` (또는 에이전트별 `agents.list[].sandbox.mode=off`)
- 샌드박스 내부 도구 허용:
  - `tools.sandbox.tools.deny`(또는 에이전트별 `agents.list[].tools.sandbox.tools.deny`)에서 제거합니다.
  - 또는 `tools.sandbox.tools.allow`에 추가합니다(또는 에이전트별로 허용).

### “메인인 줄 알았는데 왜 샌드박스 처리되어 있나요?”

`"non-main"` 모드에서는 그룹/채널 키가 메인이 _아닙니다_. 기본 세션 키(`sandbox explain`로 표시)를 사용하거나 모드를 `"off"`로 전환하세요.
