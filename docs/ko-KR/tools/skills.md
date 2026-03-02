---
summary: "Skills: managed vs workspace, gating rules, and config/env wiring"
read_when:
  - Adding or modifying skills
  - Changing skill gating or load rules
title: "Skills"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/skills.md
workflow: 15
---

# Skills (OpenClaw)

OpenClaw 는 **[AgentSkills](https://agentskills.io)-compatible** skill 폴더를 사용하여 agent 에 도구 사용 방법을 알려줍니다. 각 skill 은 YAML frontmatter 와 instructions 가 있는 `SKILL.md` 을 포함하는 디렉터리입니다. OpenClaw 는 **bundled skills** 과 선택적 로컬 재정의를 로드하고 environment, config 및 binary presence 를 기준으로 로드 시간에 필터링합니다.

## Locations and precedence

Skills 은 **three** 곳에서 로드됩니다:

1. **Bundled skills**: 설치와 함께 제공 (npm package 또는 OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

skill name 이 충돌하면, precedence 는:

`<workspace>/skills` (highest) → `~/.openclaw/skills` → bundled skills (lowest)

또한, `~/.openclaw/openclaw.json` 에서 `skills.load.extraDirs` 를 통해 추가 skill 폴더를 구성할 수 있습니다.

## Per-agent vs shared skills

**Multi-agent** 설정에서, 각 agent 는 자신의 workspace 를 갖습니다. 다음을 의미합니다:

- **Per-agent skills** 은 해당 agent 만을 위해 `<workspace>/skills` 에 있습니다.
- **Shared skills** 은 `~/.openclaw/skills` (managed/local) 에 있으며 동일한 머신에서 **all agents** 에 표시됩니다.
- **Shared folders** 은 여러 agents 에서 사용할 수 있는 일반적인 skills pack 을 원할 경우 `skills.load.extraDirs` (lowest precedence) 를 통해 추가될 수도 있습니다.

동일한 skill name 이 둘 이상의 위치에 존재하면, 일반적인 precedence 가 적용됩니다: workspace wins, then managed/local, then bundled.

## Plugins + skills

Plugins 은 `openclaw.plugin.json` 에 `skills` 디렉터리를 나열하여 자신의 skills 을 제공할 수 있습니다 (플러그인 root 에 상대 경로). Plugin skills 은 플러그인이 활성화될 때 로드되며 일반적인 skill precedence 규칙에 참여합니다.
플러그인의 config 항목에서 `metadata.openclaw.requires.config` 를 통해 gating 할 수 있습니다. [Plugins](/tools/plugin) 및 [Tools](/tools) 를 참고하세요.

## ClawHub (install + sync)

ClawHub 는 OpenClaw 를 위한 공개 skills registry 입니다. [https://clawhub.com](https://clawhub.com) 에서 browse 하세요. 이를 사용하여 skills 을 discover, install, update, 및 backup 합니다.
Full guide: [ClawHub](/tools/clawhub).

Common flows:

- Workspace 에 skill 설치:
  - `clawhub install <skill-slug>`
- 모든 installed skills 업데이트:
  - `clawhub update --all`
- Sync (scan + publish updates):
  - `clawhub sync --all`

기본적으로, `clawhub` 는 현재 working directory (또는 configured OpenClaw workspace 로 fallback) 아래의 `./skills` 에 설치합니다. OpenClaw 는 다음 session 에서 `<workspace>/skills` 로 처리합니다.

## Security notes

- 타사 skills 를 **untrusted code** 로 취급합니다. 활성화하기 전에 읽으세요.
- Untrusted inputs 및 risky tools 에는 sandboxed runs 을 선호합니다. [Sandboxing](/gateway/sandboxing) 를 참고하세요.
- `skills.entries.*.env` 및 `skills.entries.*.apiKey` 는 해당 agent turn 을 위해 **host** 프로세스에 secrets 을 주입합니다 (sandbox 아님). Secrets 을 prompts 와 logs 에서 유지합니다.
- 더 광범위한 threat model 및 checklists 는 [Security](/gateway/security) 를 참고하세요.

## Format (AgentSkills + Pi-compatible)

`SKILL.md` 는 최소한 다음을 포함해야 합니다:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notes:

- 우리는 layout/intent 에 대해 AgentSkills spec 를 따릅니다.
- embedded agent 에서 사용되는 parser 는 **single-line** frontmatter keys 만 지원합니다.
- `metadata` 은 **single-line JSON object** 이어야 합니다.
- Instructions 에서 skill 폴더 경로를 참조하기 위해 `{baseDir}` 을 사용합니다.
- 선택적 frontmatter keys:
  - `homepage` — macOS Skills UI 에서 "Website" 로 표시되는 URL (`metadata.openclaw.homepage` 를 통해서도 지원됨).
  - `user-invocable` — `true|false` (기본값: `true`). `true` 일 때, skill 은 user slash command 로 노출됩니다.
  - `disable-model-invocation` — `true|false` (기본값: `false`). `true` 일 때, skill 은 model prompt 에서 제외됩니다 (여전히 user invocation 을 통해 사용 가능).
  - `command-dispatch` — `tool` (optional). `tool` 로 설정될 때, slash command 는 model 을 우회하고 tool 에 직접 dispatch 합니다.
  - `command-tool` — `command-dispatch: tool` 을 설정할 때 호출할 tool 이름.
  - `command-arg-mode` — `raw` (기본값). Tool dispatch 의 경우, raw args 문자열을 tool 로 전달합니다 (core parsing 없음).

    Tool 은 다음 params 로 호출됩니다:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Gating (load-time filters)

OpenClaw 는 `metadata` (single-line JSON) 를 사용하여 **load time 에 skills 을 필터링합니다**:

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

`metadata.openclaw` 아래의 Fields:

- `always: true` — 항상 skill 을 포함합니다 (다른 gates 을 건너뜁니다).
- `emoji` — macOS Skills UI 에서 사용되는 선택적 emoji.
- `homepage` — macOS Skills UI 에서 "Website" 로 표시되는 선택적 URL.
- `os` — optional list of platforms (`darwin`, `linux`, `win32`). 설정된 경우, skill 은 해당 OSes 에만 eligible 합니다.
- `requires.bins` — list; 각각은 `PATH` 에 존재해야 합니다.
- `requires.anyBins` — list; 최소 하나는 `PATH` 에 존재해야 합니다.
- `requires.env` — list; env var 는 존재하거나 config 에서 제공되어야 합니다.
- `requires.config` — list of `openclaw.json` paths 가 truthy 해야 합니다.
- `primaryEnv` — `skills.entries.<name>.apiKey` 와 관련된 env var name.
- `install` — optional array of installer specs (macOS Skills UI 에서 사용: brew/node/go/uv/download).

Sandboxing note:

- `requires.bins` 는 skill load time 에 **host** 에서 확인됩니다.
- Agent 가 sandboxed 인 경우, binary 도 **컨테이너 내부에 존재해야 합니다**.
  `agents.defaults.sandbox.docker.setupCommand` (또는 사용자 정의 image) 를 통해 설치합니다.
  `setupCommand` 는 컨테이너 생성 후 한 번 실행됩니다.
  Package installs 는 또한 network egress, writable root FS, 및 sandbox 의 root user 가 필요합니다.
  예: `summarize` skill (`skills/summarize/SKILL.md`) 는 sandbox 컨테이너에서 실행되려면 `summarize` CLI 가 필요합니다.

Installer example:

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

Notes:

- 여러 installers 이 나열되면, gateway 는 **단일** preferred option (brew 가능한 경우, 그렇지 않으면 node) 을 선택합니다.
- 모든 installers 가 `download` 인 경우, OpenClaw 는 각 항목을 나열하여 이용 가능한 artifacts 를 볼 수 있습니다.
- Installer specs 은 `os: ["darwin"|"linux"|"win32"]` 를 포함하여 platform 별로 options 를 필터링할 수 있습니다.
- Node installs 는 `~/.openclaw/openclaw.json` 에서 `skills.install.nodeManager` 을 따릅니다 (기본값: npm; options: npm/pnpm/yarn/bun).
  이는 **skill installs** 에만 영향을 줍니다; Gateway runtime 은 여전히 Node 여야 합니다
  (Bun 은 WhatsApp/Telegram 에 권장되지 않음).
- Go installs: `go` 가 누락되고 `brew` 가 available 인 경우, gateway 는 먼저 Homebrew 를 통해 Go 를 설치하고 가능한 경우 Homebrew 의 `bin` 에 `GOBIN` 을 설정합니다.
- Download installs: `url` (필수), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (기본값: archive detected when auto), `stripComponents`, `targetDir` (기본값: `~/.openclaw/tools/<skillKey>`).

`metadata.openclaw` 가 없으면, skill 은 항상 eligible 입니다 (disabled in config 또는 bundled skills 에 대해 `skills.allowBundled` 에 의해 차단된 경우 제외).

## Config overrides (`~/.openclaw/openclaw.json`)

Bundled/managed skills 는 토글되고 env values 로 공급될 수 있습니다:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
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

Note: skill name 에 hyphens 가 포함된 경우, key 를 quote 합니다 (JSON5 allows quoted keys).

Config keys 는 **skill name** 과 기본적으로 일치합니다. Skill 이 `metadata.openclaw.skillKey` 를 정의하면, `skills.entries` 에서 해당 key 를 사용합니다.

Rules:

- `enabled: false` 는 bundled/installed 인 경우에도 skill 을 비활성화합니다.
- `env`: injected **only if** variable 이 이미 프로세스에 설정되지 않은 경우.
- `apiKey`: `metadata.openclaw.primaryEnv` 를 선언하는 skills 에 대한 convenience.
  Plaintext string 또는 SecretRef object (`{ source, provider, id }`) 를 지원합니다.
- `config`: optional bag for custom per-skill fields; custom keys 는 여기에 있어야 합니다.
- `allowBundled`: optional allowlist for **bundled** skills only. 설정된 경우, list 의 bundled skills 만 eligible 합니다 (managed/workspace skills unaffected).

## Environment injection (per agent run)

Agent run 이 시작될 때, OpenClaw 는:

1. Skill metadata 를 읽습니다.
2. 모든 `skills.entries.<key>.env` 또는 `skills.entries.<key>.apiKey` 를 `process.env` 에 적용합니다.
3. **eligible** skills 로 system prompt 를 빌드합니다.
4. Run 이 끝난 후 원본 environment 를 복원합니다.

이는 **scoped to the agent run** 이지, global shell environment 가 아닙니다.

## Session snapshot (performance)

OpenClaw 는 session 이 시작될 때 eligible skills 를 snapshot 하고 동일한 session 의 후속 turns 에 재사용합니다. Skills 또는 config 에 대한 변경은 다음 new session 에서 적용됩니다.

Skills 는 또한 skills watcher 가 활성화되거나 new eligible remote node 가 나타나면 mid-session 을 refresh 할 수 있습니다 (아래 참고). 이를 **hot reload** 로 생각하세요: refreshed list 는 다음 agent turn 에서 선택됩니다.

## Remote macOS nodes (Linux gateway)

Gateway 가 Linux 에서 실행 중이지만 **macOS node** 가 **with `system.run` allowed** 로 연결된 경우 (Exec approvals security 이 `deny` 로 설정되지 않음), OpenClaw 는 macOS 전용 skills 을 eligible 로 취급할 수 있으며, 필요한 binaries 가 해당 node 에 존재합니다. Agent 는 `nodes` tool 을 통해 (typically `nodes.run`) 해당 skills 을 execute 해야 합니다.

이는 node 에서 command support 를 보고하고 `system.run` 을 통한 bin probe 에 의존합니다. macOS node 가 나중에 오프라인이 되면, skills 는 visible 로 유지됩니다; invocations 는 node 가 다시 연결될 때까지 실패할 수 있습니다.

## Skills watcher (auto-refresh)

기본적으로, OpenClaw 는 skill folders 을 watch 하고 `SKILL.md` files 가 변경되면 skills snapshot 을 bumps 합니다. `skills.load` 에서 이를 구성하세요:

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

## Token impact (skills list)

Skills 이 eligible 할 때, OpenClaw 는 available skills 의 compact XML list 를 system prompt 에 주입합니다 (`pi-coding-agent` 의 `formatSkillsForPrompt` 를 통해). Cost 는 deterministic 입니다:

- **Base overhead (only when ≥1 skill):** 195 characters.
- **Per skill:** 97 characters + the length of XML-escaped `<name>`, `<description>`, and `<location>` values.

Formula (characters):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notes:

- XML escaping 은 `& < > " '` 을 entities (`&amp;`, `&lt;`, etc.) 로 확장하여 length 를 증가시킵니다.
- Token counts 는 model tokenizer 에 따라 다릅니다. Rough OpenAI-style estimate 는 ~4 chars/token 이므로, **97 chars ≈ 24 tokens** per skill plus your actual field lengths.

## Managed skills lifecycle

OpenClaw 는 baseline set of skills 을 **bundled skills** 로 제공합니다 (npm package 또는 OpenClaw.app 의 일부로). `~/.openclaw/skills` 는 local overrides 를 위해 존재합니다 (예: bundled copy 를 변경하지 않고 skill 을 pinning/patching). Workspace skills 는 user-owned 이고 name conflicts 시 both 를 재정의합니다.

## Config reference

전체 configuration schema 는 [Skills config](/tools/skills-config) 를 참고하세요.

## 더 많은 skills 찾기?

[https://clawhub.com](https://clawhub.com) 을 browse 하세요.

---
