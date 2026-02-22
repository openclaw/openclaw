---
summary: "OpenProse: OpenClaw의 .prose 워크플로우, 슬래시 명령어 및 상태"
read_when:
  - .prose 워크플로우를 실행하거나 작성하려는 경우
  - OpenProse 플러그인을 활성화하려는 경우
  - 상태 저장소를 이해해야 하는 경우
title: "OpenProse"
---

# OpenProse

OpenProse는 AI 세션을 조율하기 위한 휴대용 마크다운 우선 워크플로우 형식입니다. OpenClaw에서는 OpenProse 스킬 팩과 `/prose` 슬래시 명령어를 설치하는 플러그인으로 제공됩니다. 프로그램은 `.prose` 파일에 존재하며 명시적인 제어 흐름으로 여러 하위 에이전트를 생성할 수 있습니다.

공식 사이트: [https://www.prose.md](https://www.prose.md)

## 기능

- 명시적 병렬 처리를 통한 다중 에이전트 연구 및 합성.
- 반복 가능한 승인 안전 워크플로우 (코드 리뷰, 사건 대응, 콘텐츠 파이프라인).
- 지원되는 에이전트 런타임에서 실행할 수 있는 재사용 가능한 `.prose` 프로그램.

## 설치 + 활성화

번들 플러그인은 기본적으로 비활성화되어 있습니다. OpenProse를 활성화하세요:

```bash
openclaw plugins enable open-prose
```

플러그인을 활성화한 후 게이트웨이를 재시작하십시오.

개발/로컬 체크아웃: `openclaw plugins install ./extensions/open-prose`

관련 문서: [플러그인](/tools/plugin), [플러그인 매니페스트](/plugins/manifest), [스킬](/tools/skills).

## 슬래시 명령어

OpenProse는 사용자 호출 가능한 스킬 명령어로 `/prose`를 등록합니다. 이것은 OpenProse VM 명령어에 연결되며 내부적으로 OpenClaw 도구를 사용합니다.

일반 명령어:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## 예제: 간단한 `.prose` 파일

```prose
# 두 에이전트가 병렬로 실행되는 연구 및 합성.

input topic: "우리가 연구해야 할 것은 무엇입니까?"

agent researcher:
  model: sonnet
  prompt: "당신은 철저히 연구하고 출처를 인용합니다."

agent writer:
  model: opus
  prompt: "당신은 간결한 요약을 작성합니다."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "결과 및 초안을 최종 답변으로 병합하세요."
context: { findings, draft }
```

## 파일 위치

OpenProse는 워크스페이스 내의 `.prose/`에서 상태를 유지합니다:

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

사용자 수준의 영구 에이전트는 다음 위치에 존재합니다:

```
~/.prose/agents/
```

## 상태 모드

OpenProse는 여러 상태 백엔드를 지원합니다:

- **filesystem** (기본값): `.prose/runs/...`
- **in-context**: 작은 프로그램을 위한 일시적 상태
- **sqlite** (실험적): `sqlite3` 바이너리 필요
- **postgres** (실험적): `psql`과 연결 문자열 필요

주의사항:

- sqlite/postgres는 명시적 선택 기능이며 실험적입니다.
- postgres 자격 증명은 하위 에이전트 로그로 전송됩니다; 전용, 최소 권한의 DB를 사용하세요.

## 원격 프로그램

`/prose run <handle/slug>`는 `https://p.prose.md/<handle>/<slug>`로 해석됩니다. 직접 URL은 그대로 가져옵니다. 이는 `web_fetch` 도구를 사용합니다. (또는 POST 요청을 위해 `exec` 사용).

## OpenClaw 런타임 매핑

OpenProse 프로그램은 OpenClaw 원시 도구와 매핑됩니다:

| OpenProse 개념        | OpenClaw 도구    |
| --------------------- | ---------------- |
| 세션 생성 / 작업 도구 | `sessions_spawn` |
| 파일 읽기/쓰기        | `read` / `write` |
| 웹 가져오기           | `web_fetch`      |

도구 허용 목록에서 이러한 도구를 차단하면 OpenProse 프로그램이 실패할 수 있습니다. [스킬 설정](/tools/skills-config)을 참조하십시오.

## 보안 + 승인

`.prose` 파일은 코드처럼 취급하세요. 실행 전에 검토하십시오. 부작용을 제어하기 위해 OpenClaw 도구 허용 목록과 승인 게이트를 사용하세요.

결정론적이고 승인 기반 워크플로우를 위해 [Lobster](/tools/lobster)와 비교하세요.
