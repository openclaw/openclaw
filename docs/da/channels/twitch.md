---
summary: "Konfiguration og opsætning af Twitch-chatbot"
read_when:
  - Opsætning af Twitch-chatintegration for OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Twitch chat support via IRC forbindelse. OpenClaw forbinder som en Twitch-bruger (bot-konto) til at modtage og sende beskeder i kanaler.

## Plugin påkrævet

Twitch leveres som et plugin og er ikke inkluderet i kerneinstallationen.

Installér via CLI (npm-registreret):

```bash
openclaw plugins install @openclaw/twitch
```

Lokalt checkout (når du kører fra et git-repo):

```bash
openclaw plugins install ./extensions/twitch
```

Detaljer: [Plugins](/tools/plugin)

## Hurtig opsætning (begynder)

1. Opret en dedikeret Twitch-konto til botten (eller brug en eksisterende konto).
2. Generér legitimationsoplysninger: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Vælg **Bot Token**
   - Bekræft, at scopes `chat:read` og `chat:write` er valgt
   - Kopiér **Client ID** og **Access Token**
3. Find dit Twitch-bruger-ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Konfigurér tokenet:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (kun standardkonto)
   - Eller config: `channels.twitch.accessToken`
   - Hvis begge er sat, har config forrang (env-fallback gælder kun standardkontoen).
5. Start gatewayen.

**⚠️ Vigtigt:** Tilføj adgangskontrol (`allowFrom` eller `allowedRoles`) for at forhindre uautoriserede brugere i at udløse boten. `requireMention` standard er `true`.

Minimal konfiguration:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Hvad det er

- En Twitch-kanal ejet af Gateway.
- Deterministisk routing: svar sendes altid tilbage til Twitch.
- Hver konto mappes til en isoleret sessionsnøgle `agent:<agentId>:twitch:<accountName>`.
- `username` er bottens konto (som autentificerer), `channel` er hvilket chatrum der tilsluttes.

## Opsætning (detaljeret)

### Generér legitimationsoplysninger

Brug [Twitch Token Generator](https://twitchtokengenerator.com/):

- Vælg **Bot Token**
- Bekræft, at scopes `chat:read` og `chat:write` er valgt
- Kopiér **Client ID** og **Access Token**

Ingen manuel app registrering nødvendig. Tokens udløber efter flere timer.

### Konfigurér botten

**Env-var (kun standardkonto):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Eller config:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Hvis både env og config er sat, har config forrang.

### Adgangskontrol (anbefalet)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Foretræk `allowFrom` for en hård tilladelsesliste. Brug `allowedRoles` i stedet, hvis du ønsker rollebaseret adgang.

**Tilgængelige roller:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Hvorfor bruger ID'er?** Brugernavne kan ændre sig, så impersonation. Bruger-ID'er er permanente.

Find dit Twitch-bruger-ID: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Konvertér dit Twitch-brugernavn til ID)

## Token-opdatering (valgfrit)

Tokens fra [Twitch Token Generator](https://twitchtokengenerator.com/) kan ikke opdateres automatisk – generér dem igen, når de udløber.

For automatisk token-opdatering kan du oprette din egen Twitch-applikation i [Twitch Developer Console](https://dev.twitch.tv/console) og tilføje den til config:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

Botten opdaterer automatisk tokens før udløb og logger opdateringshændelser.

## Understøttelse af flere konti

Brug `channels.twitch.accounts` med per-konto tokens. Se [`gateway/configuration`](/gateway/configuration) for det delte mønster.

Eksempel (én botkonto i to kanaler):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Note:** Hver konto kræver sit eget token (ét token pr. kanal).

## Adgangskontrol

### Rollebaserede begrænsninger

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Tilladelsesliste efter bruger-ID (mest sikkert)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Rollebaseret adgang (alternativ)

`allowFrom` er en hård tilladsliste. Når angivet, er det kun disse bruger-id'er tilladt.
Hvis du vil have rollebaseret adgang, så lad `allowFrom` være frakoblet og konfigurer `allowedRoles` i stedet for:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Deaktiver krav om @mention

Som standard er `requireMention` `true`. For at deaktivere og svare på alle beskeder:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Fejlfinding

Kør først diagnosekommandoer:

```bash
openclaw doctor
openclaw channels status --probe
```

### Botten svarer ikke på beskeder

**Tjek adgangskontrol:** Sørg for, at dit bruger-ID er i `allowFrom`, eller fjern midlertidigt
`allowFrom` og sæt `allowedRoles: ["all"]` for at teste.

**Tjek at botten er i kanalen:** Botten skal tilslutte kanalen angivet i `channel`.

### Token-problemer

**"Failed to connect" eller autentificeringsfejl:**

- Bekræft, at `accessToken` er OAuth access token-værdien (starter typisk med `oauth:`-præfiks)
- Tjek at tokenet har scopes `chat:read` og `chat:write`
- Hvis du bruger token-opdatering, bekræft at `clientSecret` og `refreshToken` er sat

### Token-opdatering virker ikke

**Tjek logs for opdateringshændelser:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Hvis du ser "token refresh disabled (no refresh token)":

- Sørg for, at `clientSecret` er angivet
- Sørg for, at `refreshToken` er angivet

## Konfiguration

**Kontokonfiguration:**

- `username` - Bot-brugernavn
- `accessToken` - OAuth access token med `chat:read` og `chat:write`
- `clientId` - Twitch Client ID (fra Token Generator eller din app)
- `channel` - Kanal der tilsluttes (påkrævet)
- `enabled` - Aktivér denne konto (standard: `true`)
- `clientSecret` - Valgfrit: Til automatisk token-opdatering
- `refreshToken` - Valgfrit: Til automatisk token-opdatering
- `expiresIn` - Token-udløb i sekunder
- `obtainmentTimestamp` - Tidspunkt for token-udstedelse
- `allowFrom` - Tilladelsesliste for bruger-ID
- `allowedRoles` - Rollebaseret adgangskontrol (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - Kræv @mention (standard: `true`)

**Udbyderindstillinger:**

- `channels.twitch.enabled` - Aktivér/deaktivér kanalopstart
- `channels.twitch.username` - Bot-brugernavn (forenklet enkeltkontokonfiguration)
- `channels.twitch.accessToken` - OAuth access token (forenklet enkeltkontokonfiguration)
- `channels.twitch.clientId` - Twitch Client ID (forenklet enkeltkontokonfiguration)
- `channels.twitch.channel` - Kanal der tilsluttes (forenklet enkeltkontokonfiguration)
- `channels.twitch.accounts.<accountName>` - Multi-konto config (alle kontofelter ovenfor)

Fuldt eksempel:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Værktøjshandlinger

Agenten kan kalde `twitch` med handlingen:

- `send` - Send en besked til en kanal

Eksempel:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Sikkerhed & drift

- **Behandl tokens som adgangskoder** – Commit aldrig tokens til git
- **Brug automatisk token-opdatering** til langvarigt kørende bots
- **Brug tilladelseslister baseret på bruger-ID** i stedet for brugernavne til adgangskontrol
- **Overvåg logs** for token-opdateringshændelser og forbindelsesstatus
- **Begræns scopes mest muligt** – Anmod kun om `chat:read` og `chat:write`
- **Hvis du sidder fast**: Genstart gatewayen efter at have bekræftet, at ingen anden proces ejer sessionen

## Begrænsninger

- **500 tegn** pr. besked (auto-opdelt ved ordgrænser)
- Markdown fjernes før opdeling
- Ingen rate limiting (bruger Twitch’ indbyggede rate limits)
