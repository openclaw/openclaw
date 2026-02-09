---
summary: "استخدم MiniMax M2.1 في OpenClaw"
read_when:
  - تريد نماذج MiniMax في OpenClaw
  - تحتاج إلى إرشادات إعداد MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax هي شركة ذكاء اصطناعي تطوّر عائلة النماذج **M2/M2.1**. الإصدار الحالي
المركّز على البرمجة هو **MiniMax M2.1** (23 ديسمبر 2025)، والمصمَّم
للمهام المعقّدة في العالم الحقيقي.

المصدر: [مذكرة إصدار MiniMax M2.1](https://www.minimax.io/news/minimax-m21)

## نظرة عامة على النموذج (M2.1)

تُبرز MiniMax التحسينات التالية في M2.1:

- دعم أقوى لـ **البرمجة متعدّدة اللغات** (Rust، Java، Go، C++، Kotlin، Objective-C، TS/JS).
- تحسين **تطوير الويب/التطبيقات** وجودة المخرجات الجمالية (بما في ذلك التطبيقات المحمولة الأصلية).
- معالجة محسّنة لـ **التعليمات المركّبة** لسير عمل على نمط المكاتب، بالاعتماد على
  التفكير المتداخل وتنفيذ القيود المتكامل.
- **استجابات أكثر إيجازًا** مع استهلاك أقل للرموز ودورات تكرار أسرع.
- توافق أقوى مع **أطر الأدوات/الوكلاء** وإدارة السياق (Claude Code،
  Droid/Factory AI، Cline، Kilo Code، Roo Code، BlackBox).
- مخرجات أعلى جودة في **الحوار والكتابة التقنية**.

## MiniMax M2.1 مقابل MiniMax M2.1 Lightning

- **السرعة:** Lightning هو المتغيّر «السريع» في مستندات تسعير MiniMax.
- **التكلفة:** تُظهر التسعيرة نفس تكلفة الإدخال، لكن Lightning لديه تكلفة إخراج أعلى.
- **توجيه خطط البرمجة:** الواجهة الخلفية لـ Lightning غير متاحة مباشرة ضمن خطة البرمجة لدى MiniMax. تقوم MiniMax بتوجيه معظم الطلبات تلقائيًا إلى Lightning، لكنها تعود إلى
  الواجهة الخلفية العادية لـ M2.1 أثناء ذُرى الحركة.

## اختر الإعداد

### MiniMax OAuth (خطة البرمجة) — موصى به

**الأفضل لـ:** إعداد سريع مع خطة MiniMax Coding Plan عبر OAuth، دون الحاجة إلى مفتاح API.

قم بتمكين مكوّن OAuth الإضافي المدمج ثم صادِق:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

سيُطلب منك اختيار نقطة نهاية:

- **Global** — المستخدمون الدوليون (`api.minimax.io`)
- **CN** — المستخدمون في الصين (`api.minimaxi.com`)

اطّلع على [README لمكوّن MiniMax OAuth الإضافي](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) لمزيد من التفاصيل.

### MiniMax M2.1 (مفتاح API)

**الأفضل لـ:** MiniMax المُستضاف مع واجهة API متوافقة مع Anthropic.

التهيئة عبر CLI:

- شغّل `openclaw configure`
- اختر **Model/auth**
- اختر **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 كخيار احتياطي (Opus أساسي)

**الأفضل لـ:** الإبقاء على Opus 4.6 كخيار أساسي، مع التحويل إلى MiniMax M2.1 عند الفشل.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### اختياري: محليًا عبر LM Studio (يدوي)

**الأفضل لـ:** الاستدلال المحلي باستخدام LM Studio.
لقد لاحظنا نتائج قوية مع MiniMax M2.1 على عتاد قوي (مثل
حاسوب مكتبي/خادم) باستخدام الخادم المحلي لـ LM Studio.

التهيئة يدويًا عبر `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## التهيئة عبر `openclaw configure`

استخدم معالج التهيئة التفاعلي لإعداد MiniMax دون تحرير JSON:

1. شغّل `openclaw configure`.
2. اختر **Model/auth**.
3. اختر **MiniMax M2.1**.
4. حدِّد نموذجك الافتراضي عند المطالبة.

## خيارات التهيئة

- `models.providers.minimax.baseUrl`: يُفضَّل `https://api.minimax.io/anthropic` (متوافق مع Anthropic)؛ ويُعد `https://api.minimax.io/v1` اختياريًا لحمولات متوافقة مع OpenAI.
- `models.providers.minimax.api`: يُفضَّل `anthropic-messages`؛ ويُعد `openai-completions` اختياريًا لحمولات متوافقة مع OpenAI.
- `models.providers.minimax.apiKey`: مفتاح MiniMax API (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: عرِّف `id`، `name`، `reasoning`، `contextWindow`، `maxTokens`، `cost`.
- `agents.defaults.models`: أسماء مستعارة للنماذج التي تريدها في قائمة السماح.
- `models.mode`: احتفظ بـ `merge` إذا أردت إضافة MiniMax إلى جانب النماذج المدمجة.

## ملاحظات

- مراجع النماذج هي `minimax/<model>`.
- واجهة استخدام خطة البرمجة: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (تتطلّب مفتاح خطة برمجة).
- حدِّث قيم التسعير في `models.json` إذا كنت تحتاج تتبّعًا دقيقًا للتكلفة.
- رابط إحالة لخطة MiniMax Coding Plan (خصم 10%): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- راجع [/concepts/model-providers](/concepts/model-providers) لقواعد الموفّرين.
- استخدم `openclaw models list` و `openclaw models set minimax/MiniMax-M2.1` للتبديل.

## استكشاف الأخطاء وإصلاحها

### «Unknown model: minimax/MiniMax-M2.1»

يعني هذا عادةً أن **موفّر MiniMax غير مُهيّأ** (لا يوجد إدخال موفّر
ولا ملف تعريف مصادقة MiniMax/مفتاح بيئة). يوجد إصلاح لهذا الاكتشاف في
**2026.1.12** (غير مُصدر وقت الكتابة). للإصلاح:

- الترقية إلى **2026.1.12** (أو التشغيل من المصدر `main`)، ثم إعادة تشغيل Gateway.
- تشغيل `openclaw configure` واختيار **MiniMax M2.1**، أو
- إضافة كتلة `models.providers.minimax` يدويًا، أو
- تعيين `MINIMAX_API_KEY` (أو ملف تعريف مصادقة MiniMax) بحيث يمكن حقن الموفّر.

تأكّد من أن معرّف النموذج **حسّاس لحالة الأحرف**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

ثم أعد التحقّق باستخدام:

```bash
openclaw models list
```
