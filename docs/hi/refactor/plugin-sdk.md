---
summary: "योजना: सभी मैसेजिंग कनेक्टर्स के लिए एक स्वच्छ प्लगइन SDK + रनटाइम"
read_when:
  - प्लगइन आर्किटेक्चर को परिभाषित या पुनर्गठित करते समय
  - चैनल कनेक्टर्स को प्लगइन SDK/रनटाइम में माइग्रेट करते समय
title: "प्लगइन SDK पुनर्गठन"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:50Z
---

# प्लगइन SDK + रनटाइम पुनर्गठन योजना

लक्ष्य: हर मैसेजिंग कनेक्टर एक प्लगइन हो (बंडल्ड या बाहरी) जो एक स्थिर API का उपयोग करे।
कोई भी प्लगइन सीधे `src/**` से इम्पोर्ट न करे। सभी निर्भरताएँ SDK या रनटाइम के माध्यम से जाएँ।

## अभी क्यों

- वर्तमान कनेक्टर्स में पैटर्न मिश्रित हैं: सीधे कोर इम्पोर्ट, केवल dist ब्रिज, और कस्टम हेल्पर्स।
- इससे अपग्रेड नाज़ुक हो जाते हैं और एक स्वच्छ बाहरी प्लगइन सतह अवरुद्ध होती है।

## लक्ष्य आर्किटेक्चर (दो स्तर)

### 1) प्लगइन SDK (कम्पाइल-टाइम, स्थिर, प्रकाशित करने योग्य)

दायरा: टाइप्स, हेल्पर्स, और कॉन्फ़िग यूटिलिटीज़। कोई रनटाइम स्टेट नहीं, कोई साइड इफ़ेक्ट नहीं।

सामग्री (उदाहरण):

- Types: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Config helpers: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Pairing helpers: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Onboarding helpers: `promptChannelAccessConfig`, `addWildcardAllowFrom`, onboarding types.
- Tool param helpers: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Docs link helper: `formatDocsLink`.

डिलीवरी:

- `openclaw/plugin-sdk` के रूप में प्रकाशित करें (या `openclaw/plugin-sdk` के अंतर्गत कोर से एक्सपोर्ट करें)।
- स्पष्ट स्थिरता गारंटी के साथ Semver।

### 2) प्लगइन रनटाइम (एक्सीक्यूशन सतह, इंजेक्टेड)

दायरा: वह सब कुछ जो कोर रनटाइम व्यवहार को छूता है।
`OpenClawPluginApi.runtime` के माध्यम से एक्सेस किया जाता है ताकि प्लगइन्स कभी `src/**` इम्पोर्ट न करें।

प्रस्तावित सतह (न्यूनतम लेकिन पूर्ण):

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

टिप्पणियाँ:

- रनटाइम ही कोर व्यवहार तक पहुँचने का एकमात्र तरीका है।
- SDK जानबूझकर छोटा और स्थिर रखा गया है।
- प्रत्येक रनटाइम मेथड मौजूदा कोर इम्प्लीमेंटेशन से मैप होता है (कोई डुप्लिकेशन नहीं)।

## माइग्रेशन योजना (चरणबद्ध, सुरक्षित)

### चरण 0: स्कैफ़ोल्डिंग

- `openclaw/plugin-sdk` का परिचय।
- ऊपर दिए गए सतह के साथ `OpenClawPluginApi` में `api.runtime` जोड़ें।
- ट्रांज़िशन विंडो के दौरान मौजूदा इम्पोर्ट्स बनाए रखें (डिप्रिकेशन चेतावनियाँ)।

### चरण 1: ब्रिज क्लीनअप (कम जोखिम)

- प्रति-एक्सटेंशन `core-bridge.ts` को `api.runtime` से बदलें।
- BlueBubbles, Zalo, Zalo Personal को पहले माइग्रेट करें (पहले से काफ़ी निकट)।
- डुप्लिकेट ब्रिज कोड हटाएँ।

### चरण 2: हल्के डायरेक्ट-इम्पोर्ट प्लगइन्स

- Matrix को SDK + रनटाइम में माइग्रेट करें।
- ऑनबोर्डिंग, डायरेक्टरी, ग्रुप मेंशन लॉजिक का सत्यापन करें।

### चरण 3: भारी डायरेक्ट-इम्पोर्ट प्लगइन्स

- MS Teams को माइग्रेट करें (रनटाइम हेल्पर्स का सबसे बड़ा सेट)।
- सुनिश्चित करें कि reply/typing semantics वर्तमान व्यवहार से मेल खाते हों।

### चरण 4: iMessage प्लगइनाइज़ेशन

- iMessage को `extensions/imessage` में स्थानांतरित करें।
- सीधे कोर कॉल्स को `api.runtime` से बदलें।
- कॉन्फ़िग कीज़, CLI व्यवहार, और दस्तावेज़ यथावत रखें।

### चरण 5: प्रवर्तन

- लिंट नियम / CI जाँच जोड़ें: `src/**` से कोई `extensions/**` इम्पोर्ट नहीं।
- प्लगइन SDK/संस्करण संगतता जाँच जोड़ें (रनटाइम + SDK semver)।

## संगतता और संस्करणिंग

- SDK: semver, प्रकाशित, प्रलेखित परिवर्तन।
- रनटाइम: प्रति कोर रिलीज़ संस्करणित। `api.runtime.version` जोड़ें।
- प्लगइन्स आवश्यक रनटाइम रेंज घोषित करते हैं (उदा., `openclawRuntime: ">=2026.2.0"`)।

## परीक्षण रणनीति

- एडेप्टर-स्तरीय यूनिट टेस्ट (वास्तविक कोर इम्प्लीमेंटेशन के साथ रनटाइम फ़ंक्शन्स का परीक्षण)।
- प्रति प्लगइन गोल्डन टेस्ट: कोई व्यवहार विचलन न हो (रूटिंग, पेयरिंग, allowlist, मेंशन गेटिंग)।
- CI में उपयोग किया जाने वाला एक एकल एंड-टू-एंड प्लगइन सैंपल (इंस्टॉल + रन + स्मोक)।

## खुले प्रश्न

- SDK टाइप्स कहाँ होस्ट करें: अलग पैकेज या कोर एक्सपोर्ट?
- रनटाइम टाइप वितरण: SDK में (केवल टाइप्स) या कोर में?
- बंडल्ड बनाम बाहरी प्लगइन्स के लिए डॉक्स लिंक कैसे एक्सपोज़ करें?
- ट्रांज़िशन के दौरान इन-रेपो प्लगइन्स के लिए सीमित डायरेक्ट कोर इम्पोर्ट्स की अनुमति दें?

## सफलता मानदंड

- सभी चैनल कनेक्टर्स SDK + रनटाइम का उपयोग करने वाले प्लगइन्स हों।
- `src/**` से कोई `extensions/**` इम्पोर्ट नहीं।
- नए कनेक्टर टेम्पलेट्स केवल SDK + रनटाइम पर निर्भर हों।
- बाहरी प्लगइन्स को कोर सोर्स एक्सेस के बिना विकसित और अपडेट किया जा सके।

संबंधित दस्तावेज़: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration)।
