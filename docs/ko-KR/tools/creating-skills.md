---
title: "Skills 만들기"
summary: "SKILL.md 를 사용한 커스텀 워크스페이스 Skills 빌드 및 테스트"
read_when:
  - 워크스페이스에서 새 커스텀 Skill 을 만들 때
  - SKILL.md 기반 Skills 의 빠른 시작 워크플로가 필요할 때
x-i18n:
  source_path: docs/tools/creating-skills.md
---

# Skills 만들기

Skills 는 에이전트에게 도구를 언제 어떻게 사용하는지 가르칩니다. 각 Skill 은 YAML 프론트매터와 마크다운 지시사항이 포함된 `SKILL.md` 파일을 포함하는 디렉토리입니다.

Skills 가 로드되고 우선순위가 지정되는 방식은 [Skills](/tools/skills)를 참조하세요.

## 첫 번째 Skill 만들기

<Steps>
  <Step title="Skill 디렉토리 생성">
    Skills 는 워크스페이스에 있습니다. 새 폴더를 만듭니다:

    ```bash
    mkdir -p ~/.openclaw/workspace/skills/hello-world
    ```

  </Step>

  <Step title="SKILL.md 작성">
    해당 디렉토리에 `SKILL.md`를 만듭니다. 프론트매터는 메타데이터를 정의하고,
    마크다운 본문은 에이전트를 위한 지시사항을 포함합니다.

    ```markdown
    ---
    name: hello_world
    description: A simple skill that says hello.
    ---

    # Hello World Skill

    When the user asks for a greeting, use the `echo` tool to say
    "Hello from your custom skill!".
    ```

  </Step>

  <Step title="도구 추가 (선택사항)">
    프론트매터에 커스텀 도구 스키마를 정의하거나 에이전트에게 기존 시스템 도구 (`exec` 또는 `browser` 등) 를 사용하도록 지시할 수 있습니다. Skills 는 문서화하는 도구와 함께 플러그인 내에 배포될 수도 있습니다.

  </Step>

  <Step title="Skill 로드">
    OpenClaw 이 Skill 을 인식하도록 새 세션을 시작합니다:

    ```bash
    # 채팅에서
    /new

    # 또는 Gateway 재시작
    openclaw gateway restart
    ```

    Skill 이 로드되었는지 확인합니다:

    ```bash
    openclaw skills list
    ```

  </Step>

  <Step title="테스트">
    Skill 을 트리거해야 하는 메시지를 보냅니다:

    ```bash
    openclaw agent --message "give me a greeting"
    ```

    또는 에이전트와 채팅하며 인사를 요청합니다.

  </Step>
</Steps>

## Skill 메타데이터 참조

YAML 프론트매터는 다음 필드를 지원합니다:

| 필드                                | 필수   | 설명                                   |
| ----------------------------------- | ------ | -------------------------------------- |
| `name`                              | 예     | 고유 식별자 (snake_case)               |
| `description`                       | 예     | 에이전트에게 표시되는 한 줄 설명       |
| `metadata.openclaw.os`              | 아니오 | OS 필터 (`["darwin"]`, `["linux"]` 등) |
| `metadata.openclaw.requires.bins`   | 아니오 | PATH 에 필요한 바이너리                |
| `metadata.openclaw.requires.config` | 아니오 | 필요한 설정 키                         |

## 모범 사례

- **간결하게** — AI 가 되는 방법이 아닌 _무엇을_ 해야 하는지를 모델에 지시합니다
- **안전 우선** — Skill 이 `exec`를 사용하는 경우 신뢰할 수 없는 입력에서 임의 명령 삽입을 허용하지 않도록 프롬프트를 확인합니다
- **로컬 테스트** — 공유 전에 `openclaw agent --message "..."`로 테스트합니다
- **ClawHub 사용** — [ClawHub](https://clawhub.com) 에서 Skills 를 탐색하고 기여합니다

## Skills 위치

| 위치                         | 우선순위 | 범위                 |
| ---------------------------- | -------- | -------------------- |
| `\<workspace\>/skills/`      | 최고     | 에이전트별           |
| `~/.openclaw/skills/`        | 중간     | 공유 (모든 에이전트) |
| 번들 (OpenClaw 와 함께 배포) | 최저     | 전역                 |
| `skills.load.extraDirs`      | 최저     | 커스텀 공유 폴더     |

## 관련 문서

- [Skills 참조](/tools/skills) — 로딩, 우선순위 및 게이팅 규칙
- [Skills 구성](/tools/skills-config) — `skills.*` 설정 스키마
- [ClawHub](/tools/clawhub) — 공개 Skill 레지스트리
- [플러그인 만들기](/plugins/building-plugins) — 플러그인은 Skills 를 배포할 수 있습니다
