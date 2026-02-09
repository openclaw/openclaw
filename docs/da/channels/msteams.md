---
summary: "Microsoft Teams-bot supportstatus, funktioner og konfiguration"
read_when:
  - Arbejder med MS Teams-kanalfunktioner
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> "Opgiv alt håb, I som træder ind her."

Opdateret: 2026-01-21

Status: tekst + DM vedhæftede filer understøttes; kanal / gruppe fil afsendelse kræver `sharePointSiteId` + graf tilladelser (se [Sender filer i gruppe chats](#sending-files-in-group-chats)). Afstemninger sendes via Adaptive Cards.

## Plugin påkrævet

Microsoft Teams leveres som et plugin og er ikke bundlet med kerneinstallationen.

**Breaking change (2026.1.15):** MS Teams flyttet ud af kerne. Hvis du bruger det, skal du installere plugin.

Forklaring: holder kerneinstallationer lettere og lader MS Teams-afhængigheder opdatere uafhængigt.

Installér via CLI (npm registry):

```bash
openclaw plugins install @openclaw/msteams
```

Lokalt checkout (når der køres fra et git-repo):

```bash
openclaw plugins install ./extensions/msteams
```

Hvis du vælger Teams under konfigurering/introduktion, og et git-checkout registreres,
vil OpenClaw automatisk tilbyde den lokale installationssti.

Detaljer: [Plugins](/tools/plugin)

## Hurtig opsætning (begynder)

1. Installér Microsoft Teams-plugin’et.
2. Opret en **Azure Bot** (App ID + klienthemmelighed + tenant ID).
3. Konfigurér OpenClaw med disse legitimationsoplysninger.
4. Eksponér `/api/messages` (port 3978 som standard) via en offentlig URL eller tunnel.
5. Installér Teams-app-pakken og start gateway.

Minimal konfiguration:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Bemærk: gruppechats blokeres som standard (`channels.msteams.groupPolicy: "allowlist"`). For at tillade gruppe svar, angiv `channels.msteams.groupAllowFrom` (eller brug `groupPolicy: "open"` for at tillade ethvert medlem, mention-gated).

## Mål

- Tale med OpenClaw via Teams DMs, gruppechats eller kanaler.
- Holde routing deterministisk: svar går altid tilbage til den kanal, de kom fra.
- Standard til sikker kanaladfærd (mentions kræves, medmindre andet er konfigureret).

## Konfigurationsskrivninger

Som standard har Microsoft Teams tilladelse til at skrive konfigurationsopdateringer udløst af `/config set|unset` (kræver `commands.config: true`).

Deaktivér med:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Adgangskontrol (DMs + grupper)

**DM-adgang**

- Standard: `channels.msteams.dmPolicy = "pairing"`. Ukendte afsendere ignoreres indtil de godkendes.
- `channels.msteams.allowFrom` accepterer AAD objekt IDs, UPN'er, eller vise navne. Guiden løser navne til id'er via Microsoft Graph, når legitimationsoplysninger tillader.

**Gruppeadgang**

- Standard: `channels.msteams.groupPolicy = "allowlist"` (blokeret medmindre du tilføjer `groupAllowFrom`). Brug `channels.defaults.groupPolicy` for at tilsidesætte standarden, når den ikke er angivet.
- `channels.msteams.groupAllowFrom` styrer, hvilke afsendere der kan trigge i gruppechats/kanaler (falder tilbage til `channels.msteams.allowFrom`).
- Sæt `groupPolicy: "open"` for at tillade ethvert medlem (stadig mention‑gated som standard).
- For at tillade **ingen kanaler**, sæt `channels.msteams.groupPolicy: "disabled"`.

Eksempel:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + kanal tilladelsesliste**

- Afgræns gruppe-/kanalsvar ved at liste teams og kanaler under `channels.msteams.teams`.
- Nøgler kan være team-ID’er eller -navne; kanalnøgler kan være samtale-ID’er eller -navne.
- Når `groupPolicy="allowlist"` er sat, og der findes en teams-tilladelsesliste, accepteres kun de listede teams/kanaler (mention‑gated).
- Opsætningsguiden accepterer `Team/Channel`-poster og gemmer dem for dig.
- Ved opstart opløser OpenClaw team-/kanal- og brugertilladelseslistenavne til ID’er (når Graph-tilladelser tillader det)
  og logger mappingen; uløste poster bevares, som de er indtastet.

Eksempel:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Sådan virker det

1. Installér Microsoft Teams-plugin’et.
2. Opret en **Azure Bot** (App ID + hemmelighed + tenant ID).
3. Byg en **Teams-app-pakke**, der refererer til botten og inkluderer RSC-tilladelserne nedenfor.
4. Upload/installér Teams-appen i et team (eller personligt scope for DMs).
5. Konfigurér `msteams` i `~/.openclaw/openclaw.json` (eller miljøvariabler) og start gateway.
6. Gateway lytter efter Bot Framework webhook-trafik på `/api/messages` som standard.

## Azure Bot-opsætning (Forudsætninger)

Før du konfigurerer OpenClaw, skal du oprette en Azure Bot-ressource.

### Trin 1: Opret Azure Bot

1. Gå til [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Udfyld fanen **Basics**:

   | Felt               | Værdi                                                                   |
   | ------------------ | ----------------------------------------------------------------------- |
   | **Bot handle**     | Dit botnavn, fx `openclaw-msteams` (skal være unikt) |
   | **Subscription**   | Vælg dit Azure-abonnement                                               |
   | **Resource group** | Opret ny eller brug eksisterende                                        |
   | **Pricing tier**   | **Free** til dev/test                                                   |
   | **Type of App**    | **Single Tenant** (anbefalet – se note nedenfor)     |
   | **Creation type**  | **Create new Microsoft App ID**                                         |

> **Afskrivningsmeddelelse:** Oprettelse af nye multi-tenant bots blev forældet efter 2025-07-31. Brug **Enkelt Leje** til nye bots.

3. Klik **Review + create** → **Create** (vent ~1-2 minutter)

### Trin 2: Hent legitimationsoplysninger

1. Gå til din Azure Bot-ressource → **Configuration**
2. Kopiér **Microsoft App ID** → dette er din `appId`
3. Klik **Manage Password** → gå til App Registration
4. Under **Certificates & secrets** → **New client secret** → kopiér **Value** → dette er din `appPassword`
5. Gå til **Overview** → kopiér **Directory (tenant) ID** → dette er din `tenantId`

### Trin 3: Konfigurér Messaging Endpoint

1. I Azure Bot → **Configuration**
2. Sæt **Messaging endpoint** til din webhook-URL:
   - Produktion: `https://your-domain.com/api/messages`
   - Lokal dev: Brug en tunnel (se [Lokal udvikling](#local-development-tunneling) nedenfor)

### Trin 4: Aktivér Teams-kanal

1. I Azure Bot → **Channels**
2. Klik **Microsoft Teams** → Configure → Save
3. Acceptér Servicevilkårene

## Lokal udvikling (Tunneling)

Hold kan ikke nå `localhost`. Brug en tunnel til lokal udvikling:

**Mulighed A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Mulighed B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (Alternativ)

I stedet for manuelt at oprette en manifest-ZIP kan du bruge [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. Klik **+ New app**
2. Udfyld grundlæggende info (navn, beskrivelse, udviklerinformation)
3. Gå til **App features** → **Bot**
4. Vælg **Enter a bot ID manually** og indsæt dit Azure Bot App ID
5. Afkryds scopes: **Personal**, **Team**, **Group Chat**
6. Klik **Distribute** → **Download app package**
7. I Teams: **Apps** → **Manage your apps** → **Upload a custom app** → vælg ZIP’en

Dette er ofte nemmere end håndredigering af JSON-manifester.

## Test af botten

**Mulighed A: Azure Web Chat (verificér webhook først)**

1. I Azure Portal → din Azure Bot-ressource → **Test in Web Chat**
2. Send en besked – du bør se et svar
3. Dette bekræfter, at dit webhook-endpoint virker før Teams-opsætning

**Mulighed B: Teams (efter app-installation)**

1. Installér Teams-appen (sideload eller org-katalog)
2. Find botten i Teams og send en DM
3. Tjek gateway-logs for indkommende aktivitet

## Opsætning (minimal tekst-only)

1. **Installér Microsoft Teams-plugin’et**
   - Fra npm: `openclaw plugins install @openclaw/msteams`
   - Fra lokalt checkout: `openclaw plugins install ./extensions/msteams`

2. **Bot-registrering**
   - Opret en Azure Bot (se ovenfor) og notér:
     - App ID
     - Klienthemmelighed (App password)
     - Tenant ID (single-tenant)

3. **Teams app-manifest**
   - Inkludér en `bot`-post med `botId = <App ID>`.
   - Scopes: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (krævet for filhåndtering i personligt scope).
   - Tilføj RSC-tilladelser (nedenfor).
   - Opret ikoner: `outline.png` (32x32) og `color.png` (192x192).
   - Zip alle tre filer sammen: `manifest.json`, `outline.png`, `color.png`.

4. **Konfigurér OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   Du kan også bruge miljøvariabler i stedet for konfigurationsnøgler:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot-endpoint**
   - Sæt Azure Bot Messaging Endpoint til:
     - `https://<host>:3978/api/messages` (eller din valgte sti/port).

6. **Kør gateway**
   - Teams-kanalen starter automatisk, når plugin’et er installeret, og `msteams`-konfigurationen findes med legitimationsoplysninger.

## Historikkontekst

- `channels.msteams.historyLimit` styrer, hvor mange nylige kanal-/gruppebeskeder der pakkes ind i prompten.
- Falder tilbage til `messages.groupChat.historyLimit`. Sæt `0` til at deaktivere (standard 50).
- DM historie kan begrænses med `channels.msteams.dmHistoryLimit` (bruger drejninger). Per-user tilsidesættelser: `channels.msteams.dms["<user_id>"].historyLimit`.

## Aktuelle Teams RSC-tilladelser (Manifest)

Disse er de \*\* eksisterende ressourcespecifikke tilladelser\*\* i vores Teams app manifest. De gælder kun inde i teamet/chat, hvor appen er installeret.

**For kanaler (team-scope):**

- `ChannelMessage.Read.Group` (Application) – modtag alle kanalbeskeder uden @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**For gruppechats:**

- `ChatMessage.Read.Chat` (Application) – modtag alle gruppechat-beskeder uden @mention

## Eksempel på Teams-manifest (redigeret)

Minimal, gyldigt eksempel med de obligatoriske felter. Erstat ID'er og URL'er.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Manifest-forbehold (skal-have felter)

- `bots[].botId` **skal** matche Azure Bot App ID.
- `webApplicationInfo.id` **skal** matche Azure Bot App ID.
- `bots[].scopes` skal inkludere de overflader, du planlægger at bruge (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` er påkrævet for filhåndtering i personligt scope.
- `authorization.permissions.resourceSpecific` skal inkludere kanal læs/sendt, hvis du vil have kanaltrafik.

### Opdatering af en eksisterende app

For at opdatere en allerede installeret Teams-app (fx for at tilføje RSC-tilladelser):

1. Opdatér dit `manifest.json` med de nye indstillinger
2. **Forøg feltet `version`** (fx `1.0.0` → `1.1.0`)
3. **Zip igen** manifestet med ikoner (`manifest.json`, `outline.png`, `color.png`)
4. Upload den nye zip:
   - **Mulighed A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → find din app → Upload new version
   - **Mulighed B (Sideload):** I Teams → Apps → Manage your apps → Upload a custom app
5. **For teamkanaler:** Geninstallér appen i hvert team for at nye tilladelser træder i kraft
6. **Luk Teams helt og genstart** (ikke bare luk vinduet) for at rydde cachet app-metadata

## Funktioner: Kun RSC vs Graph

### Med **kun Teams RSC** (app installeret, ingen Graph API-tilladelser)

Virker:

- Læs kanalbesked **tekst**-indhold.
- Send kanalbesked **tekst**-indhold.
- Modtag **personlige (DM)** filvedhæftninger.

Virker IKKE:

- Kanal-/gruppe **billede- eller filindhold** (payload indeholder kun HTML-stub).
- Download af vedhæftninger gemt i SharePoint/OneDrive.
- Læsning af beskedhistorik (ud over live webhook-hændelsen).

### Med **Teams RSC + Microsoft Graph Application-tilladelser**

Tilføjer:

- Download af hostet indhold (billeder indsat i beskeder).
- Download af filvedhæftninger gemt i SharePoint/OneDrive.
- Læsning af kanal-/chatbeskedhistorik via Graph.

### RSC vs Graph API

| Funktion                   | RSC-tilladelser                     | Graph API                                       |
| -------------------------- | ----------------------------------- | ----------------------------------------------- |
| **Realtime-beskeder**      | Ja (via webhook) | Nej (kun polling)            |
| **Historiske beskeder**    | Nej                                 | Ja (kan forespørge historik) |
| **Opsætningskompleksitet** | Kun app-manifest                    | Kræver admin-samtykke + token-flow              |
| **Virker offline**         | Nej (skal køre)  | Ja (forespørg når som helst) |

**Bundlinje:** RSC er til realtidslytte; GrafAPI er for historisk adgang. For at indhente ubesvarede beskeder mens du er offline, skal du bruge Graph API med `ChannelMessage.Read.All` (kræver admin samtykke).

## Graph-aktiveret medier + historik (påkrævet for kanaler)

Hvis du har brug for billeder/filer i **kanaler** eller vil hente **beskedhistorik**, skal du aktivere Microsoft Graph-tilladelser og give admin-samtykke.

1. I Entra ID (Azure AD) **App Registration** skal du tilføje Microsoft Graph **Application permissions**:
   - `ChannelMessage.Read.All` (kanalvedhæftninger + historik)
   - `Chat.Read.All` eller `ChatMessage.Read.All` (gruppechats)
2. **Giv admin-samtykke** for tenant’en.
3. Forøg Teams-appens **manifestversion**, gen-upload, og **geninstallér appen i Teams**.
4. **Luk Teams helt og genstart** for at rydde cachet app-metadata.

## Kendte begrænsninger

### Webhook-timeouts

Teams leverer beskeder via HTTP webhook. Hvis behandlingen tager for lang tid (f.eks. langsom LLM svar), kan du se:

- Gateway-timeouts
- Teams forsøger igen (giver dubletter)
- Mistede svar

OpenClaw håndterer dette ved at returnere hurtigt og sende svar proaktivt, men meget langsomme svar kan stadig give problemer.

### Formatering

Teams markdown er mere begrænset end Slack eller Discord:

- Grundlæggende formatering virker: **fed**, _kursiv_, `code`, links
- Kompleks markdown (tabeller, indlejrede lister) renderer muligvis ikke korrekt
- Adaptive Cards understøttes til afstemninger og vilkårlige kort (se nedenfor)

## Konfiguration

Nøgleindstillinger (se `/gateway/configuration` for delte kanalmønstre):

- `channels.msteams.enabled`: aktivér/deaktivér kanalen.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: bot-legitimationsoplysninger.
- `channels.msteams.webhook.port` (standard `3978`)
- `channels.msteams.webhook.path` (standard `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (standard: pairing)
- `channels.msteams.allowFrom`: allowlist for DMs (AAD objekt IDs, UPNs, eller vise navne). Guiden løser navne til id'er under opsætning når graf- adgang er tilgængelig.
- `channels.msteams.textChunkLimit`: udgående tekst-chunkstørrelse.
- `channels.msteams.chunkMode`: `length` (standard) eller `newline` for at splitte på tomme linjer (afsnitsgrænser) før længde-chunking.
- `channels.msteams.mediaAllowHosts`: tilladelsesliste for indgående vedhæftningsværter (standard Microsoft/Teams-domæner).
- `channels.msteams.mediaAuthAllowHosts`: tilladelsesliste for vedhæftning af Authorization-headere ved mediegenforsøg (standard Graph + Bot Framework-værter).
- `channels.msteams.requireMention`: kræv @mention i kanaler/grupper (standard true).
- `channels.msteams.replyStyle`: `thread | top-level` (se [Svarstil](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: per-team override.
- `channels.msteams.teams.<teamId>.requireMention`: per-team tilsidesættelse.
- `channels.msteams.teams.<teamId>.tools`: standard overskrivning pr. hold værktøjspolitik (`allow`/`deny`/`alsoAllow`) bruges, når en kanal overskrivning mangler.
- `channels.msteams.teams.<teamId>.toolsBySender`: Standard per-team per-sender værktøj politik tilsidesættelser (`"*"` jokertegn understøttet).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: per-channel per-sender værktøj politik tilsidesættelser (`"*"` jokertegn understøttet).
- `channels.msteams.sharePointSiteId`: SharePoint site-ID til filuploads i gruppechats/kanaler (se [Afsendelse af filer i gruppechats](#sending-files-in-group-chats)).

## Routing & Sessioner

- Sessionsnøgler følger standard agentformat (se [/concepts/session](/concepts/session)):
  - Direkte beskeder deler hovedsessionen (`agent:<agentId>:<mainKey>`).
  - Kanal-/gruppebeskeder bruger samtale-id:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Svarstil: Tråde vs Indlæg

Teams har for nylig introduceret to kanal-UI-stile over den samme underliggende datamodel:

| Stil                                                       | Beskrivelse                                         | Anbefalet `replyStyle`                 |
| ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| **Indlæg** (klassisk)                   | Beskeder vises som kort med trådede svar nedenunder | `thread` (standard) |
| **Tråde** (Slack-lign.) | Beskeder flyder lineært, mere som Slack             | `top-level`                            |

**Problemet:** Teams API afslører ikke hvilken UI stil en kanal anvender. Hvis du bruger den forkerte `replyStyle`:

- `thread` i en Tråde-kanal → svar vises akavet indlejret
- `top-level` i en Indlæg-kanal → svar vises som separate top-level indlæg i stedet for i tråden

**Løsning:** Konfigurér `replyStyle` pr. kanal baseret på, hvordan kanalen er sat op:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Vedhæftninger & Billeder

**Nuværende begrænsninger:**

- **DMs:** Billeder og filvedhæftninger virker via Teams bot fil-API’er.
- **Kanaler/grupper:** Vedhæftede filer bor i M365 lagerplads (SharePoint/OneDrive). Den webhook nyttelast indeholder kun en HTML stub, ikke den faktiske fil bytes. **Graf API tilladelser er påkrævet** for at downloade kanal vedhæftede filer.

Uden graftilladelser, vil kanalbeskeder med billeder blive modtaget som kun tekst (billedet indhold er ikke tilgængeligt for bot).
Som standard downloader OpenClaw kun medier fra Microsoft / Teams værtsnavne. Tilsidesæt med `channels.msteams.mediaAllowHosts` (brug `["*"]` for at tillade enhver vært).
Authorization headers are only attached for host in `channels.msteams.mediaAuthAllowHosts` (defaults to Graph + Bot Framework hosts). Hold denne liste streng (undgå multi-lejer suffikser).

## Afsendelse af filer i gruppechats

Bots kan sende filer i DMs ved hjælp af FileConsentCard flow (indbygget). **Afsendelse af filer i gruppechats/kanaler** kræver dog yderligere opsætning:

| Kontekst                               | Hvordan filer sendes                               | Nødvendig opsætning                           |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| **DMs**                                | FileConsentCard → bruger accepterer → bot uploader | Virker out of the box                         |
| **Gruppechats/kanaler**                | Upload til SharePoint → delingslink                | Kræver `sharePointSiteId` + Graph-tilladelser |
| **Billeder (alle)** | Base64-kodet inline                                | Virker out of the box                         |

### Hvorfor gruppechats kræver SharePoint

Bots har ikke et personligt OneDrive drev (`/me/drive` Graph API endpoint virker ikke for applikationsidentiteter). For at sende filer i gruppechats/-kanaler uploader bot til et \*\* SharePoint site \*\* og opretter et delingslink.

### Opsætning

1. **Tilføj Graph API-tilladelser** i Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) – upload filer til SharePoint
   - `Chat.Read.All` (Application) – valgfri, aktiverer pr.-bruger delingslinks

2. **Giv admin-samtykke** for tenant’en.

3. **Hent dit SharePoint site-ID:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Konfigurér OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Delingsadfærd

| Tilladelse                              | Delingsadfærd                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Sites.ReadWrite.All` kun               | Organisationsdækkende delingslink (alle i org kan få adgang)             |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Pr.-bruger delingslink (kun chatmedlemmer kan få adgang) |

Per-bruger deling er mere sikker, da kun chatdeltagerne kan få adgang til filen. Hvis `Chat.Read.Alle` tilladelse mangler, falder botten tilbage til delingen i hele organisationen.

### Fallback-adfærd

| Scenarie                                           | Resultat                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Gruppechat + fil + `sharePointSiteId` konfigureret | Upload til SharePoint, send delingslink                               |
| Gruppechat + fil + ingen `sharePointSiteId`        | Forsøg OneDrive-upload (kan fejle), send kun tekst |
| Personlig chat + fil                               | FileConsentCard-flow (virker uden SharePoint)      |
| Enhver kontekst + billede                          | Base64-kodet inline (virker uden SharePoint)       |

### Placering af lagrede filer

Uploadede filer gemmes i en `/OpenClawShared/`-mappe i det konfigurerede SharePoint-sites standarddokumentbibliotek.

## Afstemninger (Adaptive Cards)

OpenClaw sender Teams-afstemninger som Adaptive Cards (der findes ikke en indbygget Teams poll-API).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Stemmer registreres af gateway i `~/.openclaw/msteams-polls.json`.
- Gateway skal forblive online for at registrere stemmer.
- Afstemninger auto-poster endnu ikke resultatsammendrag (inspicér lagerfilen om nødvendigt).

## Adaptive Cards (vilkårlige)

Send vilkårlig Adaptive Card JSON til Teams-brugere eller samtaler ved hjælp af `message`-værktøjet eller CLI.

Parameteren 'kort' accepterer et JSON-objekt med Adaptive kort. Når `kort` er leveret, er beskedteksten valgfri.

**Agent-værktøj:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

Se [Adaptive Cards documentation](https://adaptivecards.io/) for kortskema og eksempler. For detaljer i målformatet, se [Målformater](#target-formats) nedenfor.

## Target formats

MSTeams-mål bruger præfikser til at skelne mellem brugere og samtaler:

| Måltype                                | Format                           | Eksempel                                                                   |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| Bruger (efter ID)   | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                                |
| Bruger (efter navn) | `user:<display-name>`            | `user:John Smith` (kræver Graph API)                    |
| Gruppe/kanal                           | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                   |
| Gruppe/kanal (rå)   | `<conversation-id>`              | `19:abc123...@thread.tacv2` (hvis indeholder `@thread`) |

**CLI-eksempler:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Agent-værktøjseksempler:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Bemærk: Uden `brugeren:` præfiks, navne standard gruppe/team opløsning. Brug altid `user:` når du målretter folk efter visningsnavn.

## Proaktiv beskeder

- Proaktive beskeder er kun mulige **efter**, at en bruger har interageret, fordi vi gemmer samtalereferencer på det tidspunkt.
- Se `/gateway/configuration` for `dmPolicy` og tilladelsesliste-gating.

## Team- og Kanal-ID’er (Almindelig faldgrube)

Parameteren `groupId` forespørgsel i Teams URL'er er **NOT** team-ID'et, der bruges til konfiguration. Udtræk ID'er fra URL-stien i stedet:

**Team-URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**Kanal-URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Til konfiguration:**

- Team-ID = stisegmentet efter `/team/` (URL-dekodet, fx `19:Bk4j...@thread.tacv2`)
- Kanal-ID = stisegmentet efter `/channel/` (URL-dekodet)
- **Ignorér** query-parameteren `groupId`

## Private kanaler

Bots har begrænset support i private kanaler:

| Funktion                                       | Standardkanaler | Private kanaler                         |
| ---------------------------------------------- | --------------- | --------------------------------------- |
| Bot-installation                               | Ja              | Begrænset                               |
| Realtime-beskeder (webhook) | Ja              | Virker muligvis ikke                    |
| RSC-tilladelser                                | Ja              | Kan opføre sig anderledes               |
| @mentions                         | Ja              | Hvis botten er tilgængelig              |
| Graph API-historik                             | Ja              | Ja (med tilladelser) |

**Workarounds hvis private kanaler ikke virker:**

1. Brug standardkanaler til bot-interaktioner
2. Brug DMs – brugere kan altid skrive direkte til botten
3. Brug Graph API til historisk adgang (kræver `ChannelMessage.Read.All`)

## Fejlfinding

### Almindelige problemer

- **Billeder vises ikke i kanaler:** Graf tilladelser eller admin samtykke mangler. Geninstaller Teams-appen og afslut fuldt ud og genåbn Teams.
- **Ingen svar i kanal:** mentions kræves som standard; sæt `channels.msteams.requireMention=false` eller konfigurér pr. team/kanal.
- **Versionsmismatch (Teams viser stadig gammelt manifest):** fjern + tilføj appen igen og luk Teams helt for at opdatere.
- **401 Uautoriseret fra webhook:** Forventet ved test manuelt uden Azure JWT - betyder, at endepunktet er tilgængeligt, men auth mislykkedes. Brug Azure Web Chat til at teste korrekt.

### Manifest-uploadfejl

- **"Ikon fil kan ikke være tom":** Manifest referencer ikon filer, der er 0 bytes. Opret gyldige PNG-ikoner (32x32 for `omrids.png`, 192x192 for `color.png`).
- **"webApplicationInfo.Id allerede i brug":** Appen er stadig installeret i et andet team/chat. Find og afinstallere det først, eller vent 5-10 minutter til formering.
- **"Something went wrong" ved upload:** Upload i stedet via [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com), åbn browser DevTools (F12) → Network-fanen, og tjek response body for den faktiske fejl.
- **Sideload fejler:** Prøv "Upload an app to your org's app catalog" i stedet for "Upload a custom app" – dette omgår ofte sideload-begrænsninger.

### RSC-tilladelser virker ikke

1. Verificér at `webApplicationInfo.id` matcher din bots App ID nøjagtigt
2. Gen-upload appen og geninstallér i team/chat
3. Tjek om din org-admin har blokeret RSC-tilladelser
4. Bekræft, at du bruger det rigtige scope: `ChannelMessage.Read.Group` for teams, `ChatMessage.Read.Chat` for gruppechats

## Referencer

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) – Azure Bot-opsætningsguide
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) – opret/administrér Teams-apps
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (kanal/gruppe kræver Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
