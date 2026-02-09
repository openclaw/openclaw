---
summary: "Äldre iMessage stöd via imsg (JSON-RPC över stdio). Nya inställningar bör använda BlueBubbles."
read_when:
  - Konfigurering av iMessage-stöd
  - Felsökning av iMessage sändning/mottagning
title: iMessage
---

# iMessage (legacy: imsg)

> **Rekommenderat:** Använd [BlueBubbles](/channels/bluebubbles) för nya iMessage-installationer.
>
> Kanalen `imsg` är en äldre extern CLI-integration och kan tas bort i en framtida version.

Status: äldre extern CLI-integration. Gateway skapar `imsg rpc` (JSON-RPC över stdio).

## Snabb konfiguration (nybörjare)

1. Säkerställ att Messages är inloggat på denna Mac.
2. Installera `imsg`:
   - `brew install steipete/tap/imsg`
3. Konfigurera OpenClaw med `channels.imessage.cliPath` och `channels.imessage.dbPath`.
4. Starta gatewayen och godkänn eventuella macOS-dialogrutor (Automation + Full Disk Access).

Minimal konfig:

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

## Vad det är

- iMessage-kanal som backas av `imsg` på macOS.
- Deterministisk routning: svar går alltid tillbaka till iMessage.
- DM:er delar agentens huvudsakliga session; grupper är isolerade (`agent:<agentId>:imessage:group:<chat_id>`).
- Om en tråd med flera deltagare anländer med `is_group=false` kan du ändå isolera den genom `chat_id` med hjälp av `channels.imessage.groups` (se ”Grupp-liknande trådar” nedan).

## Konfigskrivningar

Som standard tillåts iMessage att skriva konfiguppdateringar som triggas av `/config set|unset` (kräver `commands.config: true`).

Inaktivera med:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Krav

- macOS med Messages inloggat.
- Full Disk Access för OpenClaw + `imsg` (åtkomst till Messages-databasen).
- Automation-behörighet vid sändning.
- `channels.imessage.cliPath` kan peka på valfritt kommando som proxar stdin/stdout (till exempel ett wrapper-skript som SSH:ar till en annan Mac och kör `imsg rpc`).

## Felsökning av macOS Privacy and Security TCC

Om sändning/mottagning misslyckas (till exempel om `imsg rpc` avslutas med felkod, får timeout eller gatewayen verkar hänga), är en vanlig orsak en macOS-behörighetsdialog som aldrig godkändes.

macOS beviljar TCC behörigheter per app/processkontext. Godkänn uppmaningar i samma sammanhang som kör `imsg` (till exempel Terminal/iTerm, en LaunchAgent session eller en SSH-startad process).

Checklista:

- **Fullständig diskåtkomst**: ge åtkomst för processen som kör OpenClaw (och alla skal/SSH-omvandlare som kör `imsg`). Detta krävs för att läsa meddelandedatabasen ('chat.db').
- **Automation → Messages**: tillåt processen som kör OpenClaw (och/eller din terminal) att styra **Messages.app** för utgående sändningar.
- **`imsg` CLI-hälsa**: verifiera att `imsg` är installerat och stöder RPC (`imsg rpc --help`).

Tips: Om OpenClaw kör headless (LaunchAgent/systemd/SSH) kan macOS-prompten vara lätt att missa. Kör ett interaktivt kommando i en GUI-terminal för att tvinga fram prompten och försök sedan igen:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Relaterade macOS-mappbehörigheter (Skrivbord/Dokument/Hämtningar): [/platforms/mac/permissions](/platforms/mac/permissions).

## Konfigurering (snabb väg)

1. Säkerställ att Messages är inloggat på denna Mac.
2. Konfigurera iMessage och starta gatewayen.

### Dedikerad bot-macOS-användare (för isolerad identitet)

Om du vill att boten ska skicka från en **separat iMessage-identitet** (och hålla dina personliga Messages rena), använd ett dedikerat Apple‑ID + en dedikerad macOS-användare.

1. Skapa ett dedikerat Apple‑ID (exempel: `my-cool-bot@icloud.com`).
   - Apple kan kräva ett telefonnummer för verifiering / 2FA.
2. Skapa en macOS-användare (exempel: `openclawhome`) och logga in på den.
3. Öppna Messages i den macOS-användaren och logga in på iMessage med botens Apple‑ID.
4. Aktivera Fjärrinloggning (Systeminställningar → Allmänt → Delning → Fjärrinloggning).
5. Installera `imsg`:
   - `brew install steipete/tap/imsg`
6. Konfigurera SSH så att `ssh <bot-macos-user>@localhost true` fungerar utan lösenord.
7. Peka `channels.imessage.accounts.bot.cliPath` på en SSH-wrapper som kör `imsg` som bot-användaren.

Första körningen anmärkning: skicka/ta emot kan kräva GUI-godkännanden (Automation + Full Disk Access) i _bot macOS user_. Om `imsg rpc` ser fast eller utträde, logga in i den användaren (Skärm Delning hjälper), kör en engångs`imsg chattar --limit 1` / `imsg skicka. .`, godkänn uppmaningar, försök sedan. Se [Felsökning macOS Sekretess och säkerhet TCC](#troubleshooting-macos-privacy-and-security-tcc).

Exempel omslag (`chmod +x`). Ersätt `<bot-macos-user>` med ditt faktiska macOS användarnamn:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Exempelkonfig:

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

För installationer med ett enda konto, använd platta alternativ (`channels.imessage.cliPath`, `channels.imessage.dbPath`) i stället för `accounts`-mappen.

### Fjärr-/SSH-variant (valfritt)

Om du vill ha iMessage på en annan Mac, sätt `channels.imessage.cliPath` till en wrapper som kör `imsg` på fjärrmacOS värd över SSH. OpenClaw behöver bara stdio.

Exempel-wrapper:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Fjärrbilagor:** När `cliPath` pekar till en fjärrvärd via SSH, bifogade sökvägar i meddelandedatabasens referensfiler på fjärrmaskinen. OpenClaw kan automatiskt hämta dessa över SCP genom att ställa in `channels.imessage.remoteHost`:

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

Om `remoteHost` inte är inställd, försöker OpenClaw att automatiskt upptäcka det genom att tolka SSH-kommandot i ditt wrapper-skript. Explicit konfiguration rekommenderas för tillförlitlighet.

#### Fjärr-Mac via Tailscale (exempel)

Om Gateway körs på en Linux-värd/VM men iMessage måste köras på en Mac, är Tailscale den enklaste bryggan: Gateway pratar med Macen över tailnet, kör `imsg` via SSH och SCP:ar tillbaka bilagor.

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

Konkret konfigexempel (Tailscale-värdnamn):

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

Exempel-wrapper (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Noteringar:

- Säkerställ att Macen är inloggad i Messages och att Fjärrinloggning är aktiverad.
- Använd SSH-nycklar så att `ssh bot@mac-mini.tailnet-1234.ts.net` fungerar utan promptar.
- `remoteHost` ska matcha SSH-målet så att SCP kan hämta bilagor.

Stöd för flera konton: använd `channels.imessage.accounts` med konfiguration per konto och valfri `name`. Se [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) för det delade mönstret. Använd inte `~/.openclaw/openclaw.json` (det innehåller ofta tokens).

## Åtkomstkontroll (DM:er + grupper)

DM:er:

- Standard: `channels.imessage.dmPolicy = "pairing"`.
- Okända avsändare får en parningskod; meddelanden ignoreras tills de godkänns (koder löper ut efter 1 timme).
- Godkänn via:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Parkoppling är standard token utbyte för iMessage DMs. Detaljer: [Pairing](/channels/pairing)

Grupper:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` styr vem som kan trigga i grupper när `allowlist` är satt.
- Mention-gating använder `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`) eftersom iMessage saknar inbyggd metadata för omnämnanden.
- Multi-agent-override: sätt per-agent-mönster på `agents.list[].groupChat.mentionPatterns`.

## Hur det fungerar (beteende)

- `imsg` strömmar meddelandehändelser; gatewayen normaliserar dem till det delade kanal-kuvertet.
- Svar routas alltid tillbaka till samma chatt-id eller handle.

## Grupp-liknande trådar (`is_group=false`)

Vissa iMessage-trådar kan ha flera deltagare men ändå komma in med `is_group=false` beroende på hur Messages lagrar chattidentifieraren.

Om du uttryckligen konfigurerar ett `chat_id` under `channels.imessage.groups` behandlar OpenClaw den tråden som en ”grupp” för:

- sessionsisolering (separat `agent:<agentId>:imessage:group:<chat_id>`-sessionsnyckel)
- gruppbaserad tillåtelselista / mention-gating-beteende

Exempel:

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

Detta är användbart när du vill ha en isolerad personlighet/modell för en specifik tråd (se [Multi-agent routing](/concepts/multi-agent)). För isolering av filsystem, se [Sandboxing](/gateway/sandboxing).

## Media + begränsningar

- Valfri bilageinmatning via `channels.imessage.includeAttachments`.
- Mediatak via `channels.imessage.mediaMaxMb`.

## Begränsningar

- Utgående text delas upp till `channels.imessage.textChunkLimit` (standard 4000).
- Valfri uppdelning på nya rader: sätt `channels.imessage.chunkMode="newline"` för att dela på tomma rader (styckegränser) före längd-uppdelning.
- Mediauppladdningar begränsas av `channels.imessage.mediaMaxMb` (standard 16).

## Adressering / leveransmål

Föredra `chat_id` för stabil routning:

- `chat_id:123` (föredragen)
- `chat_guid:...`
- `chat_identifier:...`
- direkta handles: `imessage:+1555` / `sms:+1555` / `user@example.com`

Lista chattar:

```
imsg chats --limit 20
```

## Konfigurationsreferens (iMessage)

Fullständig konfiguration: [Konfiguration](/gateway/configuration)

Leverantörsalternativ:

- `channels.imessage.enabled`: aktivera/inaktivera kanalstart.
- `channels.imessage.cliPath`: sökväg till `imsg`.
- `channels.imessage.dbPath`: sökväg till Messages-databasen.
- `channels.imessage.remoteHost`: SSH-värd för överföring av SCP-bilagor när `cliPath` pekar till en fjärr-Mac (t.ex. `user@gateway-host`). Auto-upptäckt från SSH-omvandlare om ej angiven.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: SMS-region.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (standard: parning).
- `channels.imessage.allowFrom`: DM allowlist (hanterar, e-postmeddelanden, E.164 nummer eller `chat_id:*`). `open` kräver `"*"`. iMessage har inga användarnamn, använd handtag eller chattmål.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (standard: tillåtelselista).
- `channels.imessage.groupAllowFrom`: tillåtelselista för gruppavsändare.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: max antal gruppmeddelanden att inkludera som kontext (0 inaktiverar).
- `channels.imessage.dmHistorikLimit`: DM historikgräns i användarens varv. Åsidosättningar per användare: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: per-grupp-standarder + tillåtelselista (använd `"*"` för globala standarder).
- `channels.imessage.includeAttachments`: mata in bilagor i kontext.
- `channels.imessage.mediaMaxMb`: inkommande/utgående mediatak (MB).
- `channels.imessage.textChunkLimit`: utgående chunkstorlek (tecken).
- `channels.imessage.chunkMode`: `length` (standard) eller `newline` för att dela på tomma rader (styckegränser) före längd-uppdelning.

Relaterade globala alternativ:

- `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
