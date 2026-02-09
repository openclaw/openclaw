---
summary: "Configuratie en installatie van een Twitch-chatbot"
read_when:
  - Twitch-chatintegratie instellen voor OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Twitch-chatondersteuning via een IRC-verbinding. OpenClaw verbindt als een Twitch-gebruiker (botaccount) om berichten in kanalen te ontvangen en te verzenden.

## Plugin vereist

Twitch wordt geleverd als plugin en is niet gebundeld met de core-installatie.

Installeren via CLI (npm‑registry):

```bash
openclaw plugins install @openclaw/twitch
```

Lokale checkout (bij uitvoeren vanuit een git-repo):

```bash
openclaw plugins install ./extensions/twitch
```

Details: [Plugins](/tools/plugin)

## Snelle installatie (beginner)

1. Maak een speciaal Twitch-account aan voor de bot (of gebruik een bestaand account).
2. Genereer inloggegevens: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Selecteer **Bot Token**
   - Controleer dat de scopes `chat:read` en `chat:write` zijn geselecteerd
   - Kopieer de **Client ID** en **Access Token**
3. Vind je Twitch-gebruikers-ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Configureer het token:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (alleen standaardaccount)
   - Of config: `channels.twitch.accessToken`
   - Als beide zijn ingesteld, heeft config voorrang (env-terugval is alleen voor het standaardaccount).
5. Start de Gateway.

**⚠️ Belangrijk:** Voeg toegangsbeheer toe (`allowFrom` of `allowedRoles`) om te voorkomen dat onbevoegde gebruikers de bot activeren. `requireMention` staat standaard op `true`.

Minimale config:

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

## Wat het is

- Een Twitch-kanaal dat eigendom is van de Gateway.
- Deterministische routering: antwoorden gaan altijd terug naar Twitch.
- Elk account wordt gekoppeld aan een geïsoleerde sessiesleutel `agent:<agentId>:twitch:<accountName>`.
- `username` is het account van de bot (dat authenticatie uitvoert), `channel` is welke chatroom wordt betreden.

## Installatie (gedetailleerd)

### Aanmeldgegevens genereren

Gebruik [Twitch Token Generator](https://twitchtokengenerator.com/):

- Selecteer **Bot Token**
- Controleer dat de scopes `chat:read` en `chat:write` zijn geselecteerd
- Kopieer de **Client ID** en **Access Token**

Geen handmatige app-registratie nodig. Tokens verlopen na enkele uren.

### De bot configureren

**Env-var (alleen standaardaccount):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Of config:**

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

Als zowel env als config zijn ingesteld, heeft config voorrang.

### Toegangsbeheer (aanbevolen)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Geef de voorkeur aan `allowFrom` voor een harde toegestane lijst. Gebruik `allowedRoles` als je rolgebaseerde toegang wilt.

**Beschikbare rollen:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Waarom gebruikers-ID’s?** Gebruikersnamen kunnen veranderen, wat impersonatie mogelijk maakt. Gebruikers-ID’s zijn permanent.

Vind je Twitch-gebruikers-ID: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Converteer je Twitch-gebruikersnaam naar een ID)

## Tokenvernieuwing (optioneel)

Tokens van [Twitch Token Generator](https://twitchtokengenerator.com/) kunnen niet automatisch worden vernieuwd — genereer ze opnieuw wanneer ze verlopen.

Voor automatische tokenvernieuwing maak je je eigen Twitch-app aan in de [Twitch Developer Console](https://dev.twitch.tv/console) en voeg je deze toe aan de config:

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

De bot vernieuwt tokens automatisch vóór expiratie en logt vernieuwingsgebeurtenissen.

## Ondersteuning voor meerdere accounts

Gebruik `channels.twitch.accounts` met tokens per account. Zie [`gateway/configuration`](/gateway/configuration) voor het gedeelde patroon.

Voorbeeld (één botaccount in twee kanalen):

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

**Let op:** Elk account heeft zijn eigen token nodig (één token per kanaal).

## Toegangs beheer

### Rolgebaseerde beperkingen

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

### Toegestane lijst op gebruikers-ID (meest veilig)

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

### Rolgebaseerde toegang (alternatief)

`allowFrom` is een harde toegestane lijst. Wanneer ingesteld, zijn alleen die gebruikers-ID’s toegestaan.
Als je rolgebaseerde toegang wilt, laat `allowFrom` leeg en configureer `allowedRoles` in plaats daarvan:

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

### @mention-verplichting uitschakelen

Standaard is `requireMention` ingesteld op `true`. Om dit uit te schakelen en op alle berichten te reageren:

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

## Problemen oplossen

Voer eerst diagnostische opdrachten uit:

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot reageert niet op berichten

**Controleer toegangsbeheer:** Zorg dat je gebruikers-ID in `allowFrom` staat, of verwijder tijdelijk
`allowFrom` en stel `allowedRoles: ["all"]` in om te testen.

**Controleer of de bot in het kanaal is:** De bot moet het kanaal betreden dat is opgegeven in `channel`.

### Tokenproblemen

**“Failed to connect” of authenticatiefouten:**

- Controleer dat `accessToken` de OAuth-access-tokenwaarde is (begint meestal met het voorvoegsel `oauth:`)
- Controleer dat het token de scopes `chat:read` en `chat:write` heeft
- Als tokenvernieuwing wordt gebruikt, controleer dat `clientSecret` en `refreshToken` zijn ingesteld

### Tokenvernieuwing werkt niet

**Controleer logs op vernieuwingsgebeurtenissen:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Als je “token refresh disabled (no refresh token)” ziet:

- Zorg dat `clientSecret` is opgegeven
- Zorg dat `refreshToken` is opgegeven

## Config

**Accountconfig:**

- `username` - Botgebruikersnaam
- `accessToken` - OAuth-access-token met `chat:read` en `chat:write`
- `clientId` - Twitch Client ID (van Token Generator of je app)
- `channel` - Kanaal om te betreden (vereist)
- `enabled` - Dit account inschakelen (standaard: `true`)
- `clientSecret` - Optioneel: voor automatische tokenvernieuwing
- `refreshToken` - Optioneel: voor automatische tokenvernieuwing
- `expiresIn` - Tokenverval in seconden
- `obtainmentTimestamp` - Tijdstip waarop het token is verkregen
- `allowFrom` - Toegestane lijst van gebruikers-ID’s
- `allowedRoles` - Rolgebaseerd toegangsbeheer (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - @mention vereist (standaard: `true`)

**Provideropties:**

- `channels.twitch.enabled` - Starten van kanaal in-/uitschakelen
- `channels.twitch.username` - Botgebruikersnaam (vereenvoudigde single-accountconfig)
- `channels.twitch.accessToken` - OAuth-access-token (vereenvoudigde single-accountconfig)
- `channels.twitch.clientId` - Twitch Client ID (vereenvoudigde single-accountconfig)
- `channels.twitch.channel` - Kanaal om te betreden (vereenvoudigde single-accountconfig)
- `channels.twitch.accounts.<accountName>` - Multi-accountconfig (alle bovenstaande accountvelden)

Volledig voorbeeld:

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

## Toolacties

De agent kan `twitch` aanroepen met actie:

- `send` - Een bericht naar een kanaal sturen

Voorbeeld:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Veiligheid & operations

- **Behandel tokens als wachtwoorden** — commit tokens nooit naar git
- **Gebruik automatische tokenvernieuwing** voor langlopende bots
- **Gebruik toegestane lijsten op gebruikers-ID** in plaats van gebruikersnamen voor toegangsbeheer
- **Monitor logs** op tokenvernieuwingsgebeurtenissen en verbindingsstatus
- **Beperk scopes minimaal** — vraag alleen `chat:read` en `chat:write` aan
- **Als je vastloopt**: Herstart de Gateway nadat je hebt bevestigd dat geen ander proces de sessie bezit

## Beperkingen

- **500 tekens** per bericht (automatisch opgeknipt op woordgrenzen)
- Markdown wordt verwijderd vóór het opknippen
- Geen rate limiting (maakt gebruik van de ingebouwde rate limits van Twitch)
