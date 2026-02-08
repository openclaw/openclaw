---
summary: "Regler, nøgler og persistens for sessionhåndtering i chats"
read_when:
  - Ændring af sessionhåndtering eller -lagring
title: "Sessionshåndtering"
x-i18n:
  source_path: concepts/session.md
  source_hash: e2040cea1e0738a8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:33Z
---

# Sessionshåndtering

OpenClaw behandler **én direkte chatsession pr. agent** som primær. Direkte chats kollapser til `agent:<agentId>:<mainKey>` (standard `main`), mens gruppe-/kanalchats får deres egne nøgler. `session.mainKey` respekteres.

Brug `session.dmScope` til at styre, hvordan **direkte beskeder** grupperes:

- `main` (standard): alle DM’er deler hovedsessionen for kontinuitet.
- `per-peer`: isolér efter afsender-id på tværs af kanaler.
- `per-channel-peer`: isolér efter kanal + afsender (anbefalet til indbakker med flere brugere).
- `per-account-channel-peer`: isolér efter konto + kanal + afsender (anbefalet til indbakker med flere konti).
  Brug `session.identityLinks` til at mappe udbyder-præfiksede peer-id’er til en kanonisk identitet, så den samme person deler en DM-session på tværs af kanaler, når du bruger `per-peer`, `per-channel-peer` eller `per-account-channel-peer`.

## Sikker DM-tilstand (anbefalet til opsætninger med flere brugere)

> **Sikkerhedsadvarsel:** Hvis din agent kan modtage DM’er fra **flere personer**, bør du kraftigt overveje at aktivere sikker DM-tilstand. Uden den deler alle brugere den samme samtalekontekst, hvilket kan lække private oplysninger mellem brugere.

**Eksempel på problemet med standardindstillinger:**

- Alice (`<SENDER_A>`) skriver til din agent om et privat emne (for eksempel en lægeaftale)
- Bob (`<SENDER_B>`) skriver til din agent og spørger: “Hvad talte vi om?”
- Fordi begge DM’er deler den samme session, kan modellen svare Bob ved at bruge Alices tidligere kontekst.

**Løsningen:** Sæt `dmScope` til at isolere sessioner pr. bruger:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Hvornår bør dette aktiveres:**

- Du har parringsgodkendelser for mere end én afsender
- Du bruger en DM-tilladelsesliste med flere poster
- Du sætter `dmPolicy: "open"`
- Flere telefonnumre eller konti kan skrive til din agent

Noter:

- Standard er `dmScope: "main"` for kontinuitet (alle DM’er deler hovedsessionen). Dette er fint til opsætninger med én bruger.
- Til indbakker med flere konti på samme kanal bør du foretrække `per-account-channel-peer`.
- Hvis den samme person kontakter dig på flere kanaler, brug `session.identityLinks` til at samle deres DM-sessioner i én kanonisk identitet.
- Du kan verificere dine DM-indstillinger med `openclaw security audit` (se [security](/cli/security)).

## Gateway er sandhedskilden

Al sessionstilstand **ejes af gatewayen** (den “master” OpenClaw). UI-klienter (macOS-app, WebChat osv.) skal forespørge gatewayen om sessionslister og tokenantal i stedet for at læse lokale filer.

- I **remote-tilstand** ligger det sessionlager, du skal bruge, på den eksterne gateway-vært – ikke på din Mac.
- Tokenantal, der vises i UI’er, kommer fra gatewayens lagerfelter (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Klienter parser ikke JSONL-transskripter for at “rette” totaler.

## Hvor tilstanden ligger

- På **gateway-værten**:
  - Lagerfil: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (pr. agent).
- Transskripter: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram-emnesessioner bruger `.../<SessionId>-topic-<threadId>.jsonl`).
- Lageret er et map `sessionKey -> { sessionId, updatedAt, ... }`. Det er sikkert at slette poster; de genskabes efter behov.
- Gruppeposter kan inkludere `displayName`, `channel`, `subject`, `room` og `space` til at mærke sessioner i UI’er.
- Sessionsposter inkluderer `origin`-metadata (label + routing-hints), så UI’er kan forklare, hvor en session stammer fra.
- OpenClaw læser **ikke** ældre Pi/Tau-sessionsmapper.

## Sessionbeskæring

OpenClaw beskærer som standard **gamle værktøjsresultater** fra den in-memory kontekst lige før LLM-kald.
Dette omskriver **ikke** JSONL-historikken. Se [/concepts/session-pruning](/concepts/session-pruning).

## Pre-komprimering af hukommelsesflush

Når en session nærmer sig automatisk komprimering, kan OpenClaw køre en **stille hukommelsesflush**
tur, der minder modellen om at skrive varige noter til disk. Dette kører kun, når
arbejdsområdet er skrivbart. Se [Memory](/concepts/memory) og
[Compaction](/concepts/compaction).

## Mapping af transports → sessionsnøgler

- Direkte chats følger `session.dmScope` (standard `main`).
  - `main`: `agent:<agentId>:<mainKey>` (kontinuitet på tværs af enheder/kanaler).
    - Flere telefonnumre og kanaler kan mappe til den samme primære agentnøgle; de fungerer som transports ind i én samtale.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId har standardværdien `default`).
  - Hvis `session.identityLinks` matcher et udbyder-præfikset peer-id (for eksempel `telegram:123`), erstatter den kanoniske nøgle `<peerId>`, så den samme person deler en session på tværs af kanaler.
- Gruppechats isolerer tilstand: `agent:<agentId>:<channel>:group:<id>` (rum/kanaler bruger `agent:<agentId>:<channel>:channel:<id>`).
  - Telegram-forumemner tilføjer `:topic:<threadId>` til gruppe-id’et for isolation.
  - Ældre `group:<id>`-nøgler genkendes stadig til migrering.
- Indgående kontekster kan stadig bruge `group:<id>`; kanalen udledes fra `Provider` og normaliseres til den kanoniske `agent:<agentId>:<channel>:group:<id>`-form.
- Andre kilder:
  - Cron-jobs: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (medmindre den eksplicit sættes af hooken)
  - Node-kørsler: `node-<nodeId>`

## Livscyklus

- Nulstillingspolitik: sessioner genbruges, indtil de udløber, og udløb evalueres ved den næste indgående besked.
- Daglig nulstilling: standard er **kl. 04:00 lokal tid på gateway-værten**. En session er forældet, når dens seneste opdatering er tidligere end den seneste daglige nulstilling.
- Inaktiv-nulstilling (valgfrit): `idleMinutes` tilføjer et glidende inaktivitetsvindue. Når både daglig og inaktiv nulstilling er konfigureret, er det **den, der udløber først**, der tvinger en ny session.
- Ældre kun-inaktiv: hvis du sætter `session.idleMinutes` uden nogen `session.reset`/`resetByType`-konfiguration, forbliver OpenClaw i kun-inaktiv-tilstand af hensyn til bagudkompatibilitet.
- Tilsidesættelser pr. type (valgfrit): `resetByType` lader dig tilsidesætte politikken for `dm`, `group` og `thread`-sessioner (thread = Slack/Discord-tråde, Telegram-emner, Matrix-tråde når leveret af connectoren).
- Tilsidesættelser pr. kanal (valgfrit): `resetByChannel` tilsidesætter nulstillingspolitikken for en kanal (gælder for alle sessionstyper for den kanal og har forrang over `reset`/`resetByType`).
- Nulstillingsudløsere: præcis `/new` eller `/reset` (plus eventuelle ekstra i `resetTriggers`) starter et nyt sessions-id og videresender resten af beskeden. `/new <model>` accepterer et model-alias, `provider/model` eller udbydernavn (fuzzy match) for at sætte den nye sessionsmodel. Hvis `/new` eller `/reset` sendes alene, kører OpenClaw en kort “hello”-hilsentur for at bekræfte nulstillingen.
- Manuel nulstilling: slet specifikke nøgler fra lageret eller fjern JSONL-transskriptet; den næste besked genskaber dem.
- Isolerede cron-jobs udsteder altid et nyt `sessionId` pr. kørsel (ingen inaktiv genbrug).

## Afsendelsespolitik (valgfrit)

Blokér levering for specifikke sessionstyper uden at liste individuelle id’er.

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

Runtime-tilsidesættelse (kun ejer):

- `/send on` → tillad for denne session
- `/send off` → afvis for denne session
- `/send inherit` → ryd tilsidesættelse og brug konfigurationsregler
  Send disse som selvstændige beskeder, så de registreres.

## Konfiguration (valgfrit omdøbnings-eksempel)

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

## Inspektion

- `openclaw status` — viser lagersti og nylige sessioner.
- `openclaw sessions --json` — dumper alle poster (filtrér med `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — henter sessioner fra den kørende gateway (brug `--url`/`--token` for adgang til remote gateway).
- Send `/status` som en selvstændig besked i chatten for at se, om agenten er tilgængelig, hvor meget af sessionskonteksten der bruges, aktuelle thinking/verbose-toggles, og hvornår dine WhatsApp web-legitimationsoplysninger sidst blev opdateret (hjælper med at opdage behov for genlink).
- Send `/context list` eller `/context detail` for at se, hvad der er i systemprompten og de injicerede arbejdsområdefiler (og de største kontekstbidrag).
- Send `/stop` som en selvstændig besked for at afbryde den aktuelle kørsel, rydde køede opfølgninger for den session og stoppe eventuelle underagent-kørsler, der er startet fra den (svaret inkluderer antallet, der blev stoppet).
- Send `/compact` (valgfri instruktioner) som en selvstændig besked for at opsummere ældre kontekst og frigøre vinduesplads. Se [/concepts/compaction](/concepts/compaction).
- JSONL-transskripter kan åbnes direkte for at gennemgå fulde ture.

## Tips

- Hold den primære nøgle dedikeret til 1:1-trafik; lad grupper beholde deres egne nøgler.
- Ved automatiseret oprydning skal du slette individuelle nøgler i stedet for hele lageret for at bevare kontekst andre steder.

## Metadata om sessionsoprindelse

Hver sessionspost registrerer, hvor den stammer fra (best-effort), i `origin`:

- `label`: menneskeligt label (løst fra samtalelabel + gruppeemne/kanal)
- `provider`: normaliseret kanal-id (inklusive udvidelser)
- `from`/`to`: rå routing-id’er fra den indgående konvolut
- `accountId`: udbyder-konto-id (ved flere konti)
- `threadId`: tråd-/emne-id, når kanalen understøtter det
  Oprindelsesfelterne udfyldes for direkte beskeder, kanaler og grupper. Hvis en
  connector kun opdaterer leveringsrouting (for eksempel for at holde en DM-hovedsession
  frisk), bør den stadig levere indgående kontekst, så sessionen bevarer sine
  forklaringsmetadata. Udvidelser kan gøre dette ved at sende `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` og `SenderName` i den indgående
  kontekst og kalde `recordSessionMetaFromInbound` (eller videregive den samme kontekst
  til `updateLastRoute`).
