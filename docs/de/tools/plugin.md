---
summary: "„OpenClaw-Plugins/-Erweiterungen: Discovery, Konfiguration und Sicherheit“"
read_when:
  - Hinzufügen oder Ändern von Plugins/Erweiterungen
  - Dokumentation von Regeln zur Plugin-Installation oder -Ladung
title: "„Plugins“"
---

# Plugins (Erweiterungen)

## Schnellstart (neu bei Plugins?)

Ein Plugin ist einfach ein **kleines Codemodul**, das OpenClaw um zusätzliche
Funktionen erweitert (Befehle, Werkzeuge und Gateway-RPC).

Meistens verwenden Sie Plugins, wenn Sie eine Funktion benötigen, die noch nicht
im OpenClaw-Core enthalten ist (oder wenn Sie optionale Funktionen aus Ihrer
Hauptinstallation heraushalten möchten).

Schneller Einstieg:

1. Sehen Sie nach, was bereits geladen ist:

```bash
openclaw plugins list
```

2. Installieren Sie ein offizielles Plugin (Beispiel: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Starten Sie das Gateway neu und konfigurieren Sie es anschließend unter `plugins.entries.<id>.config`.

Siehe [Voice Call](/plugins/voice-call) für ein konkretes Beispiel-Plugin.

## Verfügbare Plugins (offiziell)

- Microsoft Teams ist seit 2026.1.15 ausschließlich als Plugin verfügbar; installieren Sie `@openclaw/msteams`, wenn Sie Teams verwenden.
- Memory (Core) — gebündeltes Speicher-Such-Plugin (standardmäßig aktiviert über `plugins.slots.memory`)
- Memory (LanceDB) — gebündeltes Langzeitspeicher-Plugin (Auto-Recall/-Capture; setzen Sie `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (Anbieter-Authentifizierung) — gebündelt als `google-antigravity-auth` (standardmäßig deaktiviert)
- Gemini CLI OAuth (Anbieter-Authentifizierung) — gebündelt als `google-gemini-cli-auth` (standardmäßig deaktiviert)
- Qwen OAuth (Anbieter-Authentifizierung) — gebündelt als `qwen-portal-auth` (standardmäßig deaktiviert)
- Copilot Proxy (Anbieter-Authentifizierung) — lokale VS-Code-Copilot-Proxy-Brücke; getrennt vom integrierten `github-copilot`-Geräte-Login (gebündelt, standardmäßig deaktiviert)

OpenClaw-Plugins sind **TypeScript-Module**, die zur Laufzeit über jiti geladen werden. **Die Konfigurationsvalidierung führt keinen Plugin-Code aus**; sie verwendet stattdessen das Plugin-Manifest und JSON Schema. Siehe [Plugin manifest](/plugins/manifest).

Plugins können registrieren:

- Gateway-RPC-Methoden
- Gateway-HTTP-Handler
- Agent-Werkzeuge
- CLI-Befehle
- Hintergrunddienste
- Optionale Konfigurationsvalidierung
- **Skills** (durch Auflisten von `skills`-Verzeichnissen im Plugin-Manifest)
- **Auto-Reply-Befehle** (Ausführung ohne Aufruf des KI-Agenten)

Plugins laufen **im selben Prozess** wie das Gateway; behandeln Sie sie daher als vertrauenswürdigen Code.
Leitfaden zur Tool-Erstellung: [Plugin agent tools](/plugins/agent-tools).

## Laufzeithelfer

Plugins können über `api.runtime` auf ausgewählte Core-Hilfsfunktionen zugreifen. Für Telefonie-TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Hinweise:

- Verwendet die Core-Konfiguration `messages.tts` (OpenAI oder ElevenLabs).
- Gibt PCM-Audiopuffer + Abtastrate zurück. Plugins müssen für Anbieter neu samplen/enkodieren.
- Edge TTS wird für Telefonie nicht unterstützt.

## Discovery & Priorität

OpenClaw scannt in dieser Reihenfolge:

1. Konfigurationspfade

- `plugins.load.paths` (Datei oder Verzeichnis)

2. Workspace-Erweiterungen

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Globale Erweiterungen

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Gebündelte Erweiterungen (mit OpenClaw ausgeliefert, **standardmäßig deaktiviert**)

- `<openclaw>/extensions/*`

Gebündelte Plugins müssen explizit über `plugins.entries.<id>.enabled`
oder `openclaw plugins enable <id>` aktiviert werden. Installierte Plugins sind standardmäßig aktiviert,
können aber auf die gleiche Weise deaktiviert werden.

Jedes Plugin muss im Root eine `openclaw.plugin.json`-Datei enthalten. Wenn ein Pfad
auf eine Datei zeigt, ist das Plugin-Root das Verzeichnis der Datei und muss das
Manifest enthalten.

Wenn mehrere Plugins zur gleichen ID aufgelöst werden, gewinnt der erste Treffer
in der obigen Reihenfolge; Kopien mit niedrigerer Priorität werden ignoriert.

### Package-Packs

Ein Plugin-Verzeichnis kann eine `package.json` mit `openclaw.extensions` enthalten:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Jeder Eintrag wird zu einem Plugin. Listet das Pack mehrere Erweiterungen, wird die Plugin-ID
zu `name/<fileBase>`.

Wenn Ihr Plugin npm-Abhängigkeiten importiert, installieren Sie diese in diesem Verzeichnis,
damit `node_modules` verfügbar ist (`npm install` / `pnpm install`).

### Kanal-Katalog-Metadaten

Kanal-Plugins können Onboarding-Metadaten über `openclaw.channel` und
Installationshinweise über `openclaw.install` bewerben. Dadurch bleibt der Core-Katalog datenfrei.

Beispiel:

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

OpenClaw kann außerdem **externe Kanal-Kataloge** zusammenführen (z. B. einen MPM-Registry-Export). Legen Sie eine JSON-Datei an einem der folgenden Orte ab:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Oder verweisen Sie `OPENCLAW_PLUGIN_CATALOG_PATHS` (oder `OPENCLAW_MPM_CATALOG_PATHS`) auf
eine oder mehrere JSON-Dateien (durch Komma/Semikolon/`PATH` getrennt). Jede Datei sollte
`{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }` enthalten.

## Plugin-IDs

Standard-Plugin-IDs:

- Package-Packs: `package.json` `name`
- Einzeldatei: Dateibasisname (`~/.../voice-call.ts` → `voice-call`)

Exportiert ein Plugin `id`, verwendet OpenClaw diese, warnt jedoch, wenn sie nicht mit der
konfigurierten ID übereinstimmt.

## Konfiguration

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

Felder:

- `enabled`: Hauptschalter (Standard: true)
- `allow`: Allowlist (optional)
- `deny`: Denylist (optional; Deny hat Vorrang)
- `load.paths`: zusätzliche Plugin-Dateien/-Verzeichnisse
- `entries.<id>`: Plugin-spezifische Schalter + Konfiguration

Konfigurationsänderungen **erfordern einen Neustart des Gateways**.

Validierungsregeln (streng):

- Unbekannte Plugin-IDs in `entries`, `allow`, `deny` oder `slots` sind **Fehler**.
- Unbekannte `channels.<id>`-Schlüssel sind **Fehler**, es sei denn, ein Plugin-Manifest deklariert
  die Kanal-ID.
- Die Plugin-Konfiguration wird mit dem im `openclaw.plugin.json` eingebetteten JSON Schema validiert
  (`configSchema`).
- Ist ein Plugin deaktiviert, bleibt seine Konfiguration erhalten und es wird eine **Warnung** ausgegeben.

## Plugin-Slots (exklusive Kategorien)

Einige Plugin-Kategorien sind **exklusiv** (nur eines gleichzeitig aktiv). Verwenden Sie
`plugins.slots`, um auszuwählen, welches Plugin den Slot besitzt:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Deklarieren mehrere Plugins `kind: "memory"`, wird nur das ausgewählte geladen. Andere
werden mit Diagnosen deaktiviert.

## Control UI (Schema + Labels)

Die Control UI verwendet `config.schema` (JSON Schema + `uiHints`), um bessere Formulare zu rendern.

OpenClaw erweitert `uiHints` zur Laufzeit basierend auf entdeckten Plugins:

- Fügt Plugin-spezifische Labels für `plugins.entries.<id>` / `.enabled` / `.config` hinzu
- Führt optionale, vom Plugin bereitgestellte Hinweise zu Konfigurationsfeldern zusammen unter:
  `plugins.entries.<id>.config.<field>`

Wenn Ihre Plugin-Konfigurationsfelder gute Labels/Platzhalter anzeigen sollen (und Geheimnisse als sensibel markiert werden sollen),
stellen Sie `uiHints` zusammen mit Ihrem JSON Schema im Plugin-Manifest bereit.

Beispiel:

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

`plugins update` funktioniert nur für npm-Installationen, die unter `plugins.installs` nachverfolgt werden.

Plugins können außerdem eigene Top-Level-Befehle registrieren (Beispiel: `openclaw voicecall`).

## Plugin-API (Überblick)

Plugins exportieren entweder:

- Eine Funktion: `(api) => { ... }`
- Ein Objekt: `{ id, name, configSchema, register(api) { ... } }`

## Plugin-Hooks

Plugins können Hooks mitliefern und diese zur Laufzeit registrieren. Dadurch kann ein Plugin
ereignisgesteuerte Automatisierung ohne separate Hook-Pack-Installation bündeln.

### Beispiel

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Hinweise:

- Hook-Verzeichnisse folgen der normalen Hook-Struktur (`HOOK.md` + `handler.ts`).
- Regeln zur Hook-Berechtigung gelten weiterhin (OS/Binaries/Env/Konfigurationsanforderungen).
- Plugin-verwaltete Hooks erscheinen in `openclaw hooks list` mit `plugin:<id>`.
- Sie können Plugin-verwaltete Hooks nicht über `openclaw hooks` aktivieren/deaktivieren; aktivieren/deaktivieren Sie stattdessen das Plugin.

## Anbieter-Plugins (Modell-Authentifizierung)

Plugins können **Modellanbieter-Authentifizierungs**-Flows registrieren, sodass Nutzer OAuth oder
API-Schlüssel-Setups innerhalb von OpenClaw ausführen können (keine externen Skripte erforderlich).

Registrieren Sie einen Anbieter über `api.registerProvider(...)`. Jeder Anbieter stellt eine
oder mehrere Auth-Methoden bereit (OAuth, API-Schlüssel, Device Code usw.). Diese Methoden speisen:

- `openclaw models auth login --provider <id> [--method <id>]`

Beispiel:

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

Hinweise:

- `run` erhält ein `ProviderAuthContext` mit den Hilfsfunktionen `prompter`, `runtime`,
  `openUrl` und `oauth.createVpsAwareHandlers`.
- Geben Sie `configPatch` zurück, wenn Sie Standardmodelle oder Anbieter-Konfiguration hinzufügen müssen.
- Geben Sie `defaultModel` zurück, damit `--set-default` Agent-Standardwerte aktualisieren kann.

### Registrieren eines Messaging-Kanals

Plugins können **Kanal-Plugins** registrieren, die sich wie integrierte Kanäle
(WhatsApp, Telegram usw.) verhalten. Die Kanal-Konfiguration liegt unter `channels.<id>` und wird
von Ihrem Kanal-Plugin-Code validiert.

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

Hinweise:

- Legen Sie die Konfiguration unter `channels.<id>` ab (nicht unter `plugins.entries`).
- `meta.label` wird für Labels in CLI/UI-Listen verwendet.
- `meta.aliases` fügt alternative IDs für Normalisierung und CLI-Eingaben hinzu.
- `meta.preferOver` listet Kanal-IDs auf, die beim gleichzeitigen Konfigurieren von beiden nicht automatisch aktiviert werden sollen.
- `meta.detailLabel` und `meta.systemImage` ermöglichen UIs, reichhaltigere Kanal-Labels/-Icons anzuzeigen.

### Neuen Messaging-Kanal schreiben (Schritt für Schritt)

Verwenden Sie dies, wenn Sie eine **neue Chat-Oberfläche** (einen „Messaging-Kanal“) möchten, keinen Modellanbieter.
Dokumentation zu Modellanbietern finden Sie unter `/providers/*`.

1. ID + Konfigurationsform wählen

- Die gesamte Kanal-Konfiguration liegt unter `channels.<id>`.
- Bevorzugen Sie `channels.<id>.accounts.<accountId>` für Multi-Account-Setups.

2. Kanal-Metadaten definieren

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` steuern CLI/UI-Listen.
- `meta.docsPath` sollte auf eine Doku-Seite wie `/channels/<id>` verweisen.
- `meta.preferOver` ermöglicht es einem Plugin, einen anderen Kanal zu ersetzen (Auto-Aktivierung bevorzugt ihn).
- `meta.detailLabel` und `meta.systemImage` werden von UIs für Detailtexte/Icons verwendet.

3. Erforderliche Adapter implementieren

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (Chat-Typen, Medien, Threads usw.)
- `outbound.deliveryMode` + `outbound.sendText` (für einfaches Senden)

4. Optionale Adapter nach Bedarf hinzufügen

- `setup` (Assistent), `security` (DM-Richtlinie), `status` (Health/Diagnostik)
- `gateway` (Start/Stop/Login), `mentions`, `threading`, `streaming`
- `actions` (Nachrichtenaktionen), `commands` (natives Befehlsverhalten)

5. Kanal in Ihrem Plugin registrieren

- `api.registerChannel({ plugin })`

Minimales Konfigurationsbeispiel:

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

Minimales Kanal-Plugin (nur ausgehend):

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

Laden Sie das Plugin (Erweiterungsverzeichnis oder `plugins.load.paths`), starten Sie das Gateway neu
und konfigurieren Sie anschließend `channels.<id>` in Ihrer Konfiguration.

### Agent-Werkzeuge

Siehe den dedizierten Leitfaden: [Plugin agent tools](/plugins/agent-tools).

### Gateway-RPC-Methode registrieren

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### CLI-Befehle registrieren

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

### Auto-Reply-Befehle registrieren

Plugins können benutzerdefinierte Slash-Befehle registrieren, die **ohne Aufruf des
KI-Agenten** ausgeführt werden. Dies ist nützlich für Umschaltbefehle, Statusabfragen oder schnelle Aktionen,
die keine LLM-Verarbeitung benötigen.

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

Befehls-Handler-Kontext:

- `senderId`: Die ID des Absenders (falls verfügbar)
- `channel`: Der Kanal, in dem der Befehl gesendet wurde
- `isAuthorizedSender`: Ob der Absender ein autorisierter Benutzer ist
- `args`: Argumente nach dem Befehl (falls `acceptsArgs: true`)
- `commandBody`: Der vollständige Befehlstext
- `config`: Die aktuelle OpenClaw-Konfiguration

Befehlsoptionen:

- `name`: Befehlsname (ohne führendes `/`)
- `description`: Hilfetext, der in Befehlslisten angezeigt wird
- `acceptsArgs`: Ob der Befehl Argumente akzeptiert (Standard: false). Falls false und Argumente übergeben werden, passt der Befehl nicht und die Nachricht fällt an andere Handler durch
- `requireAuth`: Ob ein autorisierter Absender erforderlich ist (Standard: true)
- `handler`: Funktion, die `{ text: string }` zurückgibt (kann async sein)

Beispiel mit Autorisierung und Argumenten:

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

Hinweise:

- Plugin-Befehle werden **vor** integrierten Befehlen und dem KI-Agenten verarbeitet
- Befehle werden global registriert und funktionieren kanalübergreifend
- Befehlsnamen sind nicht case-sensitiv (`/MyStatus` passt auf `/mystatus`)
- Befehlsnamen müssen mit einem Buchstaben beginnen und dürfen nur Buchstaben, Zahlen, Bindestriche und Unterstriche enthalten
- Reservierte Befehlsnamen (wie `help`, `status`, `reset` usw.) können von Plugins nicht überschrieben werden
- Doppelte Befehlsregistrierungen über Plugins hinweg schlagen mit einem Diagnosefehler fehl

### Hintergrunddienste registrieren

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Namenskonventionen

- Gateway-Methoden: `pluginId.action` (Beispiel: `voicecall.status`)
- Werkzeuge: `snake_case` (Beispiel: `voice_call`)
- CLI-Befehle: kebab- oder camelCase, vermeiden Sie jedoch Kollisionen mit Core-Befehlen

## Skills

Plugins können einen Skill im Repository mitliefern (`skills/<name>/SKILL.md`).
Aktivieren Sie ihn mit `plugins.entries.<id>.enabled` (oder anderen Konfigurations-Gates) und stellen Sie sicher,
dass er in Ihren Workspace-/verwalteten Skills-Speicherorten vorhanden ist.

## Distribution (npm)

Empfohlene Paketierung:

- Hauptpaket: `openclaw` (dieses Repository)
- Plugins: separate npm-Pakete unter `@openclaw/*` (Beispiel: `@openclaw/voice-call`)

Publishing-Vertrag:

- Das Plugin-`package.json` muss `openclaw.extensions` mit einer oder mehreren Entry-Dateien enthalten.
- Entry-Dateien können `.js` oder `.ts` sein (jiti lädt TS zur Laufzeit).
- `openclaw plugins install <npm-spec>` verwendet `npm pack`, extrahiert nach `~/.openclaw/extensions/<id>/` und aktiviert es in der Konfiguration.
- Stabilität der Konfigurationsschlüssel: Scoped Packages werden für `plugins.entries.*` auf die **unscoped** ID normalisiert.

## Beispiel-Plugin: Voice Call

Dieses Repository enthält ein Voice-Call-Plugin (Twilio oder Log-Fallback):

- Source: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Tool: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Konfiguration (Twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (optional `statusCallbackUrl`, `twimlUrl`)
- Konfiguration (Dev): `provider: "log"` (kein Netzwerk)

Siehe [Voice Call](/plugins/voice-call) und `extensions/voice-call/README.md` für Einrichtung und Nutzung.

## Sicherheitshinweise

Plugins laufen im selben Prozess wie das Gateway. Behandeln Sie sie als vertrauenswürdigen Code:

- Installieren Sie nur Plugins, denen Sie vertrauen.
- Bevorzugen Sie `plugins.allow`-Allowlists.
- Starten Sie das Gateway nach Änderungen neu.

## Plugins testen

Plugins können (und sollten) Tests mitliefern:

- In-Repo-Plugins können Vitest-Tests unter `src/**` ablegen (Beispiel: `src/plugins/voice-call.plugin.test.ts`).
- Separat veröffentlichte Plugins sollten ihre eigene CI ausführen (Lint/Build/Test) und validieren, dass `openclaw.extensions` auf den gebauten Entry-Point zeigt (`dist/index.js`).
