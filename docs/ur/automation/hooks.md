---
summary: "ہُکس: کمانڈز اور لائف سائیکل ایونٹس کے لیے ایونٹ پر مبنی خودکاری"
read_when:
  - آپ کو /new، /reset، /stop، اور ایجنٹ لائف سائیکل ایونٹس کے لیے ایونٹ پر مبنی خودکاری درکار ہو
  - آپ ہُکس بنانا، انسٹال کرنا، یا ڈیبگ کرنا چاہتے ہوں
title: "ہُکس"
---

# ہُکس

3. Hooks ایک قابلِ توسیع، ایونٹ پر مبنی نظام فراہم کرتے ہیں جو ایجنٹ کمانڈز اور ایونٹس کے جواب میں خودکار کارروائیوں کے لیے استعمال ہوتا ہے۔ 4. Hooks ڈائریکٹریز سے خودکار طور پر دریافت ہوتے ہیں اور CLI کمانڈز کے ذریعے منظم کیے جا سکتے ہیں، بالکل اسی طرح جیسے OpenClaw میں skills کام کرتی ہیں۔

## Getting Oriented

5. Hooks چھوٹے اسکرپٹس ہوتے ہیں جو کسی واقعے کے ہونے پر چلتے ہیں۔ 6. ان کی دو اقسام ہیں:

- **Hooks** (یہ صفحہ): Gateway کے اندر چلتے ہیں جب ایجنٹ ایونٹس فائر ہوتے ہیں، جیسے `/new`, `/reset`, `/stop`, یا لائف سائیکل ایونٹس۔
- 7. **Webhooks**: بیرونی HTTP ویب ہوکس جو دوسرے سسٹمز کو OpenClaw میں کام شروع کرنے دیتے ہیں۔ 8. [Webhook Hooks](/automation/webhook) دیکھیں یا Gmail ہیلپر کمانڈز کے لیے `openclaw webhooks` استعمال کریں۔

ہُکس پلگ اِنز کے اندر بھی بنڈل کیے جا سکتے ہیں؛ دیکھیں [Plugins](/tools/plugin#plugin-hooks)۔

عام استعمالات:

- سیشن ری سیٹ کرنے پر میموری اسنیپ شاٹ محفوظ کرنا
- خرابیوں کے ازالے یا تعمیل کے لیے کمانڈز کا آڈٹ ٹریل رکھنا
- سیشن شروع یا ختم ہونے پر فالو اَپ خودکاری ٹرگر کرنا
- ایونٹس کے فائر ہونے پر ایجنٹ ورک اسپیس میں فائلیں لکھنا یا بیرونی APIs کال کرنا

9. اگر آپ ایک چھوٹا TypeScript فنکشن لکھ سکتے ہیں، تو آپ ایک hook لکھ سکتے ہیں۔ 10. Hooks خودکار طور پر دریافت ہوتے ہیں، اور آپ انہیں CLI کے ذریعے فعال یا غیر فعال کرتے ہیں۔

## Overview

ہُکس سسٹم آپ کو یہ سہولت دیتا ہے کہ آپ:

- جب `/new` جاری کیا جائے تو سیشن سیاق کو میموری میں محفوظ کریں
- آڈٹنگ کے لیے تمام کمانڈز لاگ کریں
- ایجنٹ لائف سائیکل ایونٹس پر حسبِ ضرورت خودکاری ٹرگر کریں
- کور کوڈ میں ترمیم کیے بغیر OpenClaw کے رویّے کو وسعت دیں

## Getting Started

### Bundled Hooks

OpenClaw چار بنڈل شدہ ہُکس کے ساتھ آتا ہے جو خودکار طور پر دریافت ہو جاتے ہیں:

- **💾 session-memory**: جب آپ `/new` جاری کرتے ہیں تو سیشن سیاق کو آپ کے ایجنٹ ورک اسپیس میں (بطورِ طے شدہ `~/.openclaw/workspace/memory/`) محفوظ کرتا ہے
- **📝 command-logger**: تمام کمانڈ ایونٹس کو `~/.openclaw/logs/commands.log` میں لاگ کرتا ہے
- **🚀 boot-md**: گیٹ وے کے شروع ہونے پر `BOOT.md` چلاتا ہے (اندرونی ہُکس کے فعال ہونے کی ضرورت)
- **😈 soul-evil**: purge ونڈو کے دوران یا اتفاقی امکان سے injected `SOUL.md` مواد کو `SOUL_EVIL.md` سے بدل دیتا ہے

دستیاب ہُکس کی فہرست:

```bash
openclaw hooks list
```

ہُک فعال کریں:

```bash
openclaw hooks enable session-memory
```

ہُک کی حالت چیک کریں:

```bash
openclaw hooks check
```

تفصیلی معلومات حاصل کریں:

```bash
openclaw hooks info session-memory
```

### Onboarding

11. آن بورڈنگ کے دوران (`openclaw onboard`)، آپ سے تجویز کردہ hooks کو فعال کرنے کے لیے کہا جائے گا۔ 12. وزارڈ خودکار طور پر موزوں hooks دریافت کرتا ہے اور انتخاب کے لیے پیش کرتا ہے۔

## Hook Discovery

ہُکس تین ڈائریکٹریز سے خودکار طور پر دریافت ہوتے ہیں (ترجیح کی ترتیب میں):

1. **Workspace hooks**: `<workspace>/hooks/` (ہر ایجنٹ کے لیے، سب سے زیادہ ترجیح)
2. **Managed hooks**: `~/.openclaw/hooks/` (یوزر کے ذریعے انسٹال شدہ، ورک اسپیسز میں مشترک)
3. **Bundled hooks**: `<openclaw>/dist/hooks/bundled/` (OpenClaw کے ساتھ فراہم کردہ)

Managed ہُک ڈائریکٹریز یا تو **ایک ہُک** ہو سکتی ہیں یا **ہُک پیک** (پیکیج ڈائریکٹری)۔

ہر ہُک ایک ڈائریکٹری ہوتی ہے جس میں شامل ہوتا ہے:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

13. Hook packs معیاری npm پیکجز ہوتے ہیں جو `package.json` میں `openclaw.hooks` کے ذریعے ایک یا زیادہ hooks ایکسپورٹ کرتے ہیں۔ 14. انہیں انسٹال کریں بذریعہ:

```bash
openclaw hooks install <path-or-spec>
```

مثالی `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

15. ہر اندراج ایک hook ڈائریکٹری کی طرف اشارہ کرتا ہے جس میں `HOOK.md` اور `handler.ts` (یا `index.ts`) شامل ہوتے ہیں۔
16. Hook packs اپنے dependencies کے ساتھ آ سکتے ہیں؛ یہ `~/.openclaw/hooks/<id>` کے تحت انسٹال ہوں گے۔

## Hook Structure

### HOOK.md Format

`HOOK.md` فائل میں YAML فرنٹ میٹر میں میٹا ڈیٹا اور اس کے بعد Markdown دستاویزات ہوتی ہیں:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Detailed documentation goes here...

## What It Does

- Listens for `/new` commands
- Performs some action
- Logs the result

## Requirements

- Node.js must be installed

## Configuration

No configuration needed.
```

### Metadata Fields

`metadata.openclaw` آبجیکٹ درج ذیل کی حمایت کرتا ہے:

- **`emoji`**: CLI کے لیے ڈسپلے ایموجی (مثلاً `"💾"`)
- **`events`**: سننے کے لیے ایونٹس کی فہرست (مثلاً `["command:new", "command:reset"]`)
- **`export`**: استعمال کے لیے نامزد ایکسپورٹ (بطورِ طے شدہ `"default"`)
- **`homepage`**: دستاویزات کا URL
- **`requires`**: اختیاری تقاضے
  - **`bins`**: PATH میں درکار بائنریز (مثلاً `["git", "node"]`)
  - **`anyBins`**: ان میں سے کم از کم ایک بائنری موجود ہونی چاہیے
  - **`env`**: درکار ماحولیاتی متغیرات
  - **`config`**: درکار کنفیگ راستے (مثلاً `["workspace.dir"]`)
  - **`os`**: درکار پلیٹ فارمز (مثلاً `["darwin", "linux"]`)
- **`always`**: اہلیت کی جانچ کو بائی پاس کریں (boolean)
- **`install`**: انسٹالیشن کے طریقے (بنڈل ہُکس کے لیے: `[{"id":"bundled","kind":"bundled"}]`)

### Handler Implementation

`handler.ts` فائل ایک `HookHandler` فنکشن ایکسپورٹ کرتی ہے:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // Your custom logic here

  // Optionally send message to user
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### Event Context

ہر ایونٹ میں شامل ہوتا ہے:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // e.g., 'new', 'reset', 'stop'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## Event Types

### Command Events

ایجنٹ کمانڈز کے جاری ہونے پر ٹرگر ہوتے ہیں:

- **`command`**: تمام کمانڈ ایونٹس (عمومی لسٹنر)
- **`command:new`**: جب `/new` کمانڈ جاری ہو
- **`command:reset`**: جب `/reset` کمانڈ جاری ہو
- **`command:stop`**: جب `/stop` کمانڈ جاری ہو

### Agent Events

- **`agent:bootstrap`**: ورک اسپیس بوٹ اسٹرَیپ فائلز کے انجیکٹ ہونے سے پہلے (ہُکس `context.bootstrapFiles` کو تبدیل کر سکتے ہیں)

### Gateway Events

گیٹ وے کے شروع ہونے پر ٹرگر ہوتے ہیں:

- **`gateway:startup`**: چینلز کے شروع ہونے اور ہُکس کے لوڈ ہونے کے بعد

### Tool Result Hooks (Plugin API)

یہ ہُکس ایونٹ اسٹریم لسٹنرز نہیں ہیں؛ یہ پلگ اِنز کو اجازت دیتے ہیں کہ OpenClaw کے محفوظ کرنے سے پہلے ٹول نتائج کو ہم وقتی طور پر ایڈجسٹ کریں۔

- 17. **`tool_result_persist`**: ٹول کے نتائج کو سیشن ٹرانسکرپٹ میں لکھنے سے پہلے تبدیل کریں۔ 18. لازمی طور پر synchronous ہونا چاہیے؛ اپڈیٹ شدہ ٹول رزلٹ payload واپس کریں یا جیسا ہے ویسا رکھنے کے لیے `undefined` لوٹائیں۔ 19. [Agent Loop](/concepts/agent-loop) دیکھیں۔

### Future Events

منصوبہ بند ایونٹس:

- **`session:start`**: جب نیا سیشن شروع ہو
- **`session:end`**: جب سیشن ختم ہو
- **`agent:error`**: جب ایجنٹ کو کوئی خرابی پیش آئے
- **`message:sent`**: جب کوئی پیغام بھیجا جائے
- **`message:received`**: جب کوئی پیغام موصول ہو

## Creating Custom Hooks

### 20. 1. 21. مقام منتخب کریں

- **Workspace hooks** (`<workspace>/hooks/`): ہر ایجنٹ کے لیے، سب سے زیادہ ترجیح
- **Managed hooks** (`~/.openclaw/hooks/`): ورک اسپیسز میں مشترک

### 22. 2. 23. ڈائریکٹری اسٹرکچر بنائیں

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 24. 3. HOOK.md بنائیں

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 25. 4. 26. handler.ts بنائیں

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // Your logic here
};

export default handler;
```

### 27. 5. 28. فعال کریں اور ٹیسٹ کریں

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Configuration

### New Config Format (Recommended)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### Per-Hook Configuration

ہُکس میں حسبِ ضرورت کنفیگریشن ہو سکتی ہے:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### Extra Directories

اضافی ڈائریکٹریز سے ہُکس لوڈ کریں:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### Legacy Config Format (Still Supported)

پرانی کنفیگ فارمیٹ پچھلی مطابقت کے لیے اب بھی کام کرتی ہے:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

**Migration**: Use the new discovery-based system for new hooks. 30. لیگیسی handlers کو ڈائریکٹری پر مبنی hooks کے بعد لوڈ کیا جاتا ہے۔

## CLI Commands

### List Hooks

```bash
# List all hooks
openclaw hooks list

# Show only eligible hooks
openclaw hooks list --eligible

# Verbose output (show missing requirements)
openclaw hooks list --verbose

# JSON output
openclaw hooks list --json
```

### Hook Information

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Check Eligibility

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### Enable/Disable

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Bundled hook reference

### session-memory

جب آپ `/new` جاری کرتے ہیں تو سیشن سیاق کو میموری میں محفوظ کرتا ہے۔

**Events**: `command:new`

**Requirements**: `workspace.dir` کنفیگر ہونا لازم ہے

**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md` (بطورِ طے شدہ `~/.openclaw/workspace`)

**What it does**:

1. درست ٹرانسکرپٹ تلاش کرنے کے لیے پری ری سیٹ سیشن انٹری استعمال کرتا ہے
2. گفتگو کی آخری 15 سطریں نکالتا ہے
3. وضاحتی فائل نیم سلاگ بنانے کے لیے LLM استعمال کرتا ہے
4. سیشن میٹا ڈیٹا کو تاریخ وار میموری فائل میں محفوظ کرتا ہے

**Example output**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Filename examples**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (اگر سلاگ جنریشن ناکام ہو تو فال بیک ٹائم اسٹیمپ)

**Enable**:

```bash
openclaw hooks enable session-memory
```

### command-logger

تمام کمانڈ ایونٹس کو ایک مرکزی آڈٹ فائل میں لاگ کرتا ہے۔

**Events**: `command`

**Requirements**: کوئی نہیں

**Output**: `~/.openclaw/logs/commands.log`

**What it does**:

1. ایونٹ کی تفصیلات محفوظ کرتا ہے (کمانڈ ایکشن، ٹائم اسٹیمپ، سیشن کی، بھیجنے والے کی ID، ماخذ)
2. JSONL فارمیٹ میں لاگ فائل میں شامل کرتا ہے
3. پس منظر میں خاموشی سے چلتا ہے

**Example log entries**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**View logs**:

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Enable**:

```bash
openclaw hooks enable command-logger
```

### soul-evil

purge ونڈو کے دوران یا اتفاقی امکان سے injected `SOUL.md` مواد کو `SOUL_EVIL.md` سے بدل دیتا ہے۔

**Events**: `agent:bootstrap`

**Docs**: [SOUL Evil Hook](/hooks/soul-evil)

**Output**: کوئی فائل نہیں لکھی جاتی؛ تبدیلیاں صرف میموری میں ہوتی ہیں۔

**Enable**:

```bash
openclaw hooks enable soul-evil
```

**Config**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### boot-md

gateway کے شروع ہونے پر (چینلز کے شروع ہونے کے بعد) `BOOT.md` چلاتا ہے۔
31. اس کے چلنے کے لیے اندرونی hooks کو فعال ہونا ضروری ہے۔

**Events**: `gateway:startup`

**Requirements**: `workspace.dir` کنفیگر ہونا لازم ہے

**What it does**:

1. آپ کے ورک اسپیس سے `BOOT.md` پڑھتا ہے
2. ہدایات کو ایجنٹ رنر کے ذریعے چلاتا ہے
3. میسج ٹول کے ذریعے کسی بھی درکار آؤٹ باؤنڈ پیغامات بھیجتا ہے

**Enable**:

```bash
openclaw hooks enable boot-md
```

## Best Practices

### Keep Handlers Fast

32. Hooks کمانڈ پروسیسنگ کے دوران چلتے ہیں۔ 33. انہیں ہلکا پھلکا رکھیں:

```typescript
// ✓ Good - async work, returns immediately
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Bad - blocks command processing
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Handle Errors Gracefully

ہمیشہ خطرناک آپریشنز کو ریپ کریں:

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // Don't throw - let other handlers run
  }
};
```

### Filter Events Early

اگر ایونٹ متعلقہ نہیں تو فوراً واپس آ جائیں:

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Use Specific Event Keys

جہاں ممکن ہو میٹا ڈیٹا میں مخصوص ایونٹس درج کریں:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

اس کے بجائے:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Debugging

### Enable Hook Logging

گیٹ وے اسٹارٹ اپ پر ہُک لوڈنگ لاگ کرتا ہے:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Check Discovery

تمام دریافت شدہ ہُکس کی فہرست بنائیں:

```bash
openclaw hooks list --verbose
```

### Check Registration

اپنے ہینڈلر میں، کال ہونے پر لاگ کریں:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Verify Eligibility

چیک کریں کہ ہُک اہل کیوں نہیں ہے:

```bash
openclaw hooks info my-hook
```

آؤٹ پٹ میں گمشدہ تقاضوں کو دیکھیں۔

## Testing

### Gateway Logs

ہُک کے نفاذ کو دیکھنے کے لیے گیٹ وے لاگز مانیٹر کریں:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Test Hooks Directly

اپنے ہینڈلرز کو تنہا حالت میں ٹیسٹ کریں:

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Assert side effects
});
```

## Architecture

### Core Components

- **`src/hooks/types.ts`**: ٹائپ کی تعریفیں
- **`src/hooks/workspace.ts`**: ڈائریکٹری اسکیننگ اور لوڈنگ
- **`src/hooks/frontmatter.ts`**: HOOK.md میٹا ڈیٹا پارسنگ
- **`src/hooks/config.ts`**: اہلیت کی جانچ
- **`src/hooks/hooks-status.ts`**: اسٹیٹس رپورٹنگ
- **`src/hooks/loader.ts`**: ڈائنامک ماڈیول لوڈر
- **`src/cli/hooks-cli.ts`**: CLI کمانڈز
- **`src/gateway/server-startup.ts`**: گیٹ وے اسٹارٹ پر ہُکس لوڈ کرتا ہے
- **`src/auto-reply/reply/commands-core.ts`**: کمانڈ ایونٹس ٹرگر کرتا ہے

### Discovery Flow

```
Gateway startup
    ↓
Scan directories (workspace → managed → bundled)
    ↓
Parse HOOK.md files
    ↓
Check eligibility (bins, env, config, os)
    ↓
Load handlers from eligible hooks
    ↓
Register handlers for events
```

### Event Flow

```
User sends /new
    ↓
Command validation
    ↓
Create hook event
    ↓
Trigger hook (all registered handlers)
    ↓
Command processing continues
    ↓
Session reset
```

## Troubleshooting

### Hook Not Discovered

1. ڈائریکٹری اسٹرکچر چیک کریں:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. HOOK.md فارمیٹ کی تصدیق کریں:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. تمام دریافت شدہ ہُکس کی فہرست بنائیں:

   ```bash
   openclaw hooks list
   ```

### Hook Not Eligible

تقاضے چیک کریں:

```bash
openclaw hooks info my-hook
```

گمشدہ چیزیں دیکھیں:

- بائنریز (PATH چیک کریں)
- ماحولیاتی متغیرات
- کنفیگ اقدار
- OS مطابقت

### Hook Not Executing

1. تصدیق کریں کہ ہُک فعال ہے:

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. ہُکس کے دوبارہ لوڈ ہونے کے لیے گیٹ وے پروسیس ری اسٹارٹ کریں۔

3. غلطیوں کے لیے گیٹ وے لاگز چیک کریں:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Handler Errors

TypeScript/امپورٹ غلطیوں کے لیے چیک کریں:

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Migration Guide

### From Legacy Config to Discovery

**Before**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**After**:

1. ہُک ڈائریکٹری بنائیں:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. HOOK.md بنائیں:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. کنفیگ اپ ڈیٹ کریں:

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. تصدیق کریں اور گیٹ وے پروسیس ری اسٹارٹ کریں:

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Benefits of migration**:

- خودکار دریافت
- CLI مینجمنٹ
- اہلیت کی جانچ
- بہتر دستاویزات
- یکساں اسٹرکچر

## See Also

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
