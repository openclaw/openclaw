---
summary: "OpenProse: OpenClaw 에서의 .prose 워크플로, 슬래시 명령, 상태 관리"
read_when:
  - .prose 워크플로를 실행하거나 작성하려는 경우
  - OpenProse 플러그인을 활성화하려는 경우
  - 상태 저장 방식을 이해해야 하는 경우
title: "OpenProse"
---

# OpenProse

OpenProse 는 AI 세션을 오케스트레이션하기 위한 이식 가능한, 마크다운 우선 워크플로 형식입니다. OpenClaw 에서는 OpenProse skill pack 과 `/prose` 슬래시 명령을 설치하는 플러그인으로 제공됩니다. 프로그램은 `.prose` 파일에 존재하며, 명시적인 제어 흐름으로 여러 하위 에이전트를 생성할 수 있습니다.

공식 사이트: [https://www.prose.md](https://www.prose.md)

## 무엇을 할 수 있나요

- 명시적 병렬성을 갖춘 다중 에이전트 연구 및 종합.
- 반복 가능하고 승인에 안전한 워크플로(코드 리뷰, 인시던트 트리아지, 콘텐츠 파이프라인).
- 지원되는 에이전트 런타임 전반에서 실행할 수 있는 재사용 가능한 `.prose` 프로그램.

## 설치 + 활성화

번들된 플러그인은 기본적으로 비활성화되어 있습니다. OpenProse 를 활성화하십시오:

```bash
openclaw plugins enable open-prose
```

플러그인을 활성화한 후 Gateway(게이트웨이) 를 재시작하십시오.

개발/로컬 체크아웃: `openclaw plugins install ./extensions/open-prose`

관련 문서: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## 슬래시 명령

OpenProse 는 사용자 호출 가능한 skill 명령으로 `/prose` 를 등록합니다. 이는 OpenProse VM 지침으로 라우팅되며 내부적으로 OpenClaw 도구를 사용합니다.

일반적인 명령:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## 예시: 간단한 `.prose` 파일

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## 파일 위치

OpenProse 는 작업 공간에서 `.prose/` 아래에 상태를 저장합니다:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

사용자 수준의 영구 에이전트는 다음 위치에 있습니다:

```
~/.prose/agents/
```

## 상태 모드

OpenProse 는 여러 상태 백엔드를 지원합니다:

- **filesystem** (기본값): `.prose/runs/...`
- **in-context**: 소규모 프로그램을 위한 일시적 방식
- **sqlite** (실험적): `sqlite3` 바이너리 필요
- **postgres** (실험적): `psql` 및 연결 문자열 필요

참고:

- sqlite/postgres 는 선택 사항이며 실험적입니다.
- postgres 자격 증명은 하위 에이전트 로그로 전달됩니다. 전용의 최소 권한 DB 를 사용하십시오.

## 원격 프로그램

`/prose run <handle/slug>` 는 `https://p.prose.md/<handle>/<slug>` 로 해석됩니다.
직접 URL 은 있는 그대로 가져옵니다. 이는 `web_fetch` 도구(또는 POST 의 경우 `exec`)를 사용합니다.

## OpenClaw 런타임 매핑

OpenProse 프로그램은 OpenClaw 기본 요소로 매핑됩니다:

| OpenProse 개념  | OpenClaw 도구      |
| ------------- | ---------------- |
| 세션 생성 / 작업 도구 | `sessions_spawn` |
| 파일 읽기/쓰기      | `read` / `write` |
| 웹 가져오기        | `web_fetch`      |

도구 허용 목록이 이러한 도구를 차단하는 경우 OpenProse 프로그램은 실패합니다. [Skills 설정](/tools/skills-config)을 참고하십시오.

## 보안 + 승인

`.prose` 파일은 코드처럼 취급하십시오. 실행 전에 검토하십시오. OpenClaw 도구 허용 목록과 승인 게이트를 사용하여 부작용을 제어하십시오.

결정적이며 승인으로 제어되는 워크플로의 경우 [Lobster](/tools/lobster)와 비교해 보십시오.
