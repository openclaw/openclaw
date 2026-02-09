---
summary: "OpenClaw 샌드박스화가 작동하는 방식: 모드, 범위, 워크스페이스 접근, 이미지"
title: Sandboxing
read_when: "샌드박스화에 대한 전용 설명이 필요하거나 agents.defaults.sandbox 를 튜닝해야 할 때."
status: active
---

# Sandboxing

OpenClaw 는 **Docker 컨테이너 내부에서 도구를 실행**하여 피해 범위를 줄일 수 있습니다.
이는 **선택 사항**이며 구성(`agents.defaults.sandbox` 또는
`agents.list[].sandbox`)으로 제어됩니다. 샌드박스화가 꺼져 있으면 도구는 호스트에서 실행됩니다.
Gateway(게이트웨이)는 호스트에 유지되며, 활성화 시 도구 실행은 격리된 샌드박스에서 이루어집니다.

이는 완벽한 보안 경계는 아니지만, 모델이 잘못된 동작을 할 때 파일시스템과 프로세스 접근을 실질적으로 제한합니다.

## 무엇이 샌드박스화되는가

- 도구 실행(`exec`, `read`, `write`, `edit`, `apply_patch`, `process` 등).
- 선택적 샌드박스화된 브라우저(`agents.defaults.sandbox.browser`).
  - 기본적으로 샌드박스 브라우저는 브라우저 도구가 필요할 때 자동 시작되어(CDP 접근 가능 보장) 동작합니다.
    `agents.defaults.sandbox.browser.autoStart` 및 `agents.defaults.sandbox.browser.autoStartTimeoutMs`로 구성합니다.
  - `agents.defaults.sandbox.browser.allowHostControl`를 사용하면 샌드박스화된 세션이 호스트 브라우저를 명시적으로 대상으로 지정할 수 있습니다.
  - 선택적 허용 목록이 `target: "custom"`를 게이트합니다: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

샌드박스화되지 않음:

- Gateway(게이트웨이) 프로세스 자체.
- 호스트에서 실행하도록 명시적으로 허용된 모든 도구(예: `tools.elevated`).
  - **상승된 exec 는 호스트에서 실행되며 샌드박스화를 우회합니다.**
  - 샌드박스화가 꺼져 있으면 `tools.elevated`은 실행을 변경하지 않습니다(이미 호스트에서 실행). [Elevated Mode](/tools/elevated)를 참조하십시오.

## 모드

`agents.defaults.sandbox.mode`는 샌드박스화를 **언제** 사용하는지를 제어합니다:

- `"off"`: 샌드박스화 없음.
- `"non-main"`: **메인 세션이 아닌** 경우에만 샌드박스화(호스트에서 일반 채팅을 원할 때 기본값).
- `"all"`: 모든 세션이 샌드박스에서 실행됩니다.
  참고: `"non-main"`은 에이전트 id 가 아니라 `session.mainKey` 기준(기본값 `"main"`)입니다.
  그룹/채널 세션은 자체 키를 사용하므로 메인이 아닌 것으로 간주되어 샌드박스화됩니다.

## 범위

`agents.defaults.sandbox.scope`는 생성되는 **컨테이너 수**를 제어합니다:

- `"session"` (기본값): 세션당 하나의 컨테이너.
- `"agent"`: 에이전트당 하나의 컨테이너.
- `"shared"`: 모든 샌드박스화된 세션이 하나의 컨테이너를 공유.

## 워크스페이스 접근

`agents.defaults.sandbox.workspaceAccess`는 샌드박스가 **무엇을 볼 수 있는지**를 제어합니다:

- `"none"` (기본값): 도구는 `~/.openclaw/sandboxes` 아래의 샌드박스 워크스페이스를 봅니다.
- `"ro"`: 에이전트 워크스페이스를 `/agent`에 읽기 전용으로 마운트합니다(`write`/`edit`/`apply_patch` 비활성화).
- `"rw"`: 에이전트 워크스페이스를 `/workspace`에 읽기/쓰기 가능으로 마운트합니다.

수신 미디어는 활성 샌드박스 워크스페이스(`media/inbound/*`)로 복사됩니다.
Skills 참고: `read` 도구는 샌드박스 루트 기준입니다. `workspaceAccess: "none"`를 사용하면,
OpenClaw 는 읽을 수 있도록 적격한 Skills 를 샌드박스 워크스페이스(`.../skills`)로 미러링합니다. `"rw"`를 사용하면 워크스페이스 Skills 를 `/workspace/skills`에서 읽을 수 있습니다.

## 사용자 지정 바인드 마운트

`agents.defaults.sandbox.docker.binds`는 추가 호스트 디렉토리를 컨테이너에 마운트합니다.
형식: `host:container:mode` (예: `"/home/user/source:/source:rw"`).

전역 및 에이전트별 바인드는 **병합**됩니다(대체되지 않음). `scope: "shared"`에서는 에이전트별 바인드가 무시됩니다.

예시(읽기 전용 소스 + docker 소켓):

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

보안 참고 사항:

- 바인드는 샌드박스 파일시스템을 우회하여 설정한 모드(`:ro` 또는 `:rw`) 그대로 호스트 경로를 노출합니다.
- 민감한 마운트(예: `docker.sock`, 비밀 값, SSH 키)는 절대적으로 필요하지 않은 한 `:ro`로 설정해야 합니다.
- 워크스페이스에 대한 읽기 접근만 필요하다면 `workspaceAccess: "ro"`와 함께 사용하십시오; 바인드 모드는 독립적으로 유지됩니다.
- 바인드가 도구 정책 및 상승된 exec 와 어떻게 상호작용하는지는 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)를 참조하십시오.

## 이미지 + 설정

기본 이미지: `openclaw-sandbox:bookworm-slim`

한 번만 빌드합니다:

```bash
scripts/sandbox-setup.sh
```

참고: 기본 이미지는 Node 를 **포함하지 않습니다**. 어떤 Skill 이 Node(또는
다른 런타임)를 필요로 하는 경우, 사용자 지정 이미지를 굽거나
`sandbox.docker.setupCommand`를 통해 설치하십시오(네트워크 이그레스 + 쓰기 가능한 루트 +
root 사용자 필요).

샌드박스화된 브라우저 이미지:

```bash
scripts/sandbox-browser-setup.sh
```

기본적으로 샌드박스 컨테이너는 **네트워크가 없습니다**.
`agents.defaults.sandbox.docker.network`로 재정의할 수 있습니다.

Docker 설치와 컨테이너화된 Gateway(게이트웨이)는 여기에서 확인하십시오:
[Docker](/install/docker)

## setupCommand (컨테이너 1회 설정)

`setupCommand`은 샌드박스 컨테이너가 생성된 후 **한 번만** 실행됩니다(매 실행마다 아님).
`sh -lc`를 통해 컨테이너 내부에서 실행됩니다.

경로:

- 전역: `agents.defaults.sandbox.docker.setupCommand`
- 에이전트별: `agents.list[].sandbox.docker.setupCommand`

일반적인 함정:

- 기본 `docker.network`는 `"none"`(이그레스 없음)이므로 패키지 설치가 실패합니다.
- `readOnlyRoot: true`은 쓰기를 방지합니다; `readOnlyRoot: false`로 설정하거나 사용자 지정 이미지를 사용하십시오.
- 패키지 설치를 위해서는 `user`가 root 여야 합니다(`user`을 생략하거나 `user: "0:0"`로 설정).
- 샌드박스 exec 는 호스트 `process.env`를 **상속하지 않습니다**. Skill API 키에는
  `agents.defaults.sandbox.docker.env`(또는 사용자 지정 이미지)를 사용하십시오.

## 도구 정책 + 탈출구

도구 허용/차단 정책은 샌드박스 규칙보다 먼저 적용됩니다. 도구가 전역 또는 에이전트별로 차단되어 있다면,
샌드박스화로 다시 활성화되지 않습니다.

`tools.elevated`는 호스트에서 `exec`를 실행하는 명시적인 탈출구입니다.
`/exec` 지시문은 승인된 발신자에 대해서만 적용되며 세션별로 유지됩니다; `exec`을
강제로 비활성화하려면 도구 정책 차단을 사용하십시오([Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) 참조).

디버깅:

- 유효한 샌드박스 모드, 도구 정책, 수정 구성 키를 확인하려면 `openclaw sandbox explain`를 사용하십시오.
- “왜 이게 차단되었는가?”에 대한 사고 모델은 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)를 참조하십시오.
  잠금을 유지하십시오.

## 멀티 에이전트 재정의

각 에이전트는 샌드박스 + 도구를 재정의할 수 있습니다:
`agents.list[].sandbox` 및 `agents.list[].tools`(샌드박스 도구 정책을 위한 `agents.list[].tools.sandbox.tools` 포함).
우선순위는 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)를 참조하십시오.

## 최소 활성화 예제

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

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
