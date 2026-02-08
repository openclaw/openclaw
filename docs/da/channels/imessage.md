---
summary: "Ældre iMessage-understøttelse via imsg (JSON-RPC over stdio). Nye opsætninger bør bruge BlueBubbles."
read_when:
  - Opsætning af iMessage-understøttelse
  - Fejlfinding af iMessage send/modtag
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:14Z
---

# iMessage (legacy: imsg)

> **Anbefalet:** Brug [BlueBubbles](/channels/bluebubbles) til nye iMessage-opsætninger.
>
> Kanalen `imsg` er en ældre ekstern CLI-integration og kan blive fjernet i en fremtidig version.

Status: ældre ekstern CLI-integration. Gateway starter `imsg rpc` (JSON-RPC over stdio).

## Hurtig opsætning (begynder)

1. Sørg for, at Beskeder er logget ind på denne Mac.
2. Installér `imsg`:
   - `brew install steipete/tap/imsg`
3. Konfigurér OpenClaw med `channels.imessage.cliPath` og `channels.imessage.dbPath`.
4. Start gatewayen, og godkend eventuelle macOS-prompter (Automation + Fuld diskadgang).

Minimal konfiguration:

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

## Hvad det er

- iMessage-kanal baseret på `imsg` på macOS.
- Deterministisk routing: svar går altid tilbage til iMessage.
- DMs deler agentens hovedsession; grupper er isolerede (`agent:<agentId>:imessage:group:<chat_id>`).
- Hvis en tråd med flere deltagere ankommer med `is_group=false`, kan du stadig isolere den ved `chat_id` med `channels.imessage.groups` (se “Gruppe-agtige tråde” nedenfor).

## Konfigurationsskrivninger

Som standard må iMessage skrive konfigurationsopdateringer udløst af `/config set|unset` (kræver `commands.config: true`).

Deaktivér med:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Krav

- macOS med Beskeder logget ind.
- Fuld diskadgang til OpenClaw + `imsg` (adgang til Beskeder-databasen).
- Automation-tilladelse ved afsendelse.
- `channels.imessage.cliPath` kan pege på enhver kommando, der proxyer stdin/stdout (for eksempel et wrapper-script, der SSH’er til en anden Mac og kører `imsg rpc`).

## Fejlfinding af macOS Privacy and Security TCC

Hvis afsendelse/modtagelse fejler (for eksempel hvis `imsg rpc` afslutter med en ikke-nul status, får timeout, eller gatewayen ser ud til at hænge), er en almindelig årsag en macOS-tilladelsesprompt, der aldrig blev godkendt.

macOS giver TCC-tilladelser pr. app/proceskontekst. Godkend prompter i den samme kontekst, som kører `imsg` (for eksempel Terminal/iTerm, en LaunchAgent-session eller en proces startet via SSH).

Tjekliste:

- **Fuld diskadgang**: tillad adgang for processen, der kører OpenClaw (og eventuelle shell/SSH-wrappere, der eksekverer `imsg`). Dette er nødvendigt for at læse Beskeder-databasen (`chat.db`).
- **Automation → Beskeder**: tillad processen, der kører OpenClaw (og/eller din terminal), at styre **Messages.app** for udgående afsendelser.
- **`imsg` CLI-sundhed**: verificér at `imsg` er installeret og understøtter RPC (`imsg rpc --help`).

Tip: Hvis OpenClaw kører headless (LaunchAgent/systemd/SSH), kan macOS-prompten være let at overse. Kør en engangs interaktiv kommando i en GUI-terminal for at fremtvinge prompten, og prøv derefter igen:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Relaterede macOS-mappetilladelser (Skrivebord/Dokumenter/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions).

## Opsætning (hurtig vej)

1. Sørg for, at Beskeder er logget ind på denne Mac.
2. Konfigurér iMessage og start gatewayen.

### Dedikeret bot-macOS-bruger (for isoleret identitet)

Hvis du vil have, at botten sender fra en **separat iMessage-identitet** (og holde dine personlige Beskeder rene), så brug et dedikeret Apple-id + en dedikeret macOS-bruger.

1. Opret et dedikeret Apple-id (eksempel: `my-cool-bot@icloud.com`).
   - Apple kan kræve et telefonnummer til verifikation / 2FA.
2. Opret en macOS-bruger (eksempel: `openclawhome`) og log ind på den.
3. Åbn Beskeder i den macOS-bruger, og log ind på iMessage med bot-Apple-id’et.
4. Aktivér Fjernlogin (Systemindstillinger → Generelt → Deling → Fjernlogin).
5. Installér `imsg`:
   - `brew install steipete/tap/imsg`
6. Opsæt SSH, så `ssh <bot-macos-user>@localhost true` fungerer uden adgangskode.
7. Peg `channels.imessage.accounts.bot.cliPath` på en SSH-wrapper, der kører `imsg` som bot-brugeren.

Bemærkning ved første kørsel: afsendelse/modtagelse kan kræve GUI-godkendelser (Automation + Fuld diskadgang) i _bot-macOS-brugeren_. Hvis `imsg rpc` ser ud til at sidde fast eller afslutter, så log ind på den bruger (Skærmdeling hjælper), kør en engangs `imsg chats --limit 1` / `imsg send ...`, godkend prompter og prøv igen. Se [Fejlfinding af macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc).

Eksempel-wrapper (`chmod +x`). Erstat `<bot-macos-user>` med dit faktiske macOS-brugernavn:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Eksempelkonfiguration:

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

For opsætninger med én konto, brug flade indstillinger (`channels.imessage.cliPath`, `channels.imessage.dbPath`) i stedet for `accounts`-kortet.

### Fjern-/SSH-variant (valgfrit)

Hvis du vil have iMessage på en anden Mac, så sæt `channels.imessage.cliPath` til en wrapper, der kører `imsg` på den eksterne macOS-vært via SSH. OpenClaw behøver kun stdio.

Eksempel-wrapper:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Fjernvedhæftninger:** Når `cliPath` peger på en fjernvært via SSH, refererer vedhæftningsstier i Beskeder-databasen til filer på den eksterne maskine. OpenClaw kan automatisk hente disse via SCP ved at sætte `channels.imessage.remoteHost`:

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

Hvis `remoteHost` ikke er sat, forsøger OpenClaw at autodetektere den ved at parse SSH-kommandoen i dit wrapper-script. Eksplicit konfiguration anbefales for pålidelighed.

#### Fjern-Mac via Tailscale (eksempel)

Hvis Gateway kører på en Linux-vært/VM, men iMessage skal køre på en Mac, er Tailscale den enkleste bro: Gatewayen taler med Mac’en over tailnettet, kører `imsg` via SSH og SCP’er vedhæftninger tilbage.

Arkitektur:

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

Konkret konfigurationseksempel (Tailscale-værtsnavn):

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

Eksempel-wrapper (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Noter:

- Sørg for, at Mac’en er logget ind i Beskeder, og at Fjernlogin er aktiveret.
- Brug SSH-nøgler, så `ssh bot@mac-mini.tailnet-1234.ts.net` fungerer uden prompter.
- `remoteHost` bør matche SSH-målet, så SCP kan hente vedhæftninger.

Understøttelse af flere konti: brug `channels.imessage.accounts` med konfiguration pr. konto og valgfri `name`. Se [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for det fælles mønster. Commit ikke `~/.openclaw/openclaw.json` (det indeholder ofte tokens).

## Adgangskontrol (DMs + grupper)

DMs:

- Standard: `channels.imessage.dmPolicy = "pairing"`.
- Ukendte afsendere modtager en parringskode; beskeder ignoreres, indtil de godkendes (koder udløber efter 1 time).
- Godkend via:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Parring er standard token-udveksling for iMessage DMs. Detaljer: [Pairing](/channels/pairing)

Grupper:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` styrer, hvem der kan trigge i grupper, når `allowlist` er sat.
- Mention-gating bruger `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`), fordi iMessage ikke har native mention-metadata.
- Multi-agent override: sæt mønstre pr. agent på `agents.list[].groupChat.mentionPatterns`.

## Sådan virker det (adfærd)

- `imsg` streamer beskedhændelser; gatewayen normaliserer dem til den fælles kanal-konvolut.
- Svar routes altid tilbage til samme chat-id eller handle.

## Gruppe-agtige tråde (`is_group=false`)

Nogle iMessage-tråde kan have flere deltagere, men stadig ankomme med `is_group=false`, afhængigt af hvordan Beskeder gemmer chat-identifikatoren.

Hvis du eksplicit konfigurerer et `chat_id` under `channels.imessage.groups`, behandler OpenClaw den tråd som en “gruppe” for:

- sessionsisolering (separat `agent:<agentId>:imessage:group:<chat_id>`-sessionsnøgle)
- gruppe-tilladelsesliste / mention-gating-adfærd

Eksempel:

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

Dette er nyttigt, når du vil have en isoleret personlighed/model for en specifik tråd (se [Multi-agent routing](/concepts/multi-agent)). For filsystem-isolering, se [Sandboxing](/gateway/sandboxing).

## Medier + grænser

- Valgfri indlæsning af vedhæftninger via `channels.imessage.includeAttachments`.
- Medieloft via `channels.imessage.mediaMaxMb`.

## Begrænsninger

- Udgående tekst opdeles i bidder på `channels.imessage.textChunkLimit` (standard 4000).
- Valgfri linjeskift-opdeling: sæt `channels.imessage.chunkMode="newline"` til at splitte på tomme linjer (afsnitsgrænser) før længdeopdeling.
- Medieuploads er begrænset af `channels.imessage.mediaMaxMb` (standard 16).

## Adressering / leveringsmål

Foretræk `chat_id` for stabil routing:

- `chat_id:123` (foretrukket)
- `chat_guid:...`
- `chat_identifier:...`
- direkte handles: `imessage:+1555` / `sms:+1555` / `user@example.com`

List chats:

```
imsg chats --limit 20
```

## Konfigurationsreference (iMessage)

Fuld konfiguration: [Konfiguration](/gateway/configuration)

Udbyderindstillinger:

- `channels.imessage.enabled`: aktivér/deaktivér kanalopstart.
- `channels.imessage.cliPath`: sti til `imsg`.
- `channels.imessage.dbPath`: sti til Beskeder-databasen.
- `channels.imessage.remoteHost`: SSH-vært til SCP-overførsel af vedhæftninger, når `cliPath` peger på en fjern-Mac (f.eks. `user@gateway-host`). Autodetekteres fra SSH-wrapper, hvis ikke sat.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: SMS-region.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (standard: pairing).
- `channels.imessage.allowFrom`: DM-tilladelsesliste (handles, e-mails, E.164-numre eller `chat_id:*`). `open` kræver `"*"`. iMessage har ingen brugernavne; brug handles eller chat-mål.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (standard: tilladelsesliste).
- `channels.imessage.groupAllowFrom`: gruppesender-tilladelsesliste.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: maks. antal gruppebeskeder, der inkluderes som kontekst (0 deaktiverer).
- `channels.imessage.dmHistoryLimit`: DM-historikgrænse i brugeromgange. Overstyringer pr. bruger: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: standarder pr. gruppe + tilladelsesliste (brug `"*"` for globale standarder).
- `channels.imessage.includeAttachments`: indlæs vedhæftninger i kontekst.
- `channels.imessage.mediaMaxMb`: ind-/udgående medieloft (MB).
- `channels.imessage.textChunkLimit`: udgående chunk-størrelse (tegn).
- `channels.imessage.chunkMode`: `length` (standard) eller `newline` for at splitte på tomme linjer (afsnitsgrænser) før længdeopdeling.

Relaterede globale indstillinger:

- `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
