---
summary: "Skills: စီမံခန့်ခွဲထားသော နှင့် workspace အမျိုးအစားများ၊ gating စည်းမျဉ်းများ၊ နှင့် config/env ချိတ်ဆက်ပုံ"
read_when:
  - Skills များကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
  - Skill gating သို့မဟုတ် load စည်းမျဉ်းများကို ပြောင်းလဲခြင်း
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw uses **[AgentSkills](https://agentskills.io)-compatible** skill folders to teach the agent how to use tools. Each skill is a directory containing a `SKILL.md` with YAML frontmatter and instructions. OpenClaw loads **bundled skills** plus optional local overrides, and filters them at load time based on environment, config, and binary presence.

## Locations and precedence

Skills များကို **နေရာ ၃ ခု** မှ load လုပ်ပါသည်—

1. **Bundled skills**: install နှင့်အတူ ပို့လာသည် (npm package သို့မဟုတ် OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

Skill နာမည် တူညီမှု ဖြစ်ပါက precedence သည်—

`<workspace>/skills` (အမြင့်ဆုံး) → `~/.openclaw/skills` → bundled skills (အနိမ့်ဆုံး)

ထို့အပြင် **အနိမ့်ဆုံး precedence** ဖြင့် extra skill ဖိုလ်ဒါများကို
`skills.load.extraDirs` မှတစ်ဆင့် `~/.openclaw/openclaw.json` ထဲတွင် သတ်မှတ်နိုင်ပါသည်။

## Per-agent vs shared skills

In **multi-agent** setups, each agent has its own workspace. That means:

- **Per-agent skills** များသည် ထို agent အတွက်သာ `<workspace>/skills` ထဲတွင် ရှိပါသည်။
- **Shared skills** များသည် `~/.openclaw/skills` (managed/local) ထဲတွင် ရှိပြီး
  တူညီသော စက်ပေါ်ရှိ **agent အားလုံး** အတွက် မြင်နိုင်ပါသည်။
- **Shared folders** များကို `skills.load.extraDirs` မှတစ်ဆင့် (အနိမ့်ဆုံး
  precedence) ထပ်မံ ထည့်နိုင်ပြီး agent များစွာ အသုံးပြုမည့် common skills pack အဖြစ် သုံးနိုင်ပါသည်။

နေရာအများအပြားတွင် skill နာမည်တူ ရှိပါက အစဉ်အလာ precedence ကို အသုံးပြုပါသည်—
workspace အနိုင်ရပြီး၊ ထို့နောက် managed/local၊ ထို့နောက် bundled ဖြစ်ပါသည်။

## Plugins + skills

Plugins can ship their own skills by listing `skills` directories in
`openclaw.plugin.json` (paths relative to the plugin root). Plugin skills load
when the plugin is enabled and participate in the normal skill precedence rules.
You can gate them via `metadata.openclaw.requires.config` on the plugin’s config
entry. See [Plugins](/tools/plugin) for discovery/config and [Tools](/tools) for the
tool surface those skills teach.

## ClawHub (install + sync)

ClawHub is the public skills registry for OpenClaw. Browse at
[https://clawhub.com](https://clawhub.com). Use it to discover, install, update, and back up skills.
Full guide: [ClawHub](/tools/clawhub).

အများအားဖြင့် အသုံးပြုသော လုပ်ငန်းစဉ်များ—

- Workspace ထဲသို့ skill တစ်ခု install လုပ်ရန်:
  - `clawhub install <skill-slug>`
- Install လုပ်ထားသော skills အားလုံးကို update လုပ်ရန်:
  - `clawhub update --all`
- Sync (scan + publish updates):
  - `clawhub sync --all`

By default, `clawhub` installs into `./skills` under your current working
directory (or falls back to the configured OpenClaw workspace). OpenClaw picks
that up as `<workspace>/skills` on the next session.

## Security notes

- Treat third-party skills as **untrusted code**. Read them before enabling.
- Prefer sandboxed runs for untrusted inputs and risky tools. See [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` and `skills.entries.*.apiKey` inject secrets into the **host** process
  for that agent turn (not the sandbox). Keep secrets out of prompts and logs.
- ပိုမိုကျယ်ပြန့်သော threat model နှင့် checklists များအတွက် [Security](/gateway/security) ကို ကြည့်ပါ။

## Format (AgentSkills + Pi-compatible)

`SKILL.md` တွင် အနည်းဆုံး အောက်ပါအရာများ ပါဝင်ရပါမည်—

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

မှတ်ချက်များ—

- Layout/intent အတွက် AgentSkills spec ကို လိုက်နာပါသည်။
- Embedded agent အသုံးပြုသော parser သည် **single-line** frontmatter keys များကိုသာ ထောက်ပံ့ပါသည်။
- `metadata` သည် **single-line JSON object** ဖြစ်ရပါမည်။
- Skill ဖိုလ်ဒါ path ကို ရည်ညွှန်းရန် ညွှန်ကြားချက်များထဲတွင် `{baseDir}` ကို အသုံးပြုပါ။
- Optional frontmatter keys—
  - `homepage` — macOS Skills UI တွင် “Website” အဖြစ် ပြသမည့် URL ( `metadata.openclaw.homepage` မှတစ်ဆင့်လည်း ထောက်ပံ့ပါသည်)။
  - `user-invocable` — `true|false` (default: `true`). When `true`, the skill is exposed as a user slash command.
  - `disable-model-invocation` — `true|false` (default: `false`). When `true`, the skill is excluded from the model prompt (still available via user invocation).
  - `command-dispatch` — `tool` (optional). When set to `tool`, the slash command bypasses the model and dispatches directly to a tool.
  - `command-tool` — `command-dispatch: tool` ကို သတ်မှတ်ထားသောအခါ invoke လုပ်မည့် tool နာမည်။
  - `command-arg-mode` — `raw` (default). For tool dispatch, forwards the raw args string to the tool (no core parsing).

    Tool ကို အောက်ပါ params များဖြင့် invoke လုပ်ပါသည်—
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`။

## Gating (load-time filters)

OpenClaw သည် load အချိန်တွင် `metadata` (single-line JSON) ကို အသုံးပြု၍ **skills များကို filter လုပ်ပါသည်**—

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

`metadata.openclaw` အောက်ရှိ fields များ—

- `always: true` — skill ကို အမြဲ ထည့်သွင်းပါ (အခြား gates များကို ကျော်လွှားပါ)။
- `emoji` — macOS Skills UI မှ အသုံးပြုမည့် optional emoji။
- `homepage` — macOS Skills UI တွင် “Website” အဖြစ် ပြသမည့် optional URL။
- `os` — optional list of platforms (`darwin`, `linux`, `win32`). If set, the skill is only eligible on those OSes.
- `requires.bins` — စာရင်း; တစ်ခုချင်းစီသည် `PATH` ပေါ်တွင် ရှိရပါမည်။
- `requires.anyBins` — စာရင်း; အနည်းဆုံး တစ်ခုသည် `PATH` ပေါ်တွင် ရှိရပါမည်။
- `requires.env` — စာရင်း; env var သည် ရှိရမည် **သို့မဟုတ်** config ထဲတွင် ပံ့ပိုးထားရမည်။
- `requires.config` — truthy ဖြစ်ရမည့် `openclaw.json` paths စာရင်း။
- `primaryEnv` — env var name associated with `skills.entries.<name>.apiKey`.
- `install` — macOS Skills UI အသုံးပြုမည့် installer specs optional array (brew/node/go/uv/download)။

Sandboxing အကြောင်း မှတ်ချက်—

- `requires.bins` ကို skill load အချိန်တွင် **host** ပေါ်တွင် စစ်ဆေးပါသည်။
- If an agent is sandboxed, the binary must also exist **inside the container**.
  Install it via `agents.defaults.sandbox.docker.setupCommand` (or a custom image).
  `setupCommand` runs once after the container is created.
  Package installs also require network egress, a writable root FS, and a root user in the sandbox.
  Example: the `summarize` skill (`skills/summarize/SKILL.md`) needs the `summarize` CLI
  in the sandbox container to run there.

Installer ဥပမာ—

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

မှတ်ချက်များ—

- Installer များကို အများအပြား စာရင်းပြုလုပ်ထားပါက gateway သည် **တစ်ခုတည်း** ကို ဦးစားပေးရွေးချယ်ပါသည် (ရရှိနိုင်ပါက brew၊ မရပါက node)။
- Installer အားလုံးသည် `download` ဖြစ်ပါက OpenClaw သည် ရရှိနိုင်သော artifacts များကို မြင်နိုင်ရန် entry တစ်ခုစီကို စာရင်းပြုလုပ်ပါသည်။
- Installer specs များတွင် platform အလိုက် filter လုပ်ရန် `os: ["darwin"|"linux"|"win32"]` ပါဝင်နိုင်ပါသည်။
- Node installs honor `skills.install.nodeManager` in `openclaw.json` (default: npm; options: npm/pnpm/yarn/bun).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun is not recommended for WhatsApp/Telegram).
- Go installs—`go` မရှိဘဲ `brew` ရှိပါက gateway သည် Homebrew ဖြင့် Go ကို အရင် install လုပ်ပြီး ဖြစ်နိုင်ပါက `GOBIN` ကို Homebrew ၏ `bin` သို့ သတ်မှတ်ပါသည်။
- Download installs—`url` (လိုအပ်), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (default: archive တွေ့ရှိလျှင် auto), `stripComponents`, `targetDir` (default: `~/.openclaw/tools/<skillKey>`)။

`metadata.openclaw` မရှိပါက skill သည် အမြဲ eligible ဖြစ်ပါသည် (config တွင် disable လုပ်ထားခြင်း သို့မဟုတ် bundled skills အတွက် `skills.allowBundled` ဖြင့် ပိတ်ထားခြင်း မရှိလျှင်)။

## Config overrides (`~/.openclaw/openclaw.json`)

Bundled/managed skills များကို toggle လုပ်နိုင်ပြီး env values များကို ပံ့ပိုးနိုင်ပါသည်—

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

မှတ်ချက်—skill နာမည်တွင် hyphen များ ပါဝင်ပါက key ကို quote လုပ်ပါ (JSON5 သည် quoted keys များကို ခွင့်ပြုပါသည်)။

Config keys match the **skill name** by default. If a skill defines
`metadata.openclaw.skillKey`, use that key under `skills.entries`.

စည်းမျဉ်းများ—

- `enabled: false` သည် bundled/installed ဖြစ်နေသော်လည်း skill ကို disable လုပ်ပါသည်။
- `env`: variable သည် process ထဲတွင် မရှိသေးပါက **သာမန်အတိုင်း** inject လုပ်ပါသည်။
- `apiKey`: `metadata.openclaw.primaryEnv` ကို ကြေညာထားသော skills များအတွက် အဆင်ပြေစေရန်။
- `config`: custom per-skill fields များအတွက် optional bag; custom keys များကို ဤနေရာတွင်သာ ထားရပါမည်။
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).

## Environment injection (per agent run)

Agent run တစ်ခု စတင်သောအခါ OpenClaw သည်—

1. Skill metadata ကို ဖတ်ရှုပါသည်။
2. Applies any `skills.entries.<key>.env` သို့မဟုတ် `skills.entries.<key>.apiKey` ကို
   `process.env` သို့
3. **Eligible** skills များဖြင့် system prompt ကို တည်ဆောက်ပါသည်။
4. Run ပြီးဆုံးသည့်အခါ မူလ environment ကို ပြန်လည် restore လုပ်ပါသည်။

ဤလုပ်ငန်းစဉ်သည် **agent run အတွင်းသာ** သက်ရောက်ပြီး global shell environment မဟုတ်ပါ။

## Session snapshot (performance)

OpenClaw သည် **session တစ်ခု စတင်ချိန်တွင်** အသုံးပြုနိုင်သော skills များကို snapshot လုပ်ထားပြီး၊ session တူညီနေသရွေ့ နောက်ထပ် turn များတွင် အဆိုပါစာရင်းကို ပြန်လည်အသုံးပြုသည်။ Skills သို့မဟုတ် config အပြောင်းအလဲများသည် နောက်တစ်ခါ session အသစ် စတင်သောအခါမှ အကျိုးသက်ရောက်မည်ဖြစ်သည်။

Skills watcher ကို ဖွင့်ထားသောအခါ သို့မဟုတ် အသုံးပြုနိုင်သော remote node အသစ် ပေါ်လာသောအခါ (အောက်တွင် ကြည့်ပါ) session အတွင်းတင်ပင် skills ကို refresh လုပ်နိုင်ပါသည်။ ဤအရာကို **hot reload** အဖြစ် စဉ်းစားနိုင်သည် — refresh ပြုလုပ်ထားသောစာရင်းကို နောက်ထပ် agent turn တွင် ယူသုံးပါမည်။

## Remote macOS nodes (Linux gateway)

Gateway သည် Linux ပေါ်တွင် chạy နေပြီး **macOS node** တစ်ခုကို **`system.run` ခွင့်ပြုထားပြီး** ချိတ်ဆက်ထားပါက (Exec approvals security ကို `deny` မထားပါက) လိုအပ်သော binaries များသည် အဆိုပါ node တွင် ရှိနေသရွေ့ OpenClaw သည် macOS-only skills များကို အသုံးပြုနိုင်သော skills အဖြစ် သတ်မှတ်နိုင်ပါသည်။ Agent သည် အဆိုပါ skills များကို `nodes` tool (ပုံမှန်အားဖြင့် `nodes.run`) မှတဆင့် လုပ်ဆောင်ရမည်ဖြစ်သည်။

ဤလုပ်ငန်းစဉ်သည် node မှ ၎င်း၏ command support ကို report လုပ်ခြင်းနှင့် `system.run` မှတဆင့် bin probe ပြုလုပ်ခြင်းအပေါ် မူတည်ပါသည်။ macOS node သည် နောက်ပိုင်းတွင် offline ဖြစ်သွားပါက skills များကို ဆက်လက် မြင်နိုင်သော်လည်း node ပြန်လည်ချိတ်ဆက်မလာမချင်း invocation များ ပျက်ကွက်နိုင်ပါသည်။

## Skills watcher (auto-refresh)

ပုံမှန်အားဖြင့် OpenClaw သည် skill folders များကို စောင့်ကြည့်ပြီး `SKILL.md` ဖိုင်များ ပြောင်းလဲသည့်အခါ skills snapshot ကို bump လုပ်ပါသည်။ `skills.load` အောက်တွင် ပြင်ဆင်သတ်မှတ်နိုင်ပါသည်။

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

Skills များ အသုံးပြုနိုင်သောအခါ OpenClaw သည် အသုံးပြုနိုင်သော skills များ၏ compact XML စာရင်းကို system prompt ထဲသို့ (`pi-coding-agent` ထဲရှိ `formatSkillsForPrompt` မှတဆင့်) ထည့်သွင်းပါသည်။ ကုန်ကျစရိတ်သည် သတ်မှတ်ထားပြီးသားဖြစ်ပါသည်။

- **Base overhead (≥1 skill ရှိမှသာ):** 195 characters။
- **Skill တစ်ခုစီအတွက်:** 97 characters + XML-escaped `<name>`, `<description>`, နှင့် `<location>` တန်ဖိုးများ၏ အရှည်။

Formula (characters)—

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

မှတ်ချက်များ—

- XML escaping သည် `& < > " '` ကို entities များအဖြစ် (`&amp;`, `&lt;` စသည်) ပြောင်းလဲသဖြင့် အရှည် တိုးလာပါသည်။
- Token အရေအတွက်သည် model tokenizer ပေါ်မူတည်၍ ကွဲပြားပါသည်။ OpenAI-style အကြမ်းဖျဉ်း ခန့်မှန်းချက်အရ ~4 chars/token ဖြစ်သောကြောင့် skill တစ်ခုလျှင် **97 chars ≈ 24 tokens** နှင့် သင့် field length အမှန်တကယ်များကို ထပ်ပေါင်းရပါမည်။

## Managed skills lifecycle

OpenClaw သည် install (npm package သို့မဟုတ် OpenClaw.app) အစိတ်အပိုင်းအဖြစ် **bundled skills** အဖြစ် baseline skills အစုတစ်ခုကို ထည့်သွင်းပေးထားပါသည်။ `~/.openclaw/skills` ကို local overrides များအတွက် အသုံးပြုနိုင်ပါသည်
(ဥပမာ၊ bundled copy ကို မပြောင်းဘဲ skill တစ်ခုကို pin/patch လုပ်ရန်)။ Workspace skills များသည် user ပိုင်ဆိုင်မှုဖြစ်ပြီး အမည်တူ များဖြစ်ပါက အခြားအားလုံးကို override လုပ်ပါသည်။

## Config reference

Config schema အပြည့်အစုံအတွက် [Skills config](/tools/skills-config) ကို ကြည့်ပါ။

## Skills ပိုမို ရှာဖွေရန်?

[https://clawhub.com](https://clawhub.com) တွင် ကြည့်ရှုပါ။

---
