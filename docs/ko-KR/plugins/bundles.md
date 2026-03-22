---
summary: "Codex, Claude, Cursor 번들을 OpenClaw 플러그인으로 설치 및 사용"
read_when:
  - Codex, Claude 또는 Cursor 호환 번들을 설치하고 싶을 때
  - OpenClaw 이 번들 콘텐츠를 네이티브 기능에 매핑하는 방법을 이해해야 할 때
  - 번들 감지 또는 누락된 기능을 디버깅할 때
title: "플러그인 번들"
x-i18n:
  source_path: docs/plugins/bundles.md
---

# 플러그인 번들

OpenClaw 은 세 가지 외부 에코시스템의 플러그인을 설치할 수 있습니다: **Codex**, **Claude**, **Cursor**. 이들은 **번들** — OpenClaw 이 Skills, 훅, MCP 도구와 같은 네이티브 기능에 매핑하는 콘텐츠 및 메타데이터 팩입니다.

<Info>
  번들은 네이티브 OpenClaw 플러그인과 **다릅니다**. 네이티브 플러그인은 프로세스 내에서 실행되며 모든 기능을 등록할 수 있습니다. 번들은 선택적 기능 매핑과 더 좁은 신뢰 경계를 가진 콘텐츠 팩입니다.
</Info>

## 번들이 존재하는 이유

많은 유용한 플러그인이 Codex, Claude 또는 Cursor 형식으로 게시됩니다. 저자가 네이티브 OpenClaw 플러그인으로 다시 작성하도록 요구하는 대신, OpenClaw 은 이러한 형식을 감지하고 지원되는 콘텐츠를 네이티브 기능 세트에 매핑합니다. 이는 Claude 명령 팩이나 Codex Skill 번들을 설치하고 즉시 사용할 수 있음을 의미합니다.

## 번들 설치

<Steps>
  <Step title="디렉토리, 아카이브 또는 마켓플레이스에서 설치">
    ```bash
    # 로컬 디렉토리
    openclaw plugins install ./my-bundle

    # 아카이브
    openclaw plugins install ./my-bundle.tgz

    # Claude 마켓플레이스
    openclaw plugins marketplace list <marketplace-name>
    openclaw plugins install <plugin-name>@<marketplace-name>
    ```

  </Step>

  <Step title="감지 확인">
    ```bash
    openclaw plugins list
    openclaw plugins inspect <id>
    ```

    번들은 `codex`, `claude` 또는 `cursor`의 하위 유형과 함께 `Format: bundle`로 표시됩니다.

  </Step>

  <Step title="재시작 및 사용">
    ```bash
    openclaw gateway restart
    ```

    매핑된 기능 (Skills, 훅, MCP 도구) 은 다음 세션에서 사용할 수 있습니다.

  </Step>
</Steps>

## OpenClaw 이 번들에서 매핑하는 것

모든 번들 기능이 현재 OpenClaw 에서 실행되는 것은 아닙니다. 작동하는 것과 감지되었지만 아직 연결되지 않은 것은 다음과 같습니다.

### 현재 지원됨

| 기능         | 매핑 방법                                                                          | 적용 대상      |
| ------------ | ---------------------------------------------------------------------------------- | -------------- |
| Skill 콘텐츠 | 번들 Skill 루트가 일반 OpenClaw Skills 로 로드됨                                   | 모든 형식      |
| 명령         | `commands/` 및 `.cursor/commands/`가 Skill 루트로 처리됨                           | Claude, Cursor |
| 훅 팩        | OpenClaw 스타일 `HOOK.md` + `handler.ts` 레이아웃                                  | Codex          |
| MCP 도구     | 번들 MCP 설정이 내장 Pi 설정에 병합됨; 지원되는 stdio 서버가 서브프로세스로 실행됨 | 모든 형식      |
| 설정         | Claude `settings.json`이 내장 Pi 기본값으로 가져옴                                 | Claude         |

### 감지되었지만 실행되지 않음

이들은 인식되고 진단에 표시되지만 OpenClaw 이 실행하지 않습니다:

- Claude `agents`, `hooks.json` 자동화, `lspServers`, `outputStyles`
- Cursor `.cursor/agents`, `.cursor/hooks.json`, `.cursor/rules`
- Codex 기능 보고를 넘어선 인라인/앱 메타데이터

## 번들 형식

<AccordionGroup>
  <Accordion title="Codex 번들">
    마커: `.codex-plugin/plugin.json`

    선택적 콘텐츠: `skills/`, `hooks/`, `.mcp.json`, `.app.json`

    Codex 번들은 Skill 루트와 OpenClaw 스타일 훅 팩 디렉토리 (`HOOK.md` + `handler.ts`) 를 사용할 때 OpenClaw 에 가장 잘 맞습니다.

  </Accordion>

  <Accordion title="Claude 번들">
    두 가지 감지 모드:

    - **매니페스트 기반:** `.claude-plugin/plugin.json`
    - **매니페스트 없음:** 기본 Claude 레이아웃 (`skills/`, `commands/`, `agents/`, `hooks/`, `.mcp.json`, `settings.json`)

    Claude 전용 동작:

    - `commands/`는 Skill 콘텐츠로 처리됨
    - `settings.json`은 내장 Pi 설정으로 가져옴 (셸 재정의 키는 정제됨)
    - `.mcp.json`은 지원되는 stdio 도구를 내장 Pi 에 노출
    - `hooks/hooks.json`은 감지되지만 실행되지 않음
    - 매니페스트의 커스텀 컴포넌트 경로는 추가적임 (기본값을 대체하지 않고 확장)

  </Accordion>

  <Accordion title="Cursor 번들">
    마커: `.cursor-plugin/plugin.json`

    선택적 콘텐츠: `skills/`, `.cursor/commands/`, `.cursor/agents/`, `.cursor/rules/`, `.cursor/hooks.json`, `.mcp.json`

    - `.cursor/commands/`는 Skill 콘텐츠로 처리됨
    - `.cursor/rules/`, `.cursor/agents/`, `.cursor/hooks.json`은 감지만 됨

  </Accordion>
</AccordionGroup>

## 보안

번들은 네이티브 플러그인보다 더 좁은 신뢰 경계를 가집니다:

- OpenClaw 은 프로세스 내에서 임의의 번들 런타임 모듈을 로드하지 **않습니다**
- Skills 및 훅 팩 경로는 플러그인 루트 내에 있어야 합니다 (경계 확인됨)
- 설정 파일은 동일한 경계 확인으로 읽힘
- 지원되는 stdio MCP 서버는 서브프로세스로 실행될 수 있음

이로 인해 번들은 기본적으로 더 안전하지만, 노출하는 기능에 대해서는 서드파티 번들을 신뢰할 수 있는 콘텐츠로 취급해야 합니다.

## 관련 문서

- [플러그인 설치 및 구성](/tools/plugin)
- [플러그인 만들기](/plugins/building-plugins) — 네이티브 플러그인 만들기
- [플러그인 매니페스트](/plugins/manifest) — 네이티브 매니페스트 스키마
