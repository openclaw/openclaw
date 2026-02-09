---
summary: "Legacy iMessage-ondersteuning via imsg (JSON-RPC over stdio). Nieuwe installaties moeten BlueBubbles gebruiken."
read_when:
  - iMessage-ondersteuning instellen
  - Problemen oplossen bij iMessage verzenden/ontvangen
title: iMessage
---

# iMessage (legacy: imsg)

> **Aanbevolen:** Gebruik [BlueBubbles](/channels/bluebubbles) voor nieuwe iMessage-installaties.
>
> Het kanaal `imsg` is een legacy externe-CLI-integratie en kan in een toekomstige release worden verwijderd.

Status: legacy externe CLI-integratie. De Gateway start `imsg rpc` (JSON-RPC over stdio).

## Snelle installatie (beginner)

1. Zorg dat Berichten is aangemeld op deze Mac.
2. Installeer `imsg`:
   - `brew install steipete/tap/imsg`
3. Configureer OpenClaw met `channels.imessage.cliPath` en `channels.imessage.dbPath`.
4. Start de Gateway en keur eventuele macOS-prompts goed (Automatisering + Volledige schijftoegang).

Minimale config:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## Wat het is

- iMessage-kanaal ondersteund door `imsg` op macOS.
- Deterministische routering: antwoorden gaan altijd terug naar iMessage.
- DM's delen de hoofdsessie van de agent; groepen zijn geïsoleerd (`agent:<agentId>:imessage:group:<chat_id>`).
- Als een thread met meerdere deelnemers binnenkomt met `is_group=false`, kun je deze alsnog isoleren door `chat_id` te gebruiken met `channels.imessage.groups` (zie “Group-ish threads” hieronder).

## Config-wegschrijvingen

Standaard mag iMessage config-updates wegschrijven die worden getriggerd door `/config set|unset` (vereist `commands.config: true`).

Uitschakelen met:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Provideropties

- macOS met Berichten aangemeld.
- Volledige schijftoegang voor OpenClaw + `imsg` (toegang tot de Berichten-database).
- Automatiseringsrechten bij verzenden.
- `channels.imessage.cliPath` kan verwijzen naar elk commando dat stdin/stdout doorgeeft (bijvoorbeeld een wrapper-script dat via SSH naar een andere Mac gaat en `imsg rpc` uitvoert).

## Problemen oplossen: macOS Privacy en Beveiliging (TCC)

Als verzenden/ontvangen faalt (bijvoorbeeld `imsg rpc` eindigt met een niet-nul status, time-out optreedt, of de Gateway lijkt te hangen), is een veelvoorkomende oorzaak een macOS-rechtenprompt die nooit is goedgekeurd.

macOS verleent TCC-rechten per app/procescontext. Keur prompts goed in dezelfde context die `imsg` uitvoert (bijvoorbeeld Terminal/iTerm, een LaunchAgent-sessie of een via SSH gestart proces).

Checklist:

- **Volledige schijftoegang**: sta toegang toe voor het proces dat OpenClaw uitvoert (en elke shell/SSH-wrapper die `imsg` start). Dit is vereist om de Berichten-database te lezen (`chat.db`).
- **Automatisering → Berichten**: sta toe dat het proces dat OpenClaw uitvoert (en/of je terminal) **Messages.app** mag bedienen voor uitgaande verzending.
- **`imsg` CLI-gezondheid**: verifieer dat `imsg` is geïnstalleerd en RPC ondersteunt (`imsg rpc --help`).

Tip: Als OpenClaw headless draait (LaunchAgent/systemd/SSH), kan de macOS-prompt makkelijk worden gemist. Voer eenmalig een interactieve opdracht uit in een GUI-terminal om de prompt af te dwingen en probeer het daarna opnieuw:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Gerelateerde macOS-maprechten (Bureaublad/Documenten/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions).

## Installatie (snelle route)

1. Zorg dat Berichten is aangemeld op deze Mac.
2. Configureer iMessage en start de Gateway.

### Toegewijde bot-macOS-gebruiker (voor geïsoleerde identiteit)

Als je wilt dat de bot verzendt vanaf een **afzonderlijke iMessage-identiteit** (en je persoonlijke Berichten schoon wilt houden), gebruik dan een toegewijde Apple ID + een toegewijde macOS-gebruiker.

1. Maak een toegewijde Apple ID aan (voorbeeld: `my-cool-bot@icloud.com`).
   - Apple kan een telefoonnummer vereisen voor verificatie / 2FA.
2. Maak een macOS-gebruiker aan (voorbeeld: `openclawhome`) en meld je daarop aan.
3. Open Berichten in die macOS-gebruiker en meld je aan bij iMessage met de bot-Apple ID.
4. Schakel Inloggen op afstand in (Systeeminstellingen → Algemeen → Delen → Inloggen op afstand).
5. Installeer `imsg`:
   - `brew install steipete/tap/imsg`
6. Stel SSH zo in dat `ssh <bot-macos-user>@localhost true` zonder wachtwoord werkt.
7. Laat `channels.imessage.accounts.bot.cliPath` verwijzen naar een SSH-wrapper die `imsg` uitvoert als de bot-gebruiker.

Opmerking bij eerste run: verzenden/ontvangen kan GUI-goedkeuringen vereisen (Automatisering + Volledige schijftoegang) in de _bot-macOS-gebruiker_. Als `imsg rpc` vast lijkt te lopen of stopt, log in op die gebruiker (Schermdeling helpt), voer eenmalig `imsg chats --limit 1` / `imsg send ...` uit, keur prompts goed en probeer opnieuw. Zie [Problemen oplossen: macOS Privacy en Beveiliging (TCC)](#troubleshooting-macos-privacy-and-security-tcc).

Voorbeeld-wrapper (`chmod +x`). Vervang `<bot-macos-user>` door je daadwerkelijke macOS-gebruikersnaam:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Voorbeeldconfig:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

Voor single-account-installaties gebruik je platte opties (`channels.imessage.cliPath`, `channels.imessage.dbPath`) in plaats van de `accounts`-map.

### Remote/SSH-variant (optioneel)

Als je iMessage op een andere Mac wilt, stel `channels.imessage.cliPath` in op een wrapper die `imsg` uitvoert op de externe macOS-host via SSH. OpenClaw heeft alleen stdio nodig.

Voorbeeld-wrapper:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Externe bijlagen:** Wanneer `cliPath` naar een externe host via SSH wijst, verwijzen bijlagepaden in de Berichten-database naar bestanden op de externe machine. OpenClaw kan deze automatisch ophalen via SCP door `channels.imessage.remoteHost` in te stellen:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

Als `remoteHost` niet is ingesteld, probeert OpenClaw dit automatisch te detecteren door het SSH-commando in je wrapper-script te parseren. Expliciete configuratie wordt aanbevolen voor betrouwbaarheid.

#### Externe Mac via Tailscale (voorbeeld)

Als de Gateway op een Linux-host/VM draait maar iMessage op een Mac moet draaien, is Tailscale de eenvoudigste brug: de Gateway praat met de Mac via het tailnet, voert `imsg` uit via SSH en haalt bijlagen terug via SCP.

Architectuur:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Concreet configvoorbeeld (Tailscale-hostnaam):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Voorbeeld-wrapper (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Notities:

- Zorg dat de Mac is aangemeld bij Berichten en dat Inloggen op afstand is ingeschakeld.
- Gebruik SSH-sleutels zodat `ssh bot@mac-mini.tailnet-1234.ts.net` zonder prompts werkt.
- `remoteHost` moet overeenkomen met het SSH-doel zodat SCP bijlagen kan ophalen.

Multi-account-ondersteuning: gebruik `channels.imessage.accounts` met per-account-config en optioneel `name`. Zie [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) voor het gedeelde patroon. Commit `~/.openclaw/openclaw.json` niet (het bevat vaak tokens).

## Toegangsbeheer (DM's + groepen)

DM's:

- Standaard: `channels.imessage.dmPolicy = "pairing"`.
- Onbekende afzenders ontvangen een koppelingscode; berichten worden genegeerd totdat ze zijn goedgekeurd (codes verlopen na 1 uur).
- Goedkeuren via:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Koppeling is de standaard tokenuitwisseling voor iMessage-DM's. Details: [Pairing](/channels/pairing)

Groepen:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` bepaalt wie in groepen kan triggeren wanneer `allowlist` is ingesteld.
- Mention-gating gebruikt `agents.list[].groupChat.mentionPatterns` (of `messages.groupChat.mentionPatterns`) omdat iMessage geen native mention-metadata heeft.
- Multi-agent-override: stel per-agent patronen in op `agents.list[].groupChat.mentionPatterns`.

## Hoe het werkt (gedrag)

- `imsg` streamt berichtgebeurtenissen; de Gateway normaliseert ze naar de gedeelde kanaal-envelop.
- Antwoorden worden altijd teruggestuurd naar dezelfde chat-id of handle.

## Group-ish threads (`is_group=false`)

Sommige iMessage-threads kunnen meerdere deelnemers hebben maar toch binnenkomen met `is_group=false`, afhankelijk van hoe Berichten de chat-identificatie opslaat.

Als je expliciet een `chat_id` configureert onder `channels.imessage.groups`, behandelt OpenClaw die thread als een “groep” voor:

- sessie-isolatie (aparte `agent:<agentId>:imessage:group:<chat_id>`-sessiesleutel)
- groeps-toegestane lijst / mention-gating-gedrag

Voorbeeld:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

Dit is handig wanneer je een geïsoleerde persoonlijkheid/model wilt voor een specifieke thread (zie [Multi-agent routing](/concepts/multi-agent)). Voor bestandsysteemisolatie, zie [Sandboxing](/gateway/sandboxing).

## Media + limieten

- Optionele bijlage-inname via `channels.imessage.includeAttachments`.
- Medialimiet via `channels.imessage.mediaMaxMb`.

## Beperkingen

- Uitgaande tekst wordt gechunked tot `channels.imessage.textChunkLimit` (standaard 4000).
- Optionele newline-chunking: stel `channels.imessage.chunkMode="newline"` in om te splitsen op lege regels (paragraafgrenzen) vóór lengte-chunking.
- Media-uploads zijn beperkt door `channels.imessage.mediaMaxMb` (standaard 16).

## Adressering / afleverdoelen

Geef de voorkeur aan `chat_id` voor stabiele routering:

- `chat_id:123` (voorkeur)
- `chat_guid:...`
- `chat_identifier:...`
- directe handles: `imessage:+1555` / `sms:+1555` / `user@example.com`

Chats weergeven:

```
imsg chats --limit 20
```

## Configuratiereferentie (iMessage)

Volledige configuratie: [Configuratie](/gateway/configuration)

Provider-opties:

- `channels.imessage.enabled`: kanaalstart in-/uitschakelen.
- `channels.imessage.cliPath`: pad naar `imsg`.
- `channels.imessage.dbPath`: pad naar de Berichten-database.
- `channels.imessage.remoteHost`: SSH-host voor SCP-bijlageoverdracht wanneer `cliPath` naar een externe Mac wijst (bijv. `user@gateway-host`). Automatisch gedetecteerd vanuit de SSH-wrapper indien niet ingesteld.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: SMS-regio.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (standaard: pairing).
- `channels.imessage.allowFrom`: DM-toegestane lijst (handles, e-mails, E.164-nummers of `chat_id:*`). `open` vereist `"*"`. iMessage heeft geen gebruikersnamen; gebruik handles of chatdoelen.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (standaard: allowlist).
- `channels.imessage.groupAllowFrom`: groepsafzender-toegestane lijst.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: maximaal aantal groepsberichten om als context op te nemen (0 schakelt uit).
- `channels.imessage.dmHistoryLimit`: DM-geschiedenislimeit in gebruikersbeurten. Per-gebruiker-overschrijvingen: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: per-groep standaardwaarden + toegestane lijst (gebruik `"*"` voor globale standaardwaarden).
- `channels.imessage.includeAttachments`: neem bijlagen op in de context.
- `channels.imessage.mediaMaxMb`: inkomende/uitgaande medialimiet (MB).
- `channels.imessage.textChunkLimit`: uitgaande chunkgrootte (tekens).
- `channels.imessage.chunkMode`: `length` (standaard) of `newline` om te splitsen op lege regels (paragraafgrenzen) vóór lengte-chunking.

Gerelateerde globale opties:

- `agents.list[].groupChat.mentionPatterns` (of `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
