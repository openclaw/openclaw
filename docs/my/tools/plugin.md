---
summary: "OpenClaw ပလပ်ဂင်/တိုးချဲ့ချက်များ — ရှာဖွေတွေ့ရှိမှု၊ ဖွဲ့စည်းပြင်ဆင်မှုနှင့် လုံခြုံရေး"
read_when:
  - ပလပ်ဂင်/တိုးချဲ့ချက်များ ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း ပြုလုပ်နေသည့်အချိန်
  - ပလပ်ဂင် ထည့်သွင်းခြင်း သို့မဟုတ် ဖွင့်သုံးစည်းမျဉ်းများကို စာတမ်းရေးသားနေသည့်အချိန်
title: "Plugins"
---

# Plugins (Extensions)

## Quick start (plugins အသစ်အသုံးပြုသူများအတွက်)

ပလပ်ဂင်ဆိုသည်မှာ OpenClaw ကို အပိုအင်္ဂါရပ်များ
(အမိန့်များ၊ ကိရိယာများ၊ Gateway RPC) ဖြင့် တိုးချဲ့ပေးသည့်
**ကုဒ်မော်ဂျူးအသေးစား** တစ်ခုသာ ဖြစ်သည်။

အများအားဖြင့် core OpenClaw ထဲတွင် မပါဝင်သေးသော အင်္ဂါရပ်တစ်ခုကို လိုချင်သည့်အခါ
(သို့မဟုတ် အလိုအလျောက်မဟုတ်သော အင်္ဂါရပ်များကို သင့်အဓိက တပ်ဆင်မှုမှ ခွဲထားချင်သည့်အခါ)
ပလပ်ဂင်များကို အသုံးပြုကြသည်။

အမြန်လမ်းကြောင်း —

1. လက်ရှိ လိုဒ်ထားပြီးသားများကို ကြည့်ရန် —

```bash
openclaw plugins list
```

2. တရားဝင် ပလပ်ဂင်တစ်ခု ထည့်သွင်းရန် (ဥပမာ — Voice Call) —

```bash
openclaw plugins install @openclaw/voice-call
```

3. 23. Gateway ကို restart လုပ်ပြီးနောက် `plugins.entries.<id>` အောက်တွင် configure လုပ်ပါ။.config\`.

အကောင်အထည်ဖော်ထားသော ပလပ်ဂင် ဥပမာအတွက် [Voice Call](/plugins/voice-call) ကို ကြည့်ပါ။

## Available plugins (official)

- Microsoft Teams သည် 2026.1.15 အချိန်မှစ၍ ပလပ်ဂင်ဖြင့်သာ အသုံးပြုနိုင်ပါသည်။ Teams ကို အသုံးပြုပါက `@openclaw/msteams` ကို ထည့်သွင်းပါ။
- Memory (Core) — ထည့်သွင်းပြီးသား memory search ပလပ်ဂင် (ပုံမှန်အားဖြင့် `plugins.slots.memory` ဖြင့် ဖွင့်ထားသည်)
- Memory (LanceDB) — ထည့်သွင်းပြီးသား ရေရှည် memory ပလပ်ဂင် (auto‑recall/capture; `plugins.slots.memory = "memory-lancedb"` ကို သတ်မှတ်ပါ)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (provider auth) — `google-antigravity-auth` အဖြစ် ထည့်သွင်းပြီးသား (ပုံမှန်အားဖြင့် ပိတ်ထားသည်)
- Gemini CLI OAuth (provider auth) — `google-gemini-cli-auth` အဖြစ် ထည့်သွင်းပြီးသား (ပုံမှန်အားဖြင့် ပိတ်ထားသည်)
- Qwen OAuth (provider auth) — `qwen-portal-auth` အဖြစ် ထည့်သွင်းပြီးသား (ပုံမှန်အားဖြင့် ပိတ်ထားသည်)
- Copilot Proxy (provider auth) — local VS Code Copilot Proxy bridge; built‑in `github-copilot` device login နှင့် မတူပါ (ထည့်သွင်းပြီးသား၊ ပုံမှန်အားဖြင့် ပိတ်ထားသည်)

24. OpenClaw plugins များသည် jiti မှတဆင့် runtime တွင် load လုပ်သော **TypeScript modules** များဖြစ်သည်။ 25. **Config validation သည် plugin code ကို မအလုပ်လုပ်စေပါ**; plugin manifest နှင့် JSON Schema ကိုသာ အသုံးပြုသည်။ 26. [Plugin manifest](/plugins/manifest) ကို ကြည့်ပါ။

ပလပ်ဂင်များသည် အောက်ပါအရာများကို မှတ်ပုံတင်နိုင်ပါသည် —

- Gateway RPC နည်းလမ်းများ
- Gateway HTTP handlers
- Agent tools
- CLI အမိန့်များ
- နောက်ခံဝန်ဆောင်မှုများ
- မလိုအပ်လျှင် ထပ်ဆောင်း config validation
- **Skills** (plugin manifest ထဲတွင် `skills` လမ်းကြောင်းများကို စာရင်းပြုလုပ်ခြင်းဖြင့်)
- **Auto‑reply commands** (AI agent ကို မခေါ်ဘဲ အလိုအလျောက် အလုပ်လုပ်သည်)

27. Plugins များသည် Gateway နှင့်အတူ **in‑process** အဖြစ် chạy သဖြင့် trusted code အဖြစ် ဆက်ဆံရမည်။
28. Tool authoring guide: [Plugin agent tools](/plugins/agent-tools)။

## Runtime helpers

29. Plugins များသည် `api.runtime` မှတဆင့် ရွေးချယ်ထားသော core helpers များကို အသုံးပြုနိုင်သည်။ 30. telephony TTS အတွက်:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

မှတ်ချက်များ —

- core `messages.tts` configuration (OpenAI သို့မဟုတ် ElevenLabs) ကို အသုံးပြုပါသည်။
- 31. PCM audio buffer + sample rate ကို ပြန်ပေးသည်။ 32. Plugins များသည် providers များအတွက် resample/encode လုပ်ရမည်။
- Telephony အတွက် Edge TTS ကို မထောက်ပံ့ပါ။

## Discovery & precedence

OpenClaw သည် အောက်ပါအစဉ်အတိုင်း scan လုပ်ပါသည် —

1. Config လမ်းကြောင်းများ

- `plugins.load.paths` (ဖိုင် သို့မဟုတ် ဒိုင်ရက်ထရီ)

2. Workspace extensions

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Global extensions

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Bundled extensions (OpenClaw နှင့်အတူ ပို့ဆောင်ထားပြီး **ပုံမှန်အားဖြင့် ပိတ်ထားသည်**)

- `<openclaw>/extensions/*`

33. Bundled plugins များကို `plugins.entries.<id>.enabled` သို့မဟုတ် `openclaw plugins enable <id>` ဖြင့် တိတိကျကျ enable လုပ်ရမည်။34. Installed plugins များသည် default အနေဖြင့် enable ဖြစ်သော်လည်း အတူတူသောနည်းလမ်းဖြင့် disable လုပ်နိုင်သည်။ 35. plugin တစ်ခုချင်းစီသည် ၎င်း၏ root တွင် `openclaw.plugin.json` ဖိုင် တစ်ခု ပါဝင်ရမည်။

36. path တစ်ခုသည် ဖိုင်တစ်ခုကို ညွှန်ပြနေပါက plugin root သည် ထိုဖိုင်၏ directory ဖြစ်ပြီး manifest ပါဝင်ရမည်။ 37. entry တစ်ခုချင်းစီသည် plugin တစ်ခု ဖြစ်လာမည်။

plugin id တူညီသည့် ပလပ်ဂင်များ အများအပြား ရှိပါက
အထက်ပါအစဉ်အတိုင်း ပထမဆုံး တွေ့ရှိသော plugin သာ အသုံးပြုမည်ဖြစ်ပြီး
နောက်အဆင့်အနိမ့်များကို လျစ်လျူရှုပါမည်။

### Package packs

ပလပ်ဂင် directory တစ်ခုတွင် `package.json` ဖိုင်နှင့်
`openclaw.extensions` ပါဝင်နိုင်ပါသည် —

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

38. pack တွင် extensions များစွာ ပါဝင်ပါက plugin id သည် `name/<fileBase>` ဖြစ်လာမည်။ 39. Channel plugins များသည် `openclaw.channel` မှတဆင့် onboarding metadata နှင့် `openclaw.install` မှတဆင့် install hints များကို ကြော်ငြာနိုင်သည်။

သင့်ပလပ်ဂင်က npm deps များကို import လုပ်ပါက
`node_modules` ( `npm install` / `pnpm install` ) ကို အသုံးပြုနိုင်ရန်
ထို directory ထဲတွင် ထည့်သွင်းထားရပါမည်။

### Channel catalog metadata

40. ထိုသို့လုပ်ခြင်းဖြင့် core catalog ကို data မပါဝင်အောင် ထိန်းထားနိုင်သည်။ 41. OpenClaw သည် **external channel catalogs** များကိုလည်း ပေါင်းစည်းနိုင်သည် (ဥပမာ MPM registry export)။

ဥပမာ —

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

42. အောက်ပါနေရာများထဲမှ တစ်ခုတွင် JSON ဖိုင်ကို ချထားပါ: 43. သို့မဟုတ် `OPENCLAW_PLUGIN_CATALOG_PATHS` (သို့ `OPENCLAW_MPM_CATALOG_PATHS`) ကို JSON ဖိုင် တစ်ခု သို့မဟုတ် အများအပြား (comma/semicolon/`PATH`-delimited) သို့ ညွှန်ပြပါ။

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

44. ဖိုင်တစ်ခုချင်းစီတွင် `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }` ပါဝင်ရမည်။ 45. `entries.<id>` 46. \`: per‑plugin toggles + config

## Plugin IDs

ပုံမှန် plugin id များ —

- Package packs: `package.json` `name`
- Standalone ဖိုင်: ဖိုင်၏ base name (`~/.../voice-call.ts` → `voice-call`)

plugin တစ်ခုက `id` ကို export လုပ်ထားပါက
OpenClaw သည် ၎င်းကို အသုံးပြုသော်လည်း
configured id နှင့် မကိုက်ညီပါက သတိပေးချက် ထုတ်ပေးပါမည်။

## Config

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Fields —

- `enabled`: အဓိက toggle (default: true)
- `allow`: allowlist (optional)
- `deny`: denylist (optional; deny က ဦးစားပေးအနိုင်ရ)
- `load.paths`: အပို plugin ဖိုင်များ/ဒိုင်ရက်ထရီများ
- 47. Unknown `channels.<id>`48. \` keys များသည် plugin manifest တွင် channel id ကို ကြေညာထားခြင်း မရှိပါက **error** များဖြစ်သည်။

Config ပြောင်းလဲမှုများသည် **Gateway ကို ပြန်လည်စတင်ရန် လိုအပ်ပါသည်**။

Validation စည်းမျဉ်းများ (တင်းကျပ်) —

- `entries`, `allow`, `deny`, သို့မဟုတ် `slots` ထဲရှိ မသိသော plugin id များကို **အမှား** အဖြစ် သတ်မှတ်ပါသည်။
- Unknown `channels.<id>` keys are **errors** unless a plugin manifest declares
  the channel id.
- Plugin config ကို `openclaw.plugin.json` ထဲတွင် ပါဝင်သည့် JSON Schema ဖြင့် စစ်ဆေးပါသည် (`configSchema`)။
- Plugin ကို ပိတ်ထားပါက ၎င်း၏ config ကို ထိန်းသိမ်းထားပြီး **သတိပေးချက်** ထုတ်ပေးပါမည်။

## Plugin slots (exclusive categories)

Some plugin categories are **exclusive** (only one active at a time). Use
`plugins.slots` to select which plugin owns the slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

If multiple plugins declare `kind: "memory"`, only the selected one loads. Others
are disabled with diagnostics.

## Control UI (schema + labels)

Control UI သည် `config.schema` (JSON Schema + `uiHints`) ကို အသုံးပြုပြီး
ပိုမိုကောင်းမွန်သော ဖောင်များကို ရေးဆွဲပါသည်။

OpenClaw သည် တွေ့ရှိထားသော plugins များအပေါ် အခြေခံ၍
runtime အချိန်တွင် `uiHints` ကို တိုးချဲ့ပါသည် —

- Adds per-plugin labels for `plugins.entries.<id>` / `.enabled` / `.config`
- Merges optional plugin-provided config field hints under:
  `plugins.entries.<id>.config.<field>`

သင့် plugin config field များကို label/placeholder ကောင်းကောင်း ပြသလိုပါက
(လျှို့ဝှက်ချက်များကို sensitive အဖြစ် သတ်မှတ်လိုပါက)
plugin manifest ထဲရှိ JSON Schema နှင့်အတူ `uiHints` ကို ပေးပါ။

ဥပမာ —

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` သည် `plugins.installs` အောက်တွင် မှတ်တမ်းတင်ထားသော npm installs များအတွက်သာ အလုပ်လုပ်ပါသည်။

Plugins များသည် ကိုယ်ပိုင် top‑level commands များကိုလည်း မှတ်ပုံတင်နိုင်ပါသည်
(ဥပမာ — `openclaw voicecall`)။

## Plugin API (overview)

Plugins များသည် အောက်ပါအရာများအနက် တစ်ခုကို export လုပ်ပါသည် —

- A function: `(api) => { ... }`
- An object: `{ id, name, configSchema, register(api) { ... } }`

## Plugin hooks

Plugins can ship hooks and register them at runtime. This lets a plugin bundle
event-driven automation without a separate hook pack install.

### Example

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

မှတ်ချက်များ —

- Hook directories များသည် ပုံမှန် hook structure (`HOOK.md` + `handler.ts`) ကို လိုက်နာရပါမည်။
- Hook အရည်အချင်း သတ်မှတ်စည်းမျဉ်းများ (OS/bins/env/config လိုအပ်ချက်များ) သည် ဆက်လက် အသုံးဝင်ပါသည်။
- Plugin က စီမံခန့်ခွဲသော hooks များသည် `openclaw hooks list` ထဲတွင် `plugin:<id>` ဖြင့် ပေါ်လာပါမည်။
- Plugin က စီမံခန့်ခွဲသော hooks များကို `openclaw hooks` ဖြင့် ဖွင့်/ပိတ် မလုပ်နိုင်ပါ —
  plugin ကို ဖွင့်/ပိတ် လုပ်ရပါမည်။

## Provider plugins (model auth)

Plugins များသည် **model provider auth** flow များကို မှတ်ပုံတင်နိုင်ပြီး
အသုံးပြုသူများအား OAuth သို့မဟုတ် API‑key setup ကို
OpenClaw အတွင်းမှ တိုက်ရိုက် ပြုလုပ်နိုင်စေပါသည်
(အပြင်ဘက် script မလိုအပ်ပါ)။

Register a provider via `api.registerProvider(...)`. Each provider exposes one
or more auth methods (OAuth, API key, device code, etc.). These methods power:

- `openclaw models auth login --provider <id> [--method <id>]`

ဥပမာ —

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

မှတ်ချက်များ —

- `run` သည် `ProviderAuthContext` ကို လက်ခံရရှိပြီး
  `prompter`, `runtime`, `openUrl`,
  နှင့် `oauth.createVpsAwareHandlers` helper များ ပါဝင်ပါသည်။
- default models သို့မဟုတ် provider config ထည့်သွင်းရန် လိုအပ်ပါက
  `configPatch` ကို ပြန်ပေးပါ။
- agent defaults ကို အပ်ဒိတ်လုပ်နိုင်ရန် `--set-default` က အသုံးပြုနိုင်စေရန်
  `defaultModel` ကို ပြန်ပေးပါ။

### Register a messaging channel

Plugins can register **channel plugins** that behave like built‑in channels
(WhatsApp, Telegram, etc.). Channel config lives under `channels.<id>` and is
validated by your channel plugin code.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

မှတ်ချက်များ —

- Put config under `channels.<id>` (not `plugins.entries`).
- `meta.label` ကို CLI/UI စာရင်းများအတွက် label အဖြစ် အသုံးပြုပါသည်။
- `meta.aliases` သည် normalization နှင့် CLI inputs အတွက် alternate ids များ ထည့်ပေးပါသည်။
- `meta.preferOver` သည် channel နှစ်ခုလုံး configure လုပ်ထားပါက auto‑enable ကို မလုပ်ရန် channel id များကို စာရင်းပြုလုပ်ပါသည်။
- `meta.detailLabel` နှင့် `meta.systemImage` သည် UI များတွင် ပိုမိုကြွယ်ဝသော channel label/icon များ ပြသနိုင်စေပါသည်။

### Write a new messaging channel (step‑by‑step)

Use this when you want a **new chat surface** (a “messaging channel”), not a model provider.
Model provider docs live under `/providers/*`.

1. id နှင့် config ပုံစံကို ရွေးချယ်ပါ

- All channel config lives under `channels.<id>`.
- Prefer `channels.<id>.accounts.<accountId>` for multi‑account setups.

2. Channel metadata ကို သတ်မှတ်ပါ

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` တို့သည် CLI/UI စာရင်းများကို ထိန်းချုပ်ပါသည်။
- `meta.docsPath` သည် `/channels/<id>` ကဲ့သို့သော docs စာမျက်နှာသို့ ညွှန်ပြရပါမည်။
- `meta.preferOver` သည် plugin တစ်ခုအား အခြား channel တစ်ခုကို အစားထိုးနိုင်စေပါသည် (auto‑enable သည် ၎င်းကို ဦးစားပေးပါသည်)။
- `meta.detailLabel` နှင့် `meta.systemImage` ကို UI များတွင် အသေးစိတ်စာသား/icon များအတွက် အသုံးပြုပါသည်။

3. လိုအပ်သော adapters များကို အကောင်အထည်ဖော်ပါ

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (chat အမျိုးအစားများ၊ media၊ threads စသည်)
- `outbound.deliveryMode` + `outbound.sendText` (အခြေခံ send အတွက်)

4. လိုအပ်သလို optional adapters များကို ထည့်ပါ

- `setup` (wizard), `security` (DM policy), `status` (health/diagnostics)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (message actions), `commands` (native command behavior)

5. Channel ကို သင့် plugin ထဲတွင် မှတ်ပုံတင်ပါ

- `api.registerChannel({ plugin })`

Minimal config ဥပမာ —

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

Minimal channel plugin (outbound‑only) —

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Load the plugin (extensions dir or `plugins.load.paths`), restart the gateway,
then configure `channels.<id>` in your config.

### Agent tools

သီးသန့် လမ်းညွှန်ကို ကြည့်ပါ — [Plugin agent tools](/plugins/agent-tools)။

### Register a gateway RPC method

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Register CLI commands

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Register auto-reply commands

Plugins can register custom slash commands that execute **without invoking the
AI agent**. This is useful for toggle commands, status checks, or quick actions
that don't need LLM processing.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

Command handler context —

- `senderId`: ပို့သူ၏ ID (ရနိုင်ပါက)
- `channel`: command ပို့ခဲ့သော channel
- `isAuthorizedSender`: ပို့သူသည် ခွင့်ပြုထားသော အသုံးပြုသူ ဟုတ်/မဟုတ်
- `args`: command နောက်တွင် ပေးပို့ထားသော arguments (`acceptsArgs: true` ရှိပါက)
- `commandBody`: command စာသား အပြည့်အစုံ
- `config`: လက်ရှိ OpenClaw config

Command options —

- `name`: command အမည် (ရှေ့ရှိ `/` မပါ)
- `description`: command စာရင်းများတွင် ပြသမည့် help စာသား
- `acceptsArgs`: Whether the command accepts arguments (default: false). If false and arguments are provided, the command won't match and the message falls through to other handlers
- `requireAuth`: ခွင့်ပြုထားသော ပို့သူ လိုအပ်မလား (default: true)
- `handler`: `{ text: string }` ကို ပြန်ပေးသော function (async ဖြစ်နိုင်)

authorization နှင့် arguments ပါသော ဥပမာ —

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

မှတ်ချက်များ —

- Plugin commands များကို built‑in commands နှင့် AI agent မတိုင်မီ **အရင်ဆုံး** ဆောင်ရွက်ပါသည်။
- Commands များကို global အဖြစ် မှတ်ပုံတင်ပြီး channel အားလုံးတွင် အသုံးပြုနိုင်ပါသည်။
- Command အမည်များသည် case‑insensitive ဖြစ်ပါသည် (`/MyStatus` သည် `/mystatus` နှင့် ကိုက်ညီသည်)။
- Command အမည်များသည် အက္ခရာတစ်လုံးဖြင့် စတင်ပြီး အက္ခရာ၊ နံပါတ်၊ hyphen၊ underscore များသာ ပါဝင်ရပါမည်။
- Reserved command names (like `help`, `status`, `reset`, etc.) cannot be overridden by plugins
- Plugin များအကြား duplicate command မှတ်ပုံတင်ပါက diagnostic error ဖြင့် မအောင်မြင်ပါ။

### Register background services

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Naming conventions

- Gateway methods: `pluginId.action` (ဥပမာ — `voicecall.status`)
- Tools: `snake_case` (ဥပမာ — `voice_call`)
- CLI commands: kebab သို့မဟုတ် camel ကို အသုံးပြုနိုင်သော်လည်း core commands များနှင့် မတိုက်ခိုက်စေရန် ရှောင်ကြဉ်ပါ။

## Skills

Plugins can ship a skill in the repo (`skills/<name>/SKILL.md`).
Enable it with `plugins.entries.<id>.enabled` (or other config gates) and ensure
it’s present in your workspace/managed skills locations.

## Distribution (npm)

အကြံပြုထားသော packaging —

- Main package: `openclaw` (ဤ repo)
- Plugins: `@openclaw/*` အောက်ရှိ သီးခြား npm packages များ (ဥပမာ — `@openclaw/voice-call`)

Publishing contract —

- Plugin `package.json` တွင် `openclaw.extensions` နှင့် entry files တစ်ခု သို့မဟုတ် အများအပြား ပါဝင်ရပါမည်။
- Entry files များသည် `.js` သို့မဟုတ် `.ts` ဖြစ်နိုင်ပါသည် (jiti သည် TS ကို runtime တွင် load လုပ်ပါသည်)။
- `openclaw plugins install <npm-spec>` သည် `npm pack` ကို အသုံးပြုပြီး `~/.openclaw/extensions/<id>/` ထဲသို့ extract လုပ်ကာ config ထဲတွင် ဖွင့်ပေးပါသည်။
- Config key တည်ငြိမ်မှု — scoped packages များကို `plugins.entries.*` အတွက် **unscoped** id သို့ normalize လုပ်ပါသည်။

## Example plugin: Voice Call

ဤ repo တွင် voice‑call plugin (Twilio သို့မဟုတ် log fallback) ပါဝင်ပါသည် —

- Source: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Tool: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Config (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (optional `statusCallbackUrl`, `twimlUrl`)
- Config (dev): `provider: "log"` (network မလိုအပ်)

Setup နှင့် အသုံးပြုနည်းအတွက် [Voice Call](/plugins/voice-call) နှင့် `extensions/voice-call/README.md` ကို ကြည့်ပါ။

## Safety notes

Plugins run in-process with the Gateway. Treat them as trusted code:

- ယုံကြည်ရသော plugins များကိုသာ ထည့်သွင်းပါ။
- `plugins.allow` allowlists ကို ဦးစားပေးပါ။
- ပြောင်းလဲမှုများပြီးနောက် Gateway ကို ပြန်လည်စတင်ပါ။

## Testing plugins

Plugins များသည် စမ်းသပ်မှုများကို ထည့်သွင်းပို့ဆောင်နိုင်ပြီး (လုပ်သင့်ပါသည်) —

- Repo အတွင်းရှိ plugins များသည် Vitest tests များကို `src/**` အောက်တွင် ထားနိုင်ပါသည် (ဥပမာ — `src/plugins/voice-call.plugin.test.ts`)။
- သီးခြား publish လုပ်ထားသော plugins များသည် ကိုယ်ပိုင် CI (lint/build/test) ကို လုပ်ဆောင်ရပြီး
  `openclaw.extensions` သည် build ပြီးသား entrypoint (`dist/index.js`) ကို ညွှန်ပြနေကြောင်း စစ်ဆေးရပါမည်။
