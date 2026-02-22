---
summary: "အစီအစဉ် — မက်ဆေ့ချ်ချန်နယ်ချိတ်ဆက်မှုအားလုံးအတွက် သန့်ရှင်းသော plugin SDK + runtime တစ်ခုတည်း"
read_when:
  - Plugin ဗိသုကာကို သတ်မှတ်ခြင်း သို့မဟုတ် ပြန်လည်ဖွဲ့စည်းခြင်း ပြုလုပ်နေချိန်
  - ချန်နယ်ချိတ်ဆက်မှုများကို plugin SDK/runtime သို့ ပြောင်းရွှေ့နေချိန်
title: "Plugin SDK ပြန်လည်ဖွဲ့စည်းခြင်း"
---

# Plugin SDK + Runtime ပြန်လည်ဖွဲ့စည်းရေး အစီအစဉ်

43. ရည်မှန်းချက်: messaging connector တိုင်းသည် stable API တစ်ခုကို အသုံးပြုသော plugin (bundled သို့မဟုတ် external) ဖြစ်ရမည်။
44. Plugin များသည် `src/**` မှ တိုက်ရိုက် import မလုပ်ရ။ 45. Dependencies အားလုံးကို SDK သို့မဟုတ် runtime မှတစ်ဆင့်သာ သုံးပါ။

## ယခုအချိန်တွင် ဘာကြောင့်လိုအပ်သလဲ

- လက်ရှိ ချိတ်ဆက်မှုများတွင် ပုံစံမျိုးစုံ ပေါင်းစပ်နေသည် — core ကို တိုက်ရိုက် import လုပ်ခြင်း၊ dist-only bridge များ၊ custom helper များ။
- ယင်းကြောင့် အဆင့်မြှင့်တင်မှုများ ပျက်လွယ်ပြီး သန့်ရှင်းသော အပြင်ဘက် plugin surface တစ်ခု တည်ဆောက်ရန် တားဆီးနေသည်။

## ရည်ရွယ်ထားသော ဗိသုကာ (အလွှာနှစ်ခု)

### 1. Plugin SDK (compile-time, တည်ငြိမ်၊ ထုတ်ဝေနိုင်)

46. Scope: types, helpers, နှင့် config utilities။ 47. Runtime state မရှိ၊ side effects မရှိ။

ပါဝင်သည့်အရာများ (ဥပမာများ):

- Types: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`။
- Config helpers: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`။
- Pairing helpers: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`။
- Onboarding helpers: `promptChannelAccessConfig`, `addWildcardAllowFrom`, onboarding types။
- Tool param helpers: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`။
- Docs link helper: `formatDocsLink`။

ထုတ်ဝေမှု:

- `openclaw/plugin-sdk` အဖြစ် ထုတ်ဝေခြင်း (သို့မဟုတ် core အောက်တွင် `openclaw/plugin-sdk` အဖြစ် export ပြုလုပ်ခြင်း)။
- Semver နှင့် တည်ငြိမ်မှုအပေါ် သတ်မှတ်ချက်အတိအကျ ပါဝင်ရမည်။

### 2. Plugin Runtime (လုပ်ဆောင်ရေးအလွှာ၊ inject လုပ်ပေးထားသည်)

48. Scope: core runtime behavior ကို ထိတွေ့သည့် အရာအားလုံး။
49. Plugin များသည် `OpenClawPluginApi.runtime` မှတစ်ဆင့် access လုပ်ရပြီး `src/**` ကို import မလုပ်ရ။

အဆိုပြုထားသော surface (နည်းသော်လည်း ပြည့်စုံ):

```ts
24. export type PluginRuntime = {
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
        peer: { kind: RoutePeerKind; id: string };
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

မှတ်ချက်များ:

- Runtime သည် core အပြုအမူများကို ဝင်ရောက်အသုံးပြုနိုင်သည့် တစ်ခုတည်းသော နည်းလမ်း ဖြစ်သည်။
- SDK ကို ရည်ရွယ်ချက်ရှိရှိ သေးငယ်ပြီး တည်ငြိမ်စေရန် ဒီဇိုင်းထားသည်။
- Runtime method တစ်ခုချင်းစီသည် ရှိပြီးသား core implementation တစ်ခုနှင့် တိုက်ရိုက် မျက်နှာချင်းဆိုင် ကိုက်ညီသည် (ထပ်ပွားမှု မရှိ)။

## ပြောင်းရွှေ့မှု အစီအစဉ် (အဆင့်လိုက်၊ လုံခြုံ)

### Phase 0: scaffolding

- `openclaw/plugin-sdk` ကို မိတ်ဆက်ခြင်း။
- `OpenClawPluginApi` ထဲသို့ အထက်ပါ surface ပါဝင်သော `api.runtime` ကို ထည့်သွင်းခြင်း။
- ကူးပြောင်းကာလအတွင်း ရှိပြီးသား import များကို ထိန်းသိမ်းထားခြင်း (deprecation သတိပေးချက်များ ပါဝင်)။

### Phase 1: bridge သန့်ရှင်းရေး (အန္တရာယ်နည်း)

- extension တစ်ခုချင်းစီအလိုက် `core-bridge.ts` ကို `api.runtime` ဖြင့် အစားထိုးခြင်း။
- BlueBubbles, Zalo, Zalo Personal ကို ပထမဦးဆုံး ပြောင်းရွှေ့ခြင်း (ပြီးသားနီးစပ်နေပြီးသား)။
- ထပ်တူညီနေသော bridge code များ ဖယ်ရှားခြင်း။

### Phase 2: တိုက်ရိုက်-import အနည်းငယ်သာရှိသော plugin များ

- Matrix ကို SDK + runtime သို့ ပြောင်းရွှေ့ခြင်း။
- onboarding, directory, group mention logic များကို အတည်ပြုစစ်ဆေးခြင်း။

### Phase 3: တိုက်ရိုက်-import အများကြီးပါဝင်သော plugin များ

- MS Teams ကို ပြောင်းရွှေ့ခြင်း (runtime helper များ အများဆုံးပါဝင်)။
- reply/typing semantics များသည် လက်ရှိ အပြုအမူနှင့် ကိုက်ညီကြောင်း သေချာစေရန် စစ်ဆေးခြင်း။

### Phase 4: iMessage ကို plugin အဖြစ်ပြောင်းခြင်း

- iMessage ကို `extensions/imessage` ထဲသို့ ရွှေ့ခြင်း။
- တိုက်ရိုက် core ခေါ်ယူမှုများကို `api.runtime` ဖြင့် အစားထိုးခြင်း။
- config keys, CLI အပြုအမူနှင့် docs များကို မပြောင်းလဲဘဲ ထိန်းသိမ်းထားခြင်း။

### Phase 5: အတည်ပြုမှုနှင့် အကောင်အထည်ဖော်ခြင်း

- lint rule / CI စစ်ဆေးမှု ထည့်သွင်းခြင်း — `src/**` မှ `extensions/**` import မရှိရ။
- plugin SDK/ဗားရှင်း ကိုက်ညီမှု စစ်ဆေးချက်များ ထည့်သွင်းခြင်း (runtime + SDK semver)။

## ကိုက်ညီမှုနှင့် ဗားရှင်းစနစ်

- SDK: semver၊ ထုတ်ဝေထားပြီး၊ ပြောင်းလဲမှုများကို စာရွက်စာတမ်းပြုလုပ်ထားသည်။
- 50. Runtime: core release အလိုက် versioned ဖြစ်သည်။ `api.runtime.version` ကို ထည့်ပါ။
- Plugin များသည် လိုအပ်သော runtime အကွာအဝေးကို ကြေညာရမည် (ဥပမာ — `openclawRuntime: ">=2026.2.0"`)။

## စမ်းသပ်မှု မဟာဗျူဟာ

- Adapter အဆင့် unit test များ (runtime function များကို အမှန်တကယ် core implementation ဖြင့် စမ်းသပ်ခြင်း)။
- Plugin တစ်ခုချင်းစီအတွက် golden test များ — အပြုအမူ ပြောင်းလဲမှု မရှိကြောင်း အတည်ပြုရန် (routing, pairing, allowlist, mention gating)။
- CI တွင် အသုံးပြုရန် အဆုံးမှ အဆုံး end-to-end plugin နမူနာ တစ်ခု (install + run + smoke)။

## ဖွင့်ထားသော မေးခွန်းများ

- SDK types များကို ဘယ်မှာ ထားမလဲ — သီးခြား package သို့မဟုတ် core export အဖြစ်လား။
- Runtime type များကို ဘယ်လို ဖြန့်ချိမလဲ — SDK (types only) ထဲလား သို့မဟုတ် core ထဲလား။
- အတွဲလိုက် plugin များနှင့် အပြင်ဘက် plugin များအတွက် docs link များကို ဘယ်လို ဖော်ပြမလဲ။
- ကူးပြောင်းကာလအတွင်း in-repo plugin များအတွက် core ကို တိုက်ရိုက် import လုပ်ခြင်းကို အကန့်အသတ်ဖြင့် ခွင့်ပြုမလား။

## အောင်မြင်မှု စံနှုန်းများ

- ချန်နယ်ချိတ်ဆက်မှုအားလုံးသည် SDK + runtime ကို အသုံးပြုသော plugin များ ဖြစ်ရမည်။
- `src/**` မှ `extensions/**` import မရှိရ။
- ချိတ်ဆက်မှုအသစ် template များသည် SDK + runtime ကိုသာ မူတည်ရမည်။
- အပြင်ဘက် plugin များကို core source access မရှိဘဲ ဖန်တီး၊ အပ်ဒိတ် ပြုလုပ်နိုင်ရမည်။

ဆက်စပ်စာရွက်စာတမ်းများ: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration)
