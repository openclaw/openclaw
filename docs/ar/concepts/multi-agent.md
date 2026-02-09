---
summary: "توجيه متعدد الوكلاء: وكلاء معزولون، حسابات القنوات، والارتباطات"
title: التوجيه متعدد الوكلاء
read_when: "عندما تريد عدة وكلاء معزولين (مساحات عمل + مصادقة) ضمن عملية Gateway واحدة."
status: active
---

# التوجيه متعدد الوكلاء

الهدف: عدة وكلاء _معزولين_ (مساحة عمل منفصلة + `agentDir` + جلسات)، بالإضافة إلى عدة حسابات قنوات (مثل حسابي WhatsApp) ضمن Gateway واحد قيد التشغيل. يتم توجيه الرسائل الواردة إلى وكيل عبر الارتباطات.

## ما هو «وكيل واحد»؟

**الوكيل** هو عقل مُحاط بنطاق كامل وله ما يلي خاصًا به:

- **مساحة عمل** (ملفات، AGENTS.md/SOUL.md/USER.md، ملاحظات محلية، قواعد الشخصية).
- **دليل الحالة** (`agentDir`) لملفات تعريف المصادقة، وسجل النماذج، وتهيئة خاصة بكل وكيل.
- **مخزن الجلسات** (سجل الدردشة + حالة التوجيه) تحت `~/.openclaw/agents/<agentId>/sessions`.

ملفات تعريف المصادقة هي **لكل وكيل**. يقرأ كل وكيل من خاصته:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

لا تتم مشاركة بيانات اعتماد الوكيل الرئيسي **تلقائيًا**. لا تعِد استخدام `agentDir`
عبر الوكلاء (لأنه يسبب تعارضات في المصادقة/الجلسات). إذا أردت مشاركة بيانات الاعتماد،
انسخ `auth-profiles.json` إلى `agentDir` الخاص بالوكيل الآخر.

تكون Skills لكل وكيل عبر مجلد `skills/` الخاص بمساحة عمل كل وكيل، مع توفر Skills
المشتركة من `~/.openclaw/skills`. راجع [Skills: لكل وكيل مقابل المشتركة](/tools/skills#per-agent-vs-shared-skills).

يمكن لـ Gateway استضافة **وكيل واحد** (افتراضيًا) أو **عدة وكلاء** جنبًا إلى جنب.

**ملاحظة مساحة العمل:** مساحة عمل كل وكيل هي **cwd الافتراضي**، وليست
sandbox صارمًا. تُحل المسارات النسبية داخل مساحة العمل، لكن المسارات المطلقة قد
تصل إلى مواقع أخرى على المضيف ما لم يتم تمكين sandboxing. راجع
[Sandboxing](/gateway/sandboxing).

## المسارات (خريطة سريعة)

- التهيئة: `~/.openclaw/openclaw.json` (أو `OPENCLAW_CONFIG_PATH`)
- دليل الحالة: `~/.openclaw` (أو `OPENCLAW_STATE_DIR`)
- مساحة العمل: `~/.openclaw/workspace` (أو `~/.openclaw/workspace-<agentId>`)
- دليل الوكيل: `~/.openclaw/agents/<agentId>/agent` (أو `agents.list[].agentDir`)
- الجلسات: `~/.openclaw/agents/<agentId>/sessions`

### وضع الوكيل الواحد (الافتراضي)

إذا لم تفعل شيئًا، يعمل OpenClaw بوكيل واحد:

- `agentId` يكون افتراضيًا **`main`**.
- تُفهرس الجلسات على شكل `agent:main:<mainKey>`.
- مساحة العمل تكون افتراضيًا `~/.openclaw/workspace` (أو `~/.openclaw/workspace-<profile>` عند تعيين `OPENCLAW_PROFILE`).
- الحالة تكون افتراضيًا `~/.openclaw/agents/main/agent`.

## مساعد الوكيل

استخدم معالج الوكيل لإضافة وكيل معزول جديد:

```bash
openclaw agents add work
```

ثم أضف `bindings` (أو دع المعالج يقوم بذلك) لتوجيه الرسائل الواردة.

تحقق باستخدام:

```bash
openclaw agents list --bindings
```

## عدة وكلاء = عدة أشخاص، عدة شخصيات

مع **تعدد الوكلاء**، يصبح كل `agentId` **شخصية معزولة بالكامل**:

- **أرقام/حسابات مختلفة** (لكل قناة `accountId`).
- **شخصيات مختلفة** (ملفات مساحة العمل لكل وكيل مثل `AGENTS.md` و`SOUL.md`).
- **مصادقة + جلسات منفصلة** (لا تداخل إلا إذا فُعِّل صراحة).

يتيح ذلك لـ **عدة أشخاص** مشاركة خادم Gateway واحد مع الحفاظ على عزل «عقول» الذكاء الاصطناعي وبياناتهم.

## رقم WhatsApp واحد، عدة أشخاص (تقسيم الرسائل الخاصة)

يمكنك توجيه **رسائل WhatsApp الخاصة المختلفة** إلى وكلاء مختلفين مع البقاء على **حساب WhatsApp واحد**. تتم المطابقة على مُرسل E.164 (مثل `+15551234567`) باستخدام `peer.kind: "dm"`. تظل الردود صادرة من نفس رقم WhatsApp (لا هوية مُرسل لكل وكيل).

تفصيل مهم: المحادثات المباشرة تُطوى إلى **مفتاح الجلسة الرئيسي** للوكيل، لذا يتطلب العزل الحقيقي **وكيلًا واحدًا لكل شخص**.

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

ملاحظات:

- التحكم في الوصول للرسائل الخاصة هو **عام لكل حساب WhatsApp** (الاقتران/قائمة السماح)، وليس لكل وكيل.
- للمجموعات المشتركة، اربط المجموعة بوكيل واحد أو استخدم [مجموعات البث](/channels/broadcast-groups).

## قواعد التوجيه (كيف تختار الرسائل وكيلًا)

الارتباطات **حتمية** و**الأكثر تحديدًا يفوز**:

1. مطابقة `peer` (رسالة خاصة/مجموعة/معرّف قناة دقيق)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. مطابقة `accountId` لقناة
5. مطابقة على مستوى القناة (`accountId: "*"`)
6. الرجوع إلى الوكيل الافتراضي (`agents.list[].default`، وإلا فأول إدخال في القائمة، الافتراضي: `main`)

## عدة حسابات / أرقام هواتف

القنوات التي تدعم **عدة حسابات** (مثل WhatsApp) تستخدم `accountId` لتعريف
كل تسجيل دخول. يمكن توجيه كل `accountId` إلى وكيل مختلف، بحيث يمكن لخادم واحد استضافة
عدة أرقام هواتف دون خلط الجلسات.

## المفاهيم

- `agentId`: «عقل» واحد (مساحة عمل، مصادقة لكل وكيل، مخزن جلسات لكل وكيل).
- `accountId`: مثيل حساب قناة واحد (مثل حساب WhatsApp `"personal"` مقابل `"biz"`).
- `binding`: يوجّه الرسائل الواردة إلى `agentId` حسب `(channel, accountId, peer)` وباختيار مُعرّفات الخادم/الفريق.
- المحادثات المباشرة تُطوى إلى `agent:<agentId>:<mainKey>` (الرئيسي لكل وكيل؛ `session.mainKey`).

## مثال: حسابا WhatsApp → وكيلان

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

## مثال: دردشة WhatsApp اليومية + عمل عميق على Telegram

قسّم حسب القناة: وجّه WhatsApp إلى وكيل سريع للاستخدام اليومي وTelegram إلى وكيل Opus.

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

ملاحظات:

- إذا كان لديك عدة حسابات لقناة ما، أضف `accountId` إلى الارتباط (على سبيل المثال `{ channel: "whatsapp", accountId: "personal" }`).
- لتوجيه رسالة خاصة/مجموعة واحدة إلى Opus مع إبقاء الباقي على الدردشة، أضف ارتباط `match.peer` لذلك النظير؛ تطابقات النظير تفوز دائمًا على قواعد القناة العامة.

## مثال: القناة نفسها، نظير واحد إلى Opus

أبقِ WhatsApp على الوكيل السريع، لكن وجّه رسالة خاصة واحدة إلى Opus:

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

تطابقات النظير تفوز دائمًا، لذا اجعلها فوق قاعدة القناة العامة.

## وكيل عائلي مرتبط بمجموعة WhatsApp

اربط وكيلًا عائليًا مخصصًا بمجموعة WhatsApp واحدة، مع بوابة الذِكر
وسياسة أدوات أكثر تقييدًا:

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

ملاحظات:

- قوائم السماح/المنع للأدوات هي **أدوات** وليست Skills. إذا كانت Skill تحتاج لتشغيل
  ملف ثنائي، فتأكد من السماح بـ `exec` وأن الملف الثنائي موجود داخل sandbox.
- لبوابة أشد صرامة، عيّن `agents.list[].groupChat.mentionPatterns` وأبقِ
  قوائم السماح للمجموعات مفعّلة للقناة.

## Sandbox لكل وكيل وتهيئة الأدوات

بدءًا من الإصدار v2026.1.6، يمكن لكل وكيل امتلاك sandbox وقيود أدوات خاصة به:

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

ملاحظة: يوجد `setupCommand` تحت `sandbox.docker` ويعمل مرة واحدة عند إنشاء الحاوية.
يتم تجاهل تجاوزات `sandbox.docker.*` الخاصة بكل وكيل عندما يكون النطاق المحسوب هو `"shared"`.

**الفوائد:**

- **عزل أمني**: تقييد الأدوات للوكلاء غير الموثوقين
- **التحكم بالموارد**: وضع بعض الوكلاء داخل sandbox مع إبقاء الآخرين على المضيف
- **سياسات مرنة**: أذونات مختلفة لكل وكيل

ملاحظة: `tools.elevated` **عام** ويعتمد على المُرسل؛ ولا يمكن تهيئته لكل وكيل.
إذا احتجت حدودًا لكل وكيل، استخدم `agents.list[].tools` لمنع `exec`.
ولاستهداف المجموعات، استخدم `agents.list[].groupChat.mentionPatterns` بحيث تُطابِق @mentions الوكيل المقصود بدقة.

راجع [Sandbox & Tools متعدد الوكلاء](/tools/multi-agent-sandbox-tools) لأمثلة تفصيلية.
