---
summary: "ملٹی ایجنٹ روٹنگ: الگ تھلگ ایجنٹس، چینل اکاؤنٹس، اور بائنڈنگز"
title: ملٹی ایجنٹ روٹنگ
read_when: "جب آپ ایک ہی گیٹ وے پروسیس میں متعدد الگ تھلگ ایجنٹس (ورک اسپیسز + تصدیق) چاہتے ہوں۔"
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:26Z
---

# ملٹی ایجنٹ روٹنگ

ہدف: ایک ہی چلتے ہوئے Gateway میں متعدد _الگ تھلگ_ ایجنٹس (الگ ورک اسپیس + `agentDir` + سیشنز)، نیز متعدد چینل اکاؤنٹس (مثلاً دو WhatsApp اکاؤنٹس)۔ ان باؤنڈ پیغامات کو بائنڈنگز کے ذریعے کسی ایجنٹ تک روٹ کیا جاتا ہے۔

## “ایک ایجنٹ” کیا ہے؟

ایک **ایجنٹ** ایک مکمل طور پر محدود دماغ ہے جس کے پاس اپنی یہ چیزیں ہوتی ہیں:

- **Workspace** (فائلیں، AGENTS.md/SOUL.md/USER.md، مقامی نوٹس، پرسونا قواعد)۔
- **State directory** (`agentDir`) برائے تصدیقی پروفائلز، ماڈل رجسٹری، اور ہر ایجنٹ کی کنفیگ۔
- **Session store** (چیٹ ہسٹری + روٹنگ اسٹیٹ) جو `~/.openclaw/agents/<agentId>/sessions` کے تحت ہوتی ہے۔

تصدیقی پروفائلز **ہر ایجنٹ کے لیے الگ** ہوتے ہیں۔ ہر ایجنٹ اپنی ذیل کی جگہ سے پڑھتا ہے:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

مرکزی ایجنٹ کی اسناد خودکار طور پر شیئر **نہیں** ہوتیں۔ کبھی بھی `agentDir`
کو ایجنٹس کے درمیان دوبارہ استعمال نہ کریں
(اس سے تصدیق/سیشن ٹکراؤ پیدا ہوتا ہے)۔ اگر آپ اسناد شیئر کرنا چاہتے ہیں تو
`auth-profiles.json` کو دوسرے ایجنٹ کے `agentDir` میں کاپی کریں۔

Skills ہر ایجنٹ کے لیے اس کے ورک اسپیس کے `skills/` فولڈر کے ذریعے ہوتی ہیں،
جبکہ مشترکہ Skills `~/.openclaw/skills` سے دستیاب ہوتی ہیں۔
دیکھیں [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills)۔

Gateway **ایک ایجنٹ** (ڈیفالٹ) یا **کئی ایجنٹس** کو ساتھ ساتھ ہوسٹ کر سکتا ہے۔

**Workspace نوٹ:** ہر ایجنٹ کی ورک اسپیس **ڈیفالٹ cwd** ہوتی ہے، کوئی سخت
sandbox نہیں۔ نسبتاً راستے ورک اسپیس کے اندر حل ہوتے ہیں، لیکن مطلق راستے
sandboxing فعال نہ ہونے کی صورت میں میزبان کی دیگر جگہوں تک پہنچ سکتے ہیں۔
دیکھیں [Sandboxing](/gateway/sandboxing)۔

## Paths (فوری نقشہ)

- Config: `~/.openclaw/openclaw.json` (یا `OPENCLAW_CONFIG_PATH`)
- State dir: `~/.openclaw` (یا `OPENCLAW_STATE_DIR`)
- Workspace: `~/.openclaw/workspace` (یا `~/.openclaw/workspace-<agentId>`)
- Agent dir: `~/.openclaw/agents/<agentId>/agent` (یا `agents.list[].agentDir`)
- Sessions: `~/.openclaw/agents/<agentId>/sessions`

### سنگل ایجنٹ موڈ (ڈیفالٹ)

اگر آپ کچھ نہیں کرتے تو OpenClaw ایک واحد ایجنٹ چلاتا ہے:

- `agentId` بطورِ طے شدہ **`main`** ہوتا ہے۔
- سیشنز `agent:main:<mainKey>` کے طور پر کی کیے جاتے ہیں۔
- Workspace بطورِ طے شدہ `~/.openclaw/workspace` ہوتی ہے (یا `~/.openclaw/workspace-<profile>` جب `OPENCLAW_PROFILE` سیٹ ہو)۔
- State بطورِ طے شدہ `~/.openclaw/agents/main/agent` ہوتی ہے۔

## Agent helper

نیا الگ تھلگ ایجنٹ شامل کرنے کے لیے ایجنٹ وِزارڈ استعمال کریں:

```bash
openclaw agents add work
```

پھر ان باؤنڈ پیغامات کو روٹ کرنے کے لیے `bindings` شامل کریں (یا وِزارڈ کو کرنے دیں)۔

تصدیق کریں:

```bash
openclaw agents list --bindings
```

## متعدد ایجنٹس = متعدد افراد، متعدد شخصیات

**متعدد ایجنٹس** کے ساتھ، ہر `agentId` ایک **مکمل طور پر الگ پرسونا** بن جاتا ہے:

- **مختلف فون نمبرز/اکاؤنٹس** (ہر چینل `accountId` کے مطابق)۔
- **مختلف شخصیات** (ہر ایجنٹ کی ورک اسپیس فائلیں جیسے `AGENTS.md` اور `SOUL.md`)۔
- **الگ تصدیق + سیشنز** (واضح طور پر فعال نہ کیا جائے تو کوئی کراس ٹاک نہیں)۔

اس سے **متعدد افراد** ایک ہی Gateway سرور شیئر کر سکتے ہیں جبکہ ان کے AI “دماغ” اور ڈیٹا الگ تھلگ رہتے ہیں۔

## ایک WhatsApp نمبر، متعدد افراد (DM تقسیم)

آپ **ایک ہی WhatsApp اکاؤنٹ** پر رہتے ہوئے **مختلف WhatsApp DMs** کو مختلف ایجنٹس تک روٹ کر سکتے ہیں۔
ارسال کنندہ کے E.164 (مثلاً `+15551234567`) پر `peer.kind: "dm"` کے ذریعے میچ کریں۔
جوابات پھر بھی اسی WhatsApp نمبر سے آئیں گے (ہر ایجنٹ کے لیے الگ ارسال کنندہ شناخت نہیں)۔

اہم تفصیل: براہِ راست چیٹس ایجنٹ کی **مرکزی سیشن کلید** میں ضم ہو جاتی ہیں،
لہٰذا حقیقی علیحدگی کے لیے **ہر فرد کے لیے ایک ایجنٹ** درکار ہے۔

مثال:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

نوٹس:

- DM رسائی کا کنٹرول **ہر WhatsApp اکاؤنٹ کے لیے عالمی** ہوتا ہے (pairing/allowlist)، ایجنٹ کے لیے الگ نہیں۔
- مشترکہ گروپس کے لیے، گروپ کو ایک ایجنٹ سے بائنڈ کریں یا
  [Broadcast groups](/channels/broadcast-groups) استعمال کریں۔

## روٹنگ قواعد (پیغامات ایجنٹ کیسے منتخب کرتے ہیں)

بائنڈنگز **متعین** ہوتی ہیں اور **زیادہ مخصوص کو ترجیح** ملتی ہے:

1. `peer` میچ (عین DM/گروپ/چینل آئی ڈی)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. کسی چینل کے لیے `accountId` میچ
5. چینل سطح کا میچ (`accountId: "*"`)
6. ڈیفالٹ ایجنٹ پر فال بیک (`agents.list[].default`، ورنہ پہلی فہرست اندراج، ڈیفالٹ: `main`)

## متعدد اکاؤنٹس / فون نمبرز

وہ چینلز جو **متعدد اکاؤنٹس** کی حمایت کرتے ہیں (مثلاً WhatsApp) ہر لاگ اِن کی شناخت کے لیے
`accountId` استعمال کرتے ہیں۔ ہر `accountId` کو مختلف ایجنٹ تک روٹ کیا جا سکتا ہے،
اس طرح ایک سرور متعدد فون نمبرز کو سیشنز ملائے بغیر ہوسٹ کر سکتا ہے۔

## تصورات

- `agentId`: ایک “دماغ” (ورک اسپیس، ہر ایجنٹ کی تصدیق، ہر ایجنٹ کا سیشن اسٹور)۔
- `accountId`: ایک چینل اکاؤنٹ انسٹینس (مثلاً WhatsApp اکاؤنٹ `"personal"` بمقابلہ `"biz"`)۔
- `binding`: ان باؤنڈ پیغامات کو `agentId` تک `(channel, accountId, peer)` اور اختیاری طور پر گلڈ/ٹیم آئی ڈیز کے ذریعے روٹ کرتا ہے۔
- براہِ راست چیٹس `agent:<agentId>:<mainKey>` میں ضم ہو جاتی ہیں (ہر ایجنٹ کی “مرکزی”؛ `session.mainKey`)۔

## مثال: دو WhatsApp → دو ایجنٹس

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## مثال: WhatsApp روزمرہ چیٹ + Telegram گہرا کام

چینل کے لحاظ سے تقسیم کریں: WhatsApp کو تیز روزمرہ ایجنٹ اور Telegram کو Opus ایجنٹ کی طرف روٹ کریں۔

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

نوٹس:

- اگر کسی چینل کے لیے آپ کے پاس متعدد اکاؤنٹس ہیں تو بائنڈنگ میں `accountId` شامل کریں
  (مثلاً `{ channel: "whatsapp", accountId: "personal" }`)۔
- کسی ایک DM/گروپ کو Opus کی طرف روٹ کرنے کے لیے جبکہ باقی چیٹ پر ہی رہے،
  اس peer کے لیے `match.peer` بائنڈنگ شامل کریں؛ peer میچز ہمیشہ چینل وسیع قواعد پر غالب ہوتے ہیں۔

## مثال: ایک ہی چینل، ایک peer کو Opus

WhatsApp کو تیز ایجنٹ پر رکھیں، لیکن ایک DM کو Opus کی طرف روٹ کریں:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Peer بائنڈنگز ہمیشہ غالب رہتی ہیں، اس لیے انہیں چینل وسیع قاعدے کے اوپر رکھیں۔

## WhatsApp گروپ سے منسلک خاندانی ایجنٹ

ایک مخصوص خاندانی ایجنٹ کو ایک ہی WhatsApp گروپ سے بائنڈ کریں،
mention gating اور سخت تر ٹول پالیسی کے ساتھ:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

نوٹس:

- ٹول allow/deny فہرستیں **ٹولز** ہوتی ہیں، Skills نہیں۔ اگر کسی Skill کو بائنری چلانی ہو،
  تو یقینی بنائیں کہ `exec` کی اجازت ہے اور بائنری sandbox میں موجود ہے۔
- مزید سخت gating کے لیے `agents.list[].groupChat.mentionPatterns` سیٹ کریں اور
  چینل کے لیے گروپ allowlists فعال رکھیں۔

## ہر ایجنٹ کے لیے Sandbox اور ٹول کنفیگریشن

v2026.1.6 سے، ہر ایجنٹ کا اپنا sandbox اور ٹول پابندیاں ہو سکتی ہیں:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

نوٹ: `setupCommand`، `sandbox.docker` کے تحت ہوتا ہے اور کنٹینر بننے پر ایک بار چلتا ہے۔
جب حل شدہ اسکوپ `"shared"` ہو تو ہر ایجنٹ کی `sandbox.docker.*` اووررائیڈز نظرانداز کر دی جاتی ہیں۔

**فوائد:**

- **سکیورٹی علیحدگی**: غیر معتبر ایجنٹس کے لیے ٹولز محدود کریں
- **وسائل کا کنٹرول**: مخصوص ایجنٹس کو sandbox میں رکھیں جبکہ دیگر کو ہوسٹ پر رہنے دیں
- **لچکدار پالیسیاں**: ہر ایجنٹ کے لیے مختلف اجازتیں

نوٹ: `tools.elevated` **عالمی** اور ارسال کنندہ پر مبنی ہے؛ اسے ہر ایجنٹ کے لیے کنفیگر نہیں کیا جا سکتا۔
اگر آپ کو ہر ایجنٹ کی سطح پر حدود درکار ہوں تو `agents.list[].tools` استعمال کریں تاکہ `exec` کو روکا جا سکے۔
گروپ ٹارگٹنگ کے لیے `agents.list[].groupChat.mentionPatterns` استعمال کریں تاکہ @mentions صاف طور پر مطلوبہ ایجنٹ سے میپ ہوں۔

تفصیلی مثالوں کے لیے دیکھیں
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)۔
