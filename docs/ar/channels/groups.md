---
summary: "سلوك الدردشة الجماعية عبر الأسطح المختلفة (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - تغيير سلوك الدردشة الجماعية أو بوابة الإشارات (mentions)
title: "المجموعات"
---

# المجموعات

يتعامل OpenClaw مع الدردشات الجماعية بشكل متّسق عبر الأسطح المختلفة: WhatsApp، Telegram، Discord، Slack، Signal، iMessage، Microsoft Teams.

## مقدّمة للمبتدئين (دقيقتان)

«يعيش» OpenClaw على حسابات المراسلة الخاصة بك. لا يوجد مستخدم بوت منفصل على WhatsApp.
إذا كنت **أنت** ضمن مجموعة، يمكن لـ OpenClaw رؤية تلك المجموعة والرد فيها.

السلوك الافتراضي:

- المجموعات مقيّدة (`groupPolicy: "allowlist"`).
- تحتاج الردود إلى ذكر ما لم تقم بتعطيل صفحة الإشارة صراحة.

الترجمة: يمكن للمرسلين المُدرَجين في قائمة السماح تشغيل OpenClaw عبر الإشارة إليه.

> TL;DR
>
> - **الوصول إلى الرسائل الخاصة (DM)** يتحكّم به `*.allowFrom`.
> - **الوصول إلى المجموعات** يتحكّم به `*.groupPolicy` + قوائم السماح (`*.groups`, `*.groupAllowFrom`).
> - **تشغيل الرد** يتحكّم به بوابة الإشارات (`requireMention`, `/activation`).

التدفّق السريع (ماذا يحدث لرسالة مجموعة):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![تدفّق رسالة المجموعة](/images/groups-flow.svg)

إذا كنت تريد...

| الهدف                                                        | ما يجب ضبطه                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| السماح بكل المجموعات لكن الرد فقط عند @mentions | `groups: { "*": { requireMention: true } }`                               |
| تعطيل جميع ردود المجموعات                                    | `groupPolicy: "disabled"`                                                 |
| مجموعات محدّدة فقط                                           | `groups: { "<group-id>": { ... } }` (بدون مفتاح `"*"`) |
| أنت فقط من يمكنه التشغيل داخل المجموعات                      | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`                |

## مفاتيح الجلسة

- تستخدم جلسات المجموعات مفاتيح جلسة `agent:<agentId>:<channel>:group:<id>` (تستخدم الغرف/القنوات `agent:<agentId>:<channel>:channel:<id>`).
- تضيف مواضيع منتديات Telegram قيمة `:topic:<threadId>` إلى معرّف المجموعة بحيث يكون لكل موضوع جلسته الخاصة.
- تستخدم الدردشات المباشرة الجلسة الرئيسية (أو لكل مرسل إذا تم الضبط).
- يتم تخطّي نبضات القلب (heartbeats) لجلسات المجموعات.

## نمط: رسائل خاصة شخصية + مجموعات عامة (وكيل واحد)

نعم — يعمل هذا بشكل ممتاز إذا كانت حركة «الشخصي» لديك هي **DMs** وحركة «العام» هي **المجموعات**.

السبب: في وضع الوكيل الواحد، تصل DMs عادةً إلى مفتاح الجلسة **الرئيسي** (`agent:main:main`)، بينما تستخدم المجموعات دائمًا مفاتيح جلسة **غير رئيسية** (`agent:main:<channel>:group:<id>`). إذا فعّلت sandboxing باستخدام `mode: "non-main"`، تعمل جلسات المجموعات داخل Docker بينما تبقى جلسة DMs الرئيسية على المضيف.

يمنحك ذلك «عقل» وكيل واحد (مساحة عمل + ذاكرة مشتركة)، لكن بوضعَي تنفيذ:

- **DMs**: أدوات كاملة (المضيف)
- **المجموعات**: sandbox + أدوات مقيّدة (Docker)

> إذا كنت بحاجة إلى مساحات عمل/شخصيات منفصلة تمامًا («الشخصي» و«العام» يجب ألا يختلطا)، استخدم وكيلاً ثانيًا + ربطًا. راجع [التوجيه متعدد الوكلاء](/concepts/multi-agent).

مثال (DMs على المضيف، المجموعات داخل sandbox + أدوات مراسلة فقط):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

هل تريد أن "المجموعات تستطيع فقط مشاهدة المجلد X" بدلاً من "لا يوجد مضيف"؟ هل تريد «يمكن للمجموعات رؤية المجلد X فقط» بدلًا من «لا وصول للمضيف»؟ احتفِظ بـ `workspaceAccess: "none"` وقم بتركيب المسارات المُدرَجة في قائمة السماح فقط داخل sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

ذو صلة:

- مفاتيح التهيئة والقيم الافتراضية: [تهيئة Gateway](/gateway/configuration#agentsdefaultssandbox)
- تصحيح سبب حظر أداة: [Sandbox مقابل سياسة الأدوات مقابل الرفع](/gateway/sandbox-vs-tool-policy-vs-elevated)
- تفاصيل bind mounts: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## تسميات العرض

- تستخدم تسميات واجهة المستخدم `displayName` عند توفرها، وتُنسّق كـ `<channel>:<token>`.
- `#room` محجوز للغرف/القنوات؛ تستخدم الدردشات الجماعية `g-<slug>` (أحرف صغيرة، المسافات -> `-`، مع الإبقاء على `#@+._-`).

## سياسة المجموعات

التحكّم في كيفية التعامل مع رسائل المجموعات/الغرف لكل قناة:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| السياسة       | السلوك                                                                         |
| ------------- | ------------------------------------------------------------------------------ |
| `"open"`      | تتجاوز المجموعات قوائم السماح؛ تبقى بوابة الإشارات مطبّقة.     |
| `"disabled"`  | حظر جميع رسائل المجموعات بالكامل.                              |
| `"allowlist"` | السماح فقط بالمجموعات/الغرف التي تطابق قائمة السماح المُهيّأة. |

ملاحظات:

- `groupPolicy` منفصلة عن بوابة الإشارات (التي تتطلّب @mentions).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: استخدم `groupAllowFrom` (بديل: `allowFrom` الصريح).
- Discord: تستخدم قائمة السماح `channels.discord.guilds.<id>.channels`.
- Slack: تستخدم قائمة السماح `channels.slack.channels`.
- Matrix: تستخدم قائمة السماح `channels.matrix.groups` (معرّفات الغرف أو الأسماء المستعارة أو الأسماء). استخدم `channels.matrix.groupAllowFrom` لتقييد المرسلين؛ كما أن قوائم السماح لكل غرفة `users` مدعومة أيضًا.
- يتم التحكّم في DMs الجماعية بشكل منفصل (`channels.discord.dm.*`, `channels.slack.dm.*`).
- يمكن لقائمة السماح في Telegram مطابقة معرّفات المستخدمين (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) أو أسماء المستخدمين (`"@alice"` أو `"alice"`)؛ البوادئ غير حسّاسة لحالة الأحرف.
- الافتراضي هو `groupPolicy: "allowlist"`؛ إذا كانت قائمة السماح للمجموعات فارغة، يتم حظر رسائل المجموعات.

نموذج ذهني سريع (ترتيب التقييم لرسائل المجموعات):

1. `groupPolicy` (مفتوح/معطّل/قائمة سماح)
2. قوائم السماح للمجموعات (`*.groups`, `*.groupAllowFrom`, قائمة السماح الخاصة بالقناة)
3. بوابة الإشارات (`requireMention`, `/activation`)

## البوابة (افتراضي)

تتطلّب رسائل المجموعات إشارة ما لم يتم تجاوز ذلك لكل مجموعة. توجد القيم الافتراضية لكل نظام فرعي ضمن `*.groups."*"`.

يُعدّ الرد على رسالة البوت إشارة ضمنية (عندما تدعم القناة بيانات الرد). ينطبق هذا على Telegram وWhatsApp وSlack وDiscord وMicrosoft Teams.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

ملاحظات:

- `mentionPatterns` هي تعبيرات منتظمة غير حسّاسة لحالة الأحرف.
- الأسطح التي توفّر إشارات صريحة تمرّ دائمًا؛ الأنماط هي بديل احتياطي.
- تجاوز لكل وكيل: `agents.list[].groupChat.mentionPatterns` (مفيد عند مشاركة عدة وكلاء لمجموعة واحدة).
- تُطبَّق بوابة الإشارات فقط عندما يكون اكتشاف الإشارات ممكنًا (إشارات أصلية أو عند تهيئة `mentionPatterns`).
- توجد القيم الافتراضية لـ Discord ضمن `channels.discord.guilds."*"` (قابلة للتجاوز لكل خادم/قناة).
- يُغلَّف سياق سجل المجموعة بشكل موحّد عبر القنوات وهو **معلّق فقط** (الرسائل التي تم تخطيها بسبب بوابة الإشارات)؛ استخدم `messages.groupChat.historyLimit` للإعداد الافتراضي العام و`channels.<channel>.historyLimit` (أو `channels.<channel>.accounts.*.historyLimit`) للتجاوزات. اضبط `0` للتعطيل.

## قيود أدوات المجموعة/القناة (اختياري)

تدعم بعض إعدادات القنوات تقييد الأدوات المتاحة **داخل مجموعة/غرفة/قناة محددة**.

- `tools`: السماح/المنع للأدوات على مستوى المجموعة بالكامل.
- `toolsBySender`: تجاوزات لكل مرسل داخل المجموعة (المفاتيح هي معرّفات المرسلين/أسماء المستخدمين/عناوين البريد/أرقام الهواتف حسب القناة). استخدم `"*"` كرمز شامل.

ترتيب الحسم (الأكثر تحديدًا يفوز):

1. تطابق `toolsBySender` على مستوى المجموعة/القناة
2. `tools` على مستوى المجموعة/القناة
3. الافتراضي (`"*"`) تطابق `toolsBySender`
4. الافتراضي (`"*"`) `tools`

مثال (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

ملاحظات:

- تُطبَّق قيود أدوات المجموعة/القناة بالإضافة إلى سياسة الأدوات العامة/الخاصة بالوكيل (المنع يظلّ غالبًا).
- تستخدم بعض القنوات تعشيشًا مختلفًا للغرف/القنوات (مثل Discord `guilds.*.channels.*`، Slack `channels.*`، MS Teams `teams.*.channels.*`).

## قوائم السماح للمجموعات

عند تهيئة `channels.whatsapp.groups` أو `channels.telegram.groups` أو `channels.imessage.groups`، تعمل المفاتيح كقائمة سماح للمجموعات. استخدم `"*"` للسماح بكل المجموعات مع الاستمرار في ضبط سلوك الإشارات الافتراضي.

نوايا شائعة (نسخ/لصق):

1. تعطيل جميع ردود المجموعات

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. السماح بمجموعات محدّدة فقط (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. السماح بكل المجموعات لكن اشتراط الإشارة (صريح)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. المالك فقط يمكنه التشغيل داخل المجموعات (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## التفعيل (للمالك فقط)

يمكن لمالكي المجموعات تبديل التفعيل لكل مجموعة:

- `/activation mention`
- `/activation always`

يتم تحديد المالك بواسطة `channels.whatsapp.allowFrom` (أو رقم E.164 الذاتي للبوت عند عدم الضبط). أرسل الأمر كرسالة مستقلة. تتجاهل الأسطح الأخرى حاليًا `/activation`.

## حقول السياق

مجموعة الحمولات الواردة إلى المجموعة:

- `ChatType=group`
- `GroupSubject` (إن كان معروفًا)
- `GroupMembers` (إن كان معروفًا)
- `WasMentioned` (نتيجة بوابة الإشارات)
- تضيف مواضيع منتديات Telegram أيضًا `MessageThreadId` و`IsForum`.

يتضمن موجّه النظام للوكيل مقدّمة مجموعة في الدور الأول من جلسة مجموعة جديدة. تذكّر النموذج بالرد كإنسان، وتجنّب جداول Markdown، وتجنّب كتابة سلاسل `\n` حرفيًا.

## خصوصيات iMessage

- فضّل `chat_id:<id>` عند التوجيه أو إعداد قوائم السماح.
- عرض الدردشات: `imsg chats --limit 20`.
- تعود ردود المجموعات دائمًا إلى نفس `chat_id`.

## خصوصيات WhatsApp

راجع [رسائل المجموعات](/channels/group-messages) لسلوك خاص بـ WhatsApp فقط (حقن السجل، تفاصيل معالجة الإشارات).
