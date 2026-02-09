---
summary: "Agent-tooloppervlak voor OpenClaw (browser, canvas, nodes, message, cron) ter vervanging van verouderde `openclaw-*` Skills"
read_when:
  - Agent-tools toevoegen of wijzigen
  - "`openclaw-*` Skills uitfaseren of wijzigen"
title: "Tools"
---

# Tools (OpenClaw)

OpenClaw stelt **eersteklas agent-tools** beschikbaar voor browser, canvas, nodes en cron.
Deze vervangen de oude `openclaw-*` Skills: de tools zijn getypeerd, zonder shelling,
en de agent hoort er direct op te vertrouwen.

## Tools uitschakelen

Je kunt tools globaal toestaan/weigeren via `tools.allow` / `tools.deny` in `openclaw.json`
(weigeren wint). Dit voorkomt dat niet-toegestane tools naar modelproviders worden gestuurd.

```json5
{
  tools: { deny: ["browser"] },
}
```

Notities:

- Overeenkomen is hoofdletterongevoelig.
- `*`-wildcards worden ondersteund (`"*"` betekent alle tools).
- Als `tools.allow` alleen onbekende of niet-geladen plugin-toolnamen bevat, logt OpenClaw een waarschuwing en negeert de toegestane lijst zodat kerntools beschikbaar blijven.

## Toolprofielen (basis-toegestane lijst)

`tools.profile` stelt een **basis-toegestane toollijst** in vóór `tools.allow`/`tools.deny`.
Per-agent override: `agents.list[].tools.profile`.

Profielen:

- `minimal`: alleen `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: geen beperking (zelfde als niet ingesteld)

Voorbeeld (standaard alleen messaging, maar ook Slack + Discord-tools toestaan):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Voorbeeld (coding-profiel, maar exec/process overal weigeren):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Voorbeeld (globaal coding-profiel, supportagent met alleen messaging):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Provider-specifiek toolbeleid

Gebruik `tools.byProvider` om tools **verder te beperken** voor specifieke providers
(of één enkele `provider/model`) zonder je globale standaardinstellingen te wijzigen.
Per-agent override: `agents.list[].tools.byProvider`.

Dit wordt toegepast **na** het basis-toolprofiel en **vóór** toestaan/weigeren-lijsten,
dus het kan de toolset alleen verkleinen.
Provider-sleutels accepteren zowel `provider` (bijv. `google-antigravity`) als
`provider/model` (bijv. `openai/gpt-5.2`).

Voorbeeld (globaal coding-profiel behouden, maar minimale tools voor Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Voorbeeld (provider-/model-specifieke toegestane lijst voor een instabiel endpoint):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Voorbeeld (agent-specifieke override voor één provider):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Toolgroepen (snelkoppelingen)

Toolbeleid (globaal, agent, sandbox) ondersteunt `group:*`-items die uitbreiden naar meerdere tools.
Gebruik deze in `tools.allow` / `tools.deny`.

Beschikbare groepen:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle ingebouwde OpenClaw-tools (sluit provider-plugins uit)

Voorbeeld (alleen file-tools + browser toestaan):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + tools

Plugins kunnen **aanvullende tools** (en CLI-opdrachten) registreren naast de kernset.
Zie [Plugins](/tools/plugin) voor installatie + configuratie, en [Skills](/tools/skills) voor hoe
richtlijnen voor toolgebruik in prompts worden geïnjecteerd. Sommige plugins leveren hun eigen Skills
naast tools (bijvoorbeeld de voice-call plugin).

Optionele plugin-tools:

- [Lobster](/tools/lobster): getypeerde workflow-runtime met hervatbare goedkeuringen (vereist de Lobster CLI op de Gateway-host).
- [LLM Task](/tools/llm-task): JSON-only LLM-stap voor gestructureerde workflow-uitvoer (optionele schema-validatie).

## Toolinventaris

### `apply_patch`

Pas gestructureerde patches toe op één of meerdere bestanden. Gebruik voor multi-hunk bewerkingen.
Experimenteel: inschakelen via `tools.exec.applyPatch.enabled` (alleen OpenAI-modellen).

### `exec`

Voer shell-opdrachten uit in de werkruimte.

Kernparameters:

- `command` (vereist)
- `yieldMs` (automatisch naar achtergrond na timeout, standaard 10000)
- `background` (direct naar achtergrond)
- `timeout` (seconden; stopt het proces bij overschrijding, standaard 1800)
- `elevated` (bool; uitvoeren op host als verhoogde modus is ingeschakeld/toegestaan; wijzigt alleen gedrag wanneer de agent gesandboxed is)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (node-id/naam voor `host=node`)
- Echte TTY nodig? Stel `pty: true` in.

Notities:

- Retourneert `status: "running"` met een `sessionId` wanneer naar de achtergrond gestuurd.
- Gebruik `process` om achtergrond-sessies te pollen/loggen/schrijven/stoppen/opschonen.
- Als `process` niet is toegestaan, draait `exec` synchroon en negeert `yieldMs`/`background`.
- `elevated` wordt afgeschermd door `tools.elevated` plus een eventuele `agents.list[].tools.elevated`-override (beide moeten toestaan) en is een alias voor `host=gateway` + `security=full`.
- `elevated` wijzigt alleen gedrag wanneer de agent gesandboxed is (anders is het een no-op).
- `host=node` kan richten op een macOS Companion-app of een headless node-host (`openclaw node run`).
- gateway/node-goedkeuringen en toegestane lijsten: [Exec approvals](/tools/exec-approvals).

### `process`

Beheer achtergrond-exec-sessies.

Kernacties:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Notities:

- `poll` retourneert nieuwe uitvoer en exitstatus wanneer voltooid.
- `log` ondersteunt regelgebaseerde `offset`/`limit` (laat `offset` weg om de laatste N regels op te halen).
- `process` is per agent afgebakend; sessies van andere agents zijn niet zichtbaar.

### `web_search`

Zoek op het web met de Brave Search API.

Kernparameters:

- `query` (vereist)
- `count` (1–10; standaard uit `tools.web.search.maxResults`)

Notities:

- Vereist een Brave API-sleutel (aanbevolen: `openclaw configure --section web`, of stel `BRAVE_API_KEY` in).
- Inschakelen via `tools.web.search.enabled`.
- Antwoorden worden gecachet (standaard 15 min).
- Zie [Web tools](/tools/web) voor installatie.

### `web_fetch`

Haal leesbare content op en extraheer deze uit een URL (HTML → markdown/tekst).

Kernparameters:

- `url` (vereist)
- `extractMode` (`markdown` | `text`)
- `maxChars` (lange pagina’s afkappen)

Notities:

- Inschakelen via `tools.web.fetch.enabled`.
- `maxChars` wordt begrensd door `tools.web.fetch.maxCharsCap` (standaard 50000).
- Antwoorden worden gecachet (standaard 15 min).
- Voor JS-zware sites heeft de browser-tool de voorkeur.
- Zie [Web tools](/tools/web) voor installatie.
- Zie [Firecrawl](/tools/firecrawl) voor de optionele anti-bot fallback.

### `browser`

Bedien de door OpenClaw beheerde, dedicated browser.

Kernacties:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (retourneert image block + `MEDIA:<path>`)
- `act` (UI-acties: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profielbeheer:

- `profiles` — lijst alle browserprofielen met status
- `create-profile` — maak nieuw profiel met automatisch toegewezen poort (of `cdpUrl`)
- `delete-profile` — stop browser, verwijder gebruikersdata, verwijder uit config (alleen lokaal)
- `reset-profile` — kill verweesd proces op de poort van het profiel (alleen lokaal)

Veelgebruikte parameters:

- `profile` (optioneel; standaard `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optioneel; kiest een specifieke node-id/naam)
  Notities:
- Vereist `browser.enabled=true` (standaard `true`; stel `false` in om uit te schakelen).
- Alle acties accepteren een optionele `profile`-parameter voor multi-instance-ondersteuning.
- Wanneer `profile` ontbreekt, wordt `browser.defaultProfile` gebruikt (standaard "chrome").
- Profielnamen: alleen lowercase alfanumeriek + koppeltekens (max. 64 tekens).
- Poortbereik: 18800-18899 (~100 profielen max).
- Externe profielen zijn alleen attach-only (geen start/stop/reset).
- Als een browser-geschikte node is verbonden, kan de tool hier automatisch naartoe routen (tenzij je `target` vastzet).
- `snapshot` is standaard `ai` wanneer Playwright is geïnstalleerd; gebruik `aria` voor de toegankelijkheidsboom.
- `snapshot` ondersteunt ook role-snapshot-opties (`interactive`, `compact`, `depth`, `selector`) die refs retourneren zoals `e12`.
- `act` vereist `ref` uit `snapshot` (numerieke `12` uit AI-snapshots, of `e12` uit role-snapshots); gebruik `evaluate` voor zeldzame CSS-selectorbehoeften.
- Vermijd standaard `act` → `wait`; gebruik het alleen in uitzonderlijke gevallen (geen betrouwbare UI-status om op te wachten).
- `upload` kan optioneel een `ref` doorgeven om automatisch te klikken na het armeren.
- `upload` ondersteunt ook `inputRef` (aria-ref) of `element` (CSS-selector) om `<input type="file">` direct in te stellen.

### `canvas`

Stuur de node Canvas aan (present, eval, snapshot, A2UI).

Kernacties:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (retourneert image block + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Notities:

- Gebruikt gateway `node.invoke` onder de motorkap.
- Als geen `node` is opgegeven, kiest de tool een standaard (één verbonden node of lokale mac-node).
- A2UI is alleen v0.8 (geen `createSurface`); de CLI weigert v0.9 JSONL met regel-fouten.
- Snelle rooktest: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Ontdek en richt gepaarde nodes; verstuur notificaties; leg camera/scherm vast.

Kernacties:

- `status`, `describe`
- `pending`, `approve`, `reject` (pairing)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Notities:

- Camera-/schermopdrachten vereisen dat de node-app op de voorgrond staat.
- Afbeeldingen retourneren image blocks + `MEDIA:<path>`.
- Video’s retourneren `FILE:<path>` (mp4).
- Locatie retourneert een JSON-payload (lat/lon/nauwkeurigheid/timestamp).
- `run`-parameters: `command` argv-array; optioneel `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Voorbeeld (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Analyseer een afbeelding met het geconfigureerde afbeeldingsmodel.

Kernparameters:

- `image` (vereist pad of URL)
- `prompt` (optioneel; standaard "Describe the image.")
- `model` (optionele override)
- `maxBytesMb` (optionele groottebeperking)

Notities:

- Alleen beschikbaar wanneer `agents.defaults.imageModel` is geconfigureerd (primair of fallbacks), of wanneer een impliciet afbeeldingsmodel kan worden afgeleid uit je standaardmodel + geconfigureerde authenticatie (best-effort koppeling).
- Gebruikt het afbeeldingsmodel direct (onafhankelijk van het hoofdchatmodel).

### `message`

Verstuur berichten en kanaalacties via Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Kernacties:

- `send` (tekst + optionele media; MS Teams ondersteunt ook `card` voor Adaptive Cards)
- `poll` (WhatsApp/Discord/MS Teams polls)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Notities:

- `send` routeert WhatsApp via de Gateway; andere kanalen gaan direct.
- `poll` gebruikt de Gateway voor WhatsApp en MS Teams; Discord-polls gaan direct.
- Wanneer een message-toolcall is gebonden aan een actieve chatsessie, zijn verzendacties beperkt tot het doel van die sessie om cross-context-lekken te voorkomen.

### `cron`

Beheer Gateway-cronjobs en wakeups.

Kernacties:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (enqueue systeemevent + optionele onmiddellijke heartbeat)

Notities:

- `add` verwacht een volledig cronjob-object (zelfde schema als `cron.add` RPC).
- `update` gebruikt `{ jobId, patch }` (`id` geaccepteerd voor compatibiliteit).

### `gateway`

Herstart of pas updates toe op het draaiende Gateway-proces (in-place).

Kernacties:

- `restart` (autoriseert + verstuurt `SIGUSR1` voor in-process herstart; `openclaw gateway` herstart in-place)
- `config.get` / `config.schema`
- `config.apply` (valideren + config wegschrijven + herstart + wake)
- `config.patch` (gedeeltelijke update samenvoegen + herstart + wake)
- `update.run` (update uitvoeren + herstart + wake)

Notities:

- Gebruik `delayMs` (standaard 2000) om een lopend antwoord niet te onderbreken.
- `restart` is standaard uitgeschakeld; schakel in met `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Sessies weergeven, transcriptgeschiedenis inspecteren of naar een andere sessie verzenden.

Kernparameters:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = geen)
- `sessions_history`: `sessionKey` (of `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (of `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (standaard huidige; accepteert `sessionId`), `model?` (`default` wist override)

Notities:

- `main` is de canonieke direct-chat-sleutel; globaal/onbekend wordt verborgen.
- `messageLimit > 0` haalt de laatste N berichten per sessie op (toolberichten gefilterd).
- `sessions_send` wacht op definitieve voltooiing wanneer `timeoutSeconds > 0`.
- Levering/aankondiging gebeurt na voltooiing en is best-effort; `status: "ok"` bevestigt dat de agentrun is afgerond, niet dat de aankondiging is afgeleverd.
- `sessions_spawn` start een sub-agentrun en plaatst een announce-antwoord terug naar de aanvragende chat.
- `sessions_spawn` is non-blocking en retourneert `status: "accepted"` onmiddellijk.
- `sessions_send` voert een reply‑back ping‑pong uit (antwoord `REPLY_SKIP` om te stoppen; max. beurten via `session.agentToAgent.maxPingPongTurns`, 0–5).
- Na de ping‑pong voert de doelagent een **announce-stap** uit; antwoord `ANNOUNCE_SKIP` om de aankondiging te onderdrukken.

### `agents_list`

Lijst agent-id’s die de huidige sessie mag targeten met `sessions_spawn`.

Notities:

- Resultaat is beperkt tot per-agent toegestane lijsten (`agents.list[].subagents.allowAgents`).
- Wanneer `["*"]` is geconfigureerd, bevat de tool alle geconfigureerde agents en markeert `allowAny: true`.

## Parameters (gemeenschappelijk)

Gateway-gedekte tools (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (standaard `ws://127.0.0.1:18789`)
- `gatewayToken` (als authenticatie is ingeschakeld)
- `timeoutMs`

Let op: wanneer `gatewayUrl` is ingesteld, neem `gatewayToken` expliciet op. Tools erven geen config-
of omgevingscredentials voor overrides, en ontbrekende expliciete credentials is een fout.

Browser-tool:

- `profile` (optioneel; standaard `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optioneel; pin een specifieke node-id/naam)

## Aanbevolen agentflows

Browser-automatisering:

1. `browser` → `status` / `start`
2. `snapshot` (ai of aria)
3. `act` (click/type/press)
4. `screenshot` als je visuele bevestiging nodig hebt

Canvas-render:

1. `canvas` → `present`
2. `a2ui_push` (optioneel)
3. `snapshot`

Node-targeting:

1. `nodes` → `status`
2. `describe` op de gekozen node
3. `notify` / `run` / `camera_snap` / `screen_record`

## Veiligheid

- Vermijd directe `system.run`; gebruik `nodes` → `run` alleen met expliciete toestemming van de gebruiker.
- Respecteer toestemming van de gebruiker voor camera-/schermopname.
- Gebruik `status/describe` om rechten te waarborgen vóór het aanroepen van media-opdrachten.

## Hoe tools aan de agent worden gepresenteerd

Tools worden in twee parallelle kanalen aangeboden:

1. **Systeemprompttekst**: een voor mensen leesbare lijst + richtlijnen.
2. **Toolschema**: de gestructureerde functiedefinities die naar de model-API worden gestuurd.

Dat betekent dat de agent zowel “welke tools bestaan” als “hoe ze aan te roepen” ziet. Als een tool
niet in de systeemprompt of het schema verschijnt, kan het model deze niet aanroepen.
