---
title: "Skills 만들기"
summary: "SKILL.md로 커스텀 작업 공간 Skills 빌드 및 테스트"
read_when:
  - 작업 공간에서 새 커스텀 Skill을 만들 때
  - SKILL.md 기반 Skills용 빠른 스타터 워크플로우가 필요할 때
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/creating-skills.md
workflow: 15
---

# 커스텀 Skills 만들기

OpenClaw는 쉽게 확장 가능하도록 설계되었습니다. "Skills"은 어시스턴트에 새로운 기능을 추가하는 주요 방법입니다.

## Skill이란 무엇입니까?

Skill은 `SKILL.md` 파일(LLM에 지침 및 도구 정의를 제공)과 선택적으로 일부 스크립트 또는 리소스를 포함하는 디렉터리입니다.

## 단계별: 첫 번째 Skill

### 1. 디렉터리 만들기

Skills은 일반적으로 작업 공간 `~/.openclaw/workspace/skills/`에 있습니다. Skill용 새 폴더를 만듭니다:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. `SKILL.md` 정의

해당 디렉터리에 `SKILL.md` 파일을 만듭니다. 이 파일은 메타데이터용 YAML frontmatter와 지침용 Markdown을 사용합니다.

```markdown
---
name: hello_world
description: 인사말을 하는 간단한 Skill입니다.
---

# Hello World Skill

사용자가 인사말을 요청할 때 `echo` 도구를 사용하여 "Hello from your custom skill!"를 말합니다.
```

### 3. 도구 추가(선택 사항)

frontmatter에서 커스텀 도구를 정의하거나 기존 시스템 도구(`bash` 또는 `browser`)를 사용하도록 에이전트를 지시할 수 있습니다.

### 4. OpenClaw 새로고침

에이전트에 "refresh skills"을 요청하거나 Gateway를 다시 시작합니다. OpenClaw는 새 디렉터리를 발견하고 `SKILL.md`를 색인합니다.

## 모범 사례

- **간단하게**: 에이전트가 **하는 방법**이 아니라 **하는 일**을 지시합니다.
- **안전 우선**: Skill이 `bash`를 사용하는 경우 신뢰할 수 없는 사용자 입력의 임의 커맨드 주입을 허용하지 않도록 합니다.
- **로컬 테스트**: `openclaw agent --message "use my new skill"`을 사용하여 테스트합니다.

## 공유 Skills

또한 [ClawHub](https://clawhub.com)에서 Skill을 탐색하고 기여할 수 있습니다.
