---
summary: "Skills: စီမံခန့်ခွဲထားသော နှင့် workspace အမျိုးအစားများ၊ gating စည်းမျဉ်းများ၊ နှင့် config/env ချိတ်ဆက်ပုံ"
read_when:
  - Skills များကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
  - Skill gating သို့မဟုတ် load စည်းမျဉ်းများကို ပြောင်းလဲခြင်း
title: "Skills"
x-i18n:
  source_path: tools/skills.md
  source_hash: 70d7eb9e422c17a4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:36Z
---

# Skills (OpenClaw)

OpenClaw သည် agent ကို ကိရိယာများ အသုံးပြုပုံ သင်ကြားရန် **[AgentSkills](https://agentskills.io)-compatible** skill ဖိုလ်ဒါများကို အသုံးပြုပါသည်။ Skill တစ်ခုစီသည် YAML frontmatter နှင့် ညွှန်ကြားချက်များ ပါဝင်သော `SKILL.md` ကို ပါဝင်သည့် directory တစ်ခုဖြစ်သည်။ OpenClaw သည် **bundled skills** များနှင့် optional local overrides များကို load လုပ်ပြီး environment၊ config နှင့် binary ရှိ/မရှိ အပေါ် မူတည်ကာ load အချိန်တွင် filter လုပ်ပါသည်။

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

**Multi-agent** setup များတွင် agent တစ်ခုစီတွင် ကိုယ်ပိုင် workspace ရှိပါသည်။ ထို့ကြောင့်—

- **Per-agent skills** များသည် ထို agent အတွက်သာ `<workspace>/skills` ထဲတွင် ရှိပါသည်။
- **Shared skills** များသည် `~/.openclaw/skills` (managed/local) ထဲတွင် ရှိပြီး
  တူညီသော စက်ပေါ်ရှိ **agent အားလုံး** အတွက် မြင်နိုင်ပါသည်။
- **Shared folders** များကို `skills.load.extraDirs` မှတစ်ဆင့် (အနိမ့်ဆုံး
  precedence) ထပ်မံ ထည့်နိုင်ပြီး agent များစွာ အသုံးပြုမည့် common skills pack အဖြစ် သုံးနိုင်ပါသည်။

နေရာအများအပြားတွင် skill နာမည်တူ ရှိပါက အစဉ်အလာ precedence ကို အသုံးပြုပါသည်—
workspace အနိုင်ရပြီး၊ ထို့နောက် managed/local၊ ထို့နောက် bundled ဖြစ်ပါသည်။

## Plugins + skills

Plugins များသည် ကိုယ်ပိုင် skills များကို `skills` directories အဖြစ်
`openclaw.plugin.json` တွင် စာရင်းပြုလုပ်၍ ပို့လာနိုင်ပါသည် (plugin root ကို အခြေခံထားသော path များ)။ Plugin ကို enable လုပ်သောအခါ plugin skills များကို load လုပ်ပြီး ပုံမှန် skill precedence စည်းမျဉ်းများတွင် ပါဝင်ပါသည်။
Plugin ၏ config entry တွင် `metadata.openclaw.requires.config` ဖြင့် gate လုပ်နိုင်ပါသည်။
ရှာဖွေမှု/ဖွဲ့စည်းပြင်ဆင်မှု အတွက် [Plugins](/tools/plugin) ကိုကြည့်ပြီး၊ skills များသင်ကြားပေးသော tool surface အတွက် [Tools](/tools) ကိုကြည့်ပါ။

## ClawHub (install + sync)

ClawHub သည် OpenClaw အတွက် public skills registry ဖြစ်ပါသည်။
[https://clawhub.com](https://clawhub.com) တွင် ကြည့်ရှုနိုင်ပါသည်။ Skills များကို ရှာဖွေရန်၊ install လုပ်ရန်၊ update လုပ်ရန်နှင့် backup လုပ်ရန် အသုံးပြုနိုင်ပါသည်။
လမ်းညွှန်အပြည့်အစုံ—[ClawHub](/tools/clawhub)။

အများအားဖြင့် အသုံးပြုသော လုပ်ငန်းစဉ်များ—

- Workspace ထဲသို့ skill တစ်ခု install လုပ်ရန်:
  - `clawhub install <skill-slug>`
- Install လုပ်ထားသော skills အားလုံးကို update လုပ်ရန်:
  - `clawhub update --all`
- Sync (scan + publish updates):
  - `clawhub sync --all`

Default အနေဖြင့် `clawhub` သည် သင့်လက်ရှိ working directory အောက်ရှိ
`./skills` ထဲသို့ install လုပ်ပါသည် (သို့မဟုတ် configure လုပ်ထားသော OpenClaw workspace သို့ fallback လုပ်ပါသည်)။ နောက် session တွင် OpenClaw သည် ယင်းကို
`<workspace>/skills` အဖြစ် ခံယူပါသည်။

## Security notes

- Third-party skills များကို **ယုံကြည်မရသော code** အဖြစ် သဘောထားပါ။ Enable မလုပ်မီ ဖတ်ရှုပါ။
- ယုံကြည်မရသော input များနှင့် အန္တရာယ်ရှိသော tools များအတွက် sandboxed runs ကို ဦးစားပေးပါ။ [Sandboxing](/gateway/sandboxing) ကို ကြည့်ပါ။
- `skills.entries.*.env` နှင့် `skills.entries.*.apiKey` သည် agent turn အတွက် **host** process ထဲသို့ secret များကို inject လုပ်ပါသည် (sandbox မဟုတ်ပါ)။ Prompts နှင့် logs များထဲမှ secret များကို ထားမထားပါနှင့်။
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
  - `user-invocable` — `true|false` (default: `true`)။ `true` ဖြစ်ပါက skill ကို user slash command အဖြစ် ဖော်ပြပါသည်။
  - `disable-model-invocation` — `true|false` (default: `false`)။ `true` ဖြစ်ပါက skill ကို model prompt မှ ဖယ်ရှားပါသည် (user invocation ဖြင့် ဆက်လက် အသုံးပြုနိုင်သည်)။
  - `command-dispatch` — `tool` (optional)။ `tool` အဖြစ် သတ်မှတ်ပါက slash command သည် model ကို bypass လုပ်ပြီး tool သို့ တိုက်ရိုက် dispatch လုပ်ပါသည်။
  - `command-tool` — `command-dispatch: tool` ကို သတ်မှတ်ထားသောအခါ invoke လုပ်မည့် tool နာမည်။
  - `command-arg-mode` — `raw` (default)။ Tool dispatch အတွက် raw args string ကို tool သို့ forward လုပ်ပါသည် (core parsing မရှိပါ)။

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
- `os` — optional platform စာရင်း (`darwin`, `linux`, `win32`)။ သတ်မှတ်ထားပါက ထို OS များပေါ်တွင်သာ skill ကို eligible လုပ်ပါသည်။
- `requires.bins` — စာရင်း; တစ်ခုချင်းစီသည် `PATH` ပေါ်တွင် ရှိရပါမည်။
- `requires.anyBins` — စာရင်း; အနည်းဆုံး တစ်ခုသည် `PATH` ပေါ်တွင် ရှိရပါမည်။
- `requires.env` — စာရင်း; env var သည် ရှိရမည် **သို့မဟုတ်** config ထဲတွင် ပံ့ပိုးထားရမည်။
- `requires.config` — truthy ဖြစ်ရမည့် `openclaw.json` paths စာရင်း။
- `primaryEnv` — `skills.entries.<name>.apiKey` နှင့် ဆက်စပ်သော env var နာမည်။
- `install` — macOS Skills UI အသုံးပြုမည့် installer specs optional array (brew/node/go/uv/download)။

Sandboxing အကြောင်း မှတ်ချက်—

- `requires.bins` ကို skill load အချိန်တွင် **host** ပေါ်တွင် စစ်ဆေးပါသည်။
- Agent ကို sandboxed လုပ်ထားပါက binary သည် **container အတွင်း** တွင်လည်း ရှိရပါမည်။
  `agents.defaults.sandbox.docker.setupCommand` (သို့မဟုတ် custom image) ဖြင့် install လုပ်ပါ။
  `setupCommand` သည် container ဖန်တီးပြီးနောက် တစ်ကြိမ်သာ run လုပ်ပါသည်။
  Package installs များတွင် network egress၊ writable root FS နှင့် sandbox အတွင်း root user လည်း လိုအပ်ပါသည်။
  ဥပမာ—`summarize` skill (`skills/summarize/SKILL.md`) သည် ထိုနေရာတွင် run လုပ်ရန် sandbox container အတွင်း `summarize` CLI ကို လိုအပ်ပါသည်။

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
- Node installs များသည် `openclaw.json` ထဲရှိ `skills.install.nodeManager` ကို လိုက်နာပါသည် (default: npm; ရွေးချယ်စရာများ: npm/pnpm/yarn/bun)။
  ၎င်းသည် **skill installs** များအပေါ်သာ သက်ရောက်ပြီး Gateway runtime သည် Node ဖြစ်သင့်ပါသည်
  (WhatsApp/Telegram အတွက် Bun ကို မထောက်ခံပါ)။
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

Config keys များသည် default အနေဖြင့် **skill name** နှင့် ကိုက်ညီပါသည်။ Skill တစ်ခုက
`metadata.openclaw.skillKey` ကို သတ်မှတ်ထားပါက `skills.entries` အောက်တွင် ထို key ကို အသုံးပြုပါ။

စည်းမျဉ်းများ—

- `enabled: false` သည် bundled/installed ဖြစ်နေသော်လည်း skill ကို disable လုပ်ပါသည်။
- `env`: variable သည် process ထဲတွင် မရှိသေးပါက **သာမန်အတိုင်း** inject လုပ်ပါသည်။
- `apiKey`: `metadata.openclaw.primaryEnv` ကို ကြေညာထားသော skills များအတွက် အဆင်ပြေစေရန်။
- `config`: custom per-skill fields များအတွက် optional bag; custom keys များကို ဤနေရာတွင်သာ ထားရပါမည်။
- `allowBundled`: **bundled** skills အတွက်သာ optional allowlist။ သတ်မှတ်ထားပါက စာရင်းထဲရှိ bundled skills များသာ eligible ဖြစ်ပါသည် (managed/workspace skills များကို မထိခိုက်ပါ)။

## Environment injection (per agent run)

Agent run တစ်ခု စတင်သောအခါ OpenClaw သည်—

1. Skill metadata ကို ဖတ်ရှုပါသည်။
2. `skills.entries.<key>.env` သို့မဟုတ် `skills.entries.<key>.apiKey` များကို
   `process.env` သို့ apply လုပ်ပါသည်။
3. **Eligible** skills များဖြင့် system prompt ကို တည်ဆောက်ပါသည်။
4. Run ပြီးဆုံးသည့်အခါ မူလ environment ကို ပြန်လည် restore လုပ်ပါသည်။

ဤလုပ်ငန်းစဉ်သည် **agent run အတွင်းသာ** သက်ရောက်ပြီး global shell environment မဟုတ်ပါ။

## Session snapshot (performance)

OpenClaw သည် **session စတင်ချိန်** တွင် eligible skills များကို snapshot လုပ်ပြီး session တစ်ခုအတွင်း နောက်ထပ် turns များအတွက် ထိုစာရင်းကို ပြန်လည် အသုံးပြုပါသည်။ Skills သို့မဟုတ် config ပြောင်းလဲမှုများသည် နောက် session အသစ်တွင်သာ သက်ရောက်ပါသည်။

Skills watcher ကို enable လုပ်ထားပါက သို့မဟုတ် eligible ဖြစ်သော remote node အသစ် ပေါ်လာပါက session အလယ်တွင်လည်း refresh လုပ်နိုင်ပါသည် (အောက်တွင် ကြည့်ပါ)။ ၎င်းကို **hot reload** အဖြစ် စဉ်းစားနိုင်ပြီး refresh လုပ်ထားသောစာရင်းကို နောက် agent turn တွင် ခံယူပါသည်။

## Remote macOS nodes (Linux gateway)

Gateway သည် Linux ပေါ်တွင် run နေပြီး **macOS node** တစ်ခုကို **`system.run` ခွင့်ပြုထားခြင်းဖြင့်** ချိတ်ဆက်ထားပါက (Exec approvals security ကို `deny` မသတ်မှတ်ထားပါက) OpenClaw သည် ထို node ပေါ်တွင် လိုအပ်သော binaries ရှိနေသောအခါ macOS-only skills များကို eligible အဖြစ် သဘောထားနိုင်ပါသည်။ Agent သည် ထို skills များကို `nodes` tool (ပုံမှန်အားဖြင့် `nodes.run`) ဖြင့် execute လုပ်သင့်ပါသည်။

ဤလုပ်ငန်းစဉ်သည် node မှ ၎င်း၏ command support ကို report လုပ်ခြင်းနှင့် `system.run` မှတစ်ဆင့် bin probe အပေါ် မူတည်ပါသည်။ macOS node သည် နောက်ပိုင်း offline ဖြစ်သွားပါက skills များကို ဆက်လက် မြင်နိုင်သော်လည်း node ပြန်ချိတ်ဆက်မချင်း invocation များ မအောင်မြင်နိုင်ပါသည်။

## Skills watcher (auto-refresh)

Default အနေဖြင့် OpenClaw သည် skill ဖိုလ်ဒါများကို watch လုပ်ပြီး `SKILL.md` files များ ပြောင်းလဲသည့်အခါ skills snapshot ကို bump လုပ်ပါသည်။ ၎င်းကို `skills.load` အောက်တွင် configure လုပ်ပါ—

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

Skills များ eligible ဖြစ်ပါက OpenClaw သည် ရရှိနိုင်သော skills များ၏ compact XML စာရင်းကို system prompt ထဲသို့ inject လုပ်ပါသည် (`pi-coding-agent` ထဲရှိ `formatSkillsForPrompt` မှတစ်ဆင့်)။ ကုန်ကျစရိတ်သည် deterministic ဖြစ်ပါသည်—

- **Base overhead (≥1 skill ရှိမှသာ):** 195 characters။
- **Skill တစ်ခုစီအတွက်:** 97 characters + XML-escaped `<name>`, `<description>`, နှင့် `<location>` တန်ဖိုးများ၏ အရှည်။

Formula (characters)—

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

မှတ်ချက်များ—

- XML escaping သည် `& < > " '` ကို entities များအဖြစ် (`&amp;`, `&lt;` စသည်) ပြောင်းလဲသဖြင့် အရှည် တိုးလာပါသည်။
- Token အရေအတွက်သည် model tokenizer အလိုက် ကွာခြားပါသည်။ OpenAI စတိုင် အနီးစပ်ဆုံး ခန့်မှန်းချက်မှာ ~4 chars/token ဖြစ်ပြီး **97 chars ≈ 24 tokens** ကို skill တစ်ခုစီအတွက် သင့် field lengths အပြင် ထပ်မံ လိုအပ်ပါသည်။

## Managed skills lifecycle

OpenClaw သည် install အစိတ်အပိုင်းအဖြစ် **bundled skills** များ၏ baseline ကို ပို့လာပါသည် (npm package သို့မဟုတ် OpenClaw.app)။ `~/.openclaw/skills` သည် local overrides အတွက် ရှိပါသည် (ဥပမာ—bundled copy ကို မပြောင်းလဲဘဲ skill တစ်ခုကို pin/patch လုပ်ခြင်း)။ Workspace skills များသည် အသုံးပြုသူ ပိုင်ဆိုင်ပြီး နာမည်တူညီမှု ဖြစ်ပါက အခြားနှစ်မျိုးလုံးကို override လုပ်ပါသည်။

## Config reference

Config schema အပြည့်အစုံအတွက် [Skills config](/tools/skills-config) ကို ကြည့်ပါ။

## Skills ပိုမို ရှာဖွေရန်?

[https://clawhub.com](https://clawhub.com) တွင် ကြည့်ရှုပါ။

---
