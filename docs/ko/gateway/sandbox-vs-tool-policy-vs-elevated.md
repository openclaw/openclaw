---
read_when: You hit 'sandbox jail' or see a tool/elevated refusal and want the exact config key to change.
status: active
summary: '도구가 차단되는 이유: 샌드박스 런타임, 도구 허용/거부 정책 및 상승된 실행 게이트'
title: 샌드박스 vs 도구 정책 vs 상승
x-i18n:
    generated_at: "2026-02-08T15:59:53Z"
    model: gtx
    provider: google-translate
    source_hash: 863ea5e6d137dfb61f12bd686b9557d6df1fd0c13ba5f15861bf72248bc975f1
    source_path: gateway/sandbox-vs-tool-policy-vs-elevated.md
    workflow: 15
---

# 샌드박스 vs 도구 정책 vs 상승

OpenClaw에는 세 가지 관련(그러나 다른) 컨트롤이 있습니다.

1. **모래 상자** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) 결정 **도구가 실행되는 곳** (Docker 대 호스트).
2. **도구 정책** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) 결정 **사용 가능한/허용되는 도구**.
3. **높은** (`tools.elevated.*`, `agents.list[].tools.elevated.*`)는 **임원 전용 탈출구** 샌드박스 처리 시 호스트에서 실행됩니다.

## 빠른 디버그

검사기를 사용하여 OpenClaw가 무엇인지 확인하세요. _실제로_ 행위:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

다음과 같이 인쇄됩니다.

- 효과적인 샌드박스 모드/범위/작업 공간 액세스
- 세션이 현재 샌드박스 처리되어 있는지 여부(기본 및 비기본)
- 효과적인 샌드박스 도구 허용/거부(및 에이전트/전역/기본값에서 나온 것인지 여부)
- 높은 게이트 및 수정 키 경로

## 샌드박스: 도구가 실행되는 곳

샌드박싱은 다음에 의해 제어됩니다. `agents.defaults.sandbox.mode`:

- `"off"`: 모든 것이 호스트에서 실행됩니다.
- `"non-main"`: 기본이 아닌 세션만 샌드박스 처리됩니다(그룹/채널에 대한 일반적인 "놀라움").
- `"all"`: 모든 것이 샌드박스 처리되어 있습니다.

보다 [샌드박싱](/gateway/sandboxing) 전체 매트릭스(스코프, 작업 공간 마운트, 이미지)용.

### 바인드 마운트(보안 빠른 확인)

- `docker.binds` _피어싱_ 샌드박스 파일 시스템: 마운트한 모든 항목은 설정한 모드로 컨테이너 내부에서 볼 수 있습니다(`:ro` 또는 `:rw`).
- 모드를 생략하면 기본값은 읽기-쓰기입니다. 선호하다 `:ro` 소스/비밀의 경우.
- `scope: "shared"` 에이전트별 바인딩을 무시합니다(전역 바인딩만 적용됨).
- 제본 `/var/run/docker.sock` 호스트 제어를 샌드박스에 효과적으로 전달합니다. 의도적으로만 그렇게 하세요.
- 작업공간 액세스(`workspaceAccess: "ro"` / `"rw"`)은 바인드 모드와 무관합니다.

## 도구 정책: 존재하는 도구/호출 가능한 도구

두 가지 레이어가 중요합니다.

- **도구 프로필**:`tools.profile` 그리고 `agents.list[].tools.profile` (기본 허용 목록)
- **제공자 도구 프로필**:`tools.byProvider[provider].profile` 그리고 `agents.list[].tools.byProvider[provider].profile`
- **글로벌/에이전트별 도구 정책**:`tools.allow` / `tools.deny` 그리고 `agents.list[].tools.allow` / `agents.list[].tools.deny`
- **공급자 도구 정책**:`tools.byProvider[provider].allow/deny` 그리고 `agents.list[].tools.byProvider[provider].allow/deny`
- **샌드박스 도구 정책** (샌드박스가 적용된 경우에만 적용됨): `tools.sandbox.tools.allow` / `tools.sandbox.tools.deny` 그리고 `agents.list[].tools.sandbox.tools.*`

경험 법칙:

- `deny` 항상 승리합니다.
- 만약에 `allow` 비어 있지 않으면 다른 모든 항목은 차단된 것으로 처리됩니다.
- 도구 정책은 하드 스톱입니다. `/exec` 거부된 항목을 무시할 수 없습니다. `exec` 도구.
- `/exec` 승인된 발신자에 대한 세션 기본값만 변경합니다. 도구 액세스 권한은 부여되지 않습니다.
  공급자 도구 키는 다음 중 하나를 허용합니다. `provider` (예: `google-antigravity`) 또는 `provider/model` (예: `openai/gpt-5.2`).

### 도구 그룹(약칭)

도구 정책(글로벌, 에이전트, 샌드박스) 지원 `group:*` 여러 도구로 확장되는 항목:

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

- `group:runtime`:`exec`, `bash`, `process`
- `group:fs`:`read`, `write`, `edit`, `apply_patch`
- `group:sessions`:`sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`:`memory_search`, `memory_get`
- `group:ui`:`browser`, `canvas`
- `group:automation`:`cron`, `gateway`
- `group:messaging`:`message`
- `group:nodes`:`nodes`
- `group:openclaw`: 모든 내장 OpenClaw 도구(공급자 플러그인 제외)

## 상승: 실행 전용 "호스트에서 실행"

상승된 않습니다 **~ 아니다** 추가 도구를 부여합니다. 그것은 단지 영향을 미칩니다 `exec`.

- 샌드박스 처리된 경우 `/elevated on` (또는 `exec` ~와 함께 `elevated: true`)가 호스트에서 실행됩니다(승인이 계속 적용될 수 있음).
- 사용 `/elevated full` 세션에 대한 실행 승인을 건너뜁니다.
- 이미 직접 실행 중이라면 상승은 사실상 무작동입니다(계속 게이트됨).
- 상승된 것은 **~ 아니다** 기술 범위에 속하며 **~ 아니다** 재정의 도구 허용/거부.
- `/exec` 고가와는 별개입니다. 승인된 발신자에 대한 세션별 실행 기본값만 조정합니다.

게이트:

- 활성화: `tools.elevated.enabled` (그리고 선택적으로 `agents.list[].tools.elevated.enabled`)
- 발신자 허용 목록: `tools.elevated.allowFrom.<provider>` (그리고 선택적으로 `agents.list[].tools.elevated.allowFrom.<provider>`)

보다 [승격 모드](/tools/elevated).

## 일반적인 "샌드박스 감옥" 수정

### “샌드박스 도구 정책에 의해 도구 X가 차단되었습니다”

Fix-it 키(하나 선택):

- 샌드박스 비활성화: `agents.defaults.sandbox.mode=off` (또는 에이전트당 `agents.list[].sandbox.mode=off`)
- 샌드박스 내부에서 도구를 허용합니다.
  - 그것을 제거하다 `tools.sandbox.tools.deny` (또는 에이전트당 `agents.list[].tools.sandbox.tools.deny`)
  - 아니면 추가하세요 `tools.sandbox.tools.allow` (또는 에이전트당 허용)

### "이게 메인인 줄 알았는데 왜 샌드박스 처리되어 있는 걸까요?"

~ 안에 `"non-main"` 모드, 그룹/채널 키는 _~ 아니다_ 기본. 기본 세션 키를 사용합니다(다음으로 표시됨). `sandbox explain`) 또는 모드를 다음으로 전환하세요. `"off"`.
