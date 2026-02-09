---
summary: "Overzicht van de Feishu-bot, functies en configuratie"
read_when:
  - Je wilt een Feishu/Lark-bot verbinden
  - Je de Feishu-channel configureert
title: Feishu
---

# Feishu-bot

Feishu (Lark) is een teamchatplatform dat door bedrijven wordt gebruikt voor messaging en samenwerking. Deze plugin verbindt OpenClaw met een Feishu/Lark-bot via het WebSocket-eventabonnement van het platform, zodat berichten kunnen worden ontvangen zonder een publieke webhook-URL bloot te stellen.

---

## Vereiste plugin

Installeer de Feishu-plugin:

```bash
openclaw plugins install @openclaw/feishu
```

Lokale checkout (wanneer je vanuit een git-repo draait):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Snelle start

Er zijn twee manieren om het Feishu-kanaal toe te voegen:

### Methode 1: onboardingwizard (aanbevolen)

Als je OpenClaw net hebt geïnstalleerd, start de wizard:

```bash
openclaw onboard
```

De wizard begeleidt je bij:

1. Het aanmaken van een Feishu-app en het verzamelen van inloggegevens
2. Het configureren van app-inloggegevens in OpenClaw
3. Het starten van de Gateway

✅ **Na configuratie**, controleer de Gateway-status:

- `openclaw gateway status`
- `openclaw logs --follow`

### Methode 2: CLI-installatie

Als je de initiële installatie al hebt voltooid, voeg het kanaal toe via de CLI:

```bash
openclaw channels add
```

Kies **Feishu** en voer vervolgens de App ID en App Secret in.

✅ **Na configuratie**, beheer de Gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Stap 1: Een Feishu-app maken

### 1. Open het Feishu Open Platform

Ga naar [Feishu Open Platform](https://open.feishu.cn/app) en meld je aan.

Lark (globale) tenants moeten [https://open.larksuite.com/app](https://open.larksuite.com/app) gebruiken en `domain: "lark"` instellen in de Feishu-configuratie.

### 2. Maak een app aan

1. Klik op **Create enterprise app**
2. Vul de appnaam en -beschrijving in
3. Kies een app-icoon

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Kopieer inloggegevens

Kopieer vanuit **Credentials & Basic Info**:

- **App ID** (formaat: `cli_xxx`)
- **App Secret**

❗ **Belangrijk:** houd het App Secret privé.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Configureer rechten

Klik in **Permissions** op **Batch import** en plak:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Botfunctionaliteit inschakelen

In **App Capability** > **Bot**:

1. Schakel botfunctionaliteit in
2. Stel de botnaam in

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Eventabonnement configureren

⚠️ **Belangrijk:** zorg ervoor dat vóór het instellen van het eventabonnement:

1. Je `openclaw channels add` voor Feishu al hebt uitgevoerd
2. De Gateway draait (`openclaw gateway status`)

In **Event Subscription**:

1. Kies **Use long connection to receive events** (WebSocket)
2. Voeg het event toe: `im.message.receive_v1`

⚠️ Als de Gateway niet draait, kan het opslaan van de long-connection-instelling mislukken.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Publiceer de app

1. Maak een versie aan in **Version Management & Release**
2. Dien deze in ter beoordeling en publiceer
3. Wacht op goedkeuring door een beheerder (enterprise-apps worden meestal automatisch goedgekeurd)

---

## Stap 2: OpenClaw configureren

### Configureren met de wizard (aanbevolen)

```bash
openclaw channels add
```

Kies **Feishu** en plak je App ID en App Secret.

### Configureren via het configbestand

Bewerk `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Configureren via omgevingsvariabelen

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (globaal) domein

Als je tenant op Lark (internationaal) zit, stel het domein in op `lark` (of een volledige domeinstring). Je kunt dit instellen op `channels.feishu.domain` of per account (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Stap 3: Starten + testen

### 1. Start de Gateway

```bash
openclaw gateway
```

### 2. Stuur een testbericht

Zoek in Feishu je bot en stuur een bericht.

### 3. Koppeling goedkeuren

Standaard antwoordt de bot met een koppelingscode. Keur deze goed:

```bash
openclaw pairing approve feishu <CODE>
```

Na goedkeuring kun je normaal chatten.

---

## Overzicht

- **Feishu-botkanaal**: Feishu-bot beheerd door de Gateway
- **Deterministische routering**: antwoorden keren altijd terug naar Feishu
- **Sessiescheiding**: DM's delen één hoofdsessie; groepen zijn geïsoleerd
- **WebSocket-verbinding**: long connection via de Feishu-SDK, geen publieke URL nodig

---

## Toegangs beheer

### Directe berichten

- **Standaard**: `dmPolicy: "pairing"` (onbekende gebruikers krijgen een koppelingscode)

- **Koppeling goedkeuren**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Toegestane-lijstmodus**: stel `channels.feishu.allowFrom` in met toegestane Open ID's

### Groep chats

**1. Groepsbeleid** (`channels.feishu.groupPolicy`):

- `"open"` = iedereen in groepen toestaan (standaard)
- `"allowlist"` = alleen `groupAllowFrom` toestaan
- `"disabled"` = groepsberichten uitschakelen

**2. Vermeldingsvereiste** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @vermelding vereist (standaard)
- `false` = antwoorden zonder vermeldingen

---

## Voorbeelden van groepsconfiguratie

### Alle groepen toestaan, @vermelding vereist (standaard)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Alle groepen toestaan, geen @vermelding vereist

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Alleen specifieke gebruikers in groepen toestaan

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Groeps-/gebruikers-ID's ophalen

### Groeps-ID's (chat_id)

Groeps-ID's zien eruit als `oc_xxx`.

**Methode 1 (aanbevolen)**

1. Start de Gateway en @vermeld de bot in de groep
2. Voer `openclaw logs --follow` uit en zoek naar `chat_id`

**Methode 2**

Gebruik de Feishu API-debugger om groepschats op te sommen.

### Gebruikers-ID's (open_id)

Gebruikers-ID's zien eruit als `ou_xxx`.

**Methode 1 (aanbevolen)**

1. Start de Gateway en stuur de bot een DM
2. Voer `openclaw logs --follow` uit en zoek naar `open_id`

**Methode 2**

Controleer koppelingsverzoeken voor Open ID's van gebruikers:

```bash
openclaw pairing list feishu
```

---

## Veelgebruikte opdrachten

| Opdracht  | Beschrijving         |
| --------- | -------------------- |
| `/status` | Botstatus tonen      |
| `/reset`  | De sessie resetten   |
| `/model`  | Model tonen/wisselen |

> Let op: Feishu ondersteunt nog geen native opdrachtmenu's, dus opdrachten moeten als tekst worden verzonden.

## Gateway-beheeropdrachten

| Opdracht                   | Beschrijving                        |
| -------------------------- | ----------------------------------- |
| `openclaw gateway status`  | Gateway-status tonen                |
| `openclaw gateway install` | Gateway-service installeren/starten |
| `openclaw gateway stop`    | Gateway-service stoppen             |
| `openclaw gateway restart` | Gateway-service herstarten          |
| `openclaw logs --follow`   | Gateway-logs volgen                 |

---

## Problemen oplossen

### Bot reageert niet in groepschats

1. Zorg ervoor dat de bot aan de groep is toegevoegd
2. Zorg ervoor dat je de bot @vermeldt (standaardgedrag)
3. Controleer dat `groupPolicy` niet is ingesteld op `"disabled"`
4. Controleer de logs: `openclaw logs --follow`

### Bot ontvangt geen berichten

1. Zorg ervoor dat de app is gepubliceerd en goedgekeurd
2. Zorg ervoor dat het eventabonnement `im.message.receive_v1` bevat
3. Zorg ervoor dat **long connection** is ingeschakeld
4. Zorg ervoor dat de app-rechten volledig zijn
5. Zorg ervoor dat de Gateway draait: `openclaw gateway status`
6. Controleer de logs: `openclaw logs --follow`

### App Secret gelekt

1. Reset het App Secret in Feishu Open Platform
2. Werk het App Secret bij in je configuratie
3. Herstart de Gateway

### Verzendfouten bij berichten

1. Zorg ervoor dat de app de `im:message:send_as_bot`-rechten heeft
2. Zorg ervoor dat de app is gepubliceerd
3. Controleer de logs voor gedetailleerde fouten

---

## Geavanceerde configuratie

### Meerdere accounts

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Limiet bericht

- `textChunkLimit`: uitgaande tekstblokgrootte (standaard: 2000 tekens)
- `mediaMaxMb`: upload-/downloadlimiet voor media (standaard: 30 MB)

### Streaming

Feishu ondersteunt streamingantwoorden via interactieve kaarten. Wanneer ingeschakeld, werkt de bot een kaart bij terwijl hij tekst genereert.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Stel `streaming: false` in om te wachten op het volledige antwoord voordat het wordt verzonden.

### Multi-agentroutering

Gebruik `bindings` om Feishu-DM's of -groepen naar verschillende agents te routeren.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Routeringsvelden:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` of `"group"`
- `match.peer.id`: Open ID van gebruiker (`ou_xxx`) of groeps-ID (`oc_xxx`)

Zie [Groeps-/gebruikers-ID's ophalen](#get-groupuser-ids) voor tips om deze op te zoeken.

---

## Configuratie referentie

Volledige configuratie: [Gateway-configuratie](/gateway/configuration)

Belangrijke opties:

| Instelling                                        | Beschrijving                                                                | Standaard |
| ------------------------------------------------- | --------------------------------------------------------------------------- | --------- |
| `channels.feishu.enabled`                         | Kanaal in-/uitschakelen                                                     | `true`    |
| `channels.feishu.domain`                          | API-domein (`feishu` of `lark`)                          | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                                                      | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                                                  | -         |
| `channels.feishu.accounts.<id>.domain`            | Per-account API-domeinoverschrijving                                        | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM-beleid                                                                   | `pairing` |
| `channels.feishu.allowFrom`                       | DM-toegestane lijst (open_id-lijst) | -         |
| `channels.feishu.groupPolicy`                     | Groepsbeleid                                                                | `open`    |
| `channels.feishu.groupAllowFrom`                  | Groepstoegestane lijst                                                      | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | @vermelding vereist                                            | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | Groep inschakelen                                                           | `true`    |
| `channels.feishu.textChunkLimit`                  | Berichtblokgrootte                                                          | `2000`    |
| `channels.feishu.mediaMaxMb`                      | Medialimiet                                                                 | `30`      |
| `channels.feishu.streaming`                       | Streamingkaart-uitvoer inschakelen                                          | `true`    |
| `channels.feishu.blockStreaming`                  | Blokstreaming inschakelen                                                   | `true`    |

---

## dmPolicy-referentie

| Waarde        | Gedrag                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `"pairing"`   | **Standaard.** Onbekende gebruikers krijgen een koppelingscode; moeten worden goedgekeurd |
| `"allowlist"` | Alleen gebruikers in `allowFrom` kunnen chatten                                                           |
| `"open"`      | Alle gebruikers toestaan (vereist `"*"` in allowFrom)                                  |
| `"disabled"`  | DM's uitschakelen                                                                                         |

---

## Ondersteunde berichttypen

### Ontvangen

- ✅ Tekst
- ✅ Rijke tekst (post)
- ✅ Afbeeldingen
- ✅ Bestanden
- ✅ Audio
- ✅ Video
- ✅ Stickers

### Verzenden

- ✅ Tekst
- ✅ Afbeeldingen
- ✅ Bestanden
- ✅ Audio
- ⚠️ Rijke tekst (gedeeltelijke ondersteuning)
