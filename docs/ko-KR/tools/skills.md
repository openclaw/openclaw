---
summary: "스킬: 관리형 대 작업공간, 게이트 규칙, 및 구성/환경 변수 연결"
read_when:
  - 스킬 추가 또는 수정
  - 스킬 게이트 또는 로드 규칙 변경
title: "스킬"
---

# 스킬 (OpenClaw)

OpenClaw는 에이전트에게 도구를 사용하는 방법을 가르치기 위해 **[AgentSkills](https://agentskills.io) 호환** 스킬 폴더를 사용합니다. 각 스킬은 YAML 전면 사항과 지침이 포함된 `SKILL.md`를 포함하는 디렉터리입니다. OpenClaw는 **번들 스킬**과 선택적인 로컬 오버라이드를 로드하며, 환경, 구성 및 바이너리 존재에 따라 로드 시점에 필터링합니다.

## 스킬 위치 및 우선순위

스킬은 **세** 곳에서 로드됩니다:

1. **번들 스킬**: 설치와 함께 제공됨 (npm 패키지 또는 OpenClaw.app)
2. **관리형/로컬 스킬**: `~/.openclaw/skills`
3. **작업공간 스킬**: `<workspace>/skills`

스킬 이름이 충돌하는 경우, 우선순위는 다음과 같습니다:

`<workspace>/skills` (최고) → `~/.openclaw/skills` → 번들 스킬 (최소)

또한, 추가 스킬 폴더(최소 우선순위)는 `~/.openclaw/openclaw.json`의 `skills.load.extraDirs`를 통해 구성할 수 있습니다.

## 개별 에이전트 대 공유 스킬

**다중 에이전트** 설정에서는 각 에이전트가 자신의 작업공간을 가지고 있습니다. 이는 다음을 의미합니다:

- **개별 에이전트 스킬**은 해당 에이전트만을 위한 `<workspace>/skills` 내에 존재합니다.
- **공유 스킬**은 `~/.openclaw/skills` (관리형/로컬)에 존재하며 같은 머신의 **모든 에이전트**에게 표시됩니다.
- **공유 폴더**는 여러 에이전트에서 사용되는 공통 스킬 팩이 필요하다면 `skills.load.extraDirs`를 통해 추가할 수 있습니다 (최소 우선순위).

동일한 스킬 이름이 여러 곳에 존재한다면, 일반적인 우선순위가 적용됩니다: 작업공간이 우선, 그 다음은 관리형/로컬, 그 다음은 번들.

## 플러그인 + 스킬

플러그인은 `openclaw.plugin.json`에서 `skills` 디렉터리를 나열하여 자체 스킬을 포함할 수 있습니다 (플러그인 루트에 상대적인 경로). 플러그인 스킬은 플러그인이 활성화되면 로드되며 일반적인 스킬 우선순위 규칙에 따라 동작합니다. 플러그인의 구성 항목에 있는 `metadata.openclaw.requires.config`로 게이트할 수 있습니다. 탐색/구성은 [플러그인](/ko-KR/tools/plugin)을, 에이전트에게 가르칠 도구 표면은 [도구](/ko-KR/tools)를 참조하십시오.

## ClawHub (설치 + 동기화)

ClawHub는 OpenClaw의 공개 스킬 레지스트리입니다. [https://clawhub.com](https://clawhub.com)을 방문하여 스킬을 검색, 설치, 업데이트 및 백업할 수 있습니다. 전체 가이드는: [ClawHub](/ko-KR/tools/clawhub)를 참조하십시오.

일반적인 흐름:

- 작업공간에 스킬 설치:
  - `clawhub install <skill-slug>`
- 모든 설치된 스킬 업데이트:
  - `clawhub update --all`
- 동기화 (스캔 + 업데이트 게시):
  - `clawhub sync --all`

기본적으로, `clawhub`는 현재 작업 디렉터리 아래의 `./skills`에 설치됩니다 (또는 구성된 OpenClaw 작업공간에 대체됩니다). OpenClaw는 다음 세션에서 `<workspace>/skills`로 이를 픽업합니다.

## 보안 주의사항

- 타사 스킬을 **신뢰할 수 없는 코드**로 취급하십시오. 사용 전에 읽어보십시오.
- 신뢰할 수 없는 입력과 위험한 도구에 대해 샌드박스 격리 실행을 선호하십시오. [샌드박스 격리](/ko-KR/gateway/sandboxing)를 참조하십시오.
- `skills.entries.*.env` 및 `skills.entries.*.apiKey`는 **호스트** 프로세스에 비밀을 주입합니다 (샌드박스가 아님). 비밀은 프롬프트와 로그에서 제외하십시오.
- 더 넓은 위협 모델 및 체크리스트는 [보안](/ko-KR/gateway/security)을 참조하십시오.

## 형식 (AgentSkills + Pi 호환)

`SKILL.md`는 최소한 다음을 포함해야 합니다:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

노트:

- 레이아웃/의도에 대해 AgentSkills 명세를 따릅니다.
- 포함된 에이전트가 사용하는 파서는 **단일 줄** 전면 키만 지원합니다.
- `metadata`는 **단일 줄 JSON 객체**로 작성해야 합니다.
- 스킬 폴더 경로를 참조하는 지침에는 `{baseDir}`을 사용하십시오.
- 선택적 전면 키:
  - `homepage` — macOS 스킬 UI에서 “Website”로 표시되는 URL (또한 `metadata.openclaw.homepage`로 지원됨).
  - `user-invocable` — `true|false` (기본값: `true`). `true`일 경우, 스킬은 사용자 슬래시 명령어로 노출됩니다.
  - `disable-model-invocation` — `true|false` (기본값: `false`). `true`일 경우, 스킬은 모델 프롬프트에서 제외됩니다 (여전히 사용자 호출 가능).
  - `command-dispatch` — `tool` (선택적). `tool`로 설정된 경우, 슬래시 명령어는 모델을 우회하고 도구로 직접 전달됩니다.
  - `command-tool` — `command-dispatch: tool`이 설정된 경우 호출할 도구 이름.
  - `command-arg-mode` — `raw` (기본값). 도구 전달 시, 원시 인수 문자열을 도구로 전달합니다 (코어 파싱 없음).

    도구 인수로 실행됩니다:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## 게이트 설정 (로드 시 필터)

OpenClaw는 `metadata` (단일 줄 JSON)를 사용하여 **로드 시 스킬을 필터링**합니다:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

`metadata.openclaw` 아래의 필드:

- `always: true` — 항상 스킬을 포함합니다 (다른 게이트를 건너뜀).
- `emoji` — macOS 스킬 UI에서 사용되는 선택적 이모지.
- `homepage` — macOS 스킬 UI에서 “Website”로 표시되는 선택적 URL.
- `os` — 플랫폼의 선택적 목록 (`darwin`, `linux`, `win32`). 설정된 경우, 스킬은 해당 OS에서만 사용할 수 있습니다.
- `requires.bins` — 목록; 각 항목은 `PATH`에 존재해야 합니다.
- `requires.anyBins` — 목록; 최소 하나는 `PATH`에 존재해야 합니다.
- `requires.env` — 목록; 환경 변수는 존재해야 하거나 구성에서 제공되어야 합니다.
- `requires.config` — 진리로 평가되어야 하는 `openclaw.json` 경로의 목록.
- `primaryEnv` — `skills.entries.<name>.apiKey`와 관련된 환경 변수 이름.
- `install` — macOS 스킬 UI에서 사용되는 선택적 설치자 사양 배열 (brew/node/go/uv/download).

샌드박스 격리에 대한 주의사항:

- `requires.bins`는 스킬 로드 시 **호스트**에서 확인됩니다.
- 에이전트가 샌드박스 격리된 경우, 바이너리는 **컨테이너 내부**에도 존재해야 합니다. `agents.defaults.sandbox.docker.setupCommand` 또는 사용자 정의 이미지를 통해 설치합니다. `setupCommand`는 컨테이너 생성 후 한 번 실행됩니다. 패키지 설치는 또한 네트워크 전송, 쓰기 가능한 루트 파일 시스템 및 샌드박스 내의 루트 사용자가 필요합니다. 예: `summarize` 스킬 (`skills/summarize/SKILL.md`)은 샌드박스 컨테이너 내에서 실행해야 하는 `summarize` CLI가 필요합니다.

설치자 예시:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

노트:

- 여러 설치자가 나열된 경우, 게이트웨이는 **하나의** 선호 옵션을 선택합니다 (brew 사용 가능 시, 그렇지 않으면 node).
- 모든 설치자가 `download`인 경우, OpenClaw는 각 항목을 나열하여 사용 가능한 아티팩트를 확인할 수 있습니다.
- 설치자 사양은 플랫폼에 따라 옵션을 필터링하기 위해 `os: ["darwin"|"linux"|"win32"]`를 포함할 수 있습니다.
- 노드 설치는 `openclaw.json`의 `skills.install.nodeManager`를 따릅니다 (기본값: npm; 옵션: npm/pnpm/yarn/bun). 이것은 **스킬 설치**에만 영향을 미칩니다; 게이트웨이 런타임은 여전히 노드여야 합니다 (WhatsApp/Telegram에는 Bun이 권장되지 않음).
- Go 설치: `go`가 없고 `brew`가 사용 가능할 때, 게이트웨이는 Homebrew를 통해 Go를 먼저 설치하고 가능한 경우 Homebrew의 `bin`으로 `GOBIN`을 설정합니다.
- 다운로드 설치: `url` (필수), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (기본값: 아카이브 감지 시 자동), `stripComponents`, `targetDir` (기본값: `~/.openclaw/tools/<skillKey>`).

`metadata.openclaw`가 없는 경우, 스킬은 항상 자격이 있습니다 (구성에서 비활성화되었거나 번들 스킬에 대해 `skills.allowBundled`에 의해 차단되지 않은 한).

## 구성 오버라이드 (`~/.openclaw/openclaw.json`)

번들/관리형 스킬은 전환 가능하며 환경 값을 제공할 수 있습니다:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

참고: 스킬 이름에 하이픈이 포함된 경우, 키를 인용하십시오 (JSON5에서 인용된 키 허용).

구성 키는 기본적으로 **스킬 이름**과 일치합니다. 스킬이 `metadata.openclaw.skillKey`를 정의하면 `skills.entries` 아래에 해당 키를 사용합니다.

규칙:

- `enabled: false`는 스킬을 번들 또는 설치되어 있더라도 비활성화합니다.
- `env`: 프로세스에 이미 설정되어 있지 않은 경우에만 주입됩니다.
- `apiKey`: `metadata.openclaw.primaryEnv`를 선언하는 스킬용 편리 기능.
- `config`: 사용자 지정 필드를 위한 선택적 가방; 사용자 지정 키는 여기에 있어야 합니다.
- `allowBundled`: **번들** 스킬에만 해당하는 선택적 허용 목록. 설정된 경우, 목록에 있는 번들 스킬만 자격이 있습니다 (관리형/작업공간 스킬은 영향받지 않음).

## 환경 주입 (에이전트 실행당)

에이전트 실행이 시작되면, OpenClaw는:

1. 스킬 메타데이터를 읽습니다.
2. `skills.entries.<key>.env` 또는 `skills.entries.<key>.apiKey`를 `process.env`에 적용합니다.
3. **자격있는** 스킬로 시스템 프롬프트를 구축합니다.
4. 실행이 종료된 후 원래 환경을 복원합니다.

이는 **에이전트 실행에만 스코프를 설정**하며, 글로벌 셸 환경은 아닙니다.

## 세션 스냅샷 (성능)

OpenClaw는 **세션이 시작될 때** 자격 있는 스킬을 스냅샷하고 같은 세션의 후속 턴에 대해 그 목록을 재사용합니다. 스킬이나 구성에 대한 변경 사항은 다음 새 세션에 적용됩니다.

스킬은 스킬 감시자가 활성화되거나 새로운 자격 있는 원격 노드가 나타날 때 세션 중간에도 새로고침될 수 있습니다 (아래 참조). 이를 **핫 리로드**로 생각하십시오: 새로 업데이트된 목록은 다음 에이전트 턴에 적용됩니다.

## 원격 macOS 노드 (Linux 게이트웨이)

게이트웨이가 Linux에서 실행 중이고 **`system.run`이 허용된** (Exec 승인 보안이 `deny`로 설정되지 않음) **macOS 노드**가 연결된 경우, OpenClaw는 해당 노드에 필요한 바이너리가 있는 경우 macOS 전용 스킬을 자격 있는 것으로 처리할 수 있습니다. 에이전트는 일반적으로 `nodes.run`을 통해 해당 스킬을 실행해야 합니다.

이 노드는 자신의 명령어 지원을 보고하고 `system.run`을 통해 바이너리 검사를 수행해야 합니다. macOS 노드가 나중에 오프라인으로 전환되면 스킬은 여전히 ​​표시됩니다; 노드가 다시 연결될 때까지 호출이 실패할 수 있습니다.

## 스킬 감시자 (자동 새로고침)

기본적으로, OpenClaw는 스킬 폴더를 감시하며 `SKILL.md` 파일이 변경될 때 스킬 스냅샷을 갱신합니다. 이는 `skills.load`에서 구성할 수 있습니다:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## 토큰 영향 (스킬 목록)

스킬이 자격이 있는 경우, OpenClaw는 `pi-coding-agent`의 `formatSkillsForPrompt`를 통해 시스템 프롬프트에 사용 가능한 스킬의 압축된 XML 목록을 주입합니다. 비용은 결정적입니다:

- **기본 오버헤드 (≥1 스킬일 때만):** 195자.
- **스킬별:** 97자 + XML-이스케이프된 `<name>`, `<description>`, `<location>` 값의 길이.

공식 (문자):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

참고 사항:

- XML 이스케이핑은 `& < > " '`를 엔티티 (`&amp;`, `&lt;`, 등)로 확장하여 길이를 늘립니다.
- 모델 토크나이저에 따라 토큰 수가 다릅니다. 대략적인 OpenAI 스타일 추정치는 ~4자/토큰으로, **97자 ≈ 24 토큰**이며 실제 필드 길이가 추가됩니다.

## 관리형 스킬 수명주기

OpenClaw는 설치 (npm 패키지 또는 OpenClaw.app)의 일부로 **번들 스킬**의 기본 세트를 제공합니다. `~/.openclaw/skills`는 로컬 오버라이드를 위한 것이 존재합니다 (예: 번들 복사본을 변경하지 않고 스킬 고정/패치). 작업 공간 스킬은 사용자가 소유하며 이름 충돌 시 둘 다 우선합니다.

## 구성 참조

전체 구성 스키마는 [스킬 설정](/ko-KR/tools/skills-config)을 참조하십시오.

## 추가 스킬을 찾고 계십니까?

[https://clawhub.com](https://clawhub.com)를 둘러보세요.