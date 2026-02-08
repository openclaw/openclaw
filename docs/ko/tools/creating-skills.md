---
title: 기술 만들기
x-i18n:
    generated_at: "2026-02-08T16:07:04Z"
    model: gtx
    provider: google-translate
    source_hash: ad801da34fe361ffa584ded47f775d1c104a471a3f7b7f930652255e98945c3a
    source_path: tools/creating-skills.md
    workflow: 15
---

# 맞춤형 기술 만들기 🛠

OpenClaw는 쉽게 확장 가능하도록 설계되었습니다. "기술"은 어시스턴트에 새로운 기능을 추가하는 기본 방법입니다.

## 스킬이란 무엇입니까?

스킬은 다음을 포함하는 디렉터리입니다. `SKILL.md` 파일(LLM에 지침 및 도구 정의 제공) 및 선택적으로 일부 스크립트 또는 리소스.

## 단계별: 첫 번째 기술

### 1. 디렉토리 생성

기술은 일반적으로 작업 공간에 존재합니다. `~/.openclaw/workspace/skills/`. 스킬에 대한 새 폴더를 만듭니다.

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. 정의 `SKILL.md`

만들기 `SKILL.md` 해당 디렉토리에 파일을 넣으세요. 이 파일은 메타데이터에 YAML 앞부분을 사용하고 지침에 Markdown을 사용합니다.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. 도구 추가(선택사항)

서문에서 사용자 정의 도구를 정의하거나 상담원에게 기존 시스템 도구(예: `bash` 또는 `browser`).

### 4. OpenClaw 새로 고침

상담원에게 "기술 새로 고침"을 요청하거나 게이트웨이를 다시 시작하세요. OpenClaw는 새 디렉토리를 발견하고 `SKILL.md`.

## 모범 사례

- **간결하게**: 모델에게 지시합니다. _무엇_ AI가 되는 방법이 아니라 해야 할 일을요.
- **안전 제일**: 스킬을 사용하는 경우 `bash`, 프롬프트에서 신뢰할 수 없는 사용자 입력의 임의 명령 삽입을 허용하지 않는지 확인하세요.
- **로컬에서 테스트**: 사용 `openclaw agent --message "use my new skill"` 테스트합니다.

## 공유 기술

기술을 찾아보고 기여할 수도 있습니다. [클로허브](https://clawhub.com).
