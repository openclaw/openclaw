---
summary: "OpenClaw میں sandboxing کیسے کام کرتا ہے: موڈز، اسکوپس، ورک اسپیس رسائی، اور امیجز"
title: Sandboxing
read_when: "جب آپ کو sandboxing کی مخصوص وضاحت درکار ہو یا agents.defaults.sandbox کو ٹیون کرنا ہو۔"
status: active
x-i18n:
  source_path: gateway/sandboxing.md
  source_hash: c1bb7fd4ac37ef73
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:33Z
---

# Sandboxing

OpenClaw **ٹولز کو Docker کنٹینرز کے اندر** چلا سکتا ہے تاکہ نقصان کے دائرہ کار کو کم کیا جا سکے۔
یہ **اختیاری** ہے اور کنفیگریشن کے ذریعے کنٹرول ہوتا ہے (`agents.defaults.sandbox` یا
`agents.list[].sandbox`)۔ اگر sandboxing بند ہو تو ٹولز ہوسٹ پر چلتے ہیں۔
Gateway ہوسٹ پر ہی رہتا ہے؛ فعال ہونے پر ٹول کی عمل کاری ایک الگ تھلگ sandbox میں ہوتی ہے۔

یہ مکمل سکیورٹی حد نہیں ہے، مگر جب ماڈل کوئی ناسمجھی کرے تو فائل سسٹم
اور پروسیس رسائی کو نمایاں طور پر محدود کرتی ہے۔

## کیا چیز sandbox کی جاتی ہے

- ٹول کی عمل کاری (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, وغیرہ)۔
- اختیاری sandboxed براؤزر (`agents.defaults.sandbox.browser`)۔
  - بطورِ طے شدہ، sandbox براؤزر خود بخود شروع ہو جاتا ہے (یقینی بناتا ہے کہ CDP قابلِ رسائی ہو) جب براؤزر ٹول کو اس کی ضرورت ہو۔
    `agents.defaults.sandbox.browser.autoStart` اور `agents.defaults.sandbox.browser.autoStartTimeoutMs` کے ذریعے کنفیگر کریں۔
  - `agents.defaults.sandbox.browser.allowHostControl` sandboxed سیشنز کو ہوسٹ براؤزر کو صراحتاً ہدف بنانے دیتا ہے۔
  - اختیاری allowlists `target: "custom"` کو گیٹ کرتی ہیں: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`۔

Sandbox نہیں کیا جاتا:

- Gateway پروسیس خود۔
- کوئی بھی ٹول جسے صراحتاً ہوسٹ پر چلانے کی اجازت ہو (مثلاً `tools.elevated`)۔
  - **Elevated exec ہوسٹ پر چلتا ہے اور sandboxing کو بائی پاس کرتا ہے۔**
  - اگر sandboxing بند ہو تو `tools.elevated` عمل کاری کو تبدیل نہیں کرتا (پہلے ہی ہوسٹ پر ہے)۔ دیکھیں [Elevated Mode](/tools/elevated)۔

## Modes

`agents.defaults.sandbox.mode` یہ کنٹرول کرتا ہے کہ sandboxing **کب** استعمال ہو:

- `"off"`: کوئی sandboxing نہیں۔
- `"non-main"`: صرف **غیر-مرکزی** سیشنز sandbox ہوں (اگر آپ عام چیٹس کو ہوسٹ پر چاہتے ہیں تو یہ بطورِ طے شدہ ہے)۔
- `"all"`: ہر سیشن sandbox میں چلتا ہے۔
  نوٹ: `"non-main"` کی بنیاد `session.mainKey` پر ہے (بطورِ طے شدہ `"main"`)، ایجنٹ آئی ڈی پر نہیں۔
  گروپ/چینل سیشنز اپنی الگ کلیدیں استعمال کرتے ہیں، اس لیے وہ غیر-مرکزی شمار ہوتے ہیں اور sandbox کیے جائیں گے۔

## Scope

`agents.defaults.sandbox.scope` یہ کنٹرول کرتا ہے کہ **کتنے کنٹینرز** بنائے جائیں:

- `"session"` (بطورِ طے شدہ): ہر سیشن کے لیے ایک کنٹینر۔
- `"agent"`: ہر ایجنٹ کے لیے ایک کنٹینر۔
- `"shared"`: تمام sandboxed سیشنز کے لیے ایک مشترکہ کنٹینر۔

## Workspace access

`agents.defaults.sandbox.workspaceAccess` یہ کنٹرول کرتا ہے کہ **sandbox کیا دیکھ سکتا ہے**:

- `"none"` (بطورِ طے شدہ): ٹولز `~/.openclaw/sandboxes` کے تحت ایک sandbox ورک اسپیس دیکھتے ہیں۔
- `"ro"`: ایجنٹ ورک اسپیس کو read-only طور پر `/agent` پر ماؤنٹ کرتا ہے (`write`/`edit`/`apply_patch` کو غیر فعال کرتا ہے)۔
- `"rw"`: ایجنٹ ورک اسپیس کو read/write کے ساتھ `/workspace` پر ماؤنٹ کرتا ہے۔

آنے والا میڈیا فعال sandbox ورک اسپیس میں کاپی کیا جاتا ہے (`media/inbound/*`)۔
Skills نوٹ: `read` ٹول sandbox-rooted ہے۔ `workspaceAccess: "none"` کے ساتھ،
OpenClaw اہل skills کو sandbox ورک اسپیس (`.../skills`) میں mirror کرتا ہے تاکہ
انہیں پڑھا جا سکے۔ `"rw"` کے ساتھ، ورک اسپیس skills
`/workspace/skills` سے پڑھے جا سکتے ہیں۔

## Custom bind mounts

`agents.defaults.sandbox.docker.binds` اضافی ہوسٹ ڈائریکٹریز کو کنٹینر میں ماؤنٹ کرتا ہے۔
فارمیٹ: `host:container:mode` (مثلاً `"/home/user/source:/source:rw"`)۔

گلوبل اور per-agent binds **مرج** ہوتے ہیں (بدلے نہیں جاتے)۔ `scope: "shared"` کے تحت، per-agent binds کو نظرانداز کیا جاتا ہے۔

مثال (read-only سورس + docker ساکٹ):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

سکیورٹی نوٹس:

- Binds sandbox فائل سسٹم کو بائی پاس کرتے ہیں: وہ ہوسٹ راستوں کو اسی موڈ کے ساتھ ظاہر کرتے ہیں جو آپ سیٹ کریں (`:ro` یا `:rw`)۔
- حساس ماؤنٹس (مثلاً `docker.sock`, secrets, SSH keys) کو `:ro` ہونا چاہیے، جب تک کہ بالکل ضروری نہ ہو۔
- اگر آپ کو صرف ورک اسپیس کی read رسائی درکار ہو تو `workspaceAccess: "ro"` کے ساتھ ملائیں؛ bind موڈز آزاد رہتے ہیں۔
- یہ سمجھنے کے لیے کہ binds ٹول پالیسی اور elevated exec کے ساتھ کیسے تعامل کرتے ہیں، دیکھیں [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)۔

## Images + setup

بطورِ طے شدہ امیج: `openclaw-sandbox:bookworm-slim`

اسے ایک بار بنائیں:

```bash
scripts/sandbox-setup.sh
```

نوٹ: بطورِ طے شدہ امیج میں **Node شامل نہیں**۔ اگر کسی skill کو Node (یا
دیگر رَن ٹائمز) درکار ہوں تو یا تو ایک کسٹم امیج بنائیں یا
`sandbox.docker.setupCommand` کے ذریعے انسٹال کریں (نیٹ ورک egress + writable root +
root یوزر درکار)۔

Sandboxed براؤزر امیج:

```bash
scripts/sandbox-browser-setup.sh
```

بطورِ طے شدہ، sandbox کنٹینرز **بغیر نیٹ ورک** چلتے ہیں۔
`agents.defaults.sandbox.docker.network` کے ذریعے اووررائیڈ کریں۔

Docker کی تنصیبات اور کنٹینرائزڈ Gateway یہاں موجود ہیں:
[Docker](/install/docker)

## setupCommand (کنٹینر کی ایک بارہ سیٹ اپ)

`setupCommand` sandbox کنٹینر بننے کے بعد **ایک بار** چلتا ہے (ہر رن پر نہیں)۔
یہ `sh -lc` کے ذریعے کنٹینر کے اندر عمل میں آتا ہے۔

راستے:

- گلوبل: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

عام مسائل:

- بطورِ طے شدہ `docker.network` `"none"` ہے (کوئی egress نہیں)، اس لیے پیکج انسٹالز ناکام ہوں گے۔
- `readOnlyRoot: true` لکھائی کو روکتا ہے؛ `readOnlyRoot: false` سیٹ کریں یا کسٹم امیج بنائیں۔
- پیکج انسٹالز کے لیے `user` کا root ہونا لازم ہے ( `user` کو حذف کریں یا `user: "0:0"` سیٹ کریں)۔
- Sandbox exec ہوسٹ کے `process.env` کو وراثت میں نہیں لیتا۔ Skills کی API کلیدوں کے لیے
  `agents.defaults.sandbox.docker.env` استعمال کریں (یا کسٹم امیج)۔

## Tool policy + escape hatches

Sandbox قواعد سے پہلے ٹول allow/deny پالیسیاں اب بھی لاگو ہوتی ہیں۔ اگر کوئی ٹول
گلوبل یا per-agent سطح پر ممنوع ہو تو sandboxing اسے واپس فعال نہیں کرتی۔

`tools.elevated` ایک صریح escape hatch ہے جو `exec` کو ہوسٹ پر چلاتا ہے۔
`/exec` ہدایات صرف مجاز ارسال کنندگان پر لاگو ہوتی ہیں اور فی سیشن برقرار رہتی ہیں؛
`exec` کو مکمل طور پر غیر فعال کرنے کے لیے ٹول پالیسی deny استعمال کریں
(دیکھیں [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated))۔

Debugging:

- مؤثر sandbox موڈ، ٹول پالیسی، اور fix-it کنفیگ کلیدیں دیکھنے کے لیے `openclaw sandbox explain` استعمال کریں۔
- “یہ کیوں بلاک ہوا؟” کے ذہنی ماڈل کے لیے [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) دیکھیں۔
  اسے مقفل رکھیں۔

## Multi-agent overrides

ہر ایجنٹ sandbox + tools کو اووررائیڈ کر سکتا ہے:
`agents.list[].sandbox` اور `agents.list[].tools` (مزید `agents.list[].tools.sandbox.tools` sandbox ٹول پالیسی کے لیے)۔
ترجیحی ترتیب کے لیے دیکھیں [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)۔

## Minimal enable example

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Related docs

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
