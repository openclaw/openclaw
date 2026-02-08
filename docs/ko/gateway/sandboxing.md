---
read_when: You want a dedicated explanation of sandboxing or need to tune agents.defaults.sandbox.
status: active
summary: 'OpenClaw 샌드박스 작동 방식: 모드, 범위, 작업 공간 액세스 및 이미지'
title: 샌드박싱
x-i18n:
    generated_at: "2026-02-08T15:54:53Z"
    model: gtx
    provider: google-translate
    source_hash: c1bb7fd4ac37ef7316ba08bf6f2489dfdaff2e5eb557c787e6092a06ece858bc
    source_path: gateway/sandboxing.md
    workflow: 15
---

# 샌드박싱

OpenClaw를 실행할 수 있습니다 **Docker 컨테이너 내부의 도구** 폭발 반경을 줄이기 위해.
이것은 **선택 과목** 구성에 의해 제어됩니다(`agents.defaults.sandbox` 또는
`agents.list[].sandbox`). 샌드박스가 꺼져 있으면 도구가 호스트에서 실행됩니다.
게이트웨이는 호스트에 유지됩니다. 도구 실행은 격리된 샌드박스에서 실행됩니다.
활성화되면.

이는 완벽한 보안 경계는 아니지만 파일 시스템을 실질적으로 제한합니다.
모델이 멍청한 짓을 할 때 접근을 처리합니다.

## 샌드박스 대상

- 도구 실행(`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, 등.).
- 선택적 샌드박스 브라우저(`agents.defaults.sandbox.browser`).
  - 기본적으로 샌드박스 브라우저는 브라우저 도구에 필요할 때 자동으로 시작됩니다(CDP에 연결할 수 있도록 보장).
    다음을 통해 구성 `agents.defaults.sandbox.browser.autoStart` 그리고 `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` 샌드박스 세션이 호스트 브라우저를 명시적으로 타겟팅하도록 허용합니다.
  - 선택적 허용 목록 게이트 `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

샌드박스 처리되지 않음:

- 게이트웨이 프로세스 자체.
- 호스트에서 실행이 명시적으로 허용된 모든 도구(예: `tools.elevated`).
  - **상승된 exec는 호스트에서 실행되며 샌드박싱을 우회합니다.**
  - 샌드박싱이 꺼져 있으면 `tools.elevated` 실행을 변경하지 않습니다(이미 호스트에 있음). 보다 [승격 모드](/tools/elevated).

## 모드

`agents.defaults.sandbox.mode` 통제 수단 **언제** 샌드박싱이 사용됩니다:

- `"off"`: 샌드박싱이 없습니다.
- `"non-main"`: 샌드박스 전용 **메인이 아닌** 세션(호스트에서 일반 채팅을 원하는 경우 기본값).
- `"all"`: 모든 세션은 샌드박스에서 실행됩니다.
  메모: `"non-main"` 기반으로 `session.mainKey` (기본 `"main"`), 상담원 ID가 아닙니다.
  그룹/채널 세션은 자체 키를 사용하므로 기본이 아닌 세션으로 간주되어 샌드박스 처리됩니다.

## 범위

`agents.defaults.sandbox.scope` 통제 수단 **컨테이너가 몇개야?** 생성됩니다:

- `"session"` (기본값): 세션당 하나의 컨테이너입니다.
- `"agent"`: 에이전트당 하나의 컨테이너입니다.
- `"shared"`: 모든 샌드박스 세션에서 공유되는 하나의 컨테이너입니다.

## 작업공간 액세스

`agents.defaults.sandbox.workspaceAccess` 통제 수단 **샌드박스에서 볼 수 있는 것**: 

- `"none"` (기본값): 도구는 아래의 샌드박스 작업 공간을 확인합니다. `~/.openclaw/sandboxes`.
- `"ro"`: 에이전트 작업 영역을 읽기 전용으로 마운트합니다. `/agent` (비활성화 `write`/`edit`/`apply_patch`).
- `"rw"`: 에이전트 작업 영역 읽기/쓰기를 마운트합니다. `/workspace`.

인바운드 미디어는 활성 샌드박스 작업 공간(`media/inbound/*`).
스킬 노트: `read` 도구는 샌드박스 기반입니다. 와 함께 `workspaceAccess: "none"`,
OpenClaw는 적합한 기술을 샌드박스 작업 공간에 미러링합니다(`.../skills`) 그래서
읽을 수 있습니다. 와 함께 `"rw"`, 작업 공간 기술은 다음에서 읽을 수 있습니다.
`/workspace/skills`.

## 맞춤형 바인드 마운트

`agents.defaults.sandbox.docker.binds` 컨테이너에 추가 호스트 디렉터리를 마운트합니다.
체재: `host:container:mode` (예: `"/home/user/source:/source:rw"`).

전역 및 에이전트별 바인딩은 다음과 같습니다. **병합된** (교체되지 않음). 아래에 `scope: "shared"`, 에이전트별 바인드는 무시됩니다.

예(읽기 전용 소스 + Docker 소켓):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

보안 참고사항:

- 바인딩은 샌드박스 파일 시스템을 우회합니다. 즉, 설정한 모드에 관계없이 호스트 경로를 노출합니다(`:ro` 또는`:rw`).
- 민감한 마운트(예: `docker.sock`, 비밀, SSH 키)는 다음과 같아야 합니다. `:ro` 꼭 필요한 경우가 아니면.
- 와 결합하다 `workspaceAccess: "ro"` 작업공간에 대한 읽기 액세스만 필요한 경우 바인딩 모드는 독립적으로 유지됩니다.
- 보다 [샌드박스 vs 도구 정책 vs 상승](/gateway/sandbox-vs-tool-policy-vs-elevated) 바인드가 도구 정책 및 높은 실행 권한과 상호 작용하는 방식에 대해 알아보세요.

## 이미지 + 설정

기본 이미지: `openclaw-sandbox:bookworm-slim`

한 번만 빌드해 보세요.

```bash
scripts/sandbox-setup.sh
```

참고: 기본 이미지는 **~ 아니다** 노드를 포함합니다. 스킬에 노드(또는
다른 런타임), 사용자 정의 이미지를 굽거나 다음을 통해 설치합니다.
`sandbox.docker.setupCommand` (네트워크 송신 + 쓰기 가능한 루트 필요 +
루트 사용자).

샌드박스 브라우저 이미지:

```bash
scripts/sandbox-browser-setup.sh
```

기본적으로 샌드박스 컨테이너는 다음과 같이 실행됩니다. **네트워크 없음**.
다음으로 재정의 `agents.defaults.sandbox.docker.network`.

Docker 설치 및 컨테이너화된 게이트웨이는 여기에 있습니다.
[도커](/install/docker)

## setupCommand(일회성 컨테이너 설정)

`setupCommand` 달린다 **한 번** 샌드박스 컨테이너가 생성된 후(실행할 때마다 아님)
다음을 통해 컨테이너 내부에서 실행됩니다. `sh -lc`.

경로:

- 글로벌: `agents.defaults.sandbox.docker.setupCommand`
- 에이전트별: `agents.list[].sandbox.docker.setupCommand`

일반적인 함정:

- 기본 `docker.network` ~이다 `"none"` (송신 없음)이므로 패키지 설치가 실패합니다.
- `readOnlyRoot: true` 쓰기를 방지합니다. 세트 `readOnlyRoot: false` 또는 사용자 정의 이미지를 굽습니다.
- `user` 패키지 설치를 위해서는 루트여야 합니다(생략). `user` 또는 설정 `user: "0:0"`).
- 샌드박스 exec은 **~ 아니다** 호스트 상속 `process.env`. 사용
  `agents.defaults.sandbox.docker.env` (또는 사용자 정의 이미지) 스킬 API 키에 대한 것입니다.

## 도구 정책 + 탈출구

도구 허용/거부 정책은 샌드박스 규칙 이전에 계속 적용됩니다. 도구가 거부된 경우
전체적으로 또는 에이전트별로 샌드박스를 사용하면 다시 가져오지 않습니다.

`tools.elevated` 실행되는 명시적인 탈출구입니다 `exec` 호스트에서.
`/exec` 지시어는 승인된 발신자에게만 적용되며 세션별로 지속됩니다. 하드 비활성화
`exec`, 도구 정책 거부 사용(참조 [샌드박스 vs 도구 정책 vs 상승](/gateway/sandbox-vs-tool-policy-vs-elevated)).

디버깅:

- 사용 `openclaw sandbox explain` 효과적인 샌드박스 모드, 도구 정책 및 수정 구성 키를 검사합니다.
- 보다 [샌드박스 vs 도구 정책 vs 상승](/gateway/sandbox-vs-tool-policy-vs-elevated) "이게 왜 차단되나요?" 정신 모델.
  잠가 두세요.

## 다중 에이전트 재정의

각 에이전트는 샌드박스 + 도구를 재정의할 수 있습니다.
`agents.list[].sandbox` 그리고 `agents.list[].tools` (을 더한 `agents.list[].tools.sandbox.tools` 샌드박스 도구 정책의 경우).
보다 [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) 우선순위를 위해.

## 최소 활성화 예

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## 관련 문서

- [샌드박스 구성](/gateway/configuration#agentsdefaults-sandbox)
- [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools)
- [보안](/gateway/security)
