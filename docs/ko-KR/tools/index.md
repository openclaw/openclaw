---
summary: "OpenClaw 도구 및 플러그인 개요: 에이전트가 할 수 있는 것과 확장 방법"
read_when:
  - OpenClaw 가 제공하는 도구를 이해하고 싶을 때
  - 도구를 구성, 허용 또는 거부해야 할 때
  - 내장 도구, Skills, 플러그인 중 어떤 것을 사용할지 결정할 때
title: "도구 및 플러그인"
x-i18n:
  source_path: docs/tools/index.md
---

# 도구 및 플러그인

에이전트가 텍스트 생성 이외에 수행하는 모든 작업은 **도구**를 통해 이루어집니다.
도구는 에이전트가 파일을 읽고, 명령을 실행하고, 웹을 탐색하고, 메시지를 보내고,
장치와 상호작용하는 방식입니다.

## 도구, Skills, 플러그인

OpenClaw 에는 함께 작동하는 세 가지 레이어가 있습니다:

<Steps>
  <Step title="도구는 에이전트가 호출하는 것입니다">
    도구는 에이전트가 호출할 수 있는 타입이 지정된 함수입니다 (예: `exec`, `browser`,
    `web_search`, `message`). OpenClaw 는 **내장 도구** 세트를 제공하며
    플러그인을 통해 추가 도구를 등록할 수 있습니다.

    에이전트는 도구를 모델 API 로 전송되는 구조화된 함수 정의로 인식합니다.

  </Step>

  <Step title="Skills 는 에이전트에게 언제, 어떻게를 가르칩니다">
    Skills 는 시스템 프롬프트에 주입되는 마크다운 파일(`SKILL.md`)입니다.
    Skills 는 에이전트에게 도구를 효과적으로 사용하기 위한 컨텍스트, 제약 조건 및
    단계별 안내를 제공합니다. Skills 는 워크스페이스, 공유 폴더에 있거나
    플러그인 내에 포함되어 배포됩니다.

    [Skills 참조](/tools/skills) | [Skills 만들기](/tools/creating-skills)

  </Step>

  <Step title="플러그인은 모든 것을 하나로 묶습니다">
    플러그인은 채널, 모델 프로바이더, 도구, Skills, 음성, 이미지 생성 등
    다양한 기능의 조합을 등록할 수 있는 패키지입니다.
    일부 플러그인은 **코어**(OpenClaw 와 함께 배포)이고, 다른 플러그인은 **외부**
    (커뮤니티에서 npm 에 게시)입니다.

    [플러그인 설치 및 구성](/tools/plugin) | [직접 만들기](/plugins/building-plugins)

  </Step>
</Steps>

## 내장 도구

다음 도구는 OpenClaw 와 함께 제공되며 플러그인 설치 없이 사용할 수 있습니다:

| 도구                         | 기능                                          | 페이지                            |
| ---------------------------- | --------------------------------------------- | --------------------------------- |
| `exec` / `process`           | 셸 명령 실행, 백그라운드 프로세스 관리        | [Exec](/tools/exec)               |
| `browser`                    | Chromium 브라우저 제어 (탐색, 클릭, 스크린샷) | [Browser](/tools/browser)         |
| `web_search` / `web_fetch`   | 웹 검색, 페이지 콘텐츠 가져오기               | [Web](/tools/web)                 |
| `read` / `write` / `edit`    | 워크스페이스 내 파일 I/O                      |                                   |
| `apply_patch`                | 다중 헝크 파일 패치                           | [Apply Patch](/tools/apply-patch) |
| `message`                    | 모든 채널에 걸쳐 메시지 전송                  | [Agent Send](/tools/agent-send)   |
| `canvas`                     | 노드 Canvas 구동 (프레젠트, 평가, 스냅샷)     |                                   |
| `nodes`                      | 페어링된 장치 검색 및 대상 지정               |                                   |
| `cron` / `gateway`           | 예약 작업 관리, Gateway 재시작                |                                   |
| `image` / `image_generate`   | 이미지 분석 또는 생성                         |                                   |
| `sessions_*` / `agents_list` | 세션 관리, 서브 에이전트                      | [Sub-agents](/tools/subagents)    |

### 플러그인 제공 도구

플러그인은 추가 도구를 등록할 수 있습니다. 몇 가지 예시:

- [Lobster](/tools/lobster) — 재개 가능한 승인 기능이 있는 타입 지정 워크플로 런타임
- [LLM Task](/tools/llm-task) — 구조화된 출력을 위한 JSON 전용 LLM 단계
- [Diffs](/tools/diffs) — diff 뷰어 및 렌더러
- [OpenProse](/prose) — 마크다운 기반 워크플로 오케스트레이션

## 도구 구성

### 허용 및 거부 목록

`tools.allow` / `tools.deny` 설정을 통해 에이전트가 호출할 수 있는 도구를 제어합니다.
거부가 항상 허용보다 우선합니다.

```json5
{
  tools: {
    allow: ["group:fs", "browser", "web_search"],
    deny: ["exec"],
  },
}
```

### 도구 프로필

`tools.profile`은 `allow`/`deny`가 적용되기 전에 기본 허용 목록을 설정합니다.
에이전트별 재정의: `agents.list[].tools.profile`.

| 프로필      | 포함 내용                              |
| ----------- | -------------------------------------- |
| `full`      | 모든 도구 (기본값)                     |
| `coding`    | 파일 I/O, 런타임, 세션, 메모리, 이미지 |
| `messaging` | 메시징, 세션 목록/히스토리/전송/상태   |
| `minimal`   | `session_status` 만                    |

### 도구 그룹

허용/거부 목록에서 `group:*` 약칭을 사용합니다:

| 그룹               | 도구                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `group:runtime`    | exec, bash, process                                                            |
| `group:fs`         | read, write, edit, apply_patch                                                 |
| `group:sessions`   | sessions_list, sessions_history, sessions_send, sessions_spawn, session_status |
| `group:memory`     | memory_search, memory_get                                                      |
| `group:web`        | web_search, web_fetch                                                          |
| `group:ui`         | browser, canvas                                                                |
| `group:automation` | cron, gateway                                                                  |
| `group:messaging`  | message                                                                        |
| `group:nodes`      | nodes                                                                          |
| `group:openclaw`   | 모든 내장 OpenClaw 도구 (플러그인 도구 제외)                                   |

### 프로바이더별 제한

전역 기본값을 변경하지 않고 특정 프로바이더에 대해 도구를 제한하려면
`tools.byProvider`를 사용합니다:

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```
