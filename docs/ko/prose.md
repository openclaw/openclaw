---
read_when:
    - .prose 워크플로를 실행하거나 작성하려는 경우
    - OpenProse 플러그인을 활성화하고 싶습니다
    - 상태 저장을 이해해야 합니다.
summary: 'OpenProse: OpenClaw의 .prose 워크플로우, 슬래시 명령 및 상태'
title: 오픈프로즈
x-i18n:
    generated_at: "2026-02-08T16:01:17Z"
    model: gtx
    provider: google-translate
    source_hash: 53c161466d278e5f34759313eec600a26da7018bcd52ce68c5a15e5c769bcbe5
    source_path: prose.md
    workflow: 15
---

# 오픈프로즈

OpenProse는 AI 세션을 조정하기 위한 이식 가능한 마크다운 우선 워크플로 형식입니다. OpenClaw에서는 OpenProse 스킬 팩과 `/prose` 슬래시 명령. 프로그램이 살고 있습니다 `.prose` 파일을 생성하고 명시적인 제어 흐름을 통해 여러 하위 에이전트를 생성할 수 있습니다.

공식 사이트: [https://www.prose.md](https://www.prose.md)

## 무엇을 할 수 있나요?

- 명시적인 병렬성을 갖춘 다중 에이전트 연구 + 합성.
- 승인이 보장되는 반복 가능한 워크플로(코드 검토, 사건 분류, 콘텐츠 파이프라인)
- 재사용 가능 `.prose` 지원되는 에이전트 런타임 전반에 걸쳐 실행할 수 있는 프로그램입니다.

## 설치 + 활성화

번들 플러그인은 기본적으로 비활성화되어 있습니다. OpenProse 활성화:

```bash
openclaw plugins enable open-prose
```

플러그인을 활성화한 후 게이트웨이를 다시 시작하십시오.

개발/로컬 체크아웃: `openclaw plugins install ./extensions/open-prose`

관련 문서: [플러그인](/tools/plugin), [플러그인 매니페스트](/plugins/manifest), [기술](/tools/skills).

## 슬래시 명령

OpenProse 레지스터 `/prose` 사용자가 호출할 수 있는 기술 명령으로 사용됩니다. OpenProse VM 지침으로 라우팅하고 내부적으로 OpenClaw 도구를 사용합니다.

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

## 예: 간단한 `.prose` 파일

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

OpenProse는 상태를 다음과 같이 유지합니다. `.prose/` 작업 공간에서:

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

사용자 수준 영구 에이전트는 다음 위치에 있습니다.

```
~/.prose/agents/
```

## 상태 모드

OpenProse는 다중 상태 백엔드를 지원합니다:

- **파일 시스템** (기본): `.prose/runs/...`
- **상황에 맞는**: 일시적, 작은 프로그램용
- **SQLite** (실험적): 필요 `sqlite3` 바이너리
- **포스트그레스** (실험적): 필요 `psql` 그리고 연결 문자열

참고:

- sqlite/postgres는 선택 가능하고 실험적입니다.
- postgres 자격 증명은 하위 에이전트 로그로 전달됩니다. 최소 권한의 전용 DB를 사용합니다.

## 원격 프로그램

`/prose run <handle/slug>` 결심하다 `https://p.prose.md/<handle>/<slug>`.
직접 URL은 있는 그대로 가져옵니다. 이는 `web_fetch` 도구(또는 `exec` POST의 경우).

## OpenClaw 런타임 매핑

OpenProse 프로그램은 OpenClaw 기본 요소에 매핑됩니다.

| OpenProse concept         | OpenClaw tool    |
| ------------------------- | ---------------- |
| Spawn session / Task tool | `sessions_spawn` |
| File read/write           | `read` / `write` |
| Web fetch                 | `web_fetch`      |

도구 허용 목록이 이러한 도구를 차단하면 OpenProse 프로그램이 실패합니다. 보다 [스킬 구성](/tools/skills-config).

## 보안 + 승인

대하다 `.prose` 코드와 같은 파일. 실행하기 전에 검토하세요. OpenClaw 도구 허용 목록과 승인 게이트를 사용하여 부작용을 제어하세요.

결정론적 승인 기반 워크플로의 경우 다음과 비교하세요. [새우](/tools/lobster).
