---
title: "샌드박스 vs 도구 정책 vs 승격"
summary: "도구가 차단되는 이유: 샌드박스 런타임, 도구 허용/거부 정책, 승격 exec 게이트"
read_when: "'sandbox jail' 또는 도구/승격 거부가 표시되고 변경할 정확한 설정 키를 원함"
status: active
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/sandbox-vs-tool-policy-vs-elevated.md
  workflow: 15
---

# 샌드박스 vs 도구 정책 vs 승격

OpenClaw는 세 가지 관련(하지만 다른) 제어가 있습니다:

1. **샌드박스**(`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`)는 **도구가 실행되는 위치**를 결정합니다(Docker vs 호스트).
2. **도구 정책**(`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`)은 **어떤 도구를 사용할 수 있는지**를 결정합니다.
3. **승격**(`tools.elevated.*`, `agents.list[].tools.elevated.*`)은 **exec 전용 이스케이프 해치**이며 샌드박싱되어 있을 때 호스트에서 실행됩니다.

## 빠른 디버그

검사기를 사용하여 OpenClaw가 **실제로** 수행하는 작업을 확인합니다:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

출력:

- 효과적인 샌드박스 모드/범위/작업 공간 액세스
- 세션이 현재 샌드박싱되는지 여부(메인 vs 비메인)
- 효과적인 샌드박스 도구 허용/거부(에이전트/전역/기본값에서 온 경우)
- 승격 게이트 및 수정 키 경로

## 샌드박스: 도구가 실행되는 곳

샌드박싱은 `agents.defaults.sandbox.mode`에 의해 제어됩니다:

- `"off"`: 모든 것이 호스트에서 실행됩니다.
- `"non-main"`: 비메인 세션만 샌드박싱됩니다(그룹/채널의 일반적인 "놀람").
- `"all"`: 모든 것이 샌드박싱됩니다.

[Sandboxing](/gateway/sandboxing)를 참조하면 전체 매트릭스(범위, 작업 공간 마운트, 이미지)를 확인합니다.

### 바인드 마운트(보안 빠른 검사)

- `docker.binds`는 샌드박스 파일 시스템을 **뚫습니다**: 마운트하는 모든 것이 설정한 모드로 컨테이너 내부에 표시됩니다(`:ro` 또는 `:rw`).
- 모드를 생략하면 기본값은 읽기-쓰기입니다. 소스/비밀에는 `:ro`를 선호합니다.
- `scope: "shared"`는 에이전트별 바인드를 무시합니다(전역 바인드만 적용).
- `/var/run/docker.sock` 바인드는 호스트 제어를 샌드박스에 효과적으로 제공합니다. 의도적으로만 수행합니다.
- 작업 공간 액세스(`workspaceAccess: "ro"`/`"rw"`)는 바인드 모드와 독립적입니다.

## 도구 정책: 어떤 도구가 존재/호출 가능한지

두 개의 계층이 중요합니다:

- **도구 프로파일**: `tools.profile` 및 `agents.list[].tools.profile` (기본 허용 목록)
- **공급자 도구 프로파일**: `tools.byProvider[provider].profile` 및 `agents.list[].tools.byProvider[provider].profile`
- **전역/에이전트별 도구 정책**: `tools.allow`/`tools.deny` 및 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **공급자 도구 정책**: `tools.byProvider[provider].allow/deny` 및 `agents.list[].tools.byProvider[provider].allow/deny`
- **샌드박스 도구 정책**(샌드박싱되었을 때만 적용): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 및 `agents.list[].tools.sandbox.tools.*`

경험:

- `deny`는 항상 이깁니다.
- `allow`가 비어 있지 않으면 다른 모든 것이 차단됩니다.
- 도구 정책은 하드 중지입니다. `/exec`은 거부된 `exec` 도구를 재정의할 수 없습니다.
- `/exec`는 인증된 발신자만 세션 기본값을 변경합니다. 도구 액세스를 부여하지 않습니다.

## 승격: exec만 "호스트에서 실행"

승격은 추가 도구를 부여하지 않습니다. `exec`만 영향을 미칩니다.

- 샌드박싱되는 경우 `/elevated on`(또는 `elevated: true`를 사용한 exec)이 호스트에서 실행됩니다(승인이 여전히 적용될 수 있음).
- `/elevated full`을 사용하여 exec 승인을 세션에서 건너뜁니다.
- 이미 직접 실행 중인 경우 승격은 효과적으로 no-op입니다(여전히 게이트됨).
- 승격은 **기술 범위가 아니며** 도구 허용/거부를 재정의하지 않습니다.
- `/exec`는 승격과 별개입니다. 인증된 발신자만 세션별 exec 기본값을 조정합니다.

게이트:

- 활성화: `tools.elevated.enabled` (및 선택사항 `agents.list[].tools.elevated.enabled`)
- 발신자 허용 목록: `tools.elevated.allowFrom.<provider>` (및 선택사항 `agents.list[].tools.elevated.allowFrom.<provider>`)

[Elevated Mode](/tools/elevated) 참조.

## 일반적인 "샌드박스 jail" 수정

### "도구 X가 샌드박스 도구 정책으로 차단됨"

수정 키(하나 선택):

- 샌드박스 비활성화: `agents.defaults.sandbox.mode=off` (또는 에이전트별 `agents.list[].sandbox.mode=off`)
- 샌드박스 내부의 도구 허용:
  - `tools.sandbox.tools.deny`에서 제거(또는 에이전트별 `agents.list[].tools.sandbox.tools.deny`)
  - 또는 `tools.sandbox.tools.allow` (또는 에이전트별 허용)에 추가

### "이것이 메인이라고 생각했는데 왜 샌드박싱되어 있습니까?"

`"non-main"` 모드에서 그룹/채널 키는 메인이 아닙니다. 메인 세션 키(`sandbox explain`에 표시)를 사용하거나 모드를 `"off"`로 전환합니다.
