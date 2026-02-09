---
summary: "Agentverktygsyta för OpenClaw (browser, canvas, noder, meddelanden, cron) som ersätter äldre `openclaw-*` Skills"
read_when:
  - Lägger till eller ändrar agentverktyg
  - Avvecklar eller ändrar `openclaw-*` Skills
title: "Verktyg"
---

# Verktyg (OpenClaw)

OpenClaw exponerar **förstklassiga agentverktyg** för webbläsare, duk, noder och cron.
Dessa ersätter de gamla `openclaw-*` färdigheterna: verktygen är skrivna, inget skalande,
och agenten bör förlita sig på dem direkt.

## Inaktivera verktyg

Du kan globalt tillåta/neka verktyg via `tools.allow` / `tools.deny` i `openclaw.json`
(neka vinner). Detta förhindrar att otillåtna verktyg skickas till modellleverantörer.

```json5
{
  tools: { deny: ["browser"] },
}
```

Noteringar:

- Matchning är skiftlägesokänslig.
- `*` jokertecken stöds (`"*"` betyder alla verktyg).
- Om `tools.allow` endast refererar till okända eller ej laddade plugin‑verktygsnamn loggar OpenClaw en varning och ignorerar tillåtelselistan så att kärnverktyg förblir tillgängliga.

## Verktygsprofiler (bas‑tillåtelselista)

`tools.profile` sets a **base tool allowlist** before `tools.allow`/`tools.deny`.
Per-agent override: `agents.list[].tools.profile`.

Profiler:

- `minimal`: endast `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: inga begränsningar (samma som ej satt)

Exempel (endast meddelanden som standard, tillåt även Slack + Discord‑verktyg):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Exempel (kodningsprofil, men neka exec/process överallt):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Exempel (global kodningsprofil, supportagent med endast meddelanden):

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

## Leverantörsspecifik verktygspolicy

Använd `tools.byProvider` till **ytterligare begränsa** verktyg för specifika leverantörer
(eller en enda `provider/model`) utan att ändra dina globala standarder.
Per-agent override: `agents.list[].tools.byProvider`.

Detta tillämpas **efter** basverktygsprofilen och **före** tillåta/neka listor,
så att den endast kan begränsa verktygssatsen.
Leverantörsnycklar accepterar antingen `provider` (t.ex. `google-antigravity`) eller
`provider/model` (t.ex. `openai/gpt-5.2`).

Exempel (behåll global kodningsprofil, men minimala verktyg för Google Antigravity):

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

Exempel (leverantörs-/modellspecifik tillåtelselista för ett instabilt endpoint):

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

Exempel (agent‑specifik åsidosättning för en enskild leverantör):

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

## Verktygsgrupper (genvägar)

Verktygspolicys (global, agent, sandbox) stödjer `group:*`‑poster som expanderar till flera verktyg.
Använd dessa i `tools.allow` / `tools.deny`.

Tillgängliga grupper:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alla inbyggda OpenClaw‑verktyg (exkluderar leverantörspluginer)

Exempel (tillåt endast filverktyg + browser):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Pluginer + verktyg

Plugins kan registrera **ytterligare verktyg** (och CLI-kommandon) bortom kärnuppsättningen.
Se [Plugins](/tools/plugin) för installation + config, och [Skills](/tools/skills) för hur
verktygsanvändning vägledning injiceras i anvisningar. Vissa plugins skeppa sina egna färdigheter
tillsammans med verktyg (till exempel röstsamtalsplugin).

Valfria plugin‑verktyg:

- [Lobster](/tools/lobster): typad workflow‑runtime med återupptagbara godkännanden (kräver Lobster CLI på gateway‑värden).
- [LLM Task](/tools/llm-task): JSON‑endast LLM‑steg för strukturerad workflow‑utdata (valfri schemavalidering).

## Verktygsinventering

### `apply_patch`

Applicera strukturerade patchar över en eller flera filer. Använd för multi-hunk redigeringar.
Experimentellt: aktivera via `tools.exec.applyPatch.enabled` (OpenAI-modeller endast).

### `exec`

Kör shell‑kommandon i arbetsytan.

Kärnparametrar:

- `command` (krävs)
- `yieldMs` (auto‑bakgrund efter timeout, standard 10000)
- `background` (omedelbar bakgrund)
- `timeout` (sekunder; dödar processen om den överskrids, standard 1800)
- `elevated` (bool; kör på värd om förhöjt läge är aktiverat/tillåtet; ändrar endast beteende när agenten är sandboxad)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (nod‑id/namn för `host=node`)
- Behöver du en riktig TTY? Ange `pty: true`.

Noteringar:

- Returnerar `status: "running"` med ett `sessionId` när den körs i bakgrunden.
- Använd `process` för att polla/logga/skriva/döda/rensa bakgrundssessioner.
- Om `process` inte är tillåtet körs `exec` synkront och ignorerar `yieldMs`/`background`.
- `elevated` styrs av `tools.elevated` plus eventuell `agents.list[].tools.elevated`‑åsidosättning (båda måste tillåta) och är ett alias för `host=gateway` + `security=full`.
- `elevated` ändrar endast beteende när agenten är sandboxad (annars är det en no‑op).
- `host=node` kan rikta sig till en macOS companion‑app eller en headless nodvärd (`openclaw node run`).
- gateway/nod‑godkännanden och tillåtelselistor: [Exec approvals](/tools/exec-approvals).

### `process`

Hantera bakgrundssessioner för exec.

Kärnåtgärder:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Noteringar:

- `poll` returnerar ny utdata och exit‑status när den är klar.
- `log` stöder radbaserad `offset`/`limit` (utelämna `offset` för att hämta de senaste N raderna).
- `process` är per agent; sessioner från andra agenter är inte synliga.

### `web_search`

Sök på webben med Brave Search API.

Kärnparametrar:

- `query` (krävs)
- `count` (1–10; standard från `tools.web.search.maxResults`)

Noteringar:

- Kräver en Brave API‑nyckel (rekommenderat: `openclaw configure --section web`, eller sätt `BRAVE_API_KEY`).
- Aktivera via `tools.web.search.enabled`.
- Svar cachelagras (standard 15 min).
- Se [Web tools](/tools/web) för konfiguration.

### `web_fetch`

Hämta och extrahera läsbart innehåll från en URL (HTML → markdown/text).

Kärnparametrar:

- `url` (krävs)
- `extractMode` (`markdown` | `text`)
- `maxChars` (trunkera långa sidor)

Noteringar:

- Aktivera via `tools.web.fetch.enabled`.
- `maxChars` begränsas av `tools.web.fetch.maxCharsCap` (standard 50000).
- Svar cachelagras (standard 15 min).
- För JS‑tunga webbplatser, föredra browser‑verktyget.
- Se [Web tools](/tools/web) för konfiguration.
- Se [Firecrawl](/tools/firecrawl) för valfri anti‑bot‑fallback.

### `browser`

Styr den dedikerade OpenClaw‑hanterade browsern.

Kärnåtgärder:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (returnerar bildblock + `MEDIA:<path>`)
- `act` (UI‑åtgärder: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profilhantering:

- `profiles` — lista alla browserprofiler med status
- `create-profile` — skapa ny profil med automatiskt tilldelad port (eller `cdpUrl`)
- `delete-profile` — stoppa browser, radera användardata, ta bort från konfig (endast lokalt)
- `reset-profile` — döda föräldralös process på profilens port (endast lokalt)

Vanliga parametrar:

- `profile` (valfri; standard `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (valfri; välj specifikt nod‑id/namn)
  Noteringar:
- Kräver `browser.enabled=true` (standard är `true`; sätt `false` för att inaktivera).
- Alla åtgärder accepterar valfri `profile`‑parameter för stöd av flera instanser.
- När `profile` utelämnas används `browser.defaultProfile` (standard "chrome").
- Profilnamn: endast gemener alfanumeriskt + bindestreck (max 64 tecken).
- Portintervall: 18800–18899 (~100 profiler max).
- Fjärrprofiler är endast attach‑only (ingen start/stop/reset).
- Om en browser‑kapabel nod är ansluten kan verktyget auto‑routa till den (om du inte pinnar `target`).
- `snapshot` standardiserar till `ai` när Playwright är installerat; använd `aria` för tillgänglighetsträdet.
- `snapshot` stöder även role‑snapshot‑alternativ (`interactive`, `compact`, `depth`, `selector`) som returnerar referenser som `e12`.
- `act` kräver `ref` från `snapshot` (numeriskt `12` från AI‑snapshots, eller `e12` från role‑snapshots); använd `evaluate` för sällsynta behov av CSS‑selektor.
- Undvik `act` → `wait` som standard; använd endast i undantagsfall (ingen pålitlig UI‑status att vänta på).
- `upload` kan valfritt skicka ett `ref` för auto‑klick efter aktivering.
- `upload` stöder även `inputRef` (aria‑ref) eller `element` (CSS‑selektor) för att sätta `<input type="file">` direkt.

### `canvas`

Styr nodens Canvas (present, eval, snapshot, A2UI).

Kärnåtgärder:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (returnerar bildblock + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Noteringar:

- Använder gateway `node.invoke` under huven.
- Om ingen `node` anges väljer verktyget en standard (en ensam ansluten nod eller lokal mac‑nod).
- A2UI är endast v0.8 (ingen `createSurface`); CLI avvisar v0.9 JSONL med radfel.
- Snabb kontroll: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Upptäck och rikta parade noder; skicka notiser; fånga kamera/skärm.

Kärnåtgärder:

- `status`, `describe`
- `pending`, `approve`, `reject` (parning)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Noteringar:

- Kamera/skärm‑kommandon kräver att nodappen är i förgrunden.
- Bilder returnerar bildblock + `MEDIA:<path>`.
- Videor returnerar `FILE:<path>` (mp4).
- Plats returnerar en JSON‑payload (lat/lon/accuracy/timestamp).
- `run`‑parametrar: `command` argv‑array; valfri `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Exempel (`run`):

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

Analysera en bild med den konfigurerade bildmodellen.

Kärnparametrar:

- `image` (krävd sökväg eller URL)
- `prompt` (valfri; standard "Describe the image.")
- `model` (valfri åsidosättning)
- `maxBytesMb` (valfri storleksgräns)

Noteringar:

- Endast tillgängligt när `agents.defaults.imageModel` är konfigurerad (primär eller fallbacks), eller när en implicit bildmodell kan härledas från din standardmodell + konfigurerad autentisering (best‑effort‑parning).
- Använder bildmodellen direkt (oberoende av huvud‑chattmodellen).

### `message`

Skicka meddelanden och kanalåtgärder över Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Kärnåtgärder:

- `send` (text + valfri media; MS Teams stöder även `card` för Adaptive Cards)
- `poll` (WhatsApp/Discord/MS Teams‑omröstningar)
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

Noteringar:

- `send` routar WhatsApp via Gateway; andra kanaler går direkt.
- `poll` använder Gateway för WhatsApp och MS Teams; Discord‑omröstningar går direkt.
- När ett meddelandeverktygsanrop är bundet till en aktiv chattsession begränsas sändningar till sessionens mål för att undvika läckage mellan kontexter.

### `cron`

Hantera Gateway‑cronjobb och uppvakningar.

Kärnåtgärder:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (köar systemhändelse + valfri omedelbar heartbeat)

Noteringar:

- `add` förväntar sig ett fullständigt cronjobb‑objekt (samma schema som `cron.add` RPC).
- `update` använder `{ jobId, patch }` (`id` accepteras för kompatibilitet).

### `gateway`

Starta om eller tillämpa uppdateringar på den körande Gateway‑processen (in‑place).

Kärnåtgärder:

- `restart` (auktoriserar + skickar `SIGUSR1` för omstart i process; `openclaw gateway` startar om in‑place)
- `config.get` / `config.schema`
- `config.apply` (validera + skriv konfig + starta om + väck)
- `config.patch` (sammanfoga partiell uppdatering + starta om + väck)
- `update.run` (kör uppdatering + starta om + väck)

Noteringar:

- Använd `delayMs` (standard 2000) för att undvika att avbryta ett pågående svar.
- `restart` är inaktiverad som standard; aktivera med `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Lista sessioner, inspektera transkripthistorik eller skicka till en annan session.

Kärnparametrar:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = ingen)
- `sessions_history`: `sessionKey` (eller `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (eller `sessionId`), `message`, `timeoutSeconds?` (0 = fire‑and‑forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (standard aktuell; accepterar `sessionId`), `model?` (`default` rensar åsidosättning)

Noteringar:

- `main` är den kanoniska direct‑chat‑nyckeln; globala/okända döljs.
- `messageLimit > 0` hämtar de senaste N meddelandena per session (verktygsmeddelanden filtreras).
- `sessions_send` väntar på slutlig färdigställning när `timeoutSeconds > 0`.
- Leverans/annonsering sker efter färdigställande och är best‑effort; `status: "ok"` bekräftar att agentkörningen är klar, inte att annonseringen levererades.
- `sessions_spawn` startar en sub‑agentkörning och postar ett announce‑svar tillbaka till begärande chatt.
- `sessions_spawn` är icke‑blockerande och returnerar `status: "accepted"` omedelbart.
- `sessions_send` kör en svar‑ping‑pong (svara `REPLY_SKIP` för att stoppa; max varv via `session.agentToAgent.maxPingPongTurns`, 0–5).
- Efter ping‑pong kör målagenten ett **announce‑steg**; svara `ANNOUNCE_SKIP` för att undertrycka annonseringen.

### `agents_list`

Lista agent‑id:n som den aktuella sessionen får rikta mot med `sessions_spawn`.

Noteringar:

- Resultatet är begränsat till per‑agent‑tillåtelselistor (`agents.list[].subagents.allowAgents`).
- När `["*"]` är konfigurerad inkluderar verktyget alla konfigurerade agenter och markerar `allowAny: true`.

## Parametrar (gemensamma)

Gateway‑backade verktyg (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (standard `ws://127.0.0.1:18789`)
- `gatewayToken` (om autentisering är aktiverad)
- `timeoutMs`

Obs: när `gatewayUrl` är satt, inkludera `gatewayToken` explicit. Verktyg ärver inte config
eller miljöuppgifter för åsidosättningar, och saknade explicita referenser är ett fel.

Browser‑verktyg:

- `profile` (valfri; standard `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (valfri; pinna ett specifikt nod‑id/namn)

## Rekommenderade agentflöden

Browser‑automation:

1. `browser` → `status` / `start`
2. `snapshot` (ai eller aria)
3. `act` (click/type/press)
4. `screenshot` om du behöver visuell bekräftelse

Canvas‑rendering:

1. `canvas` → `present`
2. `a2ui_push` (valfritt)
3. `snapshot`

Nod‑inriktning:

1. `nodes` → `status`
2. `describe` på vald nod
3. `notify` / `run` / `camera_snap` / `screen_record`

## Säkerhet

- Undvik direkt `system.run`; använd `nodes` → `run` endast med uttryckligt användarsamtycke.
- Respektera användarsamtycke för kamera/skärm‑inspelning.
- Använd `status/describe` för att säkerställa behörigheter innan media‑kommandon anropas.

## Hur verktyg presenteras för agenten

Verktyg exponeras i två parallella kanaler:

1. **Systemprompt‑text**: en människoläsbar lista + vägledning.
2. **Verktygsschema**: de strukturerade funktionsdefinitionerna som skickas till modell‑API:t.

Det betyder att agenten ser både ”vilka verktyg som finns” och ”hur man kallar dem”. Om ett verktyg
inte visas i systemprompten eller schemat, kan modellen inte kalla det.
