---
summary: "Skills: managed vs workspace, gating rules, and config/env wiring"
read_when:
  - Adding or modifying skills
  - Changing skill gating or load rules
title: "Skills"
x-i18n:
  source_hash: 70d7eb9e422c17a4f1443688585bdfbcb086b4890bd13eb652bcf5eb10fdd447
---

# 스킬(오픈클로)

OpenClaw는 **[AgentSkills](https://agentskills.io) 호환** 스킬 폴더를 사용하여 에이전트에게 도구 사용 방법을 가르칩니다. 각 스킬은 YAML 머리말과 지침이 포함된 `SKILL.md`을 포함하는 디렉터리입니다. OpenClaw는 **번들 기술**과 선택적 로컬 재정의를 로드하고 로드 시 환경, 구성, 바이너리 존재 여부에 따라 필터링합니다.

## 위치 및 우선순위

스킬은 **세 곳**에서 로드됩니다.

1. **번들 기술**: 설치와 함께 제공됩니다(npm 패키지 또는 OpenClaw.app)
2. **관리형/로컬 스킬**: `~/.openclaw/skills`
3. **작업 공간 기술**: `<workspace>/skills`

스킬 이름이 충돌하는 경우 우선 순위는 다음과 같습니다.

`<workspace>/skills` (최고) → `~/.openclaw/skills` → 번들 스킬 (최저)

또한 다음을 통해 추가 기술 폴더(최하위 우선 순위)를 구성할 수 있습니다.
`skills.load.extraDirs` `~/.openclaw/openclaw.json`에 있습니다.

## 에이전트별 기술과 공유 기술 비교

**다중 에이전트** 설정에서는 각 에이전트마다 고유한 작업 공간이 있습니다. 이는 다음을 의미합니다.

- **에이전트별 스킬**은 해당 에이전트에 대해서만 `<workspace>/skills`에 있습니다.
- **공유 스킬**은 `~/.openclaw/skills`(관리/로컬)에 있으며 표시됩니다.
  동일한 시스템의 **모든 에이전트**에게.
- **공유 폴더**는 `skills.load.extraDirs`를 통해 추가할 수도 있습니다(최저
  우선 순위) 여러 상담원이 사용하는 공통 스킬 팩을 원하는 경우.

동일한 스킬명이 여러 곳에 존재하는 경우, 일반적인 우선순위는 다음과 같습니다.
적용: 작업공간이 우선되고 관리형/로컬이 적용되며 번들로 제공됩니다.

## 플러그인 + 스킬

플러그인은 `skills` 디렉터리를 나열하여 자체 기술을 제공할 수 있습니다.
`openclaw.plugin.json` (플러그인 루트에 상대적인 경로). 플러그인 스킬 로드
플러그인이 활성화되고 일반적인 기술 우선 순위 규칙에 참여할 때.
플러그인 구성의 `metadata.openclaw.requires.config`를 통해 게이트할 수 있습니다.
입장. 검색/구성은 [플러그인](/tools/plugin)을 참조하고, 검색/구성은 [도구](/tools)를 참조하세요.
도구 표면의 기술이 가르쳐줍니다.

## ClawHub(설치 + 동기화)

ClawHub는 OpenClaw용 공개 기술 레지스트리입니다. 찾아보기
[https://clawhub.com](https://clawhub.com). 이를 사용하여 기술을 검색, 설치, 업데이트 및 백업합니다.
전체 가이드: [ClawHub](/tools/clawhub).

일반적인 흐름:

- 작업 공간에 스킬을 설치하십시오.
  - `clawhub install <skill-slug>`
- 설치된 모든 스킬 업데이트:
  - `clawhub update --all`
- 동기화(스캔 + 업데이트 게시):
  - `clawhub sync --all`

기본적으로 `clawhub`는 현재 작업 중인 `./skills`에 설치됩니다.
디렉터리(또는 구성된 OpenClaw 작업 공간으로 대체). OpenClaw 추천
다음 세션에서는 `<workspace>/skills`로 변경됩니다.

## 보안 참고 사항

- 타사 기술을 **신뢰할 수 없는 코드**로 취급합니다. 활성화하기 전에 읽어보십시오.
- 신뢰할 수 없는 입력 및 위험한 도구에 대해서는 샌드박스 실행을 선호합니다. [샌드박싱](/gateway/sandboxing)을 참조하세요.
- `skills.entries.*.env` 및 `skills.entries.*.apiKey`는 **호스트** 프로세스에 비밀을 주입합니다.
  해당 에이전트 차례에 대해(샌드박스 아님) 프롬프트와 로그에서 비밀을 유지하세요.
- 보다 광범위한 위협 모델 및 체크리스트는 [보안](/gateway/security)을 참조하세요.

## 형식(AgentSkills + Pi 호환)

`SKILL.md`에는 최소한 다음이 포함되어야 합니다.

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

참고:

- 레이아웃/의도에 대해서는 AgentSkills 사양을 따릅니다.
- 내장된 에이전트가 사용하는 파서는 **한 줄** 머리글 키만 지원합니다.
- `metadata`는 **한 줄짜리 JSON 객체**여야 합니다.
- 스킬 폴더 경로를 참조하려면 안내에 `{baseDir}`를 사용하세요.
- 선택적인 머리말 키:
  - `homepage` — macOS Skills UI에 "웹사이트"로 표시되는 URL(`metadata.openclaw.homepage`를 통해서도 지원됨)
  - `user-invocable` — `true|false` (기본값: `true`). `true` 시 스킬이 유저 슬래시 명령어로 노출됩니다.
  - `disable-model-invocation` — `true|false` (기본값: `false`). `true`인 경우 해당 스킬은 모델 프롬프트에서 제외됩니다(사용자 호출을 통해 여전히 사용 가능).
  - `command-dispatch` — `tool` (선택 사항). `tool`로 설정하면 슬래시 명령이 모델을 우회하고 도구에 직접 전달됩니다.
  - `command-tool` — `command-dispatch: tool`가 설정될 때 호출할 도구 이름입니다.
  - `command-arg-mode` — `raw` (기본값). 도구 디스패치의 경우 원시 인수 문자열을 도구에 전달합니다(코어 구문 분석 없음).

    이 도구는 매개변수를 사용하여 호출됩니다.
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## 게이팅(로드 시간 필터)

OpenClaw는 `metadata`(한 줄 JSON)을 사용하여 **로드 시 스킬을 필터링**합니다.

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

`metadata.openclaw` 아래 필드:

- `always: true` — 항상 스킬을 포함합니다(다른 게이트 건너뛰기).
- `emoji` — macOS Skills UI에서 사용되는 선택적 이모티콘입니다.
- `homepage` — macOS Skills UI에 "웹사이트"로 표시되는 선택적 URL입니다.
- `os` — 선택적 플랫폼 목록(`darwin`, `linux`, `win32`). 설정된 경우 기술은 해당 OS에서만 사용할 수 있습니다.
- `requires.bins` — 목록; 각각은 `PATH`에 존재해야 합니다.
- `requires.anyBins` — 목록; `PATH`에 적어도 하나는 존재해야 합니다.
- `requires.env` — 목록; env var는 **또는** 구성에 제공되어야 합니다.
- `requires.config` — 진실이어야 하는 `openclaw.json` 경로 목록입니다.
- `primaryEnv` — `skills.entries.<name>.apiKey`와 연관된 환경 변수 이름입니다.
- `install` — macOS Skills UI(brew/node/go/uv/download)에서 사용되는 설치 프로그램 사양의 선택적 배열입니다.

샌드박싱에 대한 참고 사항:

- 스킬 로딩 시 **호스트**에서 `requires.bins`가 체크됩니다.
- 에이전트가 샌드박스 처리된 경우 바이너리도 **컨테이너 내부**에 존재해야 합니다.
  `agents.defaults.sandbox.docker.setupCommand`(또는 사용자 정의 이미지)를 통해 설치하세요.
  `setupCommand`는 컨테이너가 생성된 후 한 번 실행됩니다.
  패키지 설치에는 네트워크 송신, 쓰기 가능한 루트 FS 및 샌드박스의 루트 사용자도 필요합니다.
  예: `summarize` 스킬(`skills/summarize/SKILL.md`)에는 `summarize` CLI가 필요합니다.
  거기에서 실행하려면 샌드박스 컨테이너에 있어야 합니다.

설치 프로그램 예:

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

참고:

- 여러 설치 프로그램이 나열되는 경우 게이트웨이는 **단일** 선호 옵션(사용 가능한 경우 Brew, 그렇지 않은 경우 노드)을 선택합니다.
- 모든 설치 프로그램이 `download`인 경우 OpenClaw는 사용 가능한 아티팩트를 볼 수 있도록 각 항목을 나열합니다.
- 설치 프로그램 사양에는 `os: ["darwin"|"linux"|"win32"]`가 포함되어 플랫폼별로 옵션을 필터링할 수 있습니다.
- 노드는 `openclaw.json`에 `skills.install.nodeManager`를 설치합니다(기본값: npm; 옵션: npm/pnpm/yarn/bun).
  이는 **스킬 설치**에만 영향을 미칩니다. 게이트웨이 런타임은 여전히 노드여야 합니다.
  (WhatsApp/Telegram에서는 Bun을 권장하지 않습니다).
- Go 설치: `go`가 없고 `brew`가 사용 가능한 경우 게이트웨이는 먼저 Homebrew를 통해 Go를 설치하고 가능하면 `GOBIN`를 Homebrew의 `bin`로 설정합니다.
- 다운로드 설치: `url` (필수), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (기본값: 아카이브 감지 시 자동), `stripComponents`, `targetDir` (기본값: `~/.openclaw/tools/<skillKey>`).

`metadata.openclaw`가 없으면 해당 스킬은 항상 적합합니다.
구성에서 비활성화되었거나 번들 스킬의 경우 `skills.allowBundled`에 의해 차단되었습니다.

## 구성 재정의 (`~/.openclaw/openclaw.json`)

번들/관리되는 기술은 env 값으로 전환하고 제공할 수 있습니다.

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

참고: 스킬 이름에 하이픈이 포함된 경우 키를 인용하십시오(JSON5에서는 인용된 키를 허용합니다).

구성 키는 기본적으로 **스킬 이름**과 일치합니다. 스킬이 정의된 경우
`metadata.openclaw.skillKey`, `skills.entries`에서 해당 키를 사용하세요.

규칙:

- `enabled: false`는 번들/설치되어 있어도 스킬을 비활성화합니다.
- `env`: 프로세스에서 변수가 아직 설정되지 않은 **경우에만** 주입됩니다.
- `apiKey` : `metadata.openclaw.primaryEnv` 선언 스킬에 대한 편의성입니다.
- `config`: 맞춤형 스킬별 필드를 위한 선택적 가방입니다. 맞춤 키는 여기에 있어야 합니다.
- `allowBundled`: **번들** 스킬에 대해서만 선택적 허용 목록입니다. 설정된 경우에만
  목록에 있는 번들 기술은 적격합니다(관리/작업 영역 기술은 영향을 받지 않음).

## 환경 주입(에이전트 실행당)

에이전트 실행이 시작되면 OpenClaw는 다음을 수행합니다.

1. 스킬 메타데이터를 읽습니다.
2. `skills.entries.<key>.env` 또는 `skills.entries.<key>.apiKey`를 적용합니다.
   `process.env`.
3. **적격** 기술로 시스템 프롬프트를 구축합니다.
4. 실행 종료 후 원래 환경을 복원합니다.

이는 전역 셸 환경이 아닌 **에이전트 실행으로 범위가 지정됩니다**.

## 세션 스냅샷(성능)

OpenClaw는 **세션이 시작될 때** 적합한 기술의 스냅샷을 찍고 동일한 세션의 후속 턴에 해당 목록을 재사용합니다. 스킬이나 구성에 대한 변경 사항은 다음 새 세션에 적용됩니다.

스킬 감시자가 활성화되거나 새로운 적격 원격 노드가 나타날 때 세션 중에 스킬을 새로 고칠 수도 있습니다(아래 참조). 이를 **핫 리로드**라고 생각하세요. 새로 고친 목록은 다음 에이전트 차례에 선택됩니다.

## 원격 macOS 노드(Linux 게이트웨이)

게이트웨이가 Linux에서 실행 중이지만 **macOS 노드**가 **`system.run` 허용**으로 연결되어 있는 경우(Exec 승인 보안이 `deny`로 설정되지 않음) OpenClaw는 해당 노드에 필요한 바이너리가 있을 때 macOS 전용 기술을 적합한 것으로 처리할 수 있습니다. 에이전트는 `nodes` 도구(일반적으로 `nodes.run`)를 통해 해당 기술을 실행해야 합니다.

이는 명령 지원을 보고하는 노드와 `system.run`를 통한 bin 프로브에 의존합니다. 나중에 macOS 노드가 오프라인이 되어도 기술은 계속 표시됩니다. 노드가 다시 연결될 때까지 호출이 실패할 수 있습니다.

## 스킬 감시자(자동 새로고침)

기본적으로 OpenClaw는 스킬 폴더를 감시하고 `SKILL.md` 파일이 변경되면 스킬 스냅샷을 충돌시킵니다. `skills.load`에서 이를 구성합니다.

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

## 토큰 영향(스킬 목록)

기술이 적격한 경우 OpenClaw는 사용 가능한 기술의 압축 XML 목록을 시스템 프롬프트에 삽입합니다(`pi-coding-agent`의 `formatSkillsForPrompt`를 통해). 비용은 결정적입니다.

- **기본 오버헤드(스킬이 1개 이상인 경우에만):** 195자.
- **스킬당:** 97자 + XML 이스케이프 처리된 `<name>`, `<description>` 및 `<location>` 값의 길이.

수식(문자):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

참고:

- XML 이스케이프는 `& < > " '`를 엔터티(`&amp;`, `&lt;` 등)로 확장하여 길이를 늘립니다.
- 토큰 수는 모델 토크나이저에 따라 다릅니다. 대략적인 OpenAI 스타일 추정치는 토큰당 ~4자이므로 스킬당 **97자 ≒ 24개 토큰**에 실제 필드 길이를 더한 값입니다.

## 관리형 기술 수명주기

OpenClaw는 기본 기술 세트를 **번들 기술**로 제공합니다.
(npm 패키지 또는 OpenClaw.app)을 설치합니다. `~/.openclaw/skills`는 로컬에 존재합니다.
재정의(예: 번들된 기능을 변경하지 않고 스킬 고정/패치)
복사). 작업 공간 기술은 사용자 소유이며 이름이 충돌하면 둘 다 재정의됩니다.

## 구성 참조

전체 구성 스키마는 [스킬 구성](/tools/skills-config)을 참조하세요.

## 더 많은 기술을 찾고 계십니까?

[https://clawhub.com](https://clawhub.com)를 찾아보세요.

---
