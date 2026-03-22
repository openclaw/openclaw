---
title: "샌드박스 vs 도구 정책 vs 권한 상승"
summary: "도구가 차단된 이유: 샌드박스 런타임, 도구 허용/거부 정책, 권한 상승 실행 게이트"
read_when: "'sandbox jail'이 발생하거나 도구/권한 상승 거부를 확인하고 정확한 설정 키를 변경하고 싶을 때."
status: active
x-i18n:
  source_path: docs/gateway/sandbox-vs-tool-policy-vs-elevated.md
---

# 샌드박스 vs 도구 정책 vs 권한 상승

OpenClaw에는 관련되지만 서로 다른 세 가지 제어가 있습니다:

1. **샌드박스** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`)는 **도구가 어디서 실행되는지** (Docker vs 호스트)를 결정합니다.
2. **도구 정책** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`)은 **어떤 도구가 사용 가능/허용되는지**를 결정합니다.
3. **권한 상승** (`tools.elevated.*`, `agents.list[].tools.elevated.*`)은 샌드박스에 있을 때 호스트에서 실행하기 위한 **exec 전용 탈출구**입니다.

## 빠른 디버그

인스펙터를 사용하여 OpenClaw이 _실제로_ 무엇을 하는지 확인합니다:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

다음을 출력합니다:

- 유효 샌드박스 모드/범위/워크스페이스 접근
- 세션이 현재 샌드박스에 있는지 (main vs non-main)
- 유효 샌드박스 도구 허용/거부 (에이전트/글로벌/기본에서 왔는지)
- 권한 상승 게이트 및 수정 키 경로

## 샌드박스: 도구가 실행되는 곳

샌드박스는 `agents.defaults.sandbox.mode`로 제어됩니다:

- `"off"`: 모든 것이 호스트에서 실행됩니다.
- `"non-main"`: non-main 세션만 샌드박스됩니다 (그룹/채널에서 일반적으로 놀라는 점).
- `"all"`: 모든 것이 샌드박스됩니다.

전체 매트릭스 (범위, 워크스페이스 마운트, 이미지)는 [샌드박스](/gateway/sandboxing)를 참고하세요.

### 바인드 마운트 (보안 빠른 확인)

- `docker.binds`는 샌드박스 파일시스템을 *관통*합니다: 마운트한 것은 설정한 모드 (`:ro` 또는 `:rw`)로 컨테이너 내부에서 볼 수 있습니다.
- 모드를 생략하면 기본값은 읽기-쓰기입니다. 소스/시크릿에는 `:ro`를 선호하세요.
- `scope: "shared"`는 에이전트별 바인드를 무시합니다 (글로벌 바인드만 적용).
- `/var/run/docker.sock`를 바인딩하면 사실상 호스트 제어를 샌드박스에 넘기는 것입니다. 의도적으로만 하세요.
- 워크스페이스 접근 (`workspaceAccess: "ro"`/`"rw"`)은 바인드 모드와 독립적입니다.

## 도구 정책: 어떤 도구가 존재하고 호출 가능한지

두 레이어가 중요합니다:

- **도구 프로필**: `tools.profile` 및 `agents.list[].tools.profile` (기본 허용 목록)
- **프로바이더 도구 프로필**: `tools.byProvider[provider].profile` 및 `agents.list[].tools.byProvider[provider].profile`
- **글로벌/에이전트별 도구 정책**: `tools.allow`/`tools.deny` 및 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **프로바이더 도구 정책**: `tools.byProvider[provider].allow/deny` 및 `agents.list[].tools.byProvider[provider].allow/deny`
- **샌드박스 도구 정책** (샌드박스일 때만 적용): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 및 `agents.list[].tools.sandbox.tools.*`

규칙 요약:

- `deny`가 항상 이깁니다.
- `allow`가 비어 있지 않으면, 나머지는 모두 차단으로 처리됩니다.
- 도구 정책이 하드 스톱입니다: `/exec`은 거부된 `exec` 도구를 재정의할 수 없습니다.
- `/exec`은 인가된 발신자에 대한 세션 기본값만 변경하며, 도구 접근을 부여하지 않습니다.
  프로바이더 도구 키는 `provider` (예: `google-antigravity`) 또는 `provider/model` (예: `openai/gpt-5.2`) 모두 허용합니다.

### 도구 그룹 (축약어)

도구 정책 (글로벌, 에이전트, 샌드박스)은 여러 도구로 확장되는 `group:*` 항목을 지원합니다:

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

## 권한 상승: exec 전용 "호스트에서 실행"

권한 상승은 추가 도구를 부여하지 **않습니다**. `exec`에만 영향을 미칩니다.

- 샌드박스에 있는 경우, `/elevated on` (또는 `elevated: true`가 있는 `exec`)은 호스트에서 실행합니다 (승인이 여전히 적용될 수 있음).
- `/elevated full`을 사용하여 세션의 exec 승인을 건너뜁니다.
- 이미 직접 실행 중이면, 권한 상승은 사실상 무의미합니다 (여전히 게이트됨).
- 권한 상승은 스킬 범위가 **아니며** 도구 허용/거부를 재정의하지 **않습니다**.
- `/exec`은 권한 상승과 별개입니다. 인가된 발신자를 위한 세션별 exec 기본값만 조정합니다.

게이트:

- 활성화: `tools.elevated.enabled` (선택적으로 `agents.list[].tools.elevated.enabled`)
- 발신자 허용 목록: `tools.elevated.allowFrom.<provider>` (선택적으로 `agents.list[].tools.elevated.allowFrom.<provider>`)

[권한 상승 모드](/tools/elevated)를 참고하세요.

## 일반적인 "sandbox jail" 수정

### "Tool X blocked by sandbox tool policy"

수정 키 (하나 선택):

- 샌드박스 비활성화: `agents.defaults.sandbox.mode=off` (또는 에이전트별 `agents.list[].sandbox.mode=off`)
- 샌드박스 내에서 도구 허용:
  - `tools.sandbox.tools.deny`에서 제거 (또는 에이전트별 `agents.list[].tools.sandbox.tools.deny`)
  - 또는 `tools.sandbox.tools.allow`에 추가 (또는 에이전트별 allow)

### "I thought this was main, why is it sandboxed?"

`"non-main"` 모드에서는 그룹/채널 키가 main이 _아닙니다_. 메인 세션 키 (`sandbox explain`에서 표시)를 사용하거나 모드를 `"off"`로 전환합니다.

## 참고

- [샌드박스](/gateway/sandboxing) -- 전체 샌드박스 레퍼런스 (모드, 범위, 백엔드, 이미지)
- [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) -- 에이전트별 오버라이드 및 우선순위
- [권한 상승 모드](/tools/elevated)
