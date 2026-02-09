---
summary: "OpenClaw प्लगइन्स/एक्सटेंशन्स: डिस्कवरी, विन्यास, और सुरक्षा"
read_when:
  - प्लगइन्स/एक्सटेंशन्स जोड़ते या संशोधित करते समय
  - प्लगइन इंस्टॉल या लोड नियमों का दस्तावेज़ीकरण करते समय
title: "प्लगइन्स"
---

# प्लगइन्स (एक्सटेंशन्स)

## त्वरित प्रारंभ (प्लगइन्स में नए हैं?)

एक प्लगइन बस एक **छोटा कोड मॉड्यूल** होता है जो OpenClaw को अतिरिक्त
विशेषताओं (कमांड्स, टूल्स, और Gateway RPC) के साथ विस्तारित करता है।

अधिकांश समय, आप प्लगइन्स का उपयोग तब करेंगे जब आपको ऐसी सुविधा चाहिए
जो अभी core OpenClaw में अंतर्निहित नहीं है (या आप वैकल्पिक सुविधाओं को
अपने मुख्य इंस्टॉल से बाहर रखना चाहते हैं)।

त्वरित मार्ग:

1. देखें कि क्या पहले से लोड है:

```bash
openclaw plugins list
```

2. एक आधिकारिक प्लगइन इंस्टॉल करें (उदाहरण: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Gateway को restart करें, फिर `plugins.entries.<id>` के अंतर्गत configure करें.config\`.

एक ठोस उदाहरण प्लगइन के लिए [Voice Call](/plugins/voice-call) देखें।

## उपलब्ध प्लगइन्स (आधिकारिक)

- Microsoft Teams 2026.1.15 से केवल प्लगइन के रूप में उपलब्ध है; यदि आप Teams का उपयोग करते हैं तो `@openclaw/msteams` इंस्टॉल करें।
- Memory (Core) — बंडल किया गया मेमोरी सर्च प्लगइन (डिफ़ॉल्ट रूप से सक्षम via `plugins.slots.memory`)
- Memory (LanceDB) — बंडल किया गया दीर्घकालिक मेमोरी प्लगइन (ऑटो-रिकॉल/कैप्चर; `plugins.slots.memory = "memory-lancedb"` सेट करें)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (प्रदाता प्रमाणीकरण) — `google-antigravity-auth` के रूप में बंडल (डिफ़ॉल्ट रूप से अक्षम)
- Gemini CLI OAuth (प्रदाता प्रमाणीकरण) — `google-gemini-cli-auth` के रूप में बंडल (डिफ़ॉल्ट रूप से अक्षम)
- Qwen OAuth (प्रदाता प्रमाणीकरण) — `qwen-portal-auth` के रूप में बंडल (डिफ़ॉल्ट रूप से अक्षम)
- Copilot Proxy (प्रदाता प्रमाणीकरण) — स्थानीय VS Code Copilot Proxy ब्रिज; अंतर्निहित `github-copilot` डिवाइस लॉगिन से अलग (बंडल, डिफ़ॉल्ट रूप से अक्षम)

OpenClaw plugins **TypeScript modules** हैं जिन्हें runtime पर jiti के माध्यम से लोड किया जाता है। **Config
validation plugin code execute नहीं करता**; यह plugin manifest और JSON
Schema का उपयोग करता है। देखें [Plugin manifest](/plugins/manifest)।

प्लगइन्स पंजीकृत कर सकते हैं:

- Gateway RPC विधियाँ
- Gateway HTTP हैंडलर्स
- एजेंट टूल्स
- CLI कमांड्स
- पृष्ठभूमि सेवाएँ
- वैकल्पिक विन्यास सत्यापन
- **Skills** (प्लगइन मैनिफ़ेस्ट में `skills` डायरेक्टरी सूचीबद्ध करके)
- **ऑटो-रिप्लाई कमांड्स** (AI एजेंट को बुलाए बिना निष्पादित)

Plugins Gateway के साथ **in‑process** चलते हैं, इसलिए उन्हें trusted code की तरह treat करें।
Tool authoring guide: [Plugin agent tools](/plugins/agent-tools)।

## रनटाइम हेल्पर्स

Plugins `api.runtime` के माध्यम से selected core helpers तक access कर सकते हैं। Telephony TTS के लिए:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

टिप्पणियाँ:

- core `messages.tts` विन्यास (OpenAI या ElevenLabs) का उपयोग करता है।
- PCM audio buffer + sample rate लौटाता है। Plugins को providers के लिए resample/encode करना होगा।
- Edge TTS टेलीफ़ोनी के लिए समर्थित नहीं है।

## डिस्कवरी और प्रीसिडेंस

OpenClaw निम्न क्रम में स्कैन करता है:

1. Config पाथ्स

- `plugins.load.paths` (फ़ाइल या डायरेक्टरी)

2. वर्कस्पेस एक्सटेंशन्स

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. ग्लोबल एक्सटेंशन्स

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. बंडल्ड एक्सटेंशन्स (OpenClaw के साथ शिप किए गए, **डिफ़ॉल्ट रूप से अक्षम**)

- `<openclaw>/extensions/*`

Bundled plugins को `plugins.entries.<id>` के माध्यम से explicitly enable करना होगा`.enabled`
या `openclaw plugins enable <id>`। Installed plugins default रूप से enabled होते हैं,
लेकिन उसी तरीके से disable किए जा सकते हैं।

प्रत्येक plugin में उसके root में एक `openclaw.plugin.json` फ़ाइल शामिल होनी चाहिए। यदि कोई path
किसी फ़ाइल की ओर इशारा करता है, तो plugin root उस फ़ाइल की directory होती है और उसमें manifest होना चाहिए।

यदि कई प्लगइन्स एक ही id पर रिज़ॉल्व होते हैं, तो ऊपर दिए गए क्रम में पहला मैच जीतता है
और कम प्रीसिडेंस वाली प्रतियाँ अनदेखी कर दी जाती हैं।

### पैकेज पैक्स

एक प्लगइन डायरेक्टरी में `package.json` शामिल हो सकता है जिसमें `openclaw.extensions` हों:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

प्रत्येक entry एक plugin बन जाती है। यदि pack कई extensions सूचीबद्ध करता है, तो plugin id
`name/<fileBase>` बन जाता है।

यदि आपका प्लगइन npm निर्भरताएँ इम्पोर्ट करता है, तो उन्हें उसी डायरेक्टरी में इंस्टॉल करें ताकि
`node_modules` उपलब्ध हो (`npm install` / `pnpm install`)।

### चैनल कैटलॉग मेटाडेटा

Channel plugins `openclaw.channel` के माध्यम से onboarding metadata और
`openclaw.install` के माध्यम से install hints advertise कर सकते हैं। यह core catalog को data-free रखता है।

उदाहरण:

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

OpenClaw **external channel catalogs** (उदाहरण के लिए, एक MPM
registry export) को भी merge कर सकता है। इनमें से किसी एक पर एक JSON फ़ाइल डालें:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

या `OPENCLAW_PLUGIN_CATALOG_PATHS` (या `OPENCLAW_MPM_CATALOG_PATHS`) को
एक या अधिक JSON फ़ाइलों (comma/semicolon/`PATH`‑delimited) की ओर point करें। प्रत्येक फ़ाइल में
`{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...}`
शामिल होना चाहिए। } } ] }\`.

## प्लगइन IDs

डिफ़ॉल्ट प्लगइन ids:

- पैकेज पैक्स: `package.json` `name`
- स्टैंडअलोन फ़ाइल: फ़ाइल बेस नाम (`~/.../voice-call.ts` → `voice-call`)

यदि कोई प्लगइन `id` एक्सपोर्ट करता है, तो OpenClaw इसका उपयोग करता है, लेकिन
जब यह कॉन्फ़िगर किए गए id से मेल नहीं खाता तो चेतावनी देता है।

## विन्यास

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

फ़ील्ड्स:

- `enabled`: मास्टर टॉगल (डिफ़ॉल्ट: true)
- `allow`: allowlist (वैकल्पिक)
- `deny`: denylist (वैकल्पिक; deny की प्राथमिकता)
- `load.paths`: अतिरिक्त प्लगइन फ़ाइलें/डायरेक्टरीज़
- `entries.<id>`: प्रति‑plugin toggles + config

विन्यास परिवर्तन **Gateway पुनः प्रारंभ** की आवश्यकता रखते हैं।

सत्यापन नियम (सख्त):

- `entries`, `allow`, `deny`, या `slots` में अज्ञात प्लगइन ids **त्रुटियाँ** हैं।
- अज्ञात \`channels.<id>\`\` keys **errors** माने जाते हैं, जब तक कि कोई plugin manifest
  उस channel id को declare न करे।
- प्लगइन विन्यास को `openclaw.plugin.json` में एम्बेडेड JSON Schema का उपयोग करके सत्यापित किया जाता है
  (`configSchema`)।
- यदि कोई प्लगइन अक्षम है, तो उसका विन्यास सुरक्षित रहता है और एक **चेतावनी** जारी की जाती है।

## प्लगइन स्लॉट्स (एक्सक्लूसिव श्रेणियाँ)

कुछ plugin categories **exclusive** होती हैं (एक समय में केवल एक active)। किस plugin के पास slot होगा यह चुनने के लिए
`plugins.slots` का उपयोग करें:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

यदि कई plugins `kind: "memory"` declare करते हैं, तो केवल चुना हुआ ही load होगा। बाकी plugins diagnostics के साथ disabled कर दिए जाते हैं।

## कंट्रोल UI (स्कीमा + लेबल्स)

कंट्रोल UI बेहतर फ़ॉर्म्स रेंडर करने के लिए `config.schema` (JSON Schema + `uiHints`) का उपयोग करता है।

OpenClaw खोजे गए प्लगइन्स के आधार पर रनटाइम पर `uiHints` को बढ़ाता है:

- `plugins.entries.<id>` के लिए प्रति‑plugin labels जोड़ता है`/`.enabled`/`.config\`
- वैकल्पिक plugin‑provided config field hints को यहाँ merge करता है:
  `plugins.entries.<id>`.config.<field>\`

यदि आप चाहते हैं कि आपके प्लगइन कॉन्फ़िग फ़ील्ड्स अच्छे लेबल/प्लेसहोल्डर दिखाएँ (और सीक्रेट्स को संवेदनशील के रूप में चिह्नित करें),
तो प्लगइन मैनिफ़ेस्ट में अपने JSON Schema के साथ `uiHints` प्रदान करें।

उदाहरण:

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

`plugins update` केवल `plugins.installs` के अंतर्गत ट्रैक किए गए npm इंस्टॉल्स के लिए काम करता है।

प्लगइन्स अपने स्वयं के टॉप‑लेवल कमांड्स भी पंजीकृत कर सकते हैं (उदाहरण: `openclaw voicecall`)।

## प्लगइन API (अवलोकन)

प्लगइन्स निम्न में से एक एक्सपोर्ट करते हैं:

- एक function: `(api) => { ...` }\`
- एक object: `{ id, name, configSchema, register(api) { ...` } }\`

## प्लगइन हुक्स

Plugins hooks ship कर सकते हैं और runtime पर उन्हें register कर सकते हैं। यह किसी plugin bundle को बिना अलग hook pack install किए
event‑driven automation देने की अनुमति देता है।

### उदाहरण

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

टिप्पणियाँ:

- हुक डायरेक्टरीज़ सामान्य हुक संरचना का पालन करती हैं (`HOOK.md` + `handler.ts`)।
- हुक पात्रता नियम अब भी लागू होते हैं (OS/bins/env/config आवश्यकताएँ)।
- प्लगइन‑प्रबंधित हुक्स `openclaw hooks list` में `plugin:<id>` के साथ दिखाई देते हैं।
- आप `openclaw hooks` के माध्यम से प्लगइन‑प्रबंधित हुक्स को सक्षम/अक्षम नहीं कर सकते; इसके बजाय प्लगइन को सक्षम/अक्षम करें।

## प्रदाता प्लगइन्स (मॉडल प्रमाणीकरण)

प्लगइन्स **मॉडल प्रदाता प्रमाणीकरण** फ़्लोज़ पंजीकृत कर सकते हैं ताकि उपयोगकर्ता OpenClaw के भीतर ही OAuth या
API‑key सेटअप चला सकें (किसी बाहरी स्क्रिप्ट की आवश्यकता नहीं)।

`api.registerProvider(...)` के माध्यम से एक provider register करें। प्रत्येक provider एक या अधिक auth methods expose करता है
(OAuth, API key, device code, आदि)। ये methods power प्रदान करते हैं:

- `openclaw models auth login --provider <id> [--method <id>]`

उदाहरण:

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

टिप्पणियाँ:

- `run` को एक `ProviderAuthContext` मिलता है जिसमें `prompter`, `runtime`,
  `openUrl`, और `oauth.createVpsAwareHandlers` हेल्पर्स होते हैं।
- जब आपको डिफ़ॉल्ट मॉडल या प्रदाता विन्यास जोड़ने की आवश्यकता हो, तो `configPatch` लौटाएँ।
- `defaultModel` लौटाएँ ताकि `--set-default` एजेंट डिफ़ॉल्ट्स अपडेट कर सके।

### मैसेजिंग चैनल पंजीकृत करें

Plugins **channel plugins** register कर सकते हैं जो built‑in channels
(WhatsApp, Telegram, आदि) की तरह व्यवहार करते हैं। Channel config `channels.<id>` के अंतर्गत रहती है\` और आपके channel plugin code द्वारा validated की जाती है।

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

टिप्पणियाँ:

- Config को `channels.<id>` के अंतर्गत रखें`(न कि`plugins.entries\`)।
- `meta.label` का उपयोग CLI/UI सूचियों में लेबल्स के लिए किया जाता है।
- `meta.aliases` नॉर्मलाइज़ेशन और CLI इनपुट्स के लिए वैकल्पिक ids जोड़ता है।
- `meta.preferOver` उन चैनल ids की सूची देता है जिन्हें दोनों कॉन्फ़िगर होने पर ऑटो‑एनेबल से छोड़ना है।
- `meta.detailLabel` और `meta.systemImage` UIs को समृद्ध चैनल लेबल्स/आइकन्स दिखाने देते हैं।

### नया मैसेजिंग चैनल लिखें (स्टेप‑बाय‑स्टेप)

इसे तब उपयोग करें जब आपको **new chat surface** (एक “messaging channel”) चाहिए, न कि कोई model provider।
Model provider docs `/providers/*` के अंतर्गत उपलब्ध हैं।

1. एक id + कॉन्फ़िग संरचना चुनें

- सभी channel config `channels.<id>` के अंतर्गत रहती है\`।
- Multi‑account setups के लिए `channels.<id>` को प्राथमिकता दें.accounts.<accountId>\`।

2. चैनल मेटाडेटा परिभाषित करें

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` CLI/UI सूचियों को नियंत्रित करते हैं।
- `meta.docsPath` को `/channels/<id>` जैसी डॉक्स पेज की ओर इशारा करना चाहिए।
- `meta.preferOver` किसी प्लगइन को दूसरे चैनल को प्रतिस्थापित करने देता है (ऑटो‑एनेबल इसे प्राथमिकता देता है)।
- `meta.detailLabel` और `meta.systemImage` UIs द्वारा विवरण टेक्स्ट/आइकन्स के लिए उपयोग किए जाते हैं।

3. आवश्यक एडेप्टर्स लागू करें

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (चैट प्रकार, मीडिया, थ्रेड्स, आदि)
- `outbound.deliveryMode` + `outbound.sendText` (मूलभूत सेंड के लिए)

4. आवश्यकता अनुसार वैकल्पिक एडेप्टर्स जोड़ें

- `setup` (विज़ार्ड), `security` (DM नीति), `status` (हेल्थ/डायग्नोस्टिक्स)
- `gateway` (स्टार्ट/स्टॉप/लॉगिन), `mentions`, `threading`, `streaming`
- `actions` (मैसेज एक्शन्स), `commands` (नेटिव कमांड व्यवहार)

5. अपने प्लगइन में चैनल पंजीकृत करें

- `api.registerChannel({ plugin })`

न्यूनतम कॉन्फ़िग उदाहरण:

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

न्यूनतम चैनल प्लगइन (केवल आउटबाउंड):

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

Plugin को load करें (extensions dir या `plugins.load.paths`), gateway restart करें,
फिर अपने config में `channels.<id>` को configure करें\`।

### एजेंट टूल्स

समर्पित गाइड देखें: [Plugin agent tools](/plugins/agent-tools)।

### Gateway RPC विधि पंजीकृत करें

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### CLI कमांड्स पंजीकृत करें

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

### ऑटो‑रिप्लाई कमांड्स पंजीकृत करें

Plugins custom slash commands register कर सकते हैं जो **AI agent को invoke किए बिना** execute होते हैं। यह toggle commands, status checks, या ऐसे quick actions के लिए उपयोगी है
जिन्हें LLM processing की आवश्यकता नहीं होती।

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

कमांड हैंडलर संदर्भ:

- `senderId`: प्रेषक का ID (यदि उपलब्ध)
- `channel`: वह चैनल जहाँ कमांड भेजा गया
- `isAuthorizedSender`: क्या प्रेषक अधिकृत उपयोगकर्ता है
- `args`: कमांड के बाद दिए गए आर्ग्युमेंट्स (यदि `acceptsArgs: true`)
- `commandBody`: पूर्ण कमांड टेक्स्ट
- `config`: वर्तमान OpenClaw कॉन्फ़िग

कमांड विकल्प:

- `name`: कमांड नाम (लीडिंग `/` के बिना)
- `description`: कमांड सूचियों में दिखाया जाने वाला सहायता टेक्स्ट
- `acceptsArgs`: क्या command arguments स्वीकार करता है (default: false)। यदि false है और arguments दिए गए हैं, तो command match नहीं करेगा और message अन्य handlers के पास चला जाएगा
- `requireAuth`: क्या अधिकृत प्रेषक की आवश्यकता है (डिफ़ॉल्ट: true)
- `handler`: वह फ़ंक्शन जो `{ text: string }` लौटाता है (async हो सकता है)

प्रमाणीकरण और आर्ग्युमेंट्स के साथ उदाहरण:

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

टिप्पणियाँ:

- प्लगइन कमांड्स अंतर्निहित कमांड्स और AI एजेंट से **पहले** प्रोसेस होते हैं
- कमांड्स वैश्विक रूप से पंजीकृत होते हैं और सभी चैनलों में काम करते हैं
- कमांड नाम केस‑इन्सेंसिटिव होते हैं (`/MyStatus` `/mystatus` से मेल खाता है)
- कमांड नाम किसी अक्षर से शुरू होने चाहिए और केवल अक्षर, अंक, हाइफ़न, और अंडरस्कोर शामिल कर सकते हैं
- Reserved command names (जैसे `help`, `status`, `reset`, आदि) plugins द्वारा override नहीं किए जा सकते
- प्लगइन्स के बीच डुप्लिकेट कमांड पंजीकरण डायग्नोस्टिक त्रुटि के साथ विफल होगा

### पृष्ठभूमि सेवाएँ पंजीकृत करें

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## नामकरण परंपराएँ

- Gateway विधियाँ: `pluginId.action` (उदाहरण: `voicecall.status`)
- टूल्स: `snake_case` (उदाहरण: `voice_call`)
- CLI कमांड्स: kebab या camel, लेकिन core कमांड्स से टकराव से बचें

## Skills

Plugins repo में एक skill ship कर सकते हैं (`skills/<name>/SKILL.md`)।
`plugins.entries.<id>` के साथ इसे enable करें.enabled\` (या अन्य config gates) और सुनिश्चित करें कि

## वितरण (npm)

अनुशंसित पैकेजिंग:

- मुख्य पैकेज: `openclaw` (यह रिपॉज़िटरी)
- प्लगइन्स: `@openclaw/*` के अंतर्गत अलग‑अलग npm पैकेज (उदाहरण: `@openclaw/voice-call`)

पब्लिशिंग अनुबंध:

- प्लगइन `package.json` में एक या अधिक एंट्री फ़ाइलों के साथ `openclaw.extensions` शामिल होना चाहिए।
- एंट्री फ़ाइलें `.js` या `.ts` हो सकती हैं (jiti रनटाइम पर TS लोड करता है)।
- `openclaw plugins install <npm-spec>` `npm pack` का उपयोग करता है, `~/.openclaw/extensions/<id>/` में एक्सट्रैक्ट करता है, और कॉन्फ़िग में सक्षम करता है।
- कॉन्फ़िग कुंजी स्थिरता: scoped पैकेजेस को `plugins.entries.*` के लिए **unscoped** id में नॉर्मलाइज़ किया जाता है।

## उदाहरण प्लगइन: Voice Call

इस रिपॉज़िटरी में एक voice‑call प्लगइन शामिल है (Twilio या लॉग फ़ॉलबैक):

- स्रोत: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- टूल: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- कॉन्फ़िग (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (वैकल्पिक `statusCallbackUrl`, `twimlUrl`)
- कॉन्फ़िग (dev): `provider: "log"` (कोई नेटवर्क नहीं)

सेटअप और उपयोग के लिए [Voice Call](/plugins/voice-call) और `extensions/voice-call/README.md` देखें।

## सुरक्षा नोट्स

प्लगइन्स गेटवे के साथ इन-प्रोसेस चलते हैं। उन्हें विश्वसनीय कोड के रूप में मानें:

- केवल वही प्लगइन्स इंस्टॉल करें जिन पर आप भरोसा करते हैं।
- `plugins.allow` allowlists को प्राथमिकता दें।
- परिवर्तनों के बाद Gateway को पुनः प्रारंभ करें।

## प्लगइन्स का परीक्षण

प्लगइन्स परीक्षण शिप कर सकते हैं (और करना चाहिए):

- इन‑रिपॉज़िटरी प्लगइन्स Vitest परीक्षणों को `src/**` के अंतर्गत रख सकते हैं (उदाहरण: `src/plugins/voice-call.plugin.test.ts`)।
- अलग से प्रकाशित प्लगइन्स को अपना CI (lint/build/test) चलाना चाहिए और यह सत्यापित करना चाहिए कि `openclaw.extensions` बिल्ट एंट्रीपॉइंट (`dist/index.js`) की ओर इशारा करता है।
