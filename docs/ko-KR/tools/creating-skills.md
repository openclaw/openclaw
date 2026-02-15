---
title: "Creating Skills"
x-i18n:
  source_hash: ad801da34fe361ffa584ded47f775d1c104a471a3f7b7f930652255e98945c3a
---

# 맞춤형 스킬 만들기 🛠

OpenClaw는 쉽게 확장 가능하도록 설계되었습니다. "기술"은 어시스턴트에 새로운 기능을 추가하는 기본 방법입니다.

## 스킬이란 무엇인가요?

스킬은 `SKILL.md` 파일(LLM에 지침 및 도구 정의 제공)과 선택적으로 일부 스크립트 또는 리소스를 포함하는 디렉터리입니다.

## 단계별: 첫 번째 기술

### 1. 디렉터리 생성

기술은 일반적으로 `~/.openclaw/workspace/skills/` 작업 공간에 있습니다. 스킬에 대한 새 폴더를 만듭니다.

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. `SKILL.md`를 정의합니다.

해당 디렉터리에 `SKILL.md` 파일을 만듭니다. 이 파일은 메타데이터에 YAML 앞부분을 사용하고 지침에 Markdown을 사용합니다.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. 도구 추가(선택사항)

서문에서 사용자 정의 도구를 정의하거나 에이전트에게 기존 시스템 도구(예: `bash` 또는 `browser`)를 사용하도록 지시할 수 있습니다.

### 4. OpenClaw 새로 고침

상담원에게 "기술 새로 고침"을 요청하거나 게이트웨이를 다시 시작하세요. OpenClaw는 새 디렉터리를 검색하고 `SKILL.md`의 색인을 생성합니다.

## 모범 사례

- **간결하게**: AI가 되는 방법이 아닌 _무엇을_ 해야 하는지 모델에 지시하세요.
- **안전 제일**: 스킬이 `bash`를 사용하는 경우 프롬프트가 신뢰할 수 없는 사용자 입력에서 임의의 명령 주입을 허용하지 않는지 확인하세요.
- **로컬 테스트**: `openclaw agent --message "use my new skill"`를 사용하여 테스트합니다.

## 공유 기술

[ClawHub](https://clawhub.com)에서 스킬을 찾아보고 기여할 수도 있습니다.
