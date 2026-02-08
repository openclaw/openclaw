---
read_when:
    - 스킬 추가 또는 수정
    - 스킬 게이팅 또는 로드 규칙 변경
summary: '기술: 관리형 대 작업 공간, 게이팅 규칙 및 구성/환경 배선'
title: 기술
x-i18n:
    generated_at: "2026-02-08T16:06:59Z"
    model: gtx
    provider: google-translate
    source_hash: 70d7eb9e422c17a4f1443688585bdfbcb086b4890bd13eb652bcf5eb10fdd447
    source_path: tools/skills.md
    workflow: 15
---

# 스킬(오픈클로)

OpenClaw는 다음을 사용합니다. **[에이전트 기술](https://agentskills.io)-호환** 상담원에게 도구 사용 방법을 가르치는 기술 폴더입니다. 각 스킬은 다음을 포함하는 디렉토리입니다. `SKILL.md` YAML 서문 및 지침이 포함되어 있습니다. OpenClaw 로드 **번들 스킬** 선택적으로 로컬 재정의를 수행하고 환경, 구성 및 바이너리 존재를 기반으로 로드 시 필터링합니다.

## 위치 및 우선순위

스킬은 다음에서 로드됩니다. **삼** 장소:

1. **번들 스킬**: 설치와 함께 제공됩니다(npm 패키지 또는 OpenClaw.app).
2. **관리형/로컬 기술**: `~/.openclaw/skills`
3. **작업 공간 기술**: `<workspace>/skills`

스킬 이름이 충돌하는 경우 우선 순위는 다음과 같습니다.

`<workspace>/skills` (최고) → `~/.openclaw/skills` → 묶음 스킬(최하위)

또한 다음을 통해 추가 기술 폴더(최하위 우선 순위)를 구성할 수 있습니다.
`skills.load.extraDirs` ~에 `~/.openclaw/openclaw.json`.

## 에이전트별 기술과 공유 기술

~ 안에 **다중 에이전트** 설정에 따라 각 에이전트에는 자체 작업 공간이 있습니다. 이는 다음을 의미합니다.

- **상담원별 기술** ~에 살다 `<workspace>/skills` 해당 상담원에게만 해당됩니다.
- **공유 기술** ~에 살다 `~/.openclaw/skills` (관리/로컬)이며 표시됩니다.
  에 **모든 상담원** 같은 기계에서.
- **공유 폴더** 다음을 통해 추가할 수도 있습니다. `skills.load.extraDirs` (최저
  우선 순위) 여러 상담원이 사용하는 공통 스킬 팩을 원하는 경우.

동일한 스킬명이 여러 곳에 존재하는 경우, 일반적인 우선순위는 다음과 같습니다.
적용: 작업공간이 우선되고 관리형/로컬이 적용되며 번들로 제공됩니다.

## 플러그인 + 스킬

플러그인은 목록을 통해 자체 기술을 배송할 수 있습니다. `skills` 디렉토리
`openclaw.plugin.json` (플러그인 루트에 상대적인 경로). 플러그인 스킬 로드
플러그인이 활성화되고 일반적인 기술 우선 순위 규칙에 참여할 때.
다음을 통해 게이트를 통과할 수 있습니다. `metadata.openclaw.requires.config` 플러그인 구성에서
입장. 보다 [플러그인](/tools/plugin) 검색/구성 및 [도구](/tools) 에 대한
도구 표면의 기술이 가르쳐줍니다.

## ClawHub(설치 + 동기화)

ClawHub는 OpenClaw용 공개 기술 레지스트리입니다. 찾아보기
[https://clawhub.com](https://clawhub.com). 이를 사용하여 기술을 검색, 설치, 업데이트 및 백업합니다.
전체 가이드: [클로허브](/tools/clawhub).

일반적인 흐름:

- 작업 공간에 기술을 설치하십시오.
  - `clawhub install <skill-slug>`
- 설치된 모든 기술을 업데이트합니다.
  - `clawhub update --all`
- 동기화(스캔 + 업데이트 게시):
  - `clawhub sync --all`

기본적으로 `clawhub` 에 설치 `./skills` 현재 근무 중인
디렉터리(또는 구성된 OpenClaw 작업 공간으로 대체). OpenClaw 추천
그건 그렇고 `<workspace>/skills` 다음 세션에.

## 보안 참고 사항

- 타사 스킬을 다음과 같이 취급합니다. **신뢰할 수 없는 코드**. 활성화하기 전에 읽어보십시오.
- 신뢰할 수 없는 입력 및 위험한 도구에 대해서는 샌드박스 실행을 선호합니다. 보다 [샌드박싱](/gateway/sandboxing).
- `skills.entries.*.env` 그리고 `skills.entries.*.apiKey` 비밀을 주입하다 **주인** 프로세스
  해당 에이전트 차례에 대해(샌드박스 아님) 프롬프트와 로그에서 비밀을 유지하세요.
- 더 광범위한 위협 모델과 체크리스트를 보려면 다음을 참조하세요. [보안](/gateway/security).

## 형식(AgentSkills + Pi 호환)

`SKILL.md` 최소한 다음을 포함해야 합니다:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

참고:

- 우리는 레이아웃/의도에 대해 AgentSkills 사양을 따릅니다.
- 내장된 에이전트가 사용하는 파서는 다음을 지원합니다. **한 줄** 머리말 키만.
- `metadata` 이어야 한다 **한 줄 JSON 객체**.
- 사용 `{baseDir}` 스킬 폴더 경로를 참조하라는 지침이 있습니다.
- 선택적인 머리말 키:
  - `homepage` — macOS Skills UI에 "웹사이트"로 표시되는 URL(다음을 통해서도 지원됨) `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (기본: `true`). 언제 `true`, 해당 스킬은 사용자 슬래시 명령으로 노출됩니다.
  - `disable-model-invocation` — `true|false` (기본: `false`). 언제 `true`, 해당 스킬은 모델 프롬프트에서 제외됩니다(사용자 호출을 통해 계속 사용 가능).
  - `command-dispatch` — `tool` (선택 과목). 으로 설정하면 `tool`, 슬래시 명령은 모델을 우회하고 도구에 직접 전달됩니다.
  - `command-tool` — 다음 경우에 호출할 도구 이름 `command-dispatch: tool` 설정됩니다.
  - `command-arg-mode` — `raw` (기본). 도구 디스패치의 경우 원시 인수 문자열을 도구에 전달합니다(코어 구문 분석 없음).

    이 도구는 매개변수를 사용하여 호출됩니다.
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## 게이팅(로드 시간 필터)

오픈클로 **로드 시 스킬 필터링** 사용하여 `metadata` (한 줄 JSON):

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

아래 필드 `metadata.openclaw`: 

- `always: true` — 항상 스킬을 포함합니다(다른 게이트 건너뛰기).
- `emoji` — macOS Skills UI에서 사용되는 선택적 이모티콘입니다.
- `homepage` — macOS Skills UI에 "웹사이트"로 표시되는 선택적 URL입니다.
- `os` — 선택적 플랫폼 목록(`darwin`, `linux`, `win32`). 설정된 경우 기술은 해당 OS에서만 사용할 수 있습니다.
- `requires.bins` - 목록; 각각은 다음에 존재해야 합니다. `PATH`.
- `requires.anyBins` - 목록; 최소한 하나는 존재해야 합니다. `PATH`.
- `requires.env` - 목록; env var가 존재해야 합니다. **또는** 구성에서 제공됩니다.
- `requires.config` — 목록 `openclaw.json` 진실해야 하는 길.
- `primaryEnv` — 다음과 연관된 env var 이름 `skills.entries.<name>.apiKey`.
- `install` — macOS Skills UI(brew/node/go/uv/download)에서 사용되는 설치 프로그램 사양의 선택적 배열입니다.

샌드박싱에 대한 참고 사항:

- `requires.bins` 에서 확인됩니다. **주인** 스킬 로딩 시간에
- 에이전트가 샌드박스 처리된 경우 바이너리도 존재해야 합니다. **컨테이너 내부**.
  다음을 통해 설치하세요. `agents.defaults.sandbox.docker.setupCommand` (또는 사용자 정의 이미지).
  `setupCommand` 컨테이너가 생성된 후 한 번 실행됩니다.
  패키지 설치에는 네트워크 송신, 쓰기 가능한 루트 FS 및 샌드박스의 루트 사용자도 필요합니다.
  예: `summarize` 스킬 (`skills/summarize/SKILL.md`)가 필요하다 `summarize` CLI
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

- 여러 설치 프로그램이 나열되면 게이트웨이는 다음 중 하나를 선택합니다. **하나의** 선호하는 옵션(사용 가능한 경우 추출, 그렇지 않은 경우 노드).
- 모든 설치 프로그램이 `download`, OpenClaw는 사용 가능한 아티팩트를 볼 수 있도록 각 항목을 나열합니다.
- 설치 프로그램 사양에는 다음이 포함될 수 있습니다. `os: ["darwin"|"linux"|"win32"]` 플랫폼별로 옵션을 필터링합니다.
- 노드 설치 명예 `skills.install.nodeManager` ~에 `openclaw.json` (기본값: npm; 옵션: npm/pnpm/yarn/bun)
  이것은 단지 영향을 미칩니다 **스킬 설치**; 게이트웨이 런타임은 여전히 노드여야 합니다.
  (WhatsApp/Telegram에서는 Bun을 권장하지 않습니다).
- Go 설치: if `go` 누락되었으며 `brew` 사용할 수 있는 경우 게이트웨이는 먼저 Homebrew를 통해 Go를 설치하고 설정합니다. `GOBIN` 홈브루에게 `bin` 가능하다면.
- 다운로드 설치: `url` (필수의), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (기본값: 아카이브가 감지되면 자동), `stripComponents`, `targetDir` (기본: `~/.openclaw/tools/<skillKey>`).

그렇지 않은 경우 `metadata.openclaw` 존재하는 경우 해당 기술은 항상 적격입니다.
구성에서 비활성화되었거나 차단되었습니다. `skills.allowBundled` 번들 스킬의 경우).

## 구성 재정의(`~/.openclaw/openclaw.json`)

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

구성 키가 다음과 일치합니다. **스킬 이름** 기본적으로. 스킬이 정의된 경우
`metadata.openclaw.skillKey`, 아래에서 해당 키를 사용하세요. `skills.entries`.

규칙:

- `enabled: false` 번들/설치되어 있어도 스킬이 비활성화됩니다.
- `env`: 주입 **경우에만** 변수가 프로세스에서 아직 설정되지 않았습니다.
- `apiKey`: 선언하는 스킬의 편의성 `metadata.openclaw.primaryEnv`.
- `config`: 맞춤형 기술별 필드를 위한 선택적 가방; 맞춤 키는 여기에 있어야 합니다.
- `allowBundled`: 선택적 허용 목록 **번들로 제공** 스킬만. 설정된 경우에만
  목록에 있는 번들 기술은 적격합니다(관리/작업 영역 기술은 영향을 받지 않음).

## 환경 주입(에이전트 실행당)

에이전트 실행이 시작되면 OpenClaw는 다음을 수행합니다.

1. 스킬 메타데이터를 읽습니다.
2. 모두 적용 `skills.entries.<key>.env`또는`skills.entries.<key>.apiKey` 에게
   `process.env`.
3. 다음을 사용하여 시스템 프롬프트를 구축합니다. **자격이 있는** 기술.
4. 실행이 종료된 후 원래 환경을 복원합니다.

이것은 **에이전트 실행으로 범위가 지정됨**, 글로벌 쉘 환경이 아닙니다.

## 세션 스냅샷(성능)

OpenClaw는 적합한 기술의 스냅샷을 찍습니다. **세션이 시작될 때** 동일한 세션의 후속 턴에 해당 목록을 재사용합니다. 스킬이나 구성에 대한 변경 사항은 다음 새 세션에 적용됩니다.

스킬 감시자가 활성화되거나 새로운 적격 원격 노드가 나타날 때 세션 중에 스킬을 새로 고칠 수도 있습니다(아래 참조). 이것을 다음과 같이 생각하십시오. **핫 리로드**: 새로 고친 목록은 다음 에이전트 차례에 선택됩니다.

## 원격 macOS 노드(Linux 게이트웨이)

게이트웨이가 Linux에서 실행되고 있지만 **macOS 노드** 연결되어 있다 **~와 함께 `system.run` 허용된** (Exec 승인 보안이 다음으로 설정되지 않았습니다. `deny`), OpenClaw는 해당 노드에 필수 바이너리가 있는 경우 macOS 전용 기술을 적합한 것으로 처리할 수 있습니다. 상담원은 다음을 통해 해당 기술을 실행해야 합니다. `nodes` 도구(일반적으로 `nodes.run`).

이는 명령 지원을 보고하는 노드와 다음을 통한 bin 프로브에 의존합니다. `system.run`. 나중에 macOS 노드가 오프라인이 되어도 기술은 계속 표시됩니다. 노드가 다시 연결될 때까지 호출이 실패할 수 있습니다.

## 스킬 감시자(자동 새로고침)

기본적으로 OpenClaw는 스킬 폴더를 감시하고 다음과 같은 경우 스킬 스냅샷을 충돌시킵니다. `SKILL.md` 파일이 변경됩니다. 이것을 아래에서 구성하십시오 `skills.load`: 

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

기술이 적격한 경우 OpenClaw는 사용 가능한 기술의 압축된 XML 목록을 시스템 프롬프트에 삽입합니다(다음을 통해). `formatSkillsForPrompt` ~에 `pi-coding-agent`). 비용은 결정적입니다.

- **기본 오버헤드(기술이 1개 이상인 경우에만):** 195자.
- **스킬별:** 97자 + XML 이스케이프 길이 `<name>`, `<description>`, 그리고 `<location>` 가치.

수식(문자):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

참고:

- XML 이스케이프 확장 `& < > " '` 엔터티로(`&amp;`, `&lt;`등), 길이가 늘어납니다.
- 토큰 수는 모델 토크나이저에 따라 다릅니다. 대략적인 OpenAI 스타일 추정치는 ~4자/토큰이므로 **97자 ≒ 24개 토큰** 기술당 실제 필드 길이를 더한 것입니다.

## 관리형 기술 수명주기

OpenClaw는 다음과 같은 기본 기술 세트를 제공합니다. **번들 스킬** 의 일부로
(npm 패키지 또는 OpenClaw.app)을 설치합니다. `~/.openclaw/skills` 지역을 위해 존재합니다
재정의(예: 번들된 기능을 변경하지 않고 스킬 고정/패치)
복사). 작업 공간 기술은 사용자 소유이며 이름이 충돌하면 둘 다 재정의됩니다.

## 구성 참조

보다 [스킬 구성](/tools/skills-config) 전체 구성 스키마의 경우.

## 더 많은 기술을 찾고 계십니까?

먹다 [https://clawhub.com](https://clawhub.com).

---
