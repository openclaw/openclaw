---
summary: "Agent-værktøjsflade for OpenClaw (browser, canvas, nodes, message, cron), der erstatter de ældre `openclaw-*` Skills"
read_when:
  - Tilføjelse eller ændring af agent-værktøjer
  - Udfasning eller ændring af `openclaw-*` Skills
title: "Værktøjer"
---

# Værktøjer (OpenClaw)

OpenClaw udsætter **førsteklasses agentværktøjer** for browser, lærred, noder og cron.
Disse erstatter de gamle `openclaw-*` færdigheder: værktøjerne er skrevet, ingen beskydning,
og agenten bør stole på dem direkte.

## Deaktivering af værktøjer

Du kan globalt tillade / nægte værktøjer via `tools.allow` / `tools.deny` i `openclaw.json`
(benægte vinder). Dette forhindrer forbudte værktøjer i at blive sendt til modeludbydere.

```json5
{
  tools: { deny: ["browser"] },
}
```

Noter:

- Matching er ikke forskelsfølsom over for store/små bogstaver.
- `*` wildcards understøttes (`"*"` betyder alle værktøjer).
- Hvis `tools.allow` kun refererer til ukendte eller ikke-indlæste plugin-værktøjsnavne, logger OpenClaw en advarsel og ignorerer tilladelseslisten, så kerneværktøjer forbliver tilgængelige.

## Værktøjsprofiler (basis-tilladelsesliste)

`tools.profile` sætter et **base tool allowlist** før `tools.allow`/`tools.deny`.
Per-agent tilsidesættelse: `agents.list[].tools.profile`.

Profiler:

- `minimal`: kun `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: ingen begrænsning (samme som ikke sat)

Eksempel (kun messaging som standard, tillad også Slack- og Discord-værktøjer):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Eksempel (coding-profil, men afvis exec/process overalt):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Eksempel (global coding-profil, supportagent kun til messaging):

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

## Udbyderspecifik værktøjspolitik

Brug `tools.byProvider` til **yderligere begrænse** værktøjer for specifikke udbydere
(eller en enkelt `udbyder/model`) uden at ændre dine globale standardindstillinger.
Per-agent tilsidesættelse: `agents.list[].tools.byProvider`.

Dette anvendes **efter** basis-værktøjets profil og **før** tillade/benægte lister,
, så det kun kan indsnævre værktøjet.
Leverandørnøgler accepterer enten `provider` (f.eks. `google-antigravity`) eller
`provider/model` (f.eks. `openai/gpt-5.2`).

Eksempel (bevar global coding-profil, men minimale værktøjer for Google Antigravity):

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

Eksempel (udbyder-/modelspecifik tilladelsesliste for et ustabilt endpoint):

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

Eksempel (agent-specifik override for en enkelt udbyder):

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

## Værktøjsgrupper (genveje)

Værktøjspolitikker (global, agent, sandbox) understøtter `group:*`-poster, der udvider til flere værktøjer.
Brug disse i `tools.allow` / `tools.deny`.

Tilgængelige grupper:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle indbyggede OpenClaw-værktøjer (ekskluderer udbyder-plugins)

Eksempel (tillad kun filværktøjer + browser):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + værktøjer

Plugins kan registrere **yderligere værktøjer** (og CLI-kommandoer) ud over kernesættet.
Se [Plugins](/tools/plugin) for installation + config, og [Skills](/tools/skills) for hvordan
værktøj brug vejledning injiceres i prompter. Nogle plugins sender deres egne færdigheder
sammen med værktøjer (for eksempel plugin'et voice-call).

Valgfrie plugin-værktøjer:

- [Lobster](/tools/lobster): typed workflow-runtime med genoptagelige godkendelser (kræver Lobster CLI på gateway-værten).
- [LLM Task](/tools/llm-task): JSON-only LLM-trin for struktureret workflow-output (valgfri skemavalidering).

## Værktøjsoversigt

### `apply_patch`

Anvend strukturerede rettelser på tværs af en eller flere filer. Brug til multi-hunk redigeringer.
Eksperimentel: Aktiver via `tools.exec.applyPatch.enabled` (OpenAI modeller kun).

### `exec`

Kør shell-kommandoer i arbejdsområdet.

Kerneparametre:

- `command` (påkrævet)
- `yieldMs` (auto-baggrund efter timeout, standard 10000)
- `background` (øjeblikkelig baggrund)
- `timeout` (sekunder; dræber processen, hvis overskredet, standard 1800)
- `elevated` (bool; kør på værten hvis forhøjet tilstand er aktiveret/tilladt; ændrer kun adfærd når agenten er sandboxed)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (node-id/navn for `host=node`)
- Har du brug for en rigtig TTY? Sæt `pty: true`.

Noter:

- Returnerer `status: "running"` med en `sessionId`, når den kører i baggrunden.
- Brug `process` til at polle/logge/skrive/stoppe/rydde baggrundssessioner.
- Hvis `process` ikke er tilladt, kører `exec` synkront og ignorerer `yieldMs`/`background`.
- `elevated` er gated af `tools.elevated` plus eventuel `agents.list[].tools.elevated`-override (begge skal tillade) og er et alias for `host=gateway` + `security=full`.
- `elevated` ændrer kun adfærd, når agenten er sandboxed (ellers er det en no-op).
- `host=node` kan målrette en macOS Companion-app eller en headless node-vært (`openclaw node run`).
- gateway/node-godkendelser og tilladelseslister: [Exec approvals](/tools/exec-approvals).

### `process`

Administrér baggrunds-exec-sessioner.

Kernehandlinger:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Noter:

- `poll` returnerer nyt output og exit-status, når den er færdig.
- `log` understøtter linjebaseret `offset`/`limit` (udelad `offset` for at hente de sidste N linjer).
- `process` er scoped per agent; sessioner fra andre agenter er ikke synlige.

### `web_search`

Søg på nettet ved hjælp af Brave Search API.

Kerneparametre:

- `query` (påkrævet)
- `count` (1–10; standard fra `tools.web.search.maxResults`)

Noter:

- Kræver en Brave API-nøgle (anbefalet: `openclaw configure --section web`, eller sæt `BRAVE_API_KEY`).
- Aktiver via `tools.web.search.enabled`.
- Svar caches (standard 15 min).
- Se [Web tools](/tools/web) for opsætning.

### `web_fetch`

Hent og udtræk læsbart indhold fra en URL (HTML → markdown/tekst).

Kerneparametre:

- `url` (påkrævet)
- `extractMode` (`markdown` | `text`)
- `maxChars` (afkort lange sider)

Noter:

- Aktiver via `tools.web.fetch.enabled`.
- `maxChars` er begrænset af `tools.web.fetch.maxCharsCap` (standard 50000).
- Svar caches (standard 15 min).
- For JS-tunge sites, foretræk browser-værktøjet.
- Se [Web tools](/tools/web) for opsætning.
- Se [Firecrawl](/tools/firecrawl) for den valgfrie anti-bot fallback.

### `browser`

Styr den dedikerede OpenClaw-administrerede browser.

Kernehandlinger:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (returnerer image-blok + `MEDIA:<path>`)
- `act` (UI-handlinger: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profiladministration:

- `profiles` — list alle browserprofiler med status
- `create-profile` — opret ny profil med automatisk allokeret port (eller `cdpUrl`)
- `delete-profile` — stop browser, slet brugerdata, fjern fra konfiguration (kun lokalt)
- `reset-profile` — dræb forældreløs proces på profilens port (kun lokalt)

Fælles parametre:

- `profile` (valgfri; standard er `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (valgfri; vælger et specifikt node-id/navn)
  Noter:
- Kræver `browser.enabled=true` (standard er `true`; sæt `false` for at deaktivere).
- Alle handlinger accepterer valgfri `profile`-parameter for multi-instans-understøttelse.
- Når `profile` udelades, bruges `browser.defaultProfile` (standard "chrome").
- Profilnavne: kun små bogstaver og tal + bindestreger (maks. 64 tegn).
- Portinterval: 18800-18899 (~100 profiler maks.).
- Fjernprofiler er kun attach-only (ingen start/stop/reset).
- Hvis en browser-kapabel node er forbundet, kan værktøjet auto-route til den (medmindre du fastlåser `target`).
- `snapshot` er som standard `ai`, når Playwright er installeret; brug `aria` til tilgængelighedstræet.
- `snapshot` understøtter også role-snapshot-indstillinger (`interactive`, `compact`, `depth`, `selector`), som returnerer refs som `e12`.
- `act` kræver `ref` fra `snapshot` (numerisk `12` fra AI-snapshots eller `e12` fra role-snapshots); brug `evaluate` til sjældne behov for CSS-selektorer.
- Undgå `act` → `wait` som standard; brug det kun i ekstraordinære tilfælde (ingen pålidelig UI-tilstand at vente på).
- `upload` kan valgfrit sende en `ref` for automatisk klik efter arming.
- `upload` understøtter også `inputRef` (aria-ref) eller `element` (CSS-selektor) til at sætte `<input type="file">` direkte.

### `canvas`

Styr node Canvas (present, eval, snapshot, A2UI).

Kernehandlinger:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (returnerer image-blok + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Noter:

- Bruger gateway `node.invoke` under motorhjelmen.
- Hvis ingen `node` angives, vælger værktøjet en standard (enkelt forbundet node eller lokal mac-node).
- A2UI er kun v0.8 (ingen `createSurface`); CLI’en afviser v0.9 JSONL med linjefejl.
- Hurtig smoke-test: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Opdag og målret parrede nodes; send notifikationer; optag kamera/skærm.

Kernehandlinger:

- `status`, `describe`
- `pending`, `approve`, `reject` (parring)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Noter:

- Kamera-/skærmkommandoer kræver, at node-appen er i forgrunden.
- Billeder returnerer image-blokke + `MEDIA:<path>`.
- Videoer returnerer `FILE:<path>` (mp4).
- Lokation returnerer en JSON-payload (lat/lon/nøjagtighed/timestamp).
- `run`-parametre: `command` argv-array; valgfri `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Eksempel (`run`):

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

Analysér et billede med den konfigurerede billedmodel.

Kerneparametre:

- `image` (påkrævet sti eller URL)
- `prompt` (valgfri; standard "Describe the image.")
- `model` (valgfri override)
- `maxBytesMb` (valgfri størrelsesgrænse)

Noter:

- Kun tilgængelig når `agents.defaults.imageModel` er konfigureret (primær eller fallback), eller når en implicit billedmodel kan udledes fra din standardmodel + konfigureret auth (best-effort-parring).
- Bruger billedmodellen direkte (uafhængigt af den primære chatmodel).

### `message`

Send beskeder og kanalhandlinger på tværs af Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Kernehandlinger:

- `send` (tekst + valgfri medier; MS Teams understøtter også `card` for Adaptive Cards)
- `poll` (WhatsApp/Discord/MS Teams-afstemninger)
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

Noter:

- `send` router WhatsApp via Gateway; andre kanaler går direkte.
- `poll` bruger Gateway til WhatsApp og MS Teams; Discord-afstemninger går direkte.
- Når et message-værktøjskald er bundet til en aktiv chat-session, er afsendelser begrænset til sessionens mål for at undgå krydskontekst-lækager.

### `cron`

Administrér Gateway cron-jobs og wakeups.

Kernehandlinger:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (enqueue systemevent + valgfri øjeblikkelig heartbeat)

Noter:

- `add` forventer et fuldt cron-job-objekt (samme skema som `cron.add` RPC).
- `update` bruger `{ jobId, patch }` (`id` accepteres for kompatibilitet).

### `gateway`

Genstart eller anvend opdateringer på den kørende Gateway-proces (in-place).

Kernehandlinger:

- `restart` (autoriserer + sender `SIGUSR1` for genstart i proces; `openclaw gateway` genstarter in-place)
- `config.get` / `config.schema`
- `config.apply` (validér + skriv konfiguration + genstart + wake)
- `config.patch` (flet delvis opdatering + genstart + wake)
- `update.run` (kør opdatering + genstart + wake)

Noter:

- Brug `delayMs` (standard 2000) for at undgå at afbryde et igangværende svar.
- `restart` er deaktiveret som standard; aktiver med `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

List sessioner, inspicér transskripthistorik eller send til en anden session.

Kerneparametre:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = ingen)
- `sessions_history`: `sessionKey` (eller `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (eller `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (standard current; accepterer `sessionId`), `model?` (`default` rydder override)

Noter:

- `main` er den kanoniske direct-chat-nøgle; globale/ukendte er skjult.
- `messageLimit > 0` henter de sidste N beskeder pr. session (værktøjsbeskeder filtreret).
- `sessions_send` venter på endelig fuldførelse når `timeoutSeconds > 0`.
- Levering/annoncering sker efter fuldførelse og er best-effort; `status: "ok"` bekræfter, at agentkørslen er afsluttet, ikke at annoncen blev leveret.
- `sessions_spawn` starter en sub-agent-kørsel og poster et announce-svar tilbage til anmoder-chatten.
- `sessions_spawn` er ikke-blokerende og returnerer `status: "accepted"` med det samme.
- `sessions_send` kører et svar-back ping-pong (svar `REPLY_SKIP` til at stoppe; max drejes via `session.agentToAgent.maxPingPongTurns`, 0–5).
- Efter ping‑pong kører målagenten et **announce-trin**; svar `ANNOUNCE_SKIP` for at undertrykke annoncen.

### `agents_list`

List agent-id’er som den aktuelle session kan målrette med `sessions_spawn`.

Noter:

- Resultatet er begrænset til per-agent-tilladelseslister (`agents.list[].subagents.allowAgents`).
- Når `["*"]` er konfigureret, inkluderer værktøjet alle konfigurerede agenter og markerer `allowAny: true`.

## Parametre (fælles)

Gateway-bakkede værktøjer (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (standard `ws://127.0.0.1:18789`)
- `gatewayToken` (hvis auth er aktiveret)
- `timeoutMs`

Bemærk: Når `gatewayUrl` er indstillet, skal du inkludere `gatewayToken` udtrykkeligt. Værktøjer arver ikke config
eller miljø legitimationsoplysninger for tilsidesættelser, og manglende eksplicitte legitimationsoplysninger er en fejl.

Browser-værktøj:

- `profile` (valgfri; standard `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (valgfri; fastlås et specifikt node-id/navn)

## Anbefalede agentflows

Browser-automatisering:

1. `browser` → `status` / `start`
2. `snapshot` (ai eller aria)
3. `act` (click/type/press)
4. `screenshot` hvis du har brug for visuel bekræftelse

Canvas-rendering:

1. `canvas` → `present`
2. `a2ui_push` (valgfri)
3. `snapshot`

Node-målretning:

1. `nodes` → `status`
2. `describe` på den valgte node
3. `notify` / `run` / `camera_snap` / `screen_record`

## Sikkerhed

- Undgå direkte `system.run`; brug `nodes` → `run` kun med eksplicit brugeraccept.
- Respektér brugerens samtykke til kamera-/skærmoptagelse.
- Brug `status/describe` for at sikre tilladelser før mediekommandoer kaldes.

## Hvordan værktøjer præsenteres for agenten

Værktøjer eksponeres i to parallelle kanaler:

1. **System prompt-tekst**: en menneskeligt læsbar liste + vejledning.
2. **Værktøjsskema**: de strukturerede funktionsdefinitioner, der sendes til model-API’en.

Det betyder, at agenten ser både ”hvilke redskaber der findes” og ”hvordan man kalder dem”. Hvis et værktøj
ikke vises i systemprompten eller skemaet, kan modellen ikke kalde det.
