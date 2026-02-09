---
summary: "الخطة: مجموعة تطوير إضافات واحدة نظيفة + بيئة تشغيل لجميع موصلات المراسلة"
read_when:
  - عند تعريف أو إعادة هيكلة بنية الإضافات
  - ترحيل موصلات القنوات إلى برنامج SDK/وقت التشغيل الإضافي
title: "refactor/plugin-sdk.md"
---

# خطة إعادة هيكلة مجموعة تطوير الإضافات + بيئة التشغيل

الهدف: كل موصل مراسلة هو إضافة (مضمّنة أو خارجية) تستخدم واجهة برمجة تطبيقات واحدة مستقرة.
لا تستورد أي إضافة مباشرةً من `src/**`. تمرّ جميع التبعيات عبر مجموعة التطوير أو بيئة التشغيل.

## لماذا الآن

- الموصلات الحالية تمزج أنماطًا مختلفة: استيرادات مباشرة من النواة، جسور تعتمد على حزم التوزيع فقط، ومساعدات مخصّصة.
- هذا يجعل الترقيات هشّة ويمنع سطحًا نظيفًا لإضافات خارجية.

## البنية المستهدفة (طبقتان)

### 1. مجموعة تطوير الإضافات (وقت الترجمة، مستقرة، قابلة للنشر)

النطاق: الأنواع، المساعدات، وأدوات التهيئة. بلا حالة وقت تشغيل، وبلا آثار جانبية.

المحتويات (أمثلة):

- الأنواع: `ChannelPlugin`، المحوّلات، `ChannelMeta`، `ChannelCapabilities`، `ChannelDirectoryEntry`.
- مساعدات التهيئة: `buildChannelConfigSchema`، `setAccountEnabledInConfigSection`، `deleteAccountFromConfigSection`،
  `applyAccountNameToChannelSection`.
- مساعدات الإقران: `PAIRING_APPROVED_MESSAGE`، `formatPairingApproveHint`.
- مساعدات التهيئة الأولية: `promptChannelAccessConfig`، `addWildcardAllowFrom`، وأنواع التهيئة الأولية.
- مساعدات معاملات الأدوات: `createActionGate`، `readStringParam`، `readNumberParam`، `readReactionParams`، `jsonResult`.
- مساعد رابط التوثيق: `formatDocsLink`.

التسليم:

- النشر كـ `openclaw/plugin-sdk` (أو التصدير من النواة تحت `openclaw/plugin-sdk`).
- الالتزام بـ semver مع ضمانات استقرار صريحة.

### 2. بيئة تشغيل الإضافات (سطح التنفيذ، مُحقن)

النطاق: كل ما يلامس سلوك وقت التشغيل للنواة.
يتم الوصول إليه عبر `OpenClawPluginApi.runtime` بحيث لا تستورد الإضافات `src/**` أبدًا.

السطح المقترح (حدّ أدنى لكنه كامل):

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

ملاحظات:

- بيئة التشغيل هي الطريقة الوحيدة للوصول إلى سلوك النواة.
- مجموعة التطوير صغيرة ومستقرة عن قصد.
- فكل طريقة تشغيل تخطط للتنفيذ الأساسي القائم (عدم الازدواجية).

## خطة الترحيل (على مراحل، وآمنة)

### المرحلة 0: التهيئة الأساسية

- إدخال `openclaw/plugin-sdk`.
- إضافة `api.runtime` إلى `OpenClawPluginApi` بالسطح أعلاه.
- الإبقاء على الاستيرادات الحالية خلال نافذة انتقال (تحذيرات إهمال).

### المرحلة 1: تنظيف الجسور (مخاطر منخفضة)

- استبدال `core-bridge.ts` لكل إضافة بـ `api.runtime`.
- ترحيل BlueBubbles وZalo وZalo Personal أولًا (قريبة بالفعل).
- إزالة كود الجسور المكرر.

### المرحلة 2: إضافات ذات استيراد مباشر خفيف

- ترحيل المصفوفة إلى SDK + التشغيل.
- التحقق من منطق التهيئة الأولية، والدليل، وذكر المجموعات.

### المرحلة 3: إضافات ذات استيراد مباشر كثيف

- ترحيل Microsoft Teams (أكبر مجموعة من مساعدات وقت التشغيل).
- التأكد من تطابق دلالات الرد/الكتابة مع السلوك الحالي.

### المرحلة 4: تحويل iMessage إلى إضافة

- نقل iMessage إلى `extensions/imessage`.
- استبدال استدعاءات النواة المباشرة بـ `api.runtime`.
- الإبقاء على مفاتيح التهيئة، وسلوك CLI، والتوثيق كما هو.

### المرحلة 5: الإنفاذ

- إضافة قاعدة lint / فحص CI: لا توجد استيرادات `extensions/**` من `src/**`.
- أضف إضافة/فحص توافق الإصدارات (تشغيل + فصل SDK).

## التوافق والإصدارات

- ديفيد كريس: تغييرات شبه منشورة وموثقة.
- بيئة التشغيل: مُرقّمة لكل إصدار من النواة. إضافة `api.runtime.version`.
- تُصرّح الإضافات بنطاق بيئة التشغيل المطلوب (مثل `openclawRuntime: ">=2026.2.0"`).

## استراتيجية الاختبار

- اختبارات وحدات على مستوى المحوّلات (استدعاء دوال بيئة التشغيل مع تنفيذ النواة الحقيقي).
- اختبارات مرجعية لكل إضافة: ضمان عدم انحراف السلوك (التوجيه، الإقران، قوائم السماح، تقييد الذِكر).
- عيّنة إضافة واحدة من طرف إلى طرف تُستخدم في CI (تثبيت + تشغيل + اختبار دخاني).

## أسئلة مفتوحة

- أين تُستضاف أنواع مجموعة التطوير: حزمة منفصلة أم تصدير من النواة؟
- توزيع نوع التشغيل: في SDK (الأنواع فقط) أو في الجوهر؟
- كيف نكشف روابط التوثيق للإضافات المضمّنة مقابل الخارجية؟
- هل نسمح باستيرادات مباشرة محدودة من النواة لإضافات داخل المستودع خلال الانتقال؟

## معايير النجاح

- جميع موصلات القنوات إضافات تستخدم مجموعة التطوير + بيئة التشغيل.
- لا توجد استيرادات `extensions/**` من `src/**`.
- قوالب الموصلات الجديدة تعتمد فقط على مجموعة التطوير + بيئة التشغيل.
- يمكن تطوير الإضافات الخارجية وتحديثها دون الوصول إلى مصدر النواة.

مستندات ذات صلة: [Plugins](/tools/plugin)، [Channels](/channels/index)، [Configuration](/gateway/configuration).
