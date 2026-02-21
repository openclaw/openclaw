---
summary: "OpenClaw 샌드박스 격리 작동 방식: 모드, 범위, 작업 공간 접근 및 이미지"
title: 샌드박스 격리
read_when: "샌드박스 격리에 대한 전용 설명이 필요하거나 agents.defaults.sandbox 를 조정해야 할 때"
status: active
---

# 샌드박스 격리

OpenClaw 는 폭발 반경을 줄이기 위해 **도구를 Docker 컨테이너 내에서 실행**할 수 있습니다.
이는 **옵션**이며 설정 (`agents.defaults.sandbox` 또는 `agents.list[].sandbox`)에 의해 제어됩니다. 샌드박스 격리가 꺼져 있으면 도구는 호스트에서 실행됩니다.
게이트웨이는 호스트에 남아 있으며, 샌드박스 격리가 활성화되면 도구 실행은 격리된 샌드박스에서 실행됩니다.

이는 완벽한 보안 경계가 아니지만, 모델이 잘못된 처리를 할 때 파일 시스템과 프로세스 접근을 실질적으로 제한합니다.

## 무엇이 샌드박스 격리되는가

- 도구 실행 (`exec`, `read`, `write`, `edit`, `apply_patch`, `process` 등).
- 선택적 샌드박스 격리 브라우저 (`agents.defaults.sandbox.browser`).
  - 기본적으로 샌드박스 격리 브라우저는 브라우저 도구가 필요할 때 CDP 에 접근할 수 있도록 자동 시작됩니다.
    설정은 `agents.defaults.sandbox.browser.autoStart` 및 `agents.defaults.sandbox.browser.autoStartTimeoutMs` 를 통해 가능합니다.
  - 기본적으로 샌드박스 브라우저 컨테이너는 글로벌 `bridge` 네트워크 대신 전용 Docker 네트워크 (`openclaw-sandbox-browser`)를 사용합니다.
    `agents.defaults.sandbox.browser.network`로 설정하세요.
  - 선택적 `agents.defaults.sandbox.browser.cdpSourceRange`는 CIDR 허용 목록으로 컨테이너 엣지 CDP 수신을 제한합니다 (예: `172.21.0.1/32`).
  - noVNC 관찰자 접근은 기본적으로 비밀번호로 보호됩니다; OpenClaw는 관찰자 세션으로 연결되는 단기 토큰 URL을 생성합니다.
  - `agents.defaults.sandbox.browser.allowHostControl` 은 샌드박스 격리 세션이 호스트 브라우저를 명시적으로 지정할 수 있도록 합니다.
  - 선택적 허용 목록(allowlist)이 `target: "custom"` 을 제한합니다: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

샌드박스 격리가 되지 않는 것:

- 게이트웨이 프로세스
- 호스트에서 실행할 수 있도록 명시적으로 허용된 도구 (예: `tools.elevated`).
  - **Elevated exec 는 호스트에서 실행되며 샌드박스 격리를 우회합니다.**
  - 샌드박스 격리가 꺼져 있는 경우, `tools.elevated` 는 실행을 변경하지 않습니다 (이미 호스트에서 실행 중). [Elevated Mode](/ko-KR/tools/elevated) 를 참조하세요.

## 모드

`agents.defaults.sandbox.mode` 는 샌드박스 격리가 **언제** 사용되는지를 제어합니다:

- `"off"`: 샌드박스 격리를 사용하지 않음.
- `"non-main"`: **non-main** 세션만 샌드박스 격리 (호스트에서 정상적인 채팅을 원할 때 기본값).
- `"all"`: 모든 세션이 샌드박스 격리에서 실행.
  주의: `"non-main"` 은 에이전트 ID 가 아니라 `session.mainKey` (기본값 `"main"`) 에 기초합니다.
  그룹/채널 세션은 각각의 키를 사용하며, 이는 비주요 세션으로 간주되어 샌드박스 격리됩니다.

## 범위

`agents.defaults.sandbox.scope` 는 **얼마나 많은 컨테이너**가 생성되는지를 제어합니다:

- `"session"` (기본값): 세션당 하나의 컨테이너.
- `"agent"`: 에이전트당 하나의 컨테이너.
- `"shared"`: 샌드박스 격리된 모든 세션에 의해 공유되는 하나의 컨테이너.

## 작업 공간 접근

`agents.defaults.sandbox.workspaceAccess` 는 샌드박스가 **무엇을 볼 수 있는**지를 제어합니다:

- `"none"` (기본값): 도구가 `~/.openclaw/sandboxes` 아래의 샌드박스 작업 공간을 봅니다.
- `"ro"`: 에이전트 작업 공간을 `/agent` 에 읽기 전용으로 마운트 ( `write`/`edit`/`apply_patch` 비활성화).
- `"rw"`: 에이전트 작업 공간을 `/workspace` 에 읽기/쓰기 가능으로 마운트.

수신 미디어는 활성 샌드박스 작업 공간 (`media/inbound/*`) 으로 복사됩니다.
스킬 주의사항: `read` 도구는 샌드박스의 루트를 기준으로 동작합니다. `workspaceAccess: "none"`일 경우 OpenClaw 는 사용할 수 있는 스킬을 샌드박스 작업 공간 (`.../skills`) 에 미러링하여 읽을 수 있도록 합니다. `"rw"`일 때, 작업 공간 스킬은 `/workspace/skills` 에서 읽을 수 있습니다.

## 사용자 정의 바인드 마운트

`agents.defaults.sandbox.docker.binds` 는 추가 호스트 디렉터리를 컨테이너에 마운트합니다.
형식: `host:container:mode` (예: `"/home/user/source:/source:rw"`).

전역 및 에이전트별 바인드는 **병합**됩니다 (대체되지 않음). `scope: "shared"` 일 때, 에이전트별 바인드는 무시됩니다.

`agents.defaults.sandbox.browser.binds` 는 **샌드박스 격리 브라우저** 컨테이너에 추가 호스트 디렉터리를 마운트합니다.

- 설정 시 ( `[]` 포함), 브라우저 컨테이너에 대해서 `agents.defaults.sandbox.docker.binds` 를 대체합니다.
- 생략 시, 브라우저 컨테이너는 `agents.defaults.sandbox.docker.binds` 를 기본값으로 사용합니다 (이전 버전과 호환).

예: (읽기 전용 소스 + 추가 데이터 디렉터리):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/data/myapp:/data:ro"],
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

보안 주의사항:

- 바인드는 샌드박스 파일 시스템을 우회합니다: 설정한 모드 (`:ro` 또는 `:rw`) 로 호스트 경로를 노출합니다.
- OpenClaw 는 위험한 바인드 소스를 차단합니다 (예: `docker.sock`, `/etc`, `/proc`, `/sys`, `/dev` 및 이를 노출할 부모 마운트).
- 민감한 마운트 (예: 비밀, SSH 키, 서비스 자격증명)는 반드시 필요하지 않은 한 `:ro` 로 설정해야 합니다.
- 작업 공간에 대한 읽기 접근만 필요한 경우 `workspaceAccess: "ro"` 와 결합하세요; 바인드 모드는 독립적으로 유지됩니다.
- 바인드가 도구 정책 및 Elevated exec 와 어떻게 상호 작용하는지에 대해서는 [Sandbox vs Tool Policy vs Elevated](/ko-KR/gateway/sandbox-vs-tool-policy-vs-elevated) 을 참조하세요.

## 이미지 + 설정

기본 이미지: `openclaw-sandbox:bookworm-slim`

한번 빌드하세요:

```bash
scripts/sandbox-setup.sh
```

주의: 기본 이미지에는 Node가 포함되어 있지 않습니다. 스킬이 Node (또는 다른 실행 환경)을 필요로 하는 경우, 사용자 정의 이미지를 빌드하거나 `sandbox.docker.setupCommand` 를 통해 설치하세요 (네트워크 출구 + 쓰기 가능한 루트 + 루트 사용자 필요).

샌드박스 격리 브라우저 이미지:

```bash
scripts/sandbox-browser-setup.sh
```

기본적으로, 샌드박스 컨테이너는 **네트워크 없이** 실행됩니다.
`agents.defaults.sandbox.docker.network` 를 통해 오버라이드하세요.

Docker 설치와 컨테이너화된 게이트웨이는 여기에서 찾을 수 있습니다:
[Docker](/ko-KR/install/docker)

## setupCommand (단일 컨테이너 설정)

`setupCommand` 는 샌드박스 컨테이너가 생성된 후 **한번** 실행됩니다 (매번 실행되지 않음).
컨테이너 내부에서 `sh -lc` 를 통해 실행됩니다.

경로:

- 전역: `agents.defaults.sandbox.docker.setupCommand`
- 에이전트별: `agents.list[].sandbox.docker.setupCommand`

일반적인 문제점:

- 기본 `docker.network` 는 `"none"` 이므로 (출구 없음) 패키지 설치가 실패합니다.
- `readOnlyRoot: true` 는 쓰기를 금지합니다; `readOnlyRoot: false` 로 설정하거나 사용자 정의 이미지를 빌드하세요.
- 패키지 설치를 위해서는 `user`가 루트여야 합니다 ( `user` 를 생략하거나 `user: "0:0"` 으로 설정).
- 샌드박스 exec 는 호스트의 `process.env` 를 상속하지 않습니다. 스킬 API 키의 경우 `agents.defaults.sandbox.docker.env` 를 사용하세요 (또는 사용자 정의 이미지를 사용).

## 도구 정책 + 탈출구

도구 허용/거부 정책은 여전히 샌드박스 규칙 이전에 적용됩니다. 도구가 전역 또는 에이전트별로 거부된 경우, 샌드박스 격리는 이를 다시 가져오지 않습니다.

`tools.elevated` 는 호스트에서 `exec` 를 실행하는 명시적인 탈출구입니다.
`/exec` 지시는 승인된 발신자에게만 적용되며 세션당 지속됩니다; `exec` 를 완전히 비활성화하려면 도구 정책 거부를 사용하십시오 ( [Sandbox vs Tool Policy vs Elevated](/ko-KR/gateway/sandbox-vs-tool-policy-vs-elevated) 를 참조하세요).

디버깅:

- `openclaw sandbox explain` 를 사용하여 실제 샌드박스 모드, 도구 정책, 오류 수정 설정 키를 검사하세요.
- "왜 막혔는가?"에 대한 정신적 모델은 [Sandbox vs Tool Policy vs Elevated](/ko-KR/gateway/sandbox-vs-tool-policy-vs-elevated) 을 참조하세요.
  보안을 철저히 유지하세요.

## 다중 에이전트 오버라이드

각 에이전트는 샌드박스 및 도구를 오버라이드할 수 있습니다:
`agents.list[].sandbox` 및 `agents.list[].tools` (샌드박스 도구 정책에 대해서는 `agents.list[].tools.sandbox.tools` 를 추가).
우선순위에 대해서는 [Multi-Agent Sandbox & Tools](/ko-KR/tools/multi-agent-sandbox-tools) 를 참조하세요.

## 최소 활성화 예시

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

- [샌드박스 설정](/ko-KR/gateway/configuration#agentsdefaults-sandbox)
- [다중 에이전트 샌드박스 및 도구](/ko-KR/tools/multi-agent-sandbox-tools)
- [보안](/ko-KR/gateway/security)
