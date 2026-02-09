---
summary: "Regels, sleutels en persistentie voor chat-sessiebeheer"
read_when:
  - Het aanpassen van sessie-afhandeling of opslag
title: "Sessiebeheer"
---

# Sessiebeheer

OpenClaw behandelt **één direct-chat-sessie per agent** als primair. Directe chats vallen samen tot `agent:<agentId>:<mainKey>` (standaard `main`), terwijl groeps-/kanaalchats hun eigen sleutels krijgen. `session.mainKey` wordt gerespecteerd.

Gebruik `session.dmScope` om te bepalen hoe **directe berichten** worden gegroepeerd:

- `main` (standaard): alle DM's delen de hoofdsessie voor continuïteit.
- `per-peer`: isoleer per afzender-id over kanalen heen.
- `per-channel-peer`: isoleer per kanaal + afzender (aanbevolen voor inboxen met meerdere gebruikers).
- `per-account-channel-peer`: isoleer per account + kanaal + afzender (aanbevolen voor inboxen met meerdere accounts).
  Gebruik `session.identityLinks` om provider-geprefixte peer-id's te mappen naar een canonieke identiteit, zodat dezelfde persoon één DM-sessie deelt over kanalen heen bij gebruik van `per-peer`, `per-channel-peer` of `per-account-channel-peer`.

## Veilige DM-modus (aanbevolen voor setups met meerdere gebruikers)

> **Beveiligingswaarschuwing:** Als je agent DM's kan ontvangen van **meerdere personen**, overweeg sterk om de veilige DM-modus in te schakelen. Zonder deze modus delen alle gebruikers dezelfde conversatiecontext, wat privé-informatie tussen gebruikers kan lekken.

**Voorbeeld van het probleem met standaardinstellingen:**

- Alice (`<SENDER_A>`) stuurt je agent een bericht over een privéonderwerp (bijvoorbeeld een medische afspraak)
- Bob (`<SENDER_B>`) stuurt je agent de vraag: "Waar hadden we het over?"
- Omdat beide DM's dezelfde sessie delen, kan het model Bob antwoorden met context van Alice.

**De oplossing:** Stel `dmScope` in om sessies per gebruiker te isoleren:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Wanneer dit inschakelen:**

- Je hebt koppelingsgoedkeuringen voor meer dan één afzender
- Je gebruikt een DM-toegestane lijst met meerdere vermeldingen
- Je stelt `dmPolicy: "open"` in
- Meerdere telefoonnummers of accounts kunnen je agent berichten sturen

Notities:

- Standaard is `dmScope: "main"` voor continuïteit (alle DM's delen de hoofdsessie). Dit is prima voor setups met één gebruiker.
- Voor inboxen met meerdere accounts op hetzelfde kanaal heeft `per-account-channel-peer` de voorkeur.
- Als dezelfde persoon je via meerdere kanalen benadert, gebruik `session.identityLinks` om hun DM-sessies samen te voegen tot één canonieke identiteit.
- Je kunt je DM-instellingen verifiëren met `openclaw security audit` (zie [beveiliging](/cli/security)).

## Gateway is de bron van waarheid

Alle sessiestatus is **eigendom van de Gateway** (de “master” OpenClaw). UI-clients (macOS-app, WebChat, enz.) moeten de Gateway raadplegen voor sessielijsten en tokentellingen in plaats van lokale bestanden te lezen.

- In **remote-modus** bevindt de relevante sessie-opslag zich op de externe Gateway-host, niet op je Mac.
- Tokentellingen die in UI's worden getoond, komen uit de opslagvelden van de Gateway (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Clients parsen geen JSONL-transcripten om totalen te “corrigeren”.

## Waar status leeft

- Op de **Gateway-host**:
  - Opslagbestand: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (per agent).
- Transcripties: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram-onderwerpsessies gebruiken `.../<SessionId>-topic-<threadId>.jsonl`).
- De opslag is een map `sessionKey -> { sessionId, updatedAt, ... }`. Het verwijderen van vermeldingen is veilig; ze worden on-demand opnieuw aangemaakt.
- Groepsvermeldingen kunnen `displayName`, `channel`, `subject`, `room` en `space` bevatten om sessies in UI's te labelen.
- Sessievermeldingen bevatten `origin`-metadata (label + routeringshints) zodat UI's kunnen uitleggen waar een sessie vandaan komt.
- OpenClaw leest **geen** legacy Pi/Tau-sessiemappen.

## Sessie-opruiming

OpenClaw trimt standaard **oude toolresultaten** uit de in-memory context vlak vóór LLM-aanroepen.
Dit herschrijft de JSONL-geschiedenis **niet**. Zie [/concepts/session-pruning](/concepts/session-pruning).

## Pre-compactie geheugenflush

Wanneer een sessie de automatische compactie nadert, kan OpenClaw een **stille geheugenflush**
uitvoeren die het model eraan herinnert om duurzame notities naar schijf te schrijven. Dit draait
alleen wanneer de werkruimte schrijfbaar is. Zie [Memory](/concepts/memory) en
[Compaction](/concepts/compaction).

## Transporten → sessiesleutels mappen

- Directe chats volgen `session.dmScope` (standaard `main`).
  - `main`: `agent:<agentId>:<mainKey>` (continuïteit over apparaten/kanalen).
    - Meerdere telefoonnummers en kanalen kunnen naar dezelfde agent-hoofdsleutel mappen; ze fungeren als transporten naar één conversatie.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId is standaard `default`).
  - Als `session.identityLinks` overeenkomt met een provider-geprefixte peer-id (bijvoorbeeld `telegram:123`), vervangt de canonieke sleutel `<peerId>`, zodat dezelfde persoon één sessie deelt over kanalen heen.
- Groepschats isoleren status: `agent:<agentId>:<channel>:group:<id>` (ruimtes/kanalen gebruiken `agent:<agentId>:<channel>:channel:<id>`).
  - Telegram-forumonderwerpen voegen `:topic:<threadId>` toe aan de groeps-id voor isolatie.
  - Legacy `group:<id>`-sleutels worden nog steeds herkend voor migratie.
- Inkomende contexten kunnen nog `group:<id>` gebruiken; het kanaal wordt afgeleid uit `Provider` en genormaliseerd naar de canonieke vorm `agent:<agentId>:<channel>:group:<id>`.
- Andere bronnen:
  - Cronjobs: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (tenzij expliciet door de hook ingesteld)
  - Node-runs: `node-<nodeId>`

## Levenscyclus

- Resetbeleid: sessies worden hergebruikt totdat ze verlopen, en verstrijken wordt geëvalueerd bij het volgende inkomende bericht.
- Dagelijkse reset: standaard **04:00 lokale tijd op de Gateway-host**. Een sessie is verouderd zodra de laatste update eerder is dan het meest recente dagelijkse resetmoment.
- Inactiviteitsreset (optioneel): `idleMinutes` voegt een schuivend inactiviteitsvenster toe. Wanneer zowel dagelijkse als inactiviteitsresets zijn geconfigureerd, **dwingt degene die het eerst verloopt** een nieuwe sessie af.
- Legacy alleen-inactiviteit: als je `session.idleMinutes` instelt zonder enige `session.reset`/`resetByType`-configuratie, blijft OpenClaw omwille van achterwaartse compatibiliteit in alleen-inactiviteitsmodus.
- Overrides per type (optioneel): `resetByType` laat je het beleid overschrijven voor `dm`-, `group`- en `thread`-sessies (thread = Slack/Discord-threads, Telegram-onderwerpen, Matrix-threads wanneer geleverd door de connector).
- Overrides per kanaal (optioneel): `resetByChannel` overschrijft het resetbeleid voor een kanaal (geldt voor alle sessietypen voor dat kanaal en heeft voorrang op `reset`/`resetByType`).
- Reset-triggers: exact `/new` of `/reset` (plus eventuele extra's in `resetTriggers`) starten een nieuwe sessie-id en geven de rest van het bericht door. `/new <model>` accepteert een model-alias, `provider/model` of providernaam (fuzzy match) om het nieuwe sessiemodel in te stellen. Als `/new` of `/reset` alleen wordt verzonden, voert OpenClaw een korte “hallo”-groetbeurt uit om de reset te bevestigen.
- Handmatige reset: verwijder specifieke sleutels uit de opslag of verwijder het JSONL-transcript; het volgende bericht maakt ze opnieuw aan.
- Geïsoleerde cronjobs maken per run altijd een nieuwe `sessionId` aan (geen hergebruik bij inactiviteit).

## Verzendbeleid (optioneel)

Blokkeer levering voor specifieke sessietypen zonder individuele id's te hoeven vermelden.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Runtime-override (alleen eigenaar):

- `/send on` → toestaan voor deze sessie
- `/send off` → weigeren voor deze sessie
- `/send inherit` → override wissen en configuratieregels gebruiken
  Stuur deze als zelfstandige berichten zodat ze worden geregistreerd.

## Configuratie (optioneel hernoemvoorbeeld)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Inspecteren

- `openclaw status` — toont opslagpad en recente sessies.
- `openclaw sessions --json` — dumpt elke vermelding (filter met `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — haalt sessies op van de draaiende Gateway (gebruik `--url`/`--token` voor toegang tot een externe Gateway).
- Stuur `/status` als een zelfstandig bericht in de chat om te zien of de agent bereikbaar is, hoeveel van de sessiecontext wordt gebruikt, de huidige thinking/verbose-toggles, en wanneer je WhatsApp-webgegevens voor het laatst zijn ververst (helpt bij het signaleren van herlinkbehoeften).
- Stuur `/context list` of `/context detail` om te zien wat er in de systeemprompt en geïnjecteerde werkruimtebestanden staat (en de grootste contextbijdragers).
- Stuur `/stop` als een zelfstandig bericht om de huidige run af te breken, wachtrijen met vervolgacties voor die sessie te wissen en alle sub-agent-runs die daarvan zijn gestart te stoppen (het antwoord bevat het gestopte aantal).
- Stuur `/compact` (optionele instructies) als een zelfstandig bericht om oudere context samen te vatten en vensterruimte vrij te maken. Zie [/concepts/compaction](/concepts/compaction).
- JSONL-transcripten kunnen direct worden geopend om volledige beurten te bekijken.

## Tips

- Houd de primaire sleutel gereserveerd voor 1:1-verkeer; laat groepen hun eigen sleutels behouden.
- Verwijder bij geautomatiseerde opschoning afzonderlijke sleutels in plaats van de hele opslag om context elders te behouden.

## Metadata van sessieherkomst

Elke sessievermelding registreert waar deze vandaan komt (best-effort) in `origin`:

- `label`: menselijk label (opgelost uit conversatielabel + groepsonderwerp/kanaal)
- `provider`: genormaliseerde kanaal-id (inclusief extensies)
- `from`/`to`: ruwe routerings-id's uit de inkomende envelop
- `accountId`: provider-account-id (bij meerdere accounts)
- `threadId`: thread-/onderwerp-id wanneer het kanaal dit ondersteunt
  De herkomstvelden worden gevuld voor directe berichten, kanalen en groepen. Als een
  connector alleen de afleverroutering bijwerkt (bijvoorbeeld om een DM-hoofdsessie
  vers te houden), moet hij alsnog inkomende context leveren zodat de sessie haar
  verklarende metadata behoudt. Extensies kunnen dit doen door `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` en `SenderName` in de inkomende
  context te sturen en `recordSessionMetaFromInbound` aan te roepen (of dezelfde context door te geven
  aan `updateLastRoute`).
