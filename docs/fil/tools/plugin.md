---
summary: "Mga plugin/extension ng OpenClaw: discovery, config, at kaligtasan"
read_when:
  - Pagdaragdag o pagbabago ng mga plugin/extension
  - Pagdodokumento ng mga patakaran sa pag-install o pag-load ng plugin
title: "Mga Plugin"
---

# Mga Plugin (Extensions)

## Mabilis na pagsisimula (bago sa mga plugin?)

Ang plugin ay isang **maliit na code module** na nagpapalawak sa OpenClaw gamit ang mga karagdagang
tampok (mga command, tool, at Gateway RPC).

Kadalasan, gagamit ka ng mga plugin kapag kailangan mo ng tampok na wala pa sa
core OpenClaw (o gusto mong ilayo ang mga opsyonal na tampok mula sa iyong pangunahing install).

Mabilis na ruta:

1. Tingnan kung ano ang kasalukuyang naka-load:

```bash
openclaw plugins list
```

2. Mag-install ng opisyal na plugin (halimbawa: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Restart the Gateway, then configure under `plugins.entries.<id>.config`.

Tingnan ang [Voice Call](/plugins/voice-call) para sa isang konkretong halimbawa ng plugin.

## Mga available na plugin (opisyal)

- Ang Microsoft Teams ay plugin-only simula 2026.1.15; i-install ang `@openclaw/msteams` kung gumagamit ka ng Teams.
- Memory (Core) — bundled na memory search plugin (enabled bilang default sa pamamagitan ng `plugins.slots.memory`)
- Memory (LanceDB) — bundled na long-term memory plugin (auto-recall/capture; itakda ang `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (provider auth) — bundled bilang `google-antigravity-auth` (disabled bilang default)
- Gemini CLI OAuth (provider auth) — bundled bilang `google-gemini-cli-auth` (disabled bilang default)
- Qwen OAuth (provider auth) — bundled bilang `qwen-portal-auth` (disabled bilang default)
- Copilot Proxy (provider auth) — lokal na VS Code Copilot Proxy bridge; hiwalay sa built-in na `github-copilot` device login (bundled, disabled bilang default)

OpenClaw plugins are **TypeScript modules** loaded at runtime via jiti. 23. **Hindi nagpapatupad ng plugin code ang config validation**; ginagamit nito ang plugin manifest at JSON Schema sa halip. 24. Tingnan ang [Plugin manifest](/plugins/manifest).

Maaaring magrehistro ang mga plugin ng:

- Mga Gateway RPC method
- Mga Gateway HTTP handler
- Mga agent tool
- Mga CLI command
- Mga background service
- Opsyonal na config validation
- **Skills** (sa pamamagitan ng paglista ng mga directory ng `skills` sa plugin manifest)
- **Mga auto-reply command** (nag-e-execute nang hindi tinatawag ang AI agent)

Plugins run **in‑process** with the Gateway, so treat them as trusted code.
25. Gabay sa paggawa ng tool: [Plugin agent tools](/plugins/agent-tools).

## Mga runtime helper

26. Maaaring ma-access ng mga plugin ang piling core helpers sa pamamagitan ng `api.runtime`. 27. Para sa telephony TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Mga tala:

- Gumagamit ng core `messages.tts` configuration (OpenAI o ElevenLabs).
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.
- Hindi sinusuportahan ang Edge TTS para sa telephony.

## Discovery at precedence

Ini-scan ng OpenClaw, sa pagkakasunod-sunod:

1. Mga config path

- `plugins.load.paths` (file o directory)

2. Mga workspace extension

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Mga global extension

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Mga bundled extension (kasamang ipinapadala kasama ng OpenClaw, **disabled bilang default**)

- `<openclaw>/extensions/*`

28. Ang mga bundled plugin ay dapat i-enable nang tahasan sa pamamagitan ng `plugins.entries.<id>`.enabled`or`openclaw plugins enable <id>\`. Installed plugins are enabled by default,
    but can be disabled the same way.

Each plugin must include a `openclaw.plugin.json` file in its root. If a path
points at a file, the plugin root is the file's directory and must contain the
manifest.

Kung maraming plugin ang nagre-resolve sa parehong id, ang unang tugma sa itaas na
pagkakasunod-sunod ang mananalo at babalewalain ang mga kopyang may mas mababang precedence.

### Mga package pack

Maaaring magsama ang isang plugin directory ng `package.json` na may `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

Kung ang iyong plugin ay nag-iimport ng mga npm dep, i-install ang mga ito sa directory na iyon para
magamit ang `node_modules` (`npm install` / `pnpm install`).

### Metadata ng channel catalog

Channel plugins can advertise onboarding metadata via `openclaw.channel` and
install hints via `openclaw.install`. This keeps the core catalog data-free.

Halimbawa:

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

OpenClaw can also merge **external channel catalogs** (for example, an MPM
registry export). Drop a JSON file at one of:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Or point `OPENCLAW_PLUGIN_CATALOG_PATHS` (or `OPENCLAW_MPM_CATALOG_PATHS`) at
one or more JSON files (comma/semicolon/`PATH`-delimited). Each file should
contain `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## Mga Plugin ID

Mga default na plugin id:

- Mga package pack: `package.json` `name`
- Standalone file: base name ng file (`~/.../voice-call.ts` → `voice-call`)

Kung ang isang plugin ay nag-e-export ng `id`, gagamitin ito ng OpenClaw ngunit magbibigay ng babala kapag
hindi ito tumutugma sa configured id.

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

Mga field:

- `enabled`: master toggle (default: true)
- `allow`: allowlist (opsyonal)
- `deny`: denylist (opsyonal; nangingibabaw ang deny)
- `load.paths`: dagdag na plugin file/dir
- `entries.<id>`: per‑plugin toggles + config

Ang mga pagbabago sa config ay **nangangailangan ng restart ng gateway**.

Mga patakaran sa validation (mahigpit):

- Ang mga hindi kilalang plugin id sa `entries`, `allow`, `deny`, o `slots` ay **error**.
- Unknown `channels.<id>` keys are **errors** unless a plugin manifest declares
  the channel id.
- Ang plugin config ay bino-validate gamit ang JSON Schema na naka-embed sa
  `openclaw.plugin.json` (`configSchema`).
- Kung ang isang plugin ay disabled, ang config nito ay pinapanatili at maglalabas ng **warning**.

## Mga plugin slot (eksklusibong kategorya)

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

Ginagamit ng Control UI ang `config.schema` (JSON Schema + `uiHints`) para mag-render ng mas maayos na mga form.

Dinadagdagan ng OpenClaw ang `uiHints` sa runtime batay sa mga nadiskubreng plugin:

- Adds per-plugin labels for `plugins.entries.<id>` / `.enabled` / `.config`
- Merges optional plugin-provided config field hints under:
  `plugins.entries.<id>.config.<field>`

Kung gusto mong magpakita ng magagandang label/placeholder ang mga field ng config ng iyong plugin (at markahan ang mga secret bilang sensitive),
magbigay ng `uiHints` kasama ng iyong JSON Schema sa plugin manifest.

Halimbawa:

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

Gumagana lang ang `plugins update` para sa mga npm install na sinusubaybayan sa ilalim ng `plugins.installs`.

Maaari ring magrehistro ang mga plugin ng sarili nilang top‑level command (halimbawa: `openclaw voicecall`).

## Plugin API (pangkalahatang-ideya)

Ang mga plugin ay nag-e-export ng alinman sa:

- A function: `(api) => { ... }`
- An object: `{ id, name, configSchema, register(api) { ... } }`

## Mga plugin hook

Plugins can ship hooks and register them at runtime. This lets a plugin bundle
event-driven automation without a separate hook pack install.

### Halimbawa

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Mga tala:

- Ang mga directory ng hook ay sumusunod sa normal na hook structure (`HOOK.md` + `handler.ts`).
- Patuloy na umiiral ang mga patakaran sa eligibility ng hook (OS/bin/env/config requirements).
- Ang mga hook na pinamamahalaan ng plugin ay lumalabas sa `openclaw hooks list` na may `plugin:<id>`.
- Hindi mo maaaring i-enable/i-disable ang mga hook na pinamamahalaan ng plugin sa pamamagitan ng `openclaw hooks`; i-enable/i-disable ang plugin sa halip.

## Mga provider plugin (model auth)

Maaaring magrehistro ang mga plugin ng **model provider auth** flow upang makapagpatakbo ang mga user ng OAuth o
API-key setup sa loob ng OpenClaw (walang kailangang external script).

Register a provider via `api.registerProvider(...)`. Each provider exposes one
or more auth methods (OAuth, API key, device code, etc.). These methods power:

- `openclaw models auth login --provider <id> [--method <id>]`

Halimbawa:

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

Mga tala:

- Tumatanggap ang `run` ng isang `ProviderAuthContext` na may mga helper na `prompter`, `runtime`,
  `openUrl`, at `oauth.createVpsAwareHandlers`.
- Ibalik ang `configPatch` kapag kailangan mong magdagdag ng mga default na model o provider config.
- Ibalik ang `defaultModel` upang ma-update ng `--set-default` ang mga default ng agent.

### Magrehistro ng messaging channel

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

Mga tala:

- Put config under `channels.<id>` (not `plugins.entries`).
- Ginagamit ang `meta.label` para sa mga label sa mga listahan ng CLI/UI.
- Nagdaragdag ang `meta.aliases` ng mga alternatibong id para sa normalization at mga input ng CLI.
- Inililista ng `meta.preferOver` ang mga channel id na lalaktawan ang auto-enable kapag parehong naka-configure.
- Pinapahintulutan ng `meta.detailLabel` at `meta.systemImage` ang mga UI na magpakita ng mas mayamang channel label/icon.

### Sumulat ng bagong messaging channel (hakbang‑hakbang)

Use this when you want a **new chat surface** (a “messaging channel”), not a model provider.
Model provider docs live under `/providers/*`.

1. Pumili ng id + hugis ng config

- 29) Lahat ng channel config ay nasa ilalim ng \`channels.<id>\`\`.
- Prefer `channels.<id>.accounts.<accountId>` for multi‑account setups.

2. Tukuyin ang metadata ng channel

- Kinokontrol ng `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` ang mga listahan ng CLI/UI.
- Dapat tumuro ang `meta.docsPath` sa isang docs page tulad ng `/channels/<id>`.
- Pinapahintulutan ng `meta.preferOver` ang isang plugin na palitan ang isa pang channel (mas pinipili ito ng auto-enable).
- Ginagamit ng mga UI ang `meta.detailLabel` at `meta.systemImage` para sa detail text/icon.

3. I-implement ang mga kinakailangang adapter

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (mga uri ng chat, media, thread, atbp.)
- `outbound.deliveryMode` + `outbound.sendText` (para sa basic send)

4. Magdagdag ng mga opsyonal na adapter kung kailangan

- `setup` (wizard), `security` (DM policy), `status` (health/diagnostics)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (message actions), `commands` (native command behavior)

5. Irehistro ang channel sa iyong plugin

- `api.registerChannel({ plugin })`

Minimal na halimbawa ng config:

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

Minimal na channel plugin (outbound‑only):

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

30. I-load ang plugin (extensions dir o `plugins.load.paths`), i-restart ang gateway, pagkatapos ay i-configure ang `channels.<id>`31. \` sa iyong config.

### Mga agent tool

Tingnan ang dedikadong gabay: [Plugin agent tools](/plugins/agent-tools).

### Magrehistro ng gateway RPC method

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Magrehistro ng mga CLI command

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

### Magrehistro ng mga auto-reply command

32. Maaaring magrehistro ang mga plugin ng custom slash command na nag-e-execute **nang hindi tinatawag ang AI agent**. 33. Kapaki-pakinabang ito para sa mga toggle command, status check, o mabilisang aksyon na hindi nangangailangan ng LLM processing.

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

Context ng command handler:

- `senderId`: ID ng nagpadala (kung available)
- `channel`: Ang channel kung saan ipinadala ang command
- `isAuthorizedSender`: Kung ang nagpadala ay awtorisadong user
- `args`: Mga argumentong ipinasa pagkatapos ng command (kung `acceptsArgs: true`)
- `commandBody`: Ang buong text ng command
- `config`: Ang kasalukuyang OpenClaw config

Mga opsyon ng command:

- `name`: Pangalan ng command (walang leading `/`)
- `description`: Help text na ipinapakita sa mga listahan ng command
- 34. `acceptsArgs`: Kung tumatanggap ng mga argument ang command (default: false). 35. Kung false at may ibinigay na mga argument, hindi magmamatch ang command at ang mensahe ay dadaan sa iba pang handler.
- `requireAuth`: Kung kailangan ng awtorisadong nagpadala (default: true)
- `handler`: Function na nagbabalik ng `{ text: string }` (maaaring async)

Halimbawa na may authorization at mga argumento:

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

Mga tala:

- Ang mga plugin command ay pinoproseso **bago** ang mga built-in na command at ang AI agent
- Ang mga command ay globally registered at gumagana sa lahat ng channel
- Ang mga pangalan ng command ay case-insensitive (`/MyStatus` ay tumutugma sa `/mystatus`)
- Ang mga pangalan ng command ay dapat magsimula sa isang letra at maglaman lamang ng mga letra, numero, hyphen, at underscore
- Reserved command names (like `help`, `status`, `reset`, etc.) 36. hindi maaaring i-override ng mga plugin
- Ang duplicate na pagrehistro ng command sa iba’t ibang plugin ay mabibigo na may diagnostic error

### Magrehistro ng mga background service

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Mga convention sa pagbibigay-pangalan

- Mga Gateway method: `pluginId.action` (halimbawa: `voicecall.status`)
- Mga tool: `snake_case` (halimbawa: `voice_call`)
- Mga CLI command: kebab o camel, ngunit iwasan ang pagbangga sa mga core command

## Skills

Maaaring maghatid ang mga plugin ng isang skill sa repo (`skills/<name>/SKILL.md`).
I-enable ito gamit ang `plugins.entries.<id>.enabled` (o iba pang config gates) at tiyaking

## Distribusyon (npm)

Inirerekomendang packaging:

- Pangunahing package: `openclaw` (ang repo na ito)
- Mga plugin: hiwalay na npm package sa ilalim ng `@openclaw/*` (halimbawa: `@openclaw/voice-call`)

Kontrata sa pag-publish:

- Ang plugin `package.json` ay dapat magsama ng `openclaw.extensions` na may isa o higit pang entry file.
- Ang mga entry file ay maaaring `.js` o `.ts` (nilo-load ng jiti ang TS sa runtime).
- Ginagamit ng `openclaw plugins install <npm-spec>` ang `npm pack`, ine-extract sa `~/.openclaw/extensions/<id>/`, at ini-enable ito sa config.
- Katatagan ng config key: ang mga scoped package ay nino-normalize sa **unscoped** id para sa `plugins.entries.*`.

## Halimbawang plugin: Voice Call

Kasama sa repo na ito ang isang voice‑call plugin (Twilio o log fallback):

- Source: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Tool: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Config (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (opsyonal na `statusCallbackUrl`, `twimlUrl`)
- Config (dev): `provider: "log"` (walang network)

Tingnan ang [Voice Call](/plugins/voice-call) at ang `extensions/voice-call/README.md` para sa setup at paggamit.

## Mga tala sa kaligtasan

naroroon ito sa iyong workspace/managed skills locations. 37. Ituring ang mga ito bilang pinagkakatiwalaang code:

- Mag-install lamang ng mga plugin na pinagkakatiwalaan mo.
- Mas piliin ang mga `plugins.allow` allowlist.
- I-restart ang Gateway pagkatapos ng mga pagbabago.

## Pagsubok ng mga plugin

Maaaring (at dapat) magsama ang mga plugin ng mga test:

- Ang mga in-repo plugin ay maaaring maglagay ng mga Vitest test sa ilalim ng `src/**` (halimbawa: `src/plugins/voice-call.plugin.test.ts`).
- Ang mga hiwalay na nai-publish na plugin ay dapat magpatakbo ng sarili nilang CI (lint/build/test) at i-validate na ang `openclaw.extensions` ay tumuturo sa built entrypoint (`dist/index.js`).
