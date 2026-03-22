---
summary: "OpenProse: .prose 워크플로, 슬래시 명령 및 OpenClaw 의 상태"
read_when:
  - .prose 워크플로를 실행하거나 작성하고 싶을 때
  - OpenProse 플러그인을 활성화하고 싶을 때
  - 상태 저장을 이해해야 할 때
title: "OpenProse"
x-i18n:
  source_path: docs/prose.md
---

# OpenProse

OpenProse 는 AI 세션 오케스트레이션을 위한 이식 가능한 마크다운 기반 워크플로 형식입니다. OpenClaw 에서는 OpenProse Skill 팩과 `/prose` 슬래시 명령을 설치하는 플러그인으로 배포됩니다. 프로그램은 `.prose` 파일에 존재하며 명시적 제어 흐름으로 여러 서브 에이전트를 생성할 수 있습니다.

공식 사이트: [https://www.prose.md](https://www.prose.md)

## 할 수 있는 것

- 명시적 병렬 처리를 사용한 멀티 에이전트 리서치 + 합성.
- 반복 가능한 승인 안전 워크플로 (코드 리뷰, 인시던트 분류, 콘텐츠 파이프라인).
- 지원되는 에이전트 런타임에서 실행할 수 있는 재사용 가능한 `.prose` 프로그램.

## 설치 + 활성화

번들 플러그인은 기본적으로 비활성화되어 있습니다. OpenProse 활성화:

```bash
openclaw plugins enable open-prose
```

플러그인 활성화 후 Gateway 를 재시작하세요.

개발/로컬 체크아웃: `openclaw plugins install ./extensions/open-prose`

관련 문서: [플러그인](/tools/plugin), [플러그인 매니페스트](/plugins/manifest), [Skills](/tools/skills).

## 슬래시 명령

OpenProse 는 `/prose`를 사용자 호출 가능한 Skill 명령으로 등록합니다. OpenProse VM 지시사항으로 라우팅하고 내부적으로 OpenClaw 도구를 사용합니다.

일반 명령:

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

OpenProse 는 워크스페이스의 `.prose/` 아래에 상태를 유지합니다:

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

사용자 수준 영구 에이전트:

```
~/.prose/agents/
```

## 상태 모드

OpenProse 는 여러 상태 백엔드를 지원합니다:

- **filesystem** (기본값): `.prose/runs/...`
- **in-context**: 작은 프로그램을 위한 임시
- **sqlite** (실험적): `sqlite3` 바이너리 필요
- **postgres** (실험적): `psql` 및 연결 문자열 필요

참고 사항:

- sqlite/postgres 는 옵트인이며 실험적입니다.
- postgres 자격 증명은 서브 에이전트 로그에 유입됩니다; 전용, 최소 권한 DB 를 사용하세요.

## 원격 프로그램

`/prose run <handle/slug>`는 `https://p.prose.md/<handle>/<slug>`로 해결됩니다.
직접 URL 은 있는 그대로 가져옵니다. `web_fetch` 도구 (또는 POST 를 위한 `exec`) 를 사용합니다.

## OpenClaw 런타임 매핑

OpenProse 프로그램은 OpenClaw 프리미티브에 매핑됩니다:

| OpenProse 개념        | OpenClaw 도구    |
| --------------------- | ---------------- |
| 세션 생성 / Task 도구 | `sessions_spawn` |
| 파일 읽기/쓰기        | `read` / `write` |
| 웹 가져오기           | `web_fetch`      |

도구 허용 목록이 이 도구를 차단하면 OpenProse 프로그램이 실패합니다. [Skills 구성](/tools/skills-config)을 참조하세요.

## 보안 + 승인

`.prose` 파일을 코드처럼 취급하세요. 실행 전에 검토하세요. 부수 효과를 제어하기 위해 OpenClaw 도구 허용 목록과 승인 게이트를 사용하세요.

결정적이고 승인 게이트가 있는 워크플로에 대해서는 [Lobster](/tools/lobster)와 비교하세요.
