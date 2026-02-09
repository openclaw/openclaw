---
summary: "Konpigurasyon at setup ng Twitch chat bot"
read_when:
  - Pagse-set up ng Twitch chat integration para sa OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Suporta sa Twitch chat sa pamamagitan ng koneksyong IRC. Kumokonekta ang OpenClaw bilang isang Twitch user (bot account) upang tumanggap at magpadala ng mga mensahe sa mga channel.

## Plugin required

Ipinapadala ang Twitch bilang isang plugin at hindi kasama sa core install.

I-install sa pamamagitan ng CLI (npm registry):

```bash
openclaw plugins install @openclaw/twitch
```

Local checkout (kapag tumatakbo mula sa isang git repo):

```bash
openclaw plugins install ./extensions/twitch
```

Mga detalye: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Gumawa ng hiwalay na Twitch account para sa bot (o gumamit ng umiiral na account).
2. Bumuo ng credentials: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Piliin ang **Bot Token**
   - Tiyaking napili ang mga scope na `chat:read` at `chat:write`
   - Kopyahin ang **Client ID** at **Access Token**
3. Hanapin ang iyong Twitch user ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. I-configure ang token:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (default account lamang)
   - O config: `channels.twitch.accessToken`
   - Kapag parehong naka-set, uunahin ang config (ang env fallback ay para lamang sa default account).
5. Simulan ang gateway.

**⚠️ Mahalaga:** Magdagdag ng access control (`allowFrom` o `allowedRoles`) upang maiwasan ang mga hindi awtorisadong user na mag-trigger ng bot. `requireMention` defaults to `true`.

Minimal na config:

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

## Ano ito

- Isang Twitch channel na pagmamay-ari ng Gateway.
- Deterministic routing: ang mga sagot ay palaging bumabalik sa Twitch.
- Ang bawat account ay naka-map sa isang hiwalay na session key na `agent:<agentId>:twitch:<accountName>`.
- Ang `username` ay ang account ng bot (na nag-a-authenticate), ang `channel` naman ay kung aling chat room ang sasalihan.

## Setup (detalyado)

### Bumuo ng credentials

Gamitin ang [Twitch Token Generator](https://twitchtokengenerator.com/):

- Piliin ang **Bot Token**
- Tiyaking napili ang mga scope na `chat:read` at `chat:write`
- Kopyahin ang **Client ID** at **Access Token**

Walang kinakailangang manu-manong app registration. Nag-e-expire ang mga token pagkalipas ng ilang oras.

### I-configure ang bot

**Env var (default account lamang):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**O config:**

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

Kung parehong naka-set ang env at config, uunahin ang config.

### Kontrol sa access (inirerekomenda)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Prefer `allowFrom` for a hard allowlist. Use `allowedRoles` instead if you want role-based access.

**Mga available na role:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Bakit user IDs?** Maaaring magbago ang mga username, na nagbibigay-daan sa panggagaya. User IDs are permanent.

Hanapin ang iyong Twitch user ID: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (I-convert ang iyong Twitch username sa ID)

## Token refresh (opsyonal)

Ang mga token mula sa [Twitch Token Generator](https://twitchtokengenerator.com/) ay hindi maaaring awtomatikong i-refresh — bumuo muli kapag nag-expire.

Para sa awtomatikong token refresh, gumawa ng sarili mong Twitch application sa [Twitch Developer Console](https://dev.twitch.tv/console) at idagdag sa config:

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

Awtomatikong nire-refresh ng bot ang mga token bago mag-expire at nagla-log ng mga refresh event.

## Suporta sa maraming account

Use `channels.twitch.accounts` with per-account tokens. See [`gateway/configuration`](/gateway/configuration) for the shared pattern.

Halimbawa (isang bot account sa dalawang channel):

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

**Tandaan:** Kailangan ng bawat account ng sarili nitong token (isang token bawat channel).

## Kontrol sa access

### Mga paghihigpit batay sa role

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

### Allowlist ayon sa User ID (pinaka-secure)

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

### Role-based access (alternatibo)

`allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
If you want role-based access, leave `allowFrom` unset and configure `allowedRoles` instead:

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

### I-disable ang @mention requirement

By default, `requireMention` is `true`. To disable and respond to all messages:

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

## Pag-troubleshoot

Una, patakbuhin ang mga diagnostic command:

```bash
openclaw doctor
openclaw channels status --probe
```

### Hindi tumutugon ang bot sa mga mensahe

**Suriin ang kontrol sa access:** Tiyaking ang iyong user ID ay nasa `allowFrom`, o pansamantalang alisin ang
`allowFrom` at i-set ang `allowedRoles: ["all"]` para mag-test.

**Tiyaking nasa channel ang bot:** Kailangang sumali ang bot sa channel na tinukoy sa `channel`.

### Mga isyu sa token

**"Failed to connect" o mga error sa authentication:**

- Tiyaking ang `accessToken` ay ang OAuth access token value (karaniwang nagsisimula sa prefix na `oauth:`)
- Suriin kung ang token ay may mga scope na `chat:read` at `chat:write`
- Kung gumagamit ng token refresh, tiyaking naka-set ang `clientSecret` at `refreshToken`

### Hindi gumagana ang token refresh

**Suriin ang logs para sa mga refresh event:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Kung makita mo ang "token refresh disabled (no refresh token)":

- Tiyaking ibinigay ang `clientSecret`
- Tiyaking ibinigay ang `refreshToken`

## Config

**Account config:**

- `username` - Username ng bot
- `accessToken` - OAuth access token na may `chat:read` at `chat:write`
- `clientId` - Twitch Client ID (mula sa Token Generator o sa sarili mong app)
- `channel` - Channel na sasalihan (kinakailangan)
- `enabled` - I-enable ang account na ito (default: `true`)
- `clientSecret` - Opsyonal: Para sa awtomatikong token refresh
- `refreshToken` - Opsyonal: Para sa awtomatikong token refresh
- `expiresIn` - Expiry ng token sa segundo
- `obtainmentTimestamp` - Timestamp kung kailan nakuha ang token
- `allowFrom` - Allowlist ng User ID
- `allowedRoles` - Role-based access control (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - I-require ang @mention (default: `true`)

**Mga opsyon ng provider:**

- `channels.twitch.enabled` - I-enable/i-disable ang startup ng channel
- `channels.twitch.username` - Username ng bot (pinadaling single-account config)
- `channels.twitch.accessToken` - OAuth access token (pinadaling single-account config)
- `channels.twitch.clientId` - Twitch Client ID (pinadaling single-account config)
- `channels.twitch.channel` - Channel na sasalihan (pinadaling single-account config)
- `channels.twitch.accounts.<accountName>` - Multi-account config (all account fields above)

Buong halimbawa:

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

## Tool actions

Maaaring tawagin ng agent ang `twitch` na may action:

- `send` - Magpadala ng mensahe sa isang channel

Halimbawa:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Safety & ops

- **Ituring ang mga token na parang password** - Huwag kailanman i-commit ang mga token sa git
- **Gumamit ng awtomatikong token refresh** para sa mga bot na tumatakbo nang matagal
- **Gumamit ng user ID allowlists** sa halip na mga username para sa kontrol sa access
- **I-monitor ang logs** para sa mga token refresh event at status ng koneksyon
- **Limitahan ang scope ng token** - Hilingin lamang ang `chat:read` at `chat:write`
- **Kung may problema**: I-restart ang gateway matapos kumpirmahing walang ibang process ang nagmamay-ari ng session

## Mga limitasyon

- **500 karakter** bawat mensahe (awtomatikong hina-hati sa word boundaries)
- Tinatanggal ang Markdown bago ang chunking
- Walang rate limiting (ginagamit ang built-in na rate limits ng Twitch)
