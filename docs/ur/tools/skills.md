---
summary: "Skills: منظم بمقابلہ ورک اسپیس، گیٹنگ قواعد، اور کنفیگ/ماحولیاتی وائرنگ"
read_when:
  - Skills شامل یا ترمیم کرتے وقت
  - Skill گیٹنگ یا لوڈ قواعد تبدیل کرتے وقت
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw ایجنٹ کو ٹولز استعمال کرنے کی تربیت دینے کے لیے **[AgentSkills](https://agentskills.io)-compatible** اسکل فولڈرز استعمال کرتا ہے۔ ہر اسکل ایک ڈائریکٹری ہوتی ہے جس میں YAML فرنٹ میٹر اور ہدایات کے ساتھ ایک `SKILL.md` شامل ہوتی ہے۔ OpenClaw **بنڈلڈ اسکلز** کے ساتھ اختیاری لوکل اووررائیڈز لوڈ کرتا ہے، اور لوڈ ٹائم پر ماحول، کنفیگ، اور بائنری موجودگی کی بنیاد پر انہیں فلٹر کرتا ہے۔

## مقامات اور ترجیح

Skills **تین** جگہوں سے لوڈ کی جاتی ہیں:

1. **Bundled skills**: انسٹال کے ساتھ فراہم کی جاتی ہیں (npm پیکیج یا OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

اگر کسی skill کے نام میں ٹکراؤ ہو تو ترجیح یوں ہے:

`<workspace>/skills` (اعلیٰ ترین) → `~/.openclaw/skills` → bundled skills (کم ترین)

مزید یہ کہ، آپ اضافی skill فولڈرز (کم ترین ترجیح) کنفیگر کر سکتے ہیں بذریعہ
`skills.load.extraDirs` در `~/.openclaw/openclaw.json`۔

## فی ایجنٹ بمقابلہ مشترکہ skills

**ملٹی-ایجنٹ** سیٹ اپس میں، ہر ایجنٹ کا اپنا ورک اسپیس ہوتا ہے۔ That means:

- **فی ایجنٹ skills** اس ایجنٹ کے لیے صرف `<workspace>/skills` میں ہوتی ہیں۔
- **مشترکہ skills** `~/.openclaw/skills` (managed/local) میں ہوتی ہیں اور
  اسی مشین پر موجود **تمام ایجنٹس** کو نظر آتی ہیں۔
- **مشترکہ فولڈرز** بھی `skills.load.extraDirs` کے ذریعے شامل کیے جا سکتے ہیں (کم ترین
  ترجیح) اگر آپ متعدد ایجنٹس کے لیے ایک مشترکہ skills پیک استعمال کرنا چاہتے ہوں۔

اگر ایک ہی skill نام ایک سے زیادہ جگہوں پر موجود ہو تو معمول کی ترجیح
لاگو ہوتی ہے: ورک اسپیس جیتتی ہے، پھر managed/local، پھر bundled۔

## Plugins + skills

Plugins can ship their own skills by listing `skills` directories in
`openclaw.plugin.json` (paths relative to the plugin root). Plugin skills load
when the plugin is enabled and participate in the normal skill precedence rules.
You can gate them via `metadata.openclaw.requires.config` on the plugin’s config
entry. See [Plugins](/tools/plugin) for discovery/config and [Tools](/tools) for the
tool surface those skills teach.

## ClawHub (انسٹال + ہم آہنگی)

ClawHub is the public skills registry for OpenClaw. Browse at
[https://clawhub.com](https://clawhub.com). Use it to discover, install, update, and back up skills.
Full guide: [ClawHub](/tools/clawhub).

عام طریقۂ کار:

- اپنی ورک اسپیس میں کوئی skill انسٹال کریں:
  - `clawhub install <skill-slug>`
- تمام انسٹال شدہ skills اپڈیٹ کریں:
  - `clawhub update --all`
- Sync (اسکین + اپڈیٹس شائع کریں):
  - `clawhub sync --all`

By default, `clawhub` installs into `./skills` under your current working
directory (or falls back to the configured OpenClaw workspace). OpenClaw picks
that up as `<workspace>/skills` on the next session.

## سکیورٹی نوٹس

- Treat third-party skills as **untrusted code**. Read them before enabling.
- Prefer sandboxed runs for untrusted inputs and risky tools. See [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` and `skills.entries.*.apiKey` inject secrets into the **host** process
  for that agent turn (not the sandbox). Keep secrets out of prompts and logs.
- وسیع تر threat ماڈل اور چیک لسٹس کے لیے [Security](/gateway/security) دیکھیں۔

## فارمیٹ (AgentSkills + Pi-compatible)

`SKILL.md` میں کم از کم یہ شامل ہونا چاہیے:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

نوٹس:

- لے آؤٹ/انٹینٹ کے لیے ہم AgentSkills اسپیک کی پیروی کرتے ہیں۔
- ایمبیڈڈ ایجنٹ کے ذریعے استعمال ہونے والا parser صرف **سنگل لائن** فرنٹ میٹر کیز کو سپورٹ کرتا ہے۔
- `metadata` ایک **سنگل لائن JSON آبجیکٹ** ہونا چاہیے۔
- ہدایات میں skill فولڈر کے راستے کا حوالہ دینے کے لیے `{baseDir}` استعمال کریں۔
- اختیاری فرنٹ میٹر کیز:
  - `homepage` — URL جو macOS Skills UI میں “Website” کے طور پر دکھایا جاتا ہے ( `metadata.openclaw.homepage` کے ذریعے بھی سپورٹڈ)۔
  - `user-invocable` — `true|false` (default: `true`). When `true`, the skill is exposed as a user slash command.
  - `disable-model-invocation` — `true|false` (default: `false`). When `true`, the skill is excluded from the model prompt (still available via user invocation).
  - `command-dispatch` — `tool` (optional). When set to `tool`, the slash command bypasses the model and dispatches directly to a tool.
  - `command-tool` — وہ tool نام جسے invoke کیا جائے جب `command-dispatch: tool` سیٹ ہو۔
  - `command-arg-mode` — `raw` (default). For tool dispatch, forwards the raw args string to the tool (no core parsing).

    tool کو ان params کے ساتھ invoke کیا جاتا ہے:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`۔

## گیٹنگ (لوڈ ٹائم فلٹرز)

OpenClaw **لوڈ ٹائم پر skills کو فلٹر کرتا ہے** بذریعہ `metadata` (سنگل لائن JSON):

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

`metadata.openclaw` کے تحت فیلڈز:

- `always: true` — ہمیشہ skill شامل کریں (دیگر گیٹس کو اسکیپ کریں)۔
- `emoji` — اختیاری ایموجی جو macOS Skills UI میں استعمال ہوتی ہے۔
- `homepage` — اختیاری URL جو macOS Skills UI میں “Website” کے طور پر دکھایا جاتا ہے۔
- `os` — optional list of platforms (`darwin`, `linux`, `win32`). If set, the skill is only eligible on those OSes.
- `requires.bins` — فہرست؛ ہر ایک کا `PATH` پر موجود ہونا لازم ہے۔
- `requires.anyBins` — فہرست؛ کم از کم ایک کا `PATH` پر موجود ہونا ضروری ہے۔
- `requires.env` — فہرست؛ env var کا موجود ہونا **یا** کنفیگ میں فراہم ہونا لازم ہے۔
- `requires.config` — `openclaw.json` راستوں کی فہرست جو truthy ہونے چاہئیں۔
- `primaryEnv` — env var name associated with `skills.entries.<name>.apiKey`.
- `install` — macOS Skills UI میں استعمال ہونے والی installer specs کی اختیاری array (brew/node/go/uv/download)۔

sandboxing پر نوٹ:

- `requires.bins` کو skill لوڈ ٹائم پر **ہوسٹ** پر چیک کیا جاتا ہے۔
- If an agent is sandboxed, the binary must also exist **inside the container**.
  Install it via `agents.defaults.sandbox.docker.setupCommand` (or a custom image).
  `setupCommand` runs once after the container is created.
  Package installs also require network egress, a writable root FS, and a root user in the sandbox.
  Example: the `summarize` skill (`skills/summarize/SKILL.md`) needs the `summarize` CLI
  in the sandbox container to run there.

Installer مثال:

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

نوٹس:

- اگر متعدد installers درج ہوں تو gateway **ایک** ترجیحی آپشن منتخب کرتا ہے (جب دستیاب ہو تو brew، ورنہ node)۔
- اگر تمام installers `download` ہوں تو OpenClaw ہر انٹری کی فہرست دکھاتا ہے تاکہ دستیاب artifacts نظر آ سکیں۔
- Installer specs میں پلیٹ فارم کے مطابق فلٹر کرنے کے لیے `os: ["darwin"|"linux"|"win32"]` شامل ہو سکتا ہے۔
- Node installs honor `skills.install.nodeManager` in `openclaw.json` (default: npm; options: npm/pnpm/yarn/bun).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun is not recommended for WhatsApp/Telegram).
- Go installs: اگر `go` غائب ہو اور `brew` دستیاب ہو تو gateway پہلے Homebrew کے ذریعے Go انسٹال کرتا ہے اور جہاں ممکن ہو `GOBIN` کو Homebrew کے `bin` پر سیٹ کرتا ہے۔
- Download installs: `url` (لازم)، `archive` (`tar.gz` | `tar.bz2` | `zip`)، `extract` (بطورِ طے شدہ: archive شناخت ہونے پر auto)، `stripComponents`، `targetDir` (بطورِ طے شدہ: `~/.openclaw/tools/<skillKey>`)۔

اگر کوئی `metadata.openclaw` موجود نہ ہو تو skill ہمیشہ اہل ہوتی ہے (الا یہ کہ
کنفیگ میں غیرفعال کی گئی ہو یا bundled skills کے لیے `skills.allowBundled` کے ذریعے بلاک ہو)۔

## کنفیگ overrides (`~/.openclaw/openclaw.json`)

Bundled/managed skills کو ٹوگل کیا جا سکتا ہے اور env ویلیوز فراہم کی جا سکتی ہیں:

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

نوٹ: اگر skill کے نام میں hyphens ہوں تو key کو کوٹ کریں (JSON5 کوٹڈ keys کی اجازت دیتا ہے)۔

Config keys match the **skill name** by default. If a skill defines
`metadata.openclaw.skillKey`, use that key under `skills.entries`.

قواعد:

- `enabled: false` skill کو غیر فعال کر دیتا ہے چاہے وہ bundled/installed ہو۔
- `env`: **صرف اسی صورت** inject ہوتا ہے جب ویری ایبل پہلے سے پروسیس میں سیٹ نہ ہو۔
- `apiKey`: اُن skills کے لیے سہولت جو `metadata.openclaw.primaryEnv` کا اعلان کرتی ہیں۔
- `config`: custom فی-skill فیلڈز کے لیے اختیاری bag؛ custom keys لازماً یہیں ہوں۔
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).

## ماحول کی انجیکشن (ہر ایجنٹ رن کے لیے)

جب ایجنٹ رن شروع ہوتا ہے تو OpenClaw:

1. skill میٹاڈیٹا پڑھتا ہے۔
2. Applies any `skills.entries.<key>.env` or `skills.entries.<key>.apiKey` to
   `process.env`.
3. **اہل** skills کے ساتھ سسٹم prompt بناتا ہے۔
4. رن ختم ہونے کے بعد اصل ماحول بحال کر دیتا ہے۔

یہ **ایجنٹ رن تک محدود** ہے، کوئی عالمی شیل ماحول نہیں۔

## سیشن اسنیپ شاٹ (کارکردگی)

OpenClaw snapshots the eligible skills **when a session starts** and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.

Skills can also refresh mid-session when the skills watcher is enabled or when a new eligible remote node appears (see below). Think of this as a **hot reload**: the refreshed list is picked up on the next agent turn.

## ریموٹ macOS نوڈز (Linux gateway)

If the Gateway is running on Linux but a **macOS node** is connected **with `system.run` allowed** (Exec approvals security not set to `deny`), OpenClaw can treat macOS-only skills as eligible when the required binaries are present on that node. The agent should execute those skills via the `nodes` tool (typically `nodes.run`).

This relies on the node reporting its command support and on a bin probe via `system.run`. اگر macOS نوڈ بعد میں آف لائن ہو جائے تو اسکلز نظر آتی رہیں گی؛ نوڈ کے دوبارہ جڑنے تک ان کی کالز ناکام ہو سکتی ہیں۔

## Skills watcher (خودکار ریفریش)

بطورِ ڈیفالٹ، OpenClaw اسکل فولڈرز پر نظر رکھتا ہے اور جب `SKILL.md` فائلیں بدلتی ہیں تو اسکلز اسنیپ شاٹ کو اپڈیٹ کرتا ہے۔ اسے `skills.load` کے تحت کنفیگر کریں:

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

## ٹوکن اثر (skills فہرست)

جب اسکلز اہل ہوں، OpenClaw دستیاب اسکلز کی ایک مختصر XML فہرست سسٹم پرامپٹ میں داخل کرتا ہے ( `pi-coding-agent` میں `formatSkillsForPrompt` کے ذریعے)۔ لاگت متعین (deterministic) ہے:

- **بنیادی اوورہیڈ (صرف جب ≥1 skill ہو):** 195 حروف۔
- **فی skill:** 97 حروف + XML-escaped `<name>`, `<description>`, اور `<location>` ویلیوز کی لمبائی۔

فارمولا (حروف):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

نوٹس:

- XML escaping، `& < > " '` کو entities (`&amp;`, `&lt;`, وغیرہ) میں پھیلا دیتا ہے، جس سے لمبائی بڑھتی ہے۔
- ٹوکن کی گنتی ماڈل کے ٹوکنائزر کے مطابق مختلف ہوتی ہے۔ OpenAI طرز کے ایک اندازے کے مطابق ~4 حروف/ٹوکن ہوتے ہیں، اس لیے **97 حروف ≈ 24 ٹوکن** فی اسکل، اس کے علاوہ آپ کے اصل فیلڈ کی لمبائیاں۔

## Managed skills لائف سائیکل

OpenClaw انسٹال کے حصے کے طور پر اسکلز کا ایک بنیادی سیٹ **bundled skills** کے طور پر فراہم کرتا ہے (npm پیکج یا OpenClaw.app)۔ `~/.openclaw/skills` مقامی اووررائیڈز کے لیے موجود ہے (مثلاً bundled کاپی بدلے بغیر کسی اسکل کو پن یا پیچ کرنا)۔ ورک اسپیس اسکلز صارف کی ملکیت ہوتی ہیں اور نام کے ٹکراؤ کی صورت میں دونوں کو اووررائیڈ کرتی ہیں۔

## کنفیگ حوالہ

مکمل کنفیگریشن اسکیمہ کے لیے [Skills config](/tools/skills-config) دیکھیں۔

## مزید skills تلاش کر رہے ہیں؟

ملاحظہ کریں [https://clawhub.com](https://clawhub.com)۔

---
