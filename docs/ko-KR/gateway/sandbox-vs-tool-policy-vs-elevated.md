---
title: 샌드박스 vs 도구 정책 vs 상승 권한
summary: "도구가 차단되는 이유: 샌드박스 런타임, 도구 허용/거부 정책, 상승 권한 실행 게이트"
read_when: "'샌드박스 감금' 상태에 빠지거나 도구/상승 권한 거부 메시지를 확인하고 변경할 정확한 설정 키를 알고 싶을 때."
status: active
---

# 샌드박스 vs 도구 정책 vs 상승 권한 (Sandbox vs Tool Policy vs Elevated)

OpenClaw는 서로 연관되어 있지만 다른 세 가지 제어 수단을 가지고 있습니다:

1. **샌드박스 (Sandbox)** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) — 도구가 **어디서 실행되는지** 결정합니다 (Docker vs 호스트).
2. **도구 정책 (Tool policy)** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) — **어떤 도구를 사용할 수 있는지/허용되는지** 결정합니다.
3. **상승 권한 (Elevated)** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) — 샌드박스 상태에서 호스트에서 실행하기 위한 **exec 전용 탈출구**입니다.

## 빠른 디버그

인스펙터를 사용하여 OpenClaw가 _실제로_ 수행하는 작업을 확인하세요:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

출력 내용:

- 유효한 샌드박스 모드/범위/워크스페이스 접근
- 세션이 현재 샌드박스 상태인지 여부 (main vs non-main)
- 유효한 샌드박스 도구 허용/거부 (에이전트/전역/기본값 중 어디서 왔는지 포함)
- 상승 권한 게이트 및 수정 키 경로

## 샌드박스: 도구가 실행되는 위치

샌드박싱은 `agents.defaults.sandbox.mode`로 제어됩니다:

- `"off"`: 모든 것이 호스트에서 실행됩니다.
- `"non-main"`: non-main 세션만 샌드박스 처리됩니다 (그룹/채널에서 흔한 "의외의 동작").
- `"all"`: 모든 것이 샌드박스 처리됩니다.

전체 매트릭스(범위, 워크스페이스 마운트, 이미지)는 [샌드박싱](/ko-KR/gateway/sandboxing)을 참조하세요.

### 바인드 마운트 (보안 빠른 확인)

- `docker.binds`는 샌드박스 파일시스템을 _뚫습니다_: 마운트한 것은 설정한 모드(`:ro` 또는 `:rw`)로 컨테이너 내부에서 보입니다.
- 모드를 생략하면 기본값은 읽기-쓰기입니다; 소스/시크릿에는 `:ro`를 사용하는 것이 좋습니다.
- `scope: "shared"`는 에이전트별 바인드를 무시합니다 (전역 바인드만 적용됩니다).
- `/var/run/docker.sock`을 바인딩하면 실질적으로 호스트 제어권을 샌드박스에 넘기는 것이므로 의도적으로만 수행하세요.
- 워크스페이스 접근 (`workspaceAccess: "ro"`/`"rw"`)은 바인드 모드와 독립적입니다.

## 도구 정책: 어떤 도구가 존재하는지/호출 가능한지

두 가지 레이어가 중요합니다:

- **도구 프로파일**: `tools.profile` 및 `agents.list[].tools.profile` (기본 허용 목록)
- **프로바이더 도구 프로파일**: `tools.byProvider[provider].profile` 및 `agents.list[].tools.byProvider[provider].profile`
- **전역/에이전트별 도구 정책**: `tools.allow`/`tools.deny` 및 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **프로바이더 도구 정책**: `tools.byProvider[provider].allow/deny` 및 `agents.list[].tools.byProvider[provider].allow/deny`
- **샌드박스 도구 정책** (샌드박스 상태에서만 적용): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 및 `agents.list[].tools.sandbox.tools.*`

기본 규칙:

- `deny`는 항상 우선합니다.
- `allow`가 비어 있지 않으면, 나머지는 모두 차단된 것으로 처리됩니다.
- 도구 정책은 강제 중단입니다: `/exec`는 거부된 `exec` 도구를 재정의할 수 없습니다.
- `/exec`는 인가된 발신자에 대한 세션별 exec 기본값만 변경합니다; 도구 접근 권한을 부여하지 않습니다.
  프로바이더 도구 키는 `provider` (예: `google-antigravity`) 또는 `provider/model` (예: `openai/gpt-5.2`) 형식을 허용합니다.

### 도구 그룹 (단축 표현)

도구 정책(전역, 에이전트, 샌드박스)은 여러 도구로 확장되는 `group:*` 항목을 지원합니다:

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

## 상승 권한 (Elevated): exec 전용 "호스트에서 실행"

상승 권한은 추가 도구를 부여하지 **않습니다**; `exec`에만 영향을 줍니다.

- 샌드박스 상태에서 `/elevated on` (또는 `elevated: true`와 함께 `exec`)을 사용하면 호스트에서 실행됩니다 (승인이 여전히 적용될 수 있습니다).
- `/elevated full`을 사용하면 세션에 대한 exec 승인을 건너뜁니다.
- 이미 직접 실행 중이라면 상승 권한은 사실상 no-op입니다 (여전히 게이트 적용).
- 상승 권한은 스킬 범위가 **아니며** 도구 허용/거부를 재정의하지 **않습니다**.
- `/exec`는 상승 권한과 별개입니다. 인가된 발신자에 대한 세션별 exec 기본값만 조정합니다.

게이트:

- 활성화: `tools.elevated.enabled` (선택적으로 `agents.list[].tools.elevated.enabled`)
- 발신자 허용 목록: `tools.elevated.allowFrom.<provider>` (선택적으로 `agents.list[].tools.elevated.allowFrom.<provider>`)

[상승 권한 모드](/ko-KR/tools/elevated)를 참조하세요.

## 일반적인 "샌드박스 감금" 해결책

### "도구 X가 샌드박스 도구 정책에 의해 차단됨"

수정 키 (하나를 선택):

- 샌드박스 비활성화: `agents.defaults.sandbox.mode=off` (또는 에이전트별 `agents.list[].sandbox.mode=off`)
- 샌드박스 내에서 도구 허용:
  - `tools.sandbox.tools.deny`에서 제거 (또는 에이전트별 `agents.list[].tools.sandbox.tools.deny`)
  - 또는 `tools.sandbox.tools.allow`에 추가 (또는 에이전트별 허용 목록)

### "main이라고 생각했는데 왜 샌드박스 처리되나요?"

`"non-main"` 모드에서는 그룹/채널 키가 main이 _아닙니다_. `sandbox explain`에 표시된 main 세션 키를 사용하거나 모드를 `"off"`로 전환하세요.
