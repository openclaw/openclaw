---
summary: "OpenClaw 샌드박싱 작동 방식: 모드, 범위, 작업 공간 액세스 및 이미지"
title: "샌드박싱"
read_when: "샌드박싱 전용 설명이 필요하거나 agents.defaults.sandbox를 조정해야 함"
status: active
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/sandboxing.md
  workflow: 15
---

# 샌드박싱

OpenClaw는 **도구를 Docker 컨테이너 내부에서 실행**하여 blast 반경을 줄일 수 있습니다.
이는 **선택 사항**이며 구성(`agents.defaults.sandbox` 또는 `agents.list[].sandbox`)에 의해 제어됩니다. 샌드박싱이 꺼져 있으면 도구는 호스트에서 실행됩니다.
게이트웨이는 호스트에 남아 있습니다. 도구 실행은 활성화될 때 격리된 샌드박스에서 실행됩니다.

이것이 완벽한 보안 경계는 아니지만 모델이 어리석을 때 파일 시스템 및 프로세스 액세스를 실질적으로 제한합니다.

## 샌드박싱되는 것

- 도구 실행(`exec`, `read`, `write`, `edit`, `apply_patch`, `process` 등).
- 선택사항 샌드박싱된 브라우저(`agents.defaults.sandbox.browser`).
  - 기본적으로 샌드박스 브라우저는 브라우저 도구가 필요할 때 자동 시작됩니다(CDP 도달 가능 확인).
    `agents.defaults.sandbox.browser.autoStart` 및 `agents.defaults.sandbox.browser.autoStartTimeoutMs`를 통해 구성합니다.
  - 기본적으로 샌드박스 브라우저 컨테이너는 전역 `bridge` 네트워크 대신 전용 Docker 네트워크(`openclaw-sandbox-browser`)를 사용합니다.
    `agents.defaults.sandbox.browser.network`로 구성합니다.
  - 선택사항 `agents.defaults.sandbox.browser.cdpSourceRange`는 컨테이너 에지 CDP 수신을 CIDR 허용 목록으로 제한합니다(예: `172.21.0.1/32`).
  - noVNC 옵저버 액세스는 기본적으로 암호로 보호됩니다. OpenClaw는 로컬 부트스트랩 페이지를 제공하고 URL 조각에서 암호를 사용하여 noVNC를 여는 단기 토큰 URL을 발생시킵니다(쿼리/헤더 로그가 아님).
  - `agents.defaults.sandbox.browser.allowHostControl`을 사용하면 샌드박싱된 세션이 호스트 브라우저를 명시적으로 대상으로 할 수 있습니다.
  - 선택사항 허용 목록 게이트 `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

샌드박싱되지 않음:

- 게이트웨이 프로세스 자체.
- 호스트에서 명시적으로 실행되도록 허용된 도구(예: `tools.elevated`).
  - **승격된 exec은 호스트에서 실행되고 샌드박싱을 우회합니다.**
  - 샌드박싱이 꺼져 있으면 `tools.elevated`이 실행을 변경하지 않습니다(이미 호스트에 있음). [Elevated Mode](/tools/elevated) 참조.

## 모드

`agents.defaults.sandbox.mode`는 **언제** 샌드박싱이 사용되는지 제어합니다:

- `"off"`: 샌드박싱 없음.
- `"non-main"`: **비메인** 세션만 샌드박싱합니다(정상 채팅을 호스트에 원하면 기본값).
- `"all"`: 모든 세션이 샌드박스에서 실행됩니다.
  참고: `"non-main"`은 `session.mainKey`(기본값 `"main"`)를 기반으로 하며 에이전트 ID가 아닙니다.
  그룹/채널 세션은 자신의 키를 사용하므로 비메인으로 계산되고 샌드박싱됩니다.

## 범위

`agents.defaults.sandbox.scope`는 **몇 개의 컨테이너**가 생성되는지 제어합니다:

- `"session"` (기본값): 세션당 하나의 컨테이너.
- `"agent"`: 에이전트당 하나의 컨테이너.
- `"shared"`: 모든 샌드박싱된 세션이 공유하는 하나의 컨테이너.

## 작업 공간 액세스

`agents.defaults.sandbox.workspaceAccess`는 **샌드박스가 볼 수 있는 것**을 제어합니다:

- `"none"` (기본값): 도구가 `~/.openclaw/sandboxes` 아래의 샌드박스 작업 공간을 봅니다.
- `"ro"`: 에이전트 작업 공간을 `/agent`에 읽기 전용으로 마운트합니다(`write`/`edit`/`apply_patch` 비활성화).
- `"rw"`: 에이전트 작업 공간을 `/workspace`에 읽기/쓰기로 마운트합니다.

인바운드 미디어는 활성 샌드박스 작업 공간(`media/inbound/*`)에 복사됩니다.

## 커스텀 바인드 마운트

`agents.defaults.sandbox.docker.binds`는 호스트 디렉토리를 컨테이너에 마운트합니다.
형식: `host:container:mode` (예: `"/home/user/source:/source:rw"`).

전역 및 에이전트별 바인드는 **병합됩니다**(대체되지 않음). `scope: "shared"` 아래에서 에이전트별 바인드는 무시됩니다.

`agents.defaults.sandbox.browser.binds`는 **샌드박스 브라우저** 컨테이너에만 마운트합니다.

- 설정(빈 배열 포함)되면 브라우저 컨테이너의 `agents.defaults.sandbox.docker.binds`를 대체합니다.
- 생략되면 브라우저 컨테이너가 `agents.defaults.sandbox.docker.binds`로 폴백합니다(역호환).

예제(읽기 전용 소스 + 추가 데이터 디렉토리):

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

보안 참고:

- 바인드는 샌드박스 파일 시스템을 우회합니다. 설정한 모드로 호스트 경로를 노출합니다(`:ro` 또는 `:rw`).
- OpenClaw는 위험한 바인드 소스를 차단합니다(예: `docker.sock`, `/etc`, `/proc`, `/sys`, `/dev` 및 이를 노출하는 상위 마운트).
- 민감한 마운트(비밀, SSH 키, 서비스 자격 증명)는 절대 필요한 경우가 아니면 `:ro`여야 합니다.
- `workspaceAccess: "ro"`과 결합하면 작업 공간에 대한 읽기만 필요한 경우. 바인드 모드는 독립적으로 유지됩니다.

## 이미지 + 설정

기본 이미지: `openclaw-sandbox:bookworm-slim`

한 번 빌드합니다:

```bash
scripts/sandbox-setup.sh
```

참고: 기본 이미지에는 Node가 **포함되지 않습니다**. Skill이 Node(또는 기타 런타임)가 필요하면 커스텀 이미지를 구워 `sandbox.docker.setupCommand`를 사용합니다(네트워크 이그레스 + 쓰기 가능한 루트 + 루트 사용자 필요).

샌드박싱된 브라우저 이미지:

```bash
scripts/sandbox-browser-setup.sh
```

기본적으로 샌드박스 컨테이너는 **네트워크가 없습니다**.
`agents.defaults.sandbox.docker.network`으로 재정의합니다.

보안 기본값:

- `network: "host"`는 차단됩니다.
- `network: "container:<id>"`는 기본적으로 차단됩니다(네임스페이스 조인 우회 위험).
- Break-glass 재정의: `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`.

Docker 설치 및 컨테이너화된 게이트웨이는 여기에 있습니다:
[Docker](/install/docker)

## 다중 에이전트 재정의

각 에이전트는 샌드박스 + 도구를 재정의할 수 있습니다:
`agents.list[].sandbox` 및 `agents.list[].tools` (샌드박스 도구 정책용 `agents.list[].tools.sandbox.tools`포함).
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)를 참조하여 우선 순위를 확인합니다.

## 관련 문서

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- [Security](/gateway/security)
