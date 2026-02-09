---
summary: "Signal-ondersteuning via signal-cli (JSON-RPC + SSE), installatie en nummermodel"
read_when:
  - Signal-ondersteuning instellen
  - Signal verzenden/ontvangen debuggen
title: "Signal"
---

# Signal (signal-cli)

Status: externe CLI-integratie. De Gateway communiceert met `signal-cli` via HTTP JSON-RPC + SSE.

## Snelle installatie (beginner)

1. Gebruik een **afzonderlijk Signal-nummer** voor de bot (aanbevolen).
2. Installeer `signal-cli` (Java vereist).
3. Koppel het botapparaat en start de daemon:
   - `signal-cli link -n "OpenClaw"`
4. Configureer OpenClaw en start de Gateway.

Minimale config:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## Wat het is

- Signal-kanaal via `signal-cli` (geen ingesloten libsignal).
- Deterministische routering: antwoorden gaan altijd terug naar Signal.
- DM's delen de hoofdsessie van de agent; groepen zijn geïsoleerd (`agent:<agentId>:signal:group:<groupId>`).

## Config-wegschrijvingen

Standaard mag Signal config-updates wegschrijven die worden getriggerd door `/config set|unset` (vereist `commands.config: true`).

Uitschakelen met:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## Het nummermodel (belangrijk)

- De Gateway verbindt met een **Signal-apparaat** (het `signal-cli`-account).
- Als je de bot draait op **je persoonlijke Signal-account**, worden je eigen berichten genegeerd (lusbescherming).
- Voor “ik stuur de bot een bericht en hij antwoordt”, gebruik een **afzonderlijk botnummer**.

## Installatie (snelle route)

1. Installeer `signal-cli` (Java vereist).
2. Koppel een botaccount:
   - `signal-cli link -n "OpenClaw"` en scan vervolgens de QR in Signal.
3. Configureer Signal en start de Gateway.

Voorbeeld:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Ondersteuning voor meerdere accounts: gebruik `channels.signal.accounts` met per-account config en optioneel `name`. Zie [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) voor het gedeelde patroon.

## Externe daemonmodus (httpUrl)

Als je `signal-cli` zelf wilt beheren (trage JVM cold starts, container-initialisatie of gedeelde CPU’s), draai de daemon apart en wijs OpenClaw ernaar:

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

Dit slaat auto-spawn en de opstartwachttijd binnen OpenClaw over. Voor trage starts bij auto-spawn stel je `channels.signal.startupTimeoutMs` in.

## Toegangsbeheer (DM's + groepen)

DM's:

- Standaard: `channels.signal.dmPolicy = "pairing"`.
- Onbekende afzenders ontvangen een koppelingscode; berichten worden genegeerd tot goedkeuring (codes verlopen na 1 uur).
- Goedkeuren via:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- Koppeling is de standaard tokenuitwisseling voor Signal-DM's. Details: [Pairing](/channels/pairing)
- Afzenders met alleen een UUID (van `sourceUuid`) worden opgeslagen als `uuid:<id>` in `channels.signal.allowFrom`.

Groepen:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` bepaalt wie in groepen kan triggeren wanneer `allowlist` is ingesteld.

## Hoe het werkt (gedrag)

- `signal-cli` draait als daemon; de Gateway leest events via SSE.
- Inkomende berichten worden genormaliseerd naar de gedeelde kanaalenvelop.
- Antwoorden worden altijd teruggerouteerd naar hetzelfde nummer of dezelfde groep.

## Media + limieten

- Uitgaande tekst wordt opgeknipt tot `channels.signal.textChunkLimit` (standaard 4000).
- Optioneel opsplitsen op nieuwe regels: stel `channels.signal.chunkMode="newline"` in om te splitsen op lege regels (paragraafgrenzen) vóór het lengtesplitsen.
- Bijlagen worden ondersteund (base64 opgehaald uit `signal-cli`).
- Standaard medialimiet: `channels.signal.mediaMaxMb` (standaard 8).
- Gebruik `channels.signal.ignoreAttachments` om het downloaden van media over te slaan.
- Groepsgeschiedeniscontext gebruikt `channels.signal.historyLimit` (of `channels.signal.accounts.*.historyLimit`), met fallback naar `messages.groupChat.historyLimit`. Stel `0` in om uit te schakelen (standaard 50).

## Typen + leesbevestigingen

- **Typindicatoren**: OpenClaw verstuurt typ-signalen via `signal-cli sendTyping` en ververst ze terwijl een antwoord loopt.
- **Leesbevestigingen**: wanneer `channels.signal.sendReadReceipts` true is, stuurt OpenClaw leesbevestigingen door voor toegestane DM's.
- Signal-cli biedt geen leesbevestigingen voor groepen.

## Reacties (message tool)

- Gebruik `message action=react` met `channel=signal`.
- Doelen: afzender E.164 of UUID (gebruik `uuid:<id>` uit de pairing-uitvoer; een kale UUID werkt ook).
- `messageId` is de Signal-tijdstempel van het bericht waarop je reageert.
- Groepsreacties vereisen `targetAuthor` of `targetAuthorUuid`.

Voorbeelden:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Config:

- `channels.signal.actions.reactions`: reacties in-/uitschakelen (standaard true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack` schakelt agentreacties uit (message tool `react` geeft een fout).
  - `minimal`/`extensive` schakelt agentreacties in en stelt het richtlijnniveau in.
- Per-account overrides: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Leveringsdoelen (CLI/cron)

- DM's: `signal:+15551234567` (of gewoon E.164).
- UUID-DM's: `uuid:<id>` (of kale UUID).
- Groepen: `signal:group:<groupId>`.
- Gebruikersnamen: `username:<name>` (indien ondersteund door je Signal-account).

## Problemen oplossen

Doorloop eerst deze ladder:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bevestig daarna indien nodig de DM-koppelingsstatus:

```bash
openclaw pairing list signal
```

Veelvoorkomende fouten:

- Daemon bereikbaar maar geen antwoorden: controleer account-/daemoninstellingen (`httpUrl`, `account`) en ontvangmodus.
- DM's genegeerd: afzender wacht op koppelingsgoedkeuring.
- Groepsberichten genegeerd: gating voor groepsafzenders/mentions blokkeert levering.

Voor triageflow: [/channels/troubleshooting](/channels/troubleshooting).

## Configuratiereferentie (Signal)

Volledige configuratie: [Configuratie](/gateway/configuration)

Provider-opties:

- `channels.signal.enabled`: kanaalstart in-/uitschakelen.
- `channels.signal.account`: E.164 voor het botaccount.
- `channels.signal.cliPath`: pad naar `signal-cli`.
- `channels.signal.httpUrl`: volledige daemon-URL (overschrijft host/poort).
- `channels.signal.httpHost`, `channels.signal.httpPort`: daemon-bind (standaard 127.0.0.1:8080).
- `channels.signal.autoStart`: daemon automatisch starten (standaard true als `httpUrl` niet is ingesteld).
- `channels.signal.startupTimeoutMs`: opstart-wachttijd in ms (max 120000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: bijlagen downloaden overslaan.
- `channels.signal.ignoreStories`: stories van de daemon negeren.
- `channels.signal.sendReadReceipts`: leesbevestigingen doorsturen.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (standaard: pairing).
- `channels.signal.allowFrom`: DM-toegestane lijst (E.164 of `uuid:<id>`). `open` vereist `"*"`. Signal heeft geen gebruikersnamen; gebruik telefoon-/UUID-id’s.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (standaard: toegestane lijst).
- `channels.signal.groupAllowFrom`: toegestane lijst voor groepsafzenders.
- `channels.signal.historyLimit`: max. aantal groepsberichten om als context op te nemen (0 schakelt uit).
- `channels.signal.dmHistoryLimit`: DM-geschiedenislimeit in gebruikersbeurten. Per-gebruiker overrides: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: uitgaande chunkgrootte (tekens).
- `channels.signal.chunkMode`: `length` (standaard) of `newline` om te splitsen op lege regels (paragraafgrenzen) vóór lengtesplitsen.
- `channels.signal.mediaMaxMb`: limiet voor inkomende/uitgaande media (MB).

Gerelateerde globale opties:

- `agents.list[].groupChat.mentionPatterns` (Signal ondersteunt geen native mentions).
- `messages.groupChat.mentionPatterns` (globale fallback).
- `messages.responsePrefix`.
