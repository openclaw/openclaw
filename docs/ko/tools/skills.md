---
summary: "Skills: 관리형 vs 워크스페이스, 게이팅 규칙 및 구성/환경 변수 연결"
read_when:
  - Skills 추가 또는 수정
  - Skills 게이팅 또는 로드 규칙 변경
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw 는 에이전트가 도구를 사용하는 방법을 학습하도록 **[AgentSkills](https://agentskills.io) 호환** skill 폴더를 사용합니다. 각 skill 은 YAML 프론트매터와 지침을 포함한 `SKILL.md` 를 담은 디렉토리입니다. OpenClaw 는 **번들된 skills** 와 선택적 로컬 오버라이드를 로드하며, 환경, 설정, 바이너리 존재 여부를 기준으로 로드 시 필터링합니다.

## 위치와 우선순위

Skills 는 **세 곳**에서 로드됩니다:

1. **번들된 skills**: 설치 시 함께 제공됨 (npm 패키지 또는 OpenClaw.app)
2. **관리형/로컬 skills**: `~/.openclaw/skills`
3. **워크스페이스 skills**: `<workspace>/skills`

Skill 이름이 충돌하는 경우 우선순위는 다음과 같습니다:

`<workspace>/skills` (최상위) → `~/.openclaw/skills` → 번들된 skills (최하위)

또한 `~/.openclaw/openclaw.json` 에서 `skills.load.extraDirs` 를 통해 추가 skill 폴더(최하위 우선순위)를 구성할 수 있습니다.

## 에이전트별 vs 공유 skills

**멀티 에이전트** 설정에서는 각 에이전트가 자체 워크스페이스를 가집니다. 즉:

- **에이전트별 skills** 는 해당 에이전트 전용으로 `<workspace>/skills` 에 위치합니다.
- **공유 skills** 는 `~/.openclaw/skills` (관리형/로컬)에 위치하며 동일 머신의 **모든 에이전트** 에 표시됩니다.
- **공유 폴더** 는 여러 에이전트가 사용하는 공통 skills 팩을 원할 경우 `skills.load.extraDirs` 를 통해서도 추가할 수 있습니다(최하위 우선순위).

동일한 skill 이름이 여러 위치에 존재하면 일반적인 우선순위가 적용됩니다: 워크스페이스가 우선, 그다음 관리형/로컬, 마지막으로 번들된 skills 입니다.

## 플러그인 + skills

플러그인은 플러그인 루트를 기준으로 한 경로를 `openclaw.plugin.json` 에 나열하여 자체 skills 를 제공할 수 있습니다(`skills` 디렉토리). 플러그인 skills 는 플러그인이 활성화될 때 로드되며 일반적인 skill 우선순위 규칙에 참여합니다.
플러그인 설정 항목에서 `metadata.openclaw.requires.config` 를 통해 게이팅할 수 있습니다. 검색/구성은 [Plugins](/tools/plugin), 해당 skills 가 가르치는 도구 표면은 [Tools](/tools) 를 참고하십시오.

## ClawHub (설치 + 동기화)

ClawHub 는 OpenClaw 를 위한 공개 skills 레지스트리입니다. [https://clawhub.com](https://clawhub.com) 에서 둘러볼 수 있습니다. Skills 를 발견, 설치, 업데이트, 백업하는 데 사용합니다.
전체 가이드는 [ClawHub](/tools/clawhub) 를 참고하십시오.

일반적인 흐름:

- 워크스페이스에 skill 설치:
  - `clawhub install <skill-slug>`
- 설치된 모든 skills 업데이트:
  - `clawhub update --all`
- 동기화(스캔 + 업데이트 게시):
  - `clawhub sync --all`

기본적으로 `clawhub` 는 현재 작업 디렉토리 아래의 `./skills` 에 설치합니다(또는 구성된 OpenClaw 워크스페이스로 폴백). OpenClaw 는 다음 세션에서 이를 `<workspace>/skills` 로 인식합니다.

## 보안 참고 사항

- 서드파티 skills 는 **신뢰되지 않은 코드** 로 취급하십시오. 활성화 전에 내용을 확인하십시오.
- 신뢰되지 않은 입력과 위험한 도구에는 샌드박스 실행을 선호하십시오. [Sandboxing](/gateway/sandboxing) 을 참고하십시오.
- `skills.entries.*.env` 와 `skills.entries.*.apiKey` 는 해당 에이전트 턴 동안 **호스트** 프로세스에 시크릿을 주입합니다(샌드박스 아님). 프롬프트와 로그에 시크릿을 남기지 마십시오.
- 더 넓은 위협 모델과 체크리스트는 [Security](/gateway/security) 를 참고하십시오.

## 형식 (AgentSkills + Pi 호환)

`SKILL.md` 는 최소한 다음을 포함해야 합니다:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

참고 사항:

- 레이아웃과 의도는 AgentSkills 사양을 따릅니다.
- 내장 에이전트가 사용하는 파서는 **단일 라인** 프론트매터 키만 지원합니다.
- `metadata` 는 **단일 라인 JSON 객체** 여야 합니다.
- 지침에서 skill 폴더 경로를 참조하려면 `{baseDir}` 를 사용하십시오.
- 선택적 프론트매터 키:
  - `homepage` — macOS Skills UI 에서 “Website” 로 표시되는 URL (`metadata.openclaw.homepage` 를 통해서도 지원).
  - `user-invocable` — `true|false` (기본값: `true`). `true` 일 때 skill 이 사용자 슬래시 명령으로 노출됩니다.
  - `disable-model-invocation` — `true|false` (기본값: `false`). `true` 일 때 skill 이 모델 프롬프트에서 제외됩니다(사용자 호출로는 계속 사용 가능).
  - `command-dispatch` — `tool` (선택). `tool` 로 설정되면 슬래시 명령이 모델을 우회하여 도구로 직접 디스패치됩니다.
  - `command-tool` — `command-dispatch: tool` 가 설정되었을 때 호출할 도구 이름.
  - `command-arg-mode` — `raw` (기본값). 도구 디스패치 시 원시 인자 문자열을 도구로 전달합니다(코어 파싱 없음).

    도구는 다음 파라미터로 호출됩니다:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## 게이팅 (로드 시 필터)

OpenClaw 는 `metadata` (단일 라인 JSON) 을 사용하여 **로드 시 skills 를 필터링** 합니다:

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

`metadata.openclaw` 하위 필드:

- `always: true` — 항상 skill 을 포함합니다(다른 게이트 무시).
- `emoji` — macOS Skills UI 에서 사용하는 선택적 이모지.
- `homepage` — macOS Skills UI 에서 “Website” 로 표시되는 선택적 URL.
- `os` — 선택적 플랫폼 목록 (`darwin`, `linux`, `win32`). 설정 시 해당 OS 에서만 skill 이 유효합니다.
- `requires.bins` — 목록; 각각 `PATH` 에 존재해야 합니다.
- `requires.anyBins` — 목록; 최소 하나가 `PATH` 에 존재해야 합니다.
- `requires.env` — 목록; 환경 변수가 존재 **하거나** 설정에 제공되어야 합니다.
- `requires.config` — 참이어야 하는 `openclaw.json` 경로 목록.
- `primaryEnv` — `skills.entries.<name>.apiKey` 와 연관된 환경 변수 이름.
- `install` — macOS Skills UI 에서 사용하는 선택적 설치 관리자 스펙 배열 (brew/node/go/uv/download).

샌드박스 관련 참고:

- `requires.bins` 는 skill 로드 시 **호스트** 에서 확인됩니다.
- 에이전트가 샌드박스화되어 있으면 해당 바이너리는 **컨테이너 내부** 에도 존재해야 합니다.
  `agents.defaults.sandbox.docker.setupCommand` (또는 커스텀 이미지) 를 통해 설치하십시오.
  `setupCommand` 는 컨테이너 생성 후 한 번 실행됩니다.
  패키지 설치에는 네트워크 이그레스, 쓰기 가능한 루트 FS, 샌드박스의 루트 사용자도 필요합니다.
  예: `summarize` skill (`skills/summarize/SKILL.md`) 은 샌드박스 컨테이너에서 실행하려면 `summarize` CLI 가 필요합니다.

설치 관리자 예시:

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

참고 사항:

- 여러 설치 관리자가 나열된 경우 게이트웨이는 **하나의** 선호 옵션을 선택합니다(가능하면 brew, 아니면 node).
- 모든 설치 관리자가 `download` 인 경우 OpenClaw 는 사용 가능한 아티팩트를 볼 수 있도록 각 항목을 나열합니다.
- 설치 관리자 스펙에는 플랫폼별로 옵션을 필터링하기 위한 `os: ["darwin"|"linux"|"win32"]` 를 포함할 수 있습니다.
- Node 설치는 `openclaw.json` 의 `skills.install.nodeManager` 를 준수합니다(기본값: npm; 옵션: npm/pnpm/yarn/bun).
  이는 **skill 설치** 에만 영향을 미치며, Gateway 런타임은 여전히 Node 여야 합니다
  (WhatsApp/Telegram 에서는 Bun 을 권장하지 않습니다).
- Go 설치: `go` 가 없고 `brew` 가 사용 가능하면, 게이트웨이는 먼저 Homebrew 를 통해 Go 를 설치하고 가능한 경우 `GOBIN` 를 Homebrew 의 `bin` 로 설정합니다.
- 다운로드 설치: `url` (필수), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (기본값: 아카이브 감지 시 auto), `stripComponents`, `targetDir` (기본값: `~/.openclaw/tools/<skillKey>`).

`metadata.openclaw` 가 없으면 해당 skill 은 항상 유효합니다(설정에서 비활성화되거나 번들된 skills 에 대해 `skills.allowBundled` 로 차단되지 않는 한).

## 설정 오버라이드 (`~/.openclaw/openclaw.json`)

번들/관리형 skills 는 토글하고 환경 값들을 제공할 수 있습니다:

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

참고: skill 이름에 하이픈이 포함된 경우 키를 따옴표로 감싸십시오(JSON5 는 따옴표 키를 허용합니다).

설정 키는 기본적으로 **skill 이름** 과 일치합니다. Skill 이
`metadata.openclaw.skillKey` 를 정의하는 경우, `skills.entries` 아래에서 해당 키를 사용하십시오.

규칙:

- `enabled: false` 는 번들/설치되어 있어도 skill 을 비활성화합니다.
- `env`: 변수가 프로세스에 이미 설정되어 있지 **않은 경우에만** 주입됩니다.
- `apiKey`: `metadata.openclaw.primaryEnv` 를 선언하는 skills 를 위한 편의 기능입니다.
- `config`: 커스텀 per-skill 필드를 위한 선택적 컨테이너이며, 커스텀 키는 반드시 여기에 위치해야 합니다.
- `allowBundled`: **번들된** skills 전용 선택적 허용 목록입니다. 설정 시 목록에 있는 번들된 skills 만 유효합니다(관리형/워크스페이스 skills 는 영향 없음).

## 환경 주입 (에이전트 실행별)

에이전트 실행이 시작되면 OpenClaw 는 다음을 수행합니다:

1. skill 메타데이터를 읽습니다.
2. `process.env` 에 대해 `skills.entries.<key>.env` 또는 `skills.entries.<key>.apiKey` 를 적용합니다.
3. **유효한** skills 로 시스템 프롬프트를 구성합니다.
4. 실행이 끝나면 원래 환경을 복원합니다.

이는 전역 셸 환경이 아니라 **에이전트 실행 범위** 로 한정됩니다.

## 세션 스냅샷 (성능)

OpenClaw 는 **세션 시작 시** 유효한 skills 를 스냅샷으로 저장하고, 동일 세션의 이후 턴에서 해당 목록을 재사용합니다. Skills 나 설정 변경은 다음 새 세션에서 적용됩니다.

Skills watcher 가 활성화되어 있거나 새로운 유효한 원격 노드가 나타나면 세션 중에도 새로 고칠 수 있습니다(아래 참조). 이는 **핫 리로드** 로 생각할 수 있으며, 갱신된 목록은 다음 에이전트 턴에서 적용됩니다.

## 원격 macOS 노드 (Linux Gateway)

Gateway 가 Linux 에서 실행 중이지만 **macOS 노드** 가 **`system.run` 허용 상태** 로 연결되어 있는 경우(Exec approvals 보안이 `deny` 로 설정되지 않음), OpenClaw 는 해당 노드에 필요한 바이너리가 존재하면 macOS 전용 skills 를 유효한 것으로 처리할 수 있습니다. 에이전트는 이러한 skills 를 `nodes` 도구(일반적으로 `nodes.run`) 를 통해 실행해야 합니다.

이는 노드가 명령 지원을 보고하고 `system.run` 를 통한 바이너리 프로브에 의존합니다. 이후 macOS 노드가 오프라인이 되더라도 skills 는 계속 표시되며, 노드가 다시 연결될 때까지 호출이 실패할 수 있습니다.

## Skills watcher (자동 새로 고침)

기본적으로 OpenClaw 는 skill 폴더를 감시하고 `SKILL.md` 파일이 변경되면 skills 스냅샷을 갱신합니다. `skills.load` 에서 이를 구성할 수 있습니다:

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

## 토큰 영향 (skills 목록)

Skills 가 유효하면 OpenClaw 는 사용 가능한 skills 의 간결한 XML 목록을 시스템 프롬프트에 주입합니다(`pi-coding-agent` 의 `formatSkillsForPrompt` 를 통해). 비용은 결정적입니다:

- **기본 오버헤드 (skill 이 1개 이상일 때만):** 195 문자.
- **skill 당:** 97 문자 + XML 이스케이프된 `<name>`, `<description>`, `<location>` 값의 길이.

공식(문자 수):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

참고 사항:

- XML 이스케이프는 `& < > " '` 을 엔티티(`&amp;`, `&lt;` 등)로 확장하여 길이가 증가합니다.
- 토큰 수는 모델 토크나이저에 따라 달라집니다. OpenAI 스타일의 대략적인 추정치는 ~4 문자/토큰이므로 **97 문자 ≈ 24 토큰** (skill 당) + 실제 필드 길이입니다.

## 관리형 skills 수명주기

OpenClaw 는 설치의 일부로 **번들된 skills** 의 기본 세트를 제공합니다(npm 패키지 또는 OpenClaw.app). 로컬 오버라이드를 위해 `~/.openclaw/skills` 가 존재합니다(예: 번들 사본을 변경하지 않고 skill 을 고정/패치). 워크스페이스 skills 는 사용자가 소유하며 이름 충돌 시 둘 다를 오버라이드합니다.

## 설정 참조

전체 구성 스키마는 [Skills config](/tools/skills-config) 를 참고하십시오.

## 더 많은 skills 를 찾고 계신가요?

[https://clawhub.com](https://clawhub.com) 를 둘러보십시오.

---
