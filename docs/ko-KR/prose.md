---
summary: "OpenClaw에서 .prose 워크플로우, slash 명령 및 상태"
read_when:
  - ".prose 워크플로우를 실행하거나 작성하고 싶을 때"
  - "OpenProse 플러그인을 활성화하고 싶을 때"
  - "상태 저장소를 이해해야 할 때"
title: "OpenProse"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/prose.md
  workflow: 15
---

# OpenProse

OpenProse는 AI 세션을 조율하기 위한 휴대용, 마크다운 우선 워크플로우 포맷입니다. OpenClaw에서는 OpenProse 스킬 팩 및 `/prose` slash 명령을 설치하는 플러그인으로 제공됩니다. 프로그램은 `.prose` 파일에 있으며 명시적 제어 흐름이 있는 다중 서브에이전트를 생성할 수 있습니다.

공식 사이트: [https://www.prose.md](https://www.prose.md)

## 수행할 수 있는 것

- 명시적 병렬로 다중 에이전트 연구 + 합성.
- 반복 가능한 승인 안전 워크플로우 (코드 검토, 인시던트 분류, 콘텐츠 파이프라인).
- 지원되는 에이전트 런타임에서 실행할 수 있는 재사용 가능한 `.prose` 프로그램.

## 설치 + 활성화

번들된 플러그인은 기본적으로 비활성화됩니다. OpenProse를 활성화합니다:

```bash
openclaw plugins enable open-prose
```

플러그인을 활성화한 후 Gateway를 다시 시작합니다.

개발/로컬 체크아웃: `openclaw plugins install ./extensions/open-prose`

관련 문서: [플러그인](/tools/plugin), [플러그인 매니페스트](/plugins/manifest), [스킬](/tools/skills).

## Slash 명령

OpenProse는 `/prose`를 사용자 호출 가능한 스킬 명령으로 등록합니다. OpenProse VM 지시문으로 라우팅되고 후드 아래에서 OpenClaw 도구를 사용합니다.

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
# 두 에이전트가 병렬로 실행되는 연구 + 합성.

input topic: "우리가 무엇을 연구해야 합니까?"

agent researcher:
  model: sonnet
  prompt: "당신은 철저히 연구하고 출처를 인용합니다."

agent writer:
  model: opus
  prompt: "당신은 간결한 요약을 작성합니다."

parallel:
  findings = session: researcher
    prompt: "{topic}을(를) 연구합니다."
  draft = session: writer
    prompt: "{topic}을(를) 요약합니다."

session "결과 + 초안을 최종 답변으로 병합합니다."
context: { findings, draft }
```

## 파일 위치

OpenProse는 워크스페이스의 `.prose/`에 상태를 유지합니다:

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

사용자 수준 지속 에이전트는 다음에 있습니다:

```
~/.prose/agents/
```

## 상태 모드

OpenProse는 여러 상태 백엔드를 지원합니다:

- **filesystem** (기본값): `.prose/runs/...`
- **in-context**: 작은 프로그램을 위한 임시.
- **sqlite** (실험적): `sqlite3` 바이너리 필요
- **postgres** (실험적): `psql`과 연결 문자열 필요

메모:

- sqlite/postgres는 선택이고 실험적입니다.
- postgres 자격증명이 서브에이전트 로그로 흘러갑니다. 전용, 최소 권한 DB를 사용합니다.

## 원격 프로그램

`/prose run <handle/slug>`는 `https://p.prose.md/<handle>/<slug>`로 해결됩니다.
직접 URL은 그대로 가져옵니다. 이것은 `web_fetch` 도구 (또는 POST용 `exec`)를 사용합니다.

## OpenClaw 런타임 매핑

OpenProse 프로그램은 OpenClaw 원시로 매핑합니다:

| OpenProse 개념      | OpenClaw 도구    |
| ------------------- | ---------------- |
| 세션/Task 도구 생성 | `sessions_spawn` |
| 파일 읽기/쓰기      | `read` / `write` |
| 웹 가져오기         | `web_fetch`      |

도구 allowlist가 이 도구를 차단하면 OpenProse 프로그램이 실패합니다. [스킬 구성](/tools/skills-config)을 참조하세요.

## 보안 + 승인

`.prose` 파일을 코드로 취급합니다. 실행 전에 검토합니다. OpenClaw 도구 allowlist 및 승인 게이트를 사용하여 부작용을 제어합니다.

결정론적, 승인 게이트된 워크플로우의 경우 [Lobster](/tools/lobster)와 비교합니다.
