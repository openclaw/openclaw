---
summary: "ملٹی ایجنٹ روٹنگ: الگ تھلگ ایجنٹس، چینل اکاؤنٹس، اور بائنڈنگز"
title: ملٹی ایجنٹ روٹنگ
read_when: "جب آپ ایک ہی گیٹ وے پروسیس میں متعدد الگ تھلگ ایجنٹس (ورک اسپیسز + تصدیق) چاہتے ہوں۔"
status: active
---

# ملٹی ایجنٹ روٹنگ

Goal: multiple _isolated_ agents (separate workspace + `agentDir` + sessions), plus multiple channel accounts (e.g. two WhatsApps) in one running Gateway. Inbound is routed to an agent via bindings.

## “ایک ایجنٹ” کیا ہے؟

ایک **ایجنٹ** ایک مکمل طور پر محدود دماغ ہے جس کے پاس اپنی یہ چیزیں ہوتی ہیں:

- **Workspace** (فائلیں، AGENTS.md/SOUL.md/USER.md، مقامی نوٹس، پرسونا قواعد)۔
- **State directory** (`agentDir`) برائے تصدیقی پروفائلز، ماڈل رجسٹری، اور ہر ایجنٹ کی کنفیگ۔
- **Session store** (چیٹ ہسٹری + روٹنگ اسٹیٹ) جو `~/.openclaw/agents/<agentId>/sessions` کے تحت ہوتی ہے۔

Auth profiles are **per-agent**. Each agent reads from its own:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Main agent credentials are **not** shared automatically. Never reuse `agentDir`
across agents (it causes auth/session collisions). If you want to share creds,
copy `auth-profiles.json` into the other agent's `agentDir`.

Skills are per-agent via each workspace’s `skills/` folder, with shared skills
available from `~/.openclaw/skills`. See [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Gateway **ایک ایجنٹ** (ڈیفالٹ) یا **کئی ایجنٹس** کو ساتھ ساتھ ہوسٹ کر سکتا ہے۔

**Workspace note:** each agent’s workspace is the **default cwd**, not a hard
sandbox. Relative paths resolve inside the workspace, but absolute paths can
reach other host locations unless sandboxing is enabled. See
[Sandboxing](/gateway/sandboxing).

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

You can route **different WhatsApp DMs** to different agents while staying on **one WhatsApp account**. 2. جوابات اب بھی اسی WhatsApp نمبر سے آتے ہیں (ہر ایجنٹ کے لیے الگ بھیجنے والی شناخت نہیں)۔ 3. وہ چینلز جو **متعدد اکاؤنٹس** کو سپورٹ کرتے ہیں (مثلاً WhatsApp) ہر لاگ اِن کی شناخت کے لیے `accountId` استعمال کرتے ہیں۔

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

4. ہر `accountId` کو مختلف ایجنٹ کی طرف روٹ کیا جا سکتا ہے، اس طرح ایک سرور سیشنز کو ملائے بغیر متعدد فون نمبرز ہوسٹ کر سکتا ہے۔ 5. ٹول allow/deny فہرستیں **tools** ہیں، skills نہیں۔

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

- 6. اگر کسی skill کو بائنری چلانے کی ضرورت ہو تو یقینی بنائیں کہ `exec` کی اجازت ہے اور بائنری sandbox میں موجود ہے۔ 7. نوٹ: `setupCommand`، `sandbox.docker` کے تحت ہوتا ہے اور کنٹینر بننے پر ایک بار چلتا ہے۔
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

8. جب resolved scope `"shared"` ہو تو فی‑ایجنٹ `sandbox.docker.*` overrides کو نظرانداز کر دیا جاتا ہے۔
9. نوٹ: `tools.elevated` **global** اور sender‑based ہے؛ یہ فی ایجنٹ قابلِ ترتیب نہیں۔

**فوائد:**

- **سکیورٹی علیحدگی**: غیر معتبر ایجنٹس کے لیے ٹولز محدود کریں
- **وسائل کا کنٹرول**: مخصوص ایجنٹس کو sandbox میں رکھیں جبکہ دیگر کو ہوسٹ پر رہنے دیں
- **لچکدار پالیسیاں**: ہر ایجنٹ کے لیے مختلف اجازتیں

10. اگر آپ کو فی‑ایجنٹ حدود درکار ہوں تو `agents.list[].tools` استعمال کر کے `exec` کو deny کریں۔
11. گروپ ٹارگٹنگ کے لیے `agents.list[].groupChat.mentionPatterns` استعمال کریں تاکہ @mentions صاف طور پر مطلوبہ ایجنٹ سے میپ ہوں۔
12. OpenClaw ان فراہم کنندگان کے لیے OAuth کے ذریعے “subscription auth” کو سپورٹ کرتا ہے جو اسے فراہم کرتے ہیں (خاص طور پر **OpenAI Codex (ChatGPT OAuth)**)۔

تفصیلی مثالوں کے لیے دیکھیں
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)۔
