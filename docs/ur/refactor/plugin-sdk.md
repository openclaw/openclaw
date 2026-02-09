---
summary: "منصوبہ: تمام میسجنگ کنیکٹرز کے لیے ایک صاف پلگ اِن SDK + رَن ٹائم"
read_when:
  - پلگ اِن آرکیٹیکچر کی تعریف یا ریفیکٹرنگ کرتے وقت
  - چینل کنیکٹرز کو پلگ اِن SDK/رَن ٹائم پر منتقل کرتے وقت
title: "پلگ اِن SDK ریفیکٹر"
---

# پلگ اِن SDK + رَن ٹائم ریفیکٹر منصوبہ

مقصد: ہر میسجنگ کنیکٹر ایک پلگ اِن ہو (بنڈلڈ یا بیرونی) جو ایک مستحکم API استعمال کرے۔
کوئی پلگ اِن براہِ راست `src/**` سے امپورٹ نہ کرے۔ تمام ڈیپنڈنسیز SDK یا رن ٹائم کے ذریعے جائیں۔

## کیوں اب

- موجودہ کنیکٹرز میں مختلف پیٹرنز ملے جلے ہیں: براہِ راست کور امپورٹس، صرف dist پل، اور حسبِ ضرورت ہیلپرز۔
- یہ اپ گریڈز کو نازک بناتا ہے اور ایک صاف بیرونی پلگ اِن سطح کو روکتا ہے۔

## ہدفی آرکیٹیکچر (دو پرتیں)

### 1. پلگ اِن SDK (کمپائل ٹائم، مستحکم، قابلِ اشاعت)

دائرۂ کار: ٹائپس، ہیلپرز، اور کنفیگ یوٹیلٹیز۔ کوئی رن ٹائم اسٹیٹ نہیں، کوئی سائیڈ ایفیکٹس نہیں۔

مواد (مثالیں):

- اقسام: `ChannelPlugin`, اڈاپٹرز، `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`۔
- کنفیگ ہیلپرز: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`۔
- پیئرنگ ہیلپرز: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`۔
- آن بورڈنگ ہیلپرز: `promptChannelAccessConfig`, `addWildcardAllowFrom`, آن بورڈنگ اقسام۔
- ٹول پیرامیٹر ہیلپرز: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`۔
- ڈاکس لنک ہیلپر: `formatDocsLink`۔

ترسیل:

- `openclaw/plugin-sdk` کے طور پر شائع کریں (یا کور سے `openclaw/plugin-sdk` کے تحت ایکسپورٹ کریں)۔
- واضح استحکام ضمانتوں کے ساتھ semver۔

### 2. پلگ اِن رَن ٹائم (ایگزیکیوشن سطح، انجیکٹڈ)

دائرۂ کار: وہ سب کچھ جو کور رن ٹائم رویّے کو متاثر کرتا ہے۔
`OpenClawPluginApi.runtime` کے ذریعے رسائی تاکہ پلگ اِنز کبھی `src/**` امپورٹ نہ کریں۔

مجوزہ سطح (کم سے کم مگر مکمل):

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

نوٹس:

- رَن ٹائم کور رویے تک رسائی کا واحد ذریعہ ہے۔
- SDK جان بوجھ کر چھوٹا اور مستحکم رکھا گیا ہے۔
- ہر رَن ٹائم میتھڈ موجودہ کور امپلیمنٹیشن سے میپ ہوتا ہے (کوئی تکرار نہیں)۔

## مائیگریشن منصوبہ (مرحلہ وار، محفوظ)

### مرحلہ 0: اسکیفولڈنگ

- `openclaw/plugin-sdk` متعارف کریں۔
- `OpenClawPluginApi` میں اوپر بیان کردہ سطح کے ساتھ `api.runtime` شامل کریں۔
- عبوری مدت کے دوران موجودہ امپورٹس برقرار رکھیں (ڈیپریکیشن وارننگز کے ساتھ)۔

### مرحلہ 1: برج صفائی (کم خطرہ)

- فی ایکسٹینشن `core-bridge.ts` کو `api.runtime` سے بدلیں۔
- پہلے BlueBubbles، Zalo، Zalo Personal کو منتقل کریں (پہلے ہی قریب ہیں)۔
- دہرایا گیا برج کوڈ ہٹا دیں۔

### مرحلہ 2: ہلکے براہِ راست امپورٹ پلگ اِنز

- Matrix کو SDK + رَن ٹائم پر منتقل کریں۔
- آن بورڈنگ، ڈائریکٹری، گروپ مینشن منطق کی توثیق کریں۔

### مرحلہ 3: بھاری براہِ راست امپورٹ پلگ اِنز

- MS Teams کو منتقل کریں (رَن ٹائم ہیلپرز کا سب سے بڑا سیٹ)۔
- یقینی بنائیں کہ جواب/ٹائپنگ کے سیمنٹکس موجودہ رویے سے مطابقت رکھتے ہوں۔

### مرحلہ 4: iMessage پلگ اِنائزیشن

- iMessage کو `extensions/imessage` میں منتقل کریں۔
- براہِ راست کور کالز کو `api.runtime` سے بدلیں۔
- کنفیگ کیز، CLI رویہ، اور ڈاکس برقرار رکھیں۔

### مرحلہ 5: نفاذ

- لِنٹ رول / CI چیک شامل کریں: `src/**` سے `extensions/**` امپورٹس نہیں۔
- پلگ اِن SDK/ورژن مطابقت چیکس شامل کریں (رَن ٹائم + SDK semver)۔

## مطابقت اور ورژنگ

- SDK: semver، شائع شدہ، دستاویزی تبدیلیاں۔
- رن ٹائم: ہر کور ریلیز کے مطابق ورژن شدہ۔ `api.runtime.version` شامل کریں۔
- پلگ اِنز مطلوبہ رَن ٹائم رینج ظاہر کریں (مثلاً `openclawRuntime: ">=2026.2.0"`)۔

## ٹیسٹنگ حکمتِ عملی

- اڈاپٹر سطح کے یونٹ ٹیسٹس (حقیقی کور امپلیمنٹیشن کے ساتھ رَن ٹائم فنکشنز کی جانچ)۔
- ہر پلگ اِن کے لیے گولڈن ٹیسٹس: رویے میں کسی تبدیلی نہ ہونے کو یقینی بنائیں (روٹنگ، پیئرنگ، اجازت فہرست، مینشن گیٹنگ)۔
- CI میں استعمال ہونے والا ایک واحد اینڈ ٹو اینڈ پلگ اِن نمونہ (انسٹال + رَن + اسموک)۔

## کھلے سوالات

- SDK اقسام کہاں ہوسٹ کی جائیں: الگ پیکیج یا کور ایکسپورٹ؟
- رَن ٹائم اقسام کی تقسیم: SDK میں (صرف اقسام) یا کور میں؟
- بنڈل شدہ بمقابلہ بیرونی پلگ اِنز کے لیے ڈاکس لنکس کیسے ظاہر کیے جائیں؟
- عبوری مدت میں اِن-ریپو پلگ اِنز کے لیے محدود براہِ راست کور امپورٹس کی اجازت دیں؟

## کامیابی کے معیارات

- تمام چینل کنیکٹرز SDK + رَن ٹائم استعمال کرنے والے پلگ اِنز ہوں۔
- `src/**` سے `extensions/**` امپورٹس نہ ہوں۔
- نئے کنیکٹر ٹیمپلیٹس صرف SDK + رَن ٹائم پر انحصار کریں۔
- بیرونی پلگ اِنز کور سورس تک رسائی کے بغیر تیار اور اپ ڈیٹ کیے جا سکیں۔

متعلقہ دستاویزات: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration)۔
