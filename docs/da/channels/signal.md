---
summary: "Signal-understøttelse via signal-cli (JSON-RPC + SSE), opsætning og nummermodel"
read_when:
  - Opsætning af Signal-understøttelse
  - Fejlfinding af Signal send/modtag
title: "Signal"
---

# Signal (signal-cli)

Status: ekstern CLI integration. Gateway taler til `signal-cli` over HTTP JSON-RPC + SSE.

## Hurtig opsætning (begynder)

1. Brug et **separat Signal-nummer** til botten (anbefalet).
2. Installér `signal-cli` (Java kræves).
3. Knyt bot-enheden og start daemonen:
   - `signal-cli link -n "OpenClaw"`
4. Konfigurér OpenClaw og start gatewayen.

Minimal konfiguration:

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

## Hvad det er

- Signal-kanal via `signal-cli` (ikke indlejret libsignal).
- Deterministisk routing: svar går altid tilbage til Signal.
- DM’er deler agentens primære session; grupper er isolerede (`agent:<agentId>:signal:group:<groupId>`).

## Konfigurationsskrivninger

Som standard har Signal tilladelse til at skrive konfigurationsopdateringer udløst af `/config set|unset` (kræver `commands.config: true`).

Deaktivér med:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## Nummermodellen (vigtigt)

- Gatewayen forbinder til en **Signal-enhed** (kontoen `signal-cli`).
- Hvis du kører botten på **din personlige Signal-konto**, ignorerer den dine egne beskeder (loop-beskyttelse).
- For “jeg skriver til botten, og den svarer”, brug et **separat bot-nummer**.

## Opsætning (hurtig sti)

1. Installér `signal-cli` (Java kræves).
2. Knyt en bot-konto:
   - `signal-cli link -n "OpenClaw"` og scan derefter QR-koden i Signal.
3. Konfigurér Signal og start gatewayen.

Eksempel:

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

Multi-konto support: brug `channels.signal.accounts` med per-account config og valgfri `name`. Se [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for det delte mønster.

## Ekstern daemon-tilstand (httpUrl)

Hvis du vil administrere `signal-cli` selv (langsomme JVM-kolde starter, container-init eller delte CPU’er), så kør daemonen separat og peg OpenClaw på den:

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

Dette springer auto-spawn og opstart vente inde OpenClaw. For langsom starter, når auto-spawning, sæt `channels.signal.startupTimeoutMs`.

## Adgangskontrol (DM’er + grupper)

DM’er:

- Standard: `channels.signal.dmPolicy = "pairing"`.
- Ukendte afsendere modtager en parringskode; beskeder ignoreres, indtil de er godkendt (koder udløber efter 1 time).
- Godkend via:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- Parring er standard token udveksling for Signal DMs. Detaljer: [Pairing](/channels/pairing)
- Afsendere kun med UUID (fra `sourceUuid`) gemmes som `uuid:<id>` i `channels.signal.allowFrom`.

Grupper:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` styrer, hvem der kan trigge i grupper, når `allowlist` er sat.

## Sådan virker det (adfærd)

- `signal-cli` kører som en daemon; gatewayen læser events via SSE.
- Indgående beskeder normaliseres til den fælles kanal-konvolut.
- Svar routes altid tilbage til samme nummer eller gruppe.

## Medier + grænser

- Udgående tekst opdeles i bidder på `channels.signal.textChunkLimit` (standard 4000).
- Valgfri opdeling ved linjeskift: sæt `channels.signal.chunkMode="newline"` for at splitte ved tomme linjer (afsnitsgrænser) før længdeopdeling.
- Vedhæftninger understøttes (base64 hentes fra `signal-cli`).
- Standard medieloft: `channels.signal.mediaMaxMb` (standard 8).
- Brug `channels.signal.ignoreAttachments` for at springe download af medier over.
- Gruppe historie kontekst bruger `channels.signal.historyLimit` (eller `channels.signal.accounts.*.historyLimit`), falder tilbage til `messages.groupChat.historyLimit`. Sæt `0` til at deaktivere (standard 50).

## Skriver + læsekvitteringer

- **Skriveindikatorer**: OpenClaw sender skrive-signaler via `signal-cli sendTyping` og opdaterer dem, mens et svar kører.
- **Læsekvitteringer**: når `channels.signal.sendReadReceipts` er true, videresender OpenClaw læsekvitteringer for tilladte DM’er.
- Signal-cli eksponerer ikke læsekvitteringer for grupper.

## Reaktioner (beskedværktøj)

- Brug `message action=react` med `channel=signal`.
- Mål: afsender E.164 eller UUID (brug `uuid:<id>` fra parringsoutput; rå UUID virker også).
- `messageId` er Signal-tidsstemplet for beskeden, du reagerer på.
- Gruppereaktioner kræver `targetAuthor` eller `targetAuthorUuid`.

Eksempler:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Konfiguration:

- `channels.signal.actions.reactions`: aktivér/deaktivér reaktionshandlinger (standard true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack` deaktiverer agentreaktioner (beskedværktøjet `react` vil give fejl).
  - `minimal`/`extensive` aktiverer agentreaktioner og sætter vejledningsniveauet.
- Per-account tilsidesættelser: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Leveringsmål (CLI/cron)

- DM’er: `signal:+15551234567` (eller ren E.164).
- UUID-DM’er: `uuid:<id>` (eller rå UUID).
- Grupper: `signal:group:<groupId>`.
- Brugernavne: `username:<name>` (hvis understøttet af din Signal-konto).

## Fejlfinding

Kør denne stige først:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bekræft derefter DM-parringstilstand, hvis nødvendigt:

```bash
openclaw pairing list signal
```

Almindelige fejl:

- Daemonen kan nås, men ingen svar: verificér konto-/daemonindstillinger (`httpUrl`, `account`) og modtagetilstand.
- DM’er ignoreres: afsenderen afventer parringsgodkendelse.
- Gruppebeskeder ignoreres: gruppe-afsender-/mention-gating blokerer levering.

For triage-flow: [/channels/troubleshooting](/channels/troubleshooting).

## Konfigurationsreference (Signal)

Fuld konfiguration: [Konfiguration](/gateway/configuration)

Udbyderindstillinger:

- `channels.signal.enabled`: aktivér/deaktivér kanalopstart.
- `channels.signal.account`: E.164 for bot-kontoen.
- `channels.signal.cliPath`: sti til `signal-cli`.
- `channels.signal.httpUrl`: fuld daemon-URL (overstyrer host/port).
- `channels.signal.httpHost`, `channels.signal.httpPort`: daemon-binding (standard 127.0.0.1:8080).
- `channels.signal.autoStart`: auto-start daemon (standard true, hvis `httpUrl` ikke er sat).
- `channels.signal.startupTimeoutMs`: opstarts-ventetidsgrænse i ms (maks 120000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: spring download af vedhæftninger over.
- `channels.signal.ignoreStories`: ignorer stories fra daemonen.
- `channels.signal.sendReadReceipts`: videresend læsekvitteringer.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (standard: parring).
- `channels.signal.allowFrom`: DM allowlist (E.164 eller `uuid:<id>`). `open` kræver `"*"`. Signal har ingen brugernavne; brug telefon/UUID id'er.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (standard: tilladelsesliste).
- `channels.signal.groupAllowFrom`: tilladelsesliste for gruppeafsendere.
- `channels.signal.historyLimit`: max gruppe beskeder til at omfatte som kontekst (0 disables).
- `channels.signal.dmHistoryLimit`: DM historie grænse i bruger sving. Per-user tilsidesættelser: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: udgående chunk-størrelse (tegn).
- `channels.signal.chunkMode`: `length` (standard) eller `newline` for at splitte ved tomme linjer (afsnitsgrænser) før længdeopdeling.
- `channels.signal.mediaMaxMb`: indgående/udgående medieloft (MB).

Relaterede globale indstillinger:

- `agents.list[].groupChat.mentionPatterns` (Signal understøtter ikke native mentions).
- `messages.groupChat.mentionPatterns` (global fallback).
- `messages.responsePrefix`.
