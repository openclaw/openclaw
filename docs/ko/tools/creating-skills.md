---
title: "Skills 생성하기"
---

# 커스텀 Skills 생성하기 🛠

OpenClaw 는 쉽게 확장할 수 있도록 설계되었습니다. "Skills" 는 어시스턴트에 새로운 기능을 추가하는 주요 방법입니다.

## Skill 이란 무엇인가요?

Skill 은 `SKILL.md` 파일(LLM 에 지침과 도구 정의를 제공)을 포함하는 디렉토리이며, 선택적으로 스크립트나 리소스를 포함할 수 있습니다.

## 단계별 안내: 첫 번째 Skill

### 1. 디렉토리 생성

Skills 는 워크스페이스에 위치하며, 보통 `~/.openclaw/workspace/skills/` 에 있습니다. Skill 용 새 폴더를 생성합니다:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. `SKILL.md` 정의

해당 디렉토리에 `SKILL.md` 파일을 생성합니다. 이 파일은 메타데이터를 위한 YAML 프런트매터와 지침을 위한 Markdown 을 사용합니다.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. 도구 추가 (선택 사항)

프런트매터에서 커스텀 도구를 정의하거나, 에이전트에게 기존 시스템 도구(예: `bash` 또는 `browser`)를 사용하도록 지시할 수 있습니다.

### 4. OpenClaw 새로 고침

에이전트에게 "refresh skills" 를 요청하거나 Gateway(게이트웨이)를 재시작합니다. OpenClaw 는 새 디렉토리를 발견하고 `SKILL.md` 를 인덱싱합니다.

## 모범 사례

- **간결함 유지**: 모델에게 AI 가 되는 방법이 아니라 _무엇_ 을 해야 하는지 지시합니다.
- **안전 우선**: Skill 이 `bash` 를 사용하는 경우, 신뢰할 수 없는 사용자 입력으로부터 임의의 명령 주입이 허용되지 않도록 프롬프트를 보장하십시오.
- **로컬 테스트**: `openclaw agent --message "use my new skill"` 를 사용하여 테스트합니다.

## 공유 Skills

[ClawHub](https://clawhub.com)에서 Skills 를 찾아보고 기여할 수도 있습니다.
