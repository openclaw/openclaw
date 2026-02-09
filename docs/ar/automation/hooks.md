---
summary: "Hooks: أتمتة قائمة على الأحداث للأوامر وأحداث دورة الحياة"
read_when:
  - تريد أتمتة قائمة على الأحداث لأوامر /new و/reset و/stop وأحداث دورة حياة الوكيل
  - تريد بناء أو تثبيت أو تصحيح Hooks
title: "Hooks"
---

# Hooks

توفر Hooks نظامًا قابلاً للتوسعة قائمًا على الأحداث لأتمتة الإجراءات استجابةً لأوامر الوكيل والأحداث. يتم اكتشاف Hooks تلقائيًا من الأدلة، ويمكن إدارتها عبر أوامر CLI، على نحو مشابه لكيفية عمل Skills في OpenClaw.

## Getting Oriented

تُعد Hooks سكربتات صغيرة تعمل عند حدوث شيء ما. وهناك نوعان:

- **Hooks** (هذه الصفحة): تعمل داخل Gateway عند إطلاق أحداث الوكيل، مثل `/new` و`/reset` و`/stop`، أو أحداث دورة الحياة.
- **Webhooks**: Webhooks خارجية عبر HTTP تتيح لأنظمة أخرى تشغيل مهام داخل OpenClaw. راجع [Webhook Hooks](/automation/webhook) أو استخدم `openclaw webhooks` لأوامر مساعد Gmail.

يمكن أيضًا تضمين Hooks داخل الإضافات؛ راجع [Plugins](/tools/plugin#plugin-hooks).

الاستخدامات الشائعة:

- حفظ لقطة ذاكرة عند إعادة تعيين جلسة
- الاحتفاظ بسجل تدقيق للأوامر لأغراض استكشاف الأخطاء وإصلاحها أو الامتثال
- تشغيل أتمتة لاحقة عند بدء الجلسة أو انتهائها
- كتابة ملفات داخل مساحة عمل الوكيل أو استدعاء واجهات برمجة تطبيقات خارجية عند إطلاق الأحداث

إذا كنت تستطيع كتابة دالة TypeScript صغيرة، فيمكنك كتابة Hook. يتم اكتشاف Hooks تلقائيًا، ويمكنك تمكينها أو تعطيلها عبر CLI.

## Overview

يتيح لك نظام Hooks ما يلي:

- حفظ سياق الجلسة في الذاكرة عند إصدار `/new`
- تسجيل جميع الأوامر لأغراض التدقيق
- تشغيل أتمتة مخصصة عند أحداث دورة حياة الوكيل
- توسيع سلوك OpenClaw دون تعديل الشيفرة الأساسية

## Getting Started

### Bundled Hooks

يأتي OpenClaw مع أربع Hooks مضمّنة يتم اكتشافها تلقائيًا:

- **💾 session-memory**: يحفظ سياق الجلسة في مساحة عمل الوكيل (الافتراضي `~/.openclaw/workspace/memory/`) عند إصدار `/new`
- **📝 command-logger**: يسجل جميع أحداث الأوامر إلى `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: يشغّل `BOOT.md` عند بدء Gateway (يتطلب تمكين Hooks الداخلية)
- **😈 soul-evil**: يستبدل محتوى `SOUL.md` المُحقن بـ `SOUL_EVIL.md` خلال نافذة تطهير أو باحتمال عشوائي

عرض Hooks المتاحة:

```bash
openclaw hooks list
```

تمكين Hook:

```bash
openclaw hooks enable session-memory
```

التحقق من حالة Hook:

```bash
openclaw hooks check
```

الحصول على معلومات تفصيلية:

```bash
openclaw hooks info session-memory
```

### Onboarding

أثناء التهيئة الأولية (`openclaw onboard`)، سيُطلب منك تمكين Hooks الموصى بها. يقوم معالج الإعداد باكتشاف Hooks المؤهلة تلقائيًا وعرضها للاختيار.

## Hook Discovery

يتم اكتشاف Hooks تلقائيًا من ثلاثة أدلة (حسب أولوية الترتيب):

1. **Workspace hooks**: ‏`<workspace>/hooks/` (لكل وكيل، أعلى أولوية)
2. **Managed hooks**: ‏`~/.openclaw/hooks/` (مثبّتة من المستخدم، مشتركة عبر مساحات العمل)
3. **Bundled hooks**: ‏`<openclaw>/dist/hooks/bundled/` (مضمّنة مع OpenClaw)

يمكن أن تكون أدلة Managed hooks إما **Hook واحدة** أو **حزمة Hooks** (دليل حِزمي).

تتكون كل Hook من دليل يحتوي على:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

حزم Hooks هي حزم npm قياسية تُصدّر Hook واحدة أو أكثر عبر `openclaw.hooks` في
`package.json`. ثبّتها باستخدام:

```bash
openclaw hooks install <path-or-spec>
```

مثال `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

يشير كل إدخال إلى دليل Hook يحتوي على `HOOK.md` و`handler.ts` (أو `index.ts`).
يمكن لحزم Hooks شحن تبعيات؛ وسيتم تثبيتها ضمن `~/.openclaw/hooks/<id>`.

## Hook Structure

### HOOK.md Format

يحتوي ملف `HOOK.md` على بيانات وصفية في واجهة YAML الأمامية بالإضافة إلى توثيق Markdown:

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

يدعم كائن `metadata.openclaw` ما يلي:

- **`emoji`**: رمز تعبيري للعرض في CLI (مثل `"💾"`)
- **`events`**: مصفوفة بالأحداث المراد الاستماع إليها (مثل `["command:new", "command:reset"]`)
- **`export`**: التصدير المسمّى المراد استخدامه (الافتراضي `"default"`)
- **`homepage`**: رابط التوثيق
- **`requires`**: متطلبات اختيارية
  - **`bins`**: الثنائيات المطلوبة على PATH (مثل `["git", "node"]`)
  - **`anyBins`**: يجب توفر واحد على الأقل من هذه الثنائيات
  - **`env`**: متغيرات البيئة المطلوبة
  - **`config`**: مسارات التهيئة المطلوبة (مثل `["workspace.dir"]`)
  - **`os`**: الأنظمة الأساسية المطلوبة (مثل `["darwin", "linux"]`)
- **`always`**: تجاوز فحوصات الأهلية (قيمة منطقية)
- **`install`**: طرق التثبيت (بالنسبة للـ Hooks المضمّنة: `[{"id":"bundled","kind":"bundled"}]`)

### Handler Implementation

يُصدّر ملف `handler.ts` دالة `HookHandler`:

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

يتضمن كل حدث:

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

تُطلق عند إصدار أوامر الوكيل:

- **`command`**: جميع أحداث الأوامر (مستمع عام)
- **`command:new`**: عند إصدار أمر `/new`
- **`command:reset`**: عند إصدار أمر `/reset`
- **`command:stop`**: عند إصدار أمر `/stop`

### Agent Events

- **`agent:bootstrap`**: قبل حقن ملفات تهيئة مساحة العمل (قد تُعدّل Hooks ‏`context.bootstrapFiles`)

### Gateway Events

تُطلق عند بدء Gateway:

- **`gateway:startup`**: بعد بدء القنوات وتحميل Hooks

### Tool Result Hooks (Plugin API)

هذه Hooks ليست مستمعات لتدفق الأحداث؛ بل تتيح للإضافات تعديل نتائج الأدوات بشكل متزامن قبل أن يحفظها OpenClaw.

- **`tool_result_persist`**: تحويل نتائج الأداة قبل كتابتها في سجل الجلسة. يجب أن تكون متزامنة؛ أعد حمولة نتيجة الأداة المُحدّثة أو `undefined` للإبقاء عليها كما هي. راجع [Agent Loop](/concepts/agent-loop).

### Future Events

أنواع أحداث مخططة:

- **`session:start`**: عند بدء جلسة جديدة
- **`session:end`**: عند انتهاء جلسة
- **`agent:error`**: عند مواجهة الوكيل خطأً
- **`message:sent`**: عند إرسال رسالة
- **`message:received`**: عند استلام رسالة

## Creating Custom Hooks

### 1. Choose Location

- **Workspace hooks** (`<workspace>/hooks/`): لكل وكيل، أعلى أولوية
- **Managed hooks** (`~/.openclaw/hooks/`): مشتركة عبر مساحات العمل

### 2. Create Directory Structure

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Create HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. Create handler.ts

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

### 5. Enable and Test

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

يمكن أن تمتلك Hooks تهيئة مخصصة:

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

تحميل Hooks من أدلة إضافية:

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

لا يزال تنسيق التهيئة القديم مدعومًا للتوافق العكسي:

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

**الترحيل**: استخدم نظام الاكتشاف الجديد المعتمد على الأدلة للـ Hooks الجديدة. يتم تحميل المعالِجات القديمة بعد Hooks المعتمدة على الأدلة.

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

يحفظ سياق الجلسة في الذاكرة عند إصدار `/new`.

**Events**: `command:new`

**Requirements**: يجب تهيئة `workspace.dir`

**Output**: ‏`<workspace>/memory/YYYY-MM-DD-slug.md` (الافتراضي `~/.openclaw/workspace`)

**What it does**:

1. يستخدم إدخال الجلسة قبل إعادة التعيين لتحديد النص الكامل الصحيح
2. يستخرج آخر 15 سطرًا من المحادثة
3. يستخدم LLM لتوليد اسم ملف وصفي (slug)
4. يحفظ بيانات الجلسة الوصفية في ملف ذاكرة مؤرخ

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
- `2026-01-16-1430.md` (طابع زمني احتياطي إذا فشل توليد الاسم)

**Enable**:

```bash
openclaw hooks enable session-memory
```

### command-logger

يسجل جميع أحداث الأوامر إلى ملف تدقيق مركزي.

**Events**: `command`

**Requirements**: لا شيء

**Output**: ‏`~/.openclaw/logs/commands.log`

**What it does**:

1. يلتقط تفاصيل الحدث (إجراء الأمر، الطابع الزمني، مفتاح الجلسة، معرّف المُرسِل، المصدر)
2. يُلحِق السجل بملف بتنسيق JSONL
3. يعمل بصمت في الخلفية

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

يستبدل محتوى `SOUL.md` المُحقن بـ `SOUL_EVIL.md` خلال نافذة تطهير أو باحتمال عشوائي.

**Events**: `agent:bootstrap`

**Docs**: [SOUL Evil Hook](/hooks/soul-evil)

**Output**: لا يتم كتابة ملفات؛ تتم عمليات الاستبدال في الذاكرة فقط.

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

يشغّل `BOOT.md` عند بدء Gateway (بعد بدء القنوات).
يجب تمكين Hooks الداخلية لتعمل.

**Events**: `gateway:startup`

**Requirements**: يجب تهيئة `workspace.dir`

**What it does**:

1. يقرأ `BOOT.md` من مساحة عملك
2. ينفّذ التعليمات عبر مُشغّل الوكيل
3. يرسل أي رسائل صادرة مطلوبة عبر أداة الرسائل

**Enable**:

```bash
openclaw hooks enable boot-md
```

## Best Practices

### Keep Handlers Fast

تعمل Hooks أثناء معالجة الأوامر. اجعلها خفيفة:

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

قم دائمًا بتغليف العمليات الخطِرة:

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

أعِد الخروج مبكرًا إذا لم يكن الحدث ذا صلة:

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

حدّد أحداثًا دقيقة في البيانات الوصفية كلما أمكن:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

بدلاً من:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Debugging

### Enable Hook Logging

يسجّل Gateway تحميل Hooks عند بدء التشغيل:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Check Discovery

اعرض جميع Hooks المكتشفة:

```bash
openclaw hooks list --verbose
```

### Check Registration

في المعالج الخاص بك، سجل عند استدعائه:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Verify Eligibility

تحقق من سبب عدم أهلية Hook:

```bash
openclaw hooks info my-hook
```

ابحث عن متطلبات مفقودة في المخرجات.

## Testing

### Gateway Logs

راقب سجلات Gateway لرؤية تنفيذ Hooks:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Test Hooks Directly

اختبر المعالِجات بشكل معزول:

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

- **`src/hooks/types.ts`**: تعريفات الأنواع
- **`src/hooks/workspace.ts`**: فحص الأدلة والتحميل
- **`src/hooks/frontmatter.ts`**: تحليل بيانات HOOK.md الوصفية
- **`src/hooks/config.ts`**: التحقق من الأهلية
- **`src/hooks/hooks-status.ts`**: الإبلاغ عن الحالة
- **`src/hooks/loader.ts`**: محمّل الوحدات الديناميكي
- **`src/cli/hooks-cli.ts`**: أوامر CLI
- **`src/gateway/server-startup.ts`**: تحميل Hooks عند بدء Gateway
- **`src/auto-reply/reply/commands-core.ts`**: إطلاق أحداث الأوامر

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

1. تحقق من بنية الدليل:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. تحقق من تنسيق HOOK.md:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. اعرض جميع Hooks المكتشفة:

   ```bash
   openclaw hooks list
   ```

### Hook Not Eligible

تحقق من المتطلبات:

```bash
openclaw hooks info my-hook
```

ابحث عن المفقود:

- الثنائيات (تحقق من PATH)
- متغيرات البيئة
- قيم التهيئة
- توافق نظام التشغيل

### Hook Not Executing

1. تحقق من تمكين Hook:

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. أعد تشغيل عملية Gateway لإعادة تحميل Hooks.

3. تحقق من سجلات Gateway بحثًا عن أخطاء:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Handler Errors

تحقق من أخطاء TypeScript/الاستيراد:

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

1. أنشئ دليل Hook:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. أنشئ HOOK.md:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. تحديث الإعداد:

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

4. تحقّق وأعد تشغيل عملية Gateway:

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Benefits of migration**:

- الاكتشاف التلقائي
- إدارة عبر CLI
- التحقق من الأهلية
- توثيق أفضل
- بنية متسقة

## See Also

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
