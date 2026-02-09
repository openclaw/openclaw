---
summary: "Konfiguration och konfigurering av Twitch-chattbot"
read_when:
  - Konfigurering av Twitch-chattintegration för OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Stöd för Twitch chatt via IRC-anslutning. OpenClaw ansluter som en Twitch-användare (bot account) för att ta emot och skicka meddelanden i kanaler.

## Plugin krävs

Twitch levereras som ett plugin och ingår inte i kärninstallationen.

Installera via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/twitch
```

Lokal checkout (vid körning från ett git-repo):

```bash
openclaw plugins install ./extensions/twitch
```

Detaljer: [Plugins](/tools/plugin)

## Snabbstart (nybörjare)

1. Skapa ett dedikerat Twitch-konto för boten (eller använd ett befintligt konto).
2. Generera autentiseringsuppgifter: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Välj **Bot Token**
   - Verifiera att scopes `chat:read` och `chat:write` är valda
   - Kopiera **Client ID** och **Access Token**
3. Hitta ditt Twitch-användar-ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Konfigurera token:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (endast standardkonto)
   - Eller konfig: `channels.twitch.accessToken`
   - Om båda är satta har konfig företräde (env-reserv gäller endast standardkontot).
5. Starta gatewayen.

**⚠️ Viktigt:** Lägg till åtkomstkontroll (`allowFrom` eller `allowedRoles`) för att förhindra obehöriga användare från att utlösa boten. `requireMention` defaults to `true`.

Minimal konfig:

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

## Vad det är

- En Twitch-kanal som ägs av Gateway.
- Deterministisk routning: svar går alltid tillbaka till Twitch.
- Varje konto mappas till en isolerad sessionsnyckel `agent:<agentId>:twitch:<accountName>`.
- `username` är botens konto (som autentiserar), `channel` är vilken chatt som ska anslutas till.

## Konfigurering (detaljerad)

### Generera autentiseringsuppgifter

Använd [Twitch Token Generator](https://twitchtokengenerator.com/):

- Välj **Bot Token**
- Verifiera att scopes `chat:read` och `chat:write` är valda
- Kopiera **Client ID** och **Access Token**

Ingen manuell appregistrering behövs. Tokens löper ut efter flera timmar.

### Konfigurera boten

**Env-variabel (endast standardkonto):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Eller konfig:**

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

Om både env och konfig är satta har konfig företräde.

### Åtkomstkontroll (rekommenderas)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Föredrar `allowFrom` för en hård allowlista. Använd `allowedRoles` istället om du vill ha rollbaserad åtkomst.

**Tillgängliga roller:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Varför användar-ID:n?** Användarnamn kan ändras, vilket tillåter personifiering. Användar-ID är permanent.

Hitta ditt Twitch-användar-ID: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Konvertera ditt Twitch-användarnamn till ID)

## Tokenuppdatering (valfritt)

Tokens från [Twitch Token Generator](https://twitchtokengenerator.com/) kan inte uppdateras automatiskt – generera på nytt när de har löpt ut.

För automatisk tokenuppdatering, skapa din egen Twitch-applikation i [Twitch Developer Console](https://dev.twitch.tv/console) och lägg till i konfig:

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

Boten uppdaterar automatiskt tokens före utgång och loggar uppdateringshändelser.

## Stöd för flera konton

Använd `channels.twitch.accounts` med per-account tokens. Se [`gateway/configuration`](/gateway/configuration) för det delade mönstret.

Exempel (ett botkonto i två kanaler):

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

**Obs:** Varje konto behöver sin egen token (en token per kanal).

## Åtkomstkontroll

### Rollbaserade begränsningar

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

### Tillåtelselista per användar-ID (säkrast)

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

### Rollbaserad åtkomst (alternativ)

`allowFrom` är en hård allowlista. När den är inställd, är endast dessa användar-ID tillåtna.
Om du vill ha rollbaserad åtkomst, lämna `allowFrom` unset och konfigurera `allowedRoles` istället:

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

### Inaktivera krav på @-omnämnande

Som standard är `requireMention` `true`. Inaktivera och svara på alla meddelanden:

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

## Felsökning

Kör först diagnostiska kommandon:

```bash
openclaw doctor
openclaw channels status --probe
```

### Boten svarar inte på meddelanden

**Kontrollera åtkomstkontroll:** Säkerställ att ditt användar-ID finns i `allowFrom`, eller ta tillfälligt bort
`allowFrom` och sätt `allowedRoles: ["all"]` för att testa.

**Kontrollera att boten är i kanalen:** Boten måste ansluta till kanalen som anges i `channel`.

### Tokenproblem

**”Failed to connect” eller autentiseringsfel:**

- Verifiera att `accessToken` är OAuth-åtkomsttoken-värdet (börjar vanligtvis med prefixet `oauth:`)
- Kontrollera att token har scopes `chat:read` och `chat:write`
- Om tokenuppdatering används, verifiera att `clientSecret` och `refreshToken` är satta

### Tokenuppdatering fungerar inte

**Kontrollera loggarna för uppdateringshändelser:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Om du ser ”token refresh disabled (no refresh token)”:

- Säkerställ att `clientSecret` är angivet
- Säkerställ att `refreshToken` är angivet

## Konfig

**Kontokonfig:**

- `username` – Botens användarnamn
- `accessToken` – OAuth-åtkomsttoken med `chat:read` och `chat:write`
- `clientId` – Twitch Client ID (från Token Generator eller din app)
- `channel` – Kanal att ansluta till (krävs)
- `enabled` – Aktivera detta konto (standard: `true`)
- `clientSecret` – Valfritt: För automatisk tokenuppdatering
- `refreshToken` – Valfritt: För automatisk tokenuppdatering
- `expiresIn` – Tokenutgång i sekunder
- `obtainmentTimestamp` – Tidsstämpel när token erhölls
- `allowFrom` – Tillåtelselista för användar-ID
- `allowedRoles` – Rollbaserad åtkomstkontroll (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` – Kräv @-omnämnande (standard: `true`)

**Leverantörsalternativ:**

- `channels.twitch.enabled` – Aktivera/inaktivera kanalstart
- `channels.twitch.username` – Botens användarnamn (förenklad en-kontokonfig)
- `channels.twitch.accessToken` – OAuth-åtkomsttoken (förenklad en-kontokonfig)
- `channels.twitch.clientId` – Twitch Client ID (förenklad en-kontokonfig)
- `channels.twitch.channel` – Kanal att ansluta till (förenklad en-kontokonfig)
- `channels.twitch.accounts.<accountName>` - Multi-account config (alla kontofält ovan)

Fullständigt exempel:

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

## Verktygsåtgärder

Agenten kan anropa `twitch` med åtgärd:

- `send` – Skicka ett meddelande till en kanal

Exempel:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Säkerhet & drift

- **Behandla tokens som lösenord** – Lägg aldrig in tokens i git
- **Använd automatisk tokenuppdatering** för långvariga botar
- **Använd tillåtelselistor med användar-ID** i stället för användarnamn för åtkomstkontroll
- **Övervaka loggar** för tokenuppdateringshändelser och anslutningsstatus
- **Begränsa token-scope** – Begär endast `chat:read` och `chat:write`
- **Om du kör fast**: Starta om gatewayen efter att ha bekräftat att ingen annan process äger sessionen

## Begränsningar

- **500 tecken** per meddelande (auto-uppdelat vid ordgränser)
- Markdown tas bort före uppdelning
- Ingen hastighetsbegränsning (använder Twitchs inbyggda rate limits)
