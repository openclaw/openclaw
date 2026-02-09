---
summary: "Stödstatus, funktioner och konfiguration för Microsoft Teams-bot"
read_when:
  - Arbetar med MS Teams-kanalfunktioner
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> ”Övergiv allt hopp, ni som träder in här.”

Uppdaterad: 2026-01-21

Status: text + DM bilagor stöds; kanal/grupp filsändning kräver `sharePointSiteId` + Grafiska behörigheter (se [Skickar filer i gruppchatt](#sending-files-in-group-chats)). Undersökningar skickas via Adaptive Cards.

## Plugin krävs

Microsoft Teams levereras som ett plugin och ingår inte i kärninstallationen.

**Breaking change (2026.1.15):** MS Teams flyttade ut ur kärnan. Om du använder den måste du installera plugin.

Förklaring: håller kärninstallationer lättare och låter MS Teams-beroenden uppdateras oberoende.

Installera via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/msteams
```

Lokal utcheckning (när du kör från ett git-repo):

```bash
openclaw plugins install ./extensions/msteams
```

Om du väljer Teams under konfigurering/introduktion och en git-utcheckning upptäcks,
erbjuder OpenClaw automatiskt den lokala installationssökvägen.

Detaljer: [Plugins](/tools/plugin)

## Snabbstart (nybörjare)

1. Installera Microsoft Teams-pluginet.
2. Skapa en **Azure Bot** (App ID + klienthemlighet + tenant-ID).
3. Konfigurera OpenClaw med dessa uppgifter.
4. Exponera `/api/messages` (port 3978 som standard) via en publik URL eller tunnel.
5. Installera Teams-appaketet och starta gatewayn.

Minimal konfig:

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

Obs: gruppchattar blockeras som standard (`channels.msteams.groupPolicy: "allowlist"`). För att tillåta gruppsvar, ange `channels.msteams.groupAllowFrom` (eller använd `groupPolicy: "open"` för att tillåta någon medlem, nämn-gated).

## Mål

- Prata med OpenClaw via Teams-DM:er, gruppchattar eller kanaler.
- Håll routning deterministisk: svar går alltid tillbaka till kanalen de kom från.
- Standard till säkert kanalbeteende (omnämnanden krävs om inget annat konfigureras).

## Konfigskrivningar

Som standard får Microsoft Teams skriva konfiguppdateringar som triggas av `/config set|unset` (kräver `commands.config: true`).

Inaktivera med:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Åtkomstkontroll (DM:er + grupper)

**DM-åtkomst**

- Standard: `channels.msteams.dmPolicy = "pairing"`. Okända avsändare ignoreras tills de är godkända.
- `channels.msteams.allowFrom` accepterar AAD objekt-ID, UPNs eller visningsnamn. Guiden löser namn till ID via Microsoft Graph när referenser tillåter.

**Gruppåtkomst**

- Standard: `channels.msteams.groupPolicy = "allowlist"` (blockerad såvida du inte lägger till `groupAllowFrom`). Använd `channels.defaults.groupPolicy` för att åsidosätta standard när du inaktiverar.
- `channels.msteams.groupAllowFrom` styr vilka avsändare som kan trigga i gruppchattar/kanaler (faller tillbaka till `channels.msteams.allowFrom`).
- Sätt `groupPolicy: "open"` för att tillåta alla medlemmar (fortfarande omnämnandestyrt som standard).
- För att tillåta **inga kanaler**, sätt `channels.msteams.groupPolicy: "disabled"`.

Exempel:

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

**Teams + kanal-tillåtelselista**

- Avgränsa grupp-/kanalsvar genom att lista team och kanaler under `channels.msteams.teams`.
- Nycklar kan vara team-ID:n eller namn; kanalnycklar kan vara konversations-ID:n eller namn.
- När `groupPolicy="allowlist"` och en team-tillåtelselista finns, accepteras endast listade team/kanaler (omnämnandestyrt).
- Konfigureringsguiden accepterar `Team/Channel`-poster och lagrar dem åt dig.
- Vid uppstart löser OpenClaw namn i team-/kanal- och användartillåtelselistor till ID:n (när Graph-behörigheter tillåter)
  och loggar mappningen; olösta poster behålls som de är skrivna.

Exempel:

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

## Hur det fungerar

1. Installera Microsoft Teams-pluginet.
2. Skapa en **Azure Bot** (App ID + hemlighet + tenant-ID).
3. Bygg ett **Teams-appaket** som refererar till boten och inkluderar RSC-behörigheterna nedan.
4. Ladda upp/installera Teams-appen i ett team (eller personligt scope för DM:er).
5. Konfigurera `msteams` i `~/.openclaw/openclaw.json` (eller miljövariabler) och starta gatewayn.
6. Gatewayn lyssnar efter Bot Framework-webhooktrafik på `/api/messages` som standard.

## Azure Bot-konfigurering (Förutsättningar)

Innan du konfigurerar OpenClaw behöver du skapa en Azure Bot-resurs.

### Steg 1: Skapa Azure Bot

1. Gå till [Skapa Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Fyll i fliken **Basics**:

   | Fält               | Värde                                                                                                         |
   | ------------------ | ------------------------------------------------------------------------------------------------------------- |
   | **Bot handle**     | Ditt bot namn, t.ex., `openclaw-msteams` (måste vara unik) |
   | **Subscription**   | Välj din Azure-prenumeration                                                                                  |
   | **Resource group** | Skapa ny eller använd befintlig                                                                               |
   | **Pricing tier**   | **Free** för utveckling/test                                                                                  |
   | **Type of App**    | **Single Tenant** (rekommenderas – se noten nedan)                                         |
   | **Creation type**  | **Create new Microsoft App ID**                                                                               |

> **Avskrivningsanmälan:** Skapandet av nya flerhyresgäster försågs efter 2025-07-31. Använd **Enstaka hyresgäst** för nya botar.

3. Klicka **Review + create** → **Create** (vänta ~1–2 minuter)

### Steg 2: Hämta uppgifter

1. Gå till din Azure Bot-resurs → **Configuration**
2. Kopiera **Microsoft App ID** → detta är ditt `appId`
3. Klicka **Manage Password** → gå till App Registration
4. Under **Certificates & secrets** → **New client secret** → kopiera **Value** → detta är ditt `appPassword`
5. Gå till **Overview** → kopiera **Directory (tenant) ID** → detta är ditt `tenantId`

### Steg 3: Konfigurera Messaging Endpoint

1. I Azure Bot → **Configuration**
2. Sätt **Messaging endpoint** till din webhook-URL:
   - Produktion: `https://your-domain.com/api/messages`
   - Lokal utveckling: använd en tunnel (se [Lokal utveckling](#lokal-utveckling-tunneling) nedan)

### Steg 4: Aktivera Teams-kanalen

1. I Azure Bot → **Channels**
2. Klicka **Microsoft Teams** → Configure → Save
3. Acceptera användarvillkoren

## Lokal utveckling (Tunneling)

Lagen kan inte nå `localhost`. Använd en tunnel för lokal utveckling:

**Alternativ A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Alternativ B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (Alternativ)

I stället för att manuellt skapa ett manifest-ZIP kan du använda [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. Klicka **+ New app**
2. Fyll i grundinfo (namn, beskrivning, utvecklarinfo)
3. Gå till **App features** → **Bot**
4. Välj **Enter a bot ID manually** och klistra in ditt Azure Bot App ID
5. Markera scopes: **Personal**, **Team**, **Group Chat**
6. Klicka **Distribute** → **Download app package**
7. I Teams: **Apps** → **Manage your apps** → **Upload a custom app** → välj ZIP-filen

Detta är ofta enklare än att handredigera JSON-manifest.

## Testa boten

**Alternativ A: Azure Web Chat (verifiera webhook först)**

1. I Azure Portal → din Azure Bot-resurs → **Test in Web Chat**
2. Skicka ett meddelande – du bör se ett svar
3. Detta bekräftar att din webhook-endpoint fungerar innan Teams-konfiguration

**Alternativ B: Teams (efter appinstallation)**

1. Installera Teams-appen (sideload eller organisationskatalog)
2. Hitta boten i Teams och skicka ett DM
3. Kontrollera gateway-loggar för inkommande aktivitet

## Konfigurering (minimal, endast text)

1. **Installera Microsoft Teams-pluginet**
   - Från npm: `openclaw plugins install @openclaw/msteams`
   - Från lokal utcheckning: `openclaw plugins install ./extensions/msteams`

2. **Botregistrering**
   - Skapa en Azure Bot (se ovan) och notera:
     - App ID
     - Klienthemlighet (App-lösenord)
     - Tenant-ID (single-tenant)

3. **Teams-appmanifest**
   - Inkludera en `bot`-post med `botId = <App ID>`.
   - Scopes: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (krävs för filhantering i personligt scope).
   - Lägg till RSC-behörigheter (nedan).
   - Skapa ikoner: `outline.png` (32x32) och `color.png` (192x192).
   - Zippa alla tre filer tillsammans: `manifest.json`, `outline.png`, `color.png`.

4. **Konfigurera OpenClaw**

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

   Du kan också använda miljövariabler i stället för konfignycklar:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot-endpoint**
   - Sätt Azure Bot Messaging Endpoint till:
     - `https://<host>:3978/api/messages` (eller vald sökväg/port).

6. **Kör gatewayn**
   - Teams-kanalen startar automatiskt när pluginet är installerat och `msteams`-konfig finns med uppgifter.

## Historikkontext

- `channels.msteams.historyLimit` styr hur många senaste kanal-/gruppmeddelanden som paketeras i prompten.
- Faller tillbaka till `messages.groupChat.historyLimit`. Sätt `0` till att inaktivera (standard 50).
- DM historia kan begränsas med `channels.msteams.dmHistoryLimit` (användarvändar). Åsidosättningar per användare: `channels.msteams.dms["<user_id>"].historyLimit`.

## Aktuella Teams RSC-behörigheter (Manifest)

Dessa är **befintliga resursSpecifika behörigheter** i vårt Teams app-manifest. De gäller bara inne i teamet/chatten där appen är installerad.

**För kanaler (team-scope):**

- `ChannelMessage.Read.Group` (Application) – ta emot alla kanalmeddelanden utan @omnämnande
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**För gruppchattar:**

- `ChatMessage.Read.Chat` (Application) – ta emot alla gruppchattmeddelanden utan @omnämnande

## Exempel på Teams-manifest (redigerat)

Minimal, giltigt exempel med obligatoriska fält. Ersätt ID och webbadresser.

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

### Manifest-varningar (måste-ha-fält)

- `bots[].botId` **måste** matcha Azure Bot App ID.
- `webApplicationInfo.id` **måste** matcha Azure Bot App ID.
- `bots[].scopes` måste inkludera ytorna du planerar att använda (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` krävs för filhantering i personligt scope.
- `authorization.permissions.resourceSpecific` måste inkludera kanal-läs/skicka om du vill ha kanaltrafik.

### Uppdatera en befintlig app

För att uppdatera en redan installerad Teams-app (t.ex. för att lägga till RSC-behörigheter):

1. Uppdatera ditt `manifest.json` med de nya inställningarna
2. **Öka `version`-fältet** (t.ex., `1.0.0` → `1.1.0`)
3. **Zippa om** manifestet med ikoner (`manifest.json`, `outline.png`, `color.png`)
4. Ladda upp den nya zip-filen:
   - **Alternativ A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → hitta din app → Upload new version
   - **Alternativ B (Sideload):** I Teams → Apps → Manage your apps → Upload a custom app
5. **För teamkanaler:** Installera om appen i varje team för att nya behörigheter ska gälla
6. **Avsluta Teams helt och starta om** (inte bara stäng fönstret) för att rensa cachead appmetadata

## Förmågor: endast RSC vs Graph

### Med **endast Teams RSC** (app installerad, inga Graph API-behörigheter)

Fungerar:

- Läsa kanalmeddelandens **text**.
- Skicka kanalmeddelandens **text**.
- Ta emot **personliga (DM)** filbilagor.

Fungerar INTE:

- Kanal-/gruppers **bild- eller filinnehåll** (payloaden innehåller endast HTML-stub).
- Nedladdning av bilagor lagrade i SharePoint/OneDrive.
- Läsa meddelandehistorik (utöver den live webhook-händelsen).

### Med **Teams RSC + Microsoft Graph Application-behörigheter**

Tillkommer:

- Nedladdning av hostat innehåll (bilder inklistrade i meddelanden).
- Nedladdning av filbilagor lagrade i SharePoint/OneDrive.
- Läsa kanal-/chattmeddelandehistorik via Graph.

### RSC vs Graph API

| Förmåga                    | RSC-behörigheter                          | Graph API                                       |
| -------------------------- | ----------------------------------------- | ----------------------------------------------- |
| **Realtidsmeddelanden**    | Ja (via webhook)       | Nej (endast polling)         |
| **Historiska meddelanden** | Nej                                       | Ja (kan fråga historik)      |
| **Konfigkomplexitet**      | Endast appmanifest                        | Kräver adminmedgivande + tokenflöde             |
| **Fungerar offline**       | Nej (måste vara igång) | Ja (kan fråga när som helst) |

**Nedre raden:** RSC är för realtidslyssnande; Graph API är för historisk åtkomst. För att komma ikapp missade meddelanden medan du är offline behöver du Graph API med `ChannelMessage.Read.All` (kräver administratörens samtycke).

## Graph-aktiverade medier + historik (krävs för kanaler)

Om du behöver bilder/filer i **kanaler** eller vill hämta **meddelandehistorik** måste du aktivera Microsoft Graph-behörigheter och ge adminmedgivande.

1. I Entra ID (Azure AD) **App Registration**, lägg till Microsoft Graph **Application permissions**:
   - `ChannelMessage.Read.All` (kanalbilagor + historik)
   - `Chat.Read.All` eller `ChatMessage.Read.All` (gruppchattar)
2. **Ge adminmedgivande** för tenant.
3. Öka Teams-appens **manifestversion**, ladda upp igen och **installera om appen i Teams**.
4. **Avsluta Teams helt och starta om** för att rensa cachead appmetadata.

## Kända begränsningar

### Webhook-timeouts

Teams levererar meddelanden via HTTP-webhook. Om behandlingen tar för lång tid (t.ex., långsam LLM svar), kan du se:

- Gateway-timeouts
- Teams som försöker igen (orsakar dubbletter)
- Tappade svar

OpenClaw hanterar detta genom att svara snabbt och skicka svar proaktivt, men mycket långsamma svar kan fortfarande orsaka problem.

### Formatering

Teams-markdown är mer begränsad än Slack eller Discord:

- Grundläggande formatering fungerar: **fet**, _kursiv_, `code`, länkar
- Komplex markdown (tabeller, nästlade listor) kanske inte renderas korrekt
- Adaptive Cards stöds för omröstningar och godtyckliga kort (se nedan)

## Konfiguration

Nyckelinställningar (se `/gateway/configuration` för delade kanal-mönster):

- `channels.msteams.enabled`: aktivera/inaktivera kanalen.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: botuppgifter.
- `channels.msteams.webhook.port` (standard `3978`)
- `channels.msteams.webhook.path` (standard `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (standard: pairing)
- `channels.msteams.allowFrom`: allowlist för DMs (AAD objekt ID, UPN, eller visningsnamn). Guiden löser namn på ID under installationen när Graph tillgång är tillgänglig.
- `channels.msteams.textChunkLimit`: utgående text-chunkstorlek.
- `channels.msteams.chunkMode`: `length` (standard) eller `newline` för att dela på tomrader (styckegränser) före längdchunkning.
- `channels.msteams.mediaAllowHosts`: tillåtelselista för inkommande bilagevärdar (standard Microsoft/Teams-domäner).
- `channels.msteams.mediaAuthAllowHosts`: tillåtelselista för att bifoga Authorization-headers vid medieomförsök (standard Graph + Bot Framework-värdar).
- `channels.msteams.requireMention`: kräver @omnämnande i kanaler/grupper (standard true).
- `channels.msteams.replyStyle`: `thread | top-level` (se [Svarsformat](#svarsformat-trådar-vs-inlägg)).
- `channels.msteams.team.<teamId>.replyStyle`: åsidosätter per lag.
- `channels.msteams.team.<teamId>.requireMention`: åsidosättning per lag.
- `channels.msteams.team.<teamId>.tools`: standard policy för per-team overrides (`allow`/`deny`/`alsoAllow`) som används när en kanaloverride saknas.
- `channels.msteams.team.<teamId>.toolsBySender`: standard per-team per-sender tool policy overrides (`"*"` wildcard stöds).
- `channels.msteams.team.<teamId>.kanaler.<conversationId>.replyStyle`: åsidosätter per kanal.
- `channels.msteams.team.<teamId>.kanaler.<conversationId>.requireMention`: åsidosättning per kanal.
- `channels.msteams.team.<teamId>.kanaler.<conversationId>.tools`: policy för verktyg per kanal åsidosätter (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.team.<teamId>.kanaler.<conversationId>.toolsBySender`: per-channel per-sender tool policy overrides (`"*"` wildcard stöds).
- `channels.msteams.sharePointSiteId`: SharePoint-site-ID för filuppladdningar i gruppchattar/kanaler (se [Skicka filer i gruppchattar](#skicka-filer-i-gruppchattar)).

## Routning & sessioner

- Sessionsnycklar följer standard agentformat (se [/concepts/session](/concepts/session)):
  - Direktmeddelanden delar huvudsessionen (`agent:<agentId>:<mainKey>`).
  - Kanal-/gruppmeddelanden använder konversations-ID:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Svarsformat: Trådar vs inlägg

Teams har nyligen introducerat två kanal-UI-stilar ovanpå samma underliggande datamodell:

| Stil                                      | Beskrivning                                       | Rekommenderad `replyStyle`             |
| ----------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| **Inlägg** (klassisk)  | Meddelanden visas som kort med trådade svar under | `thread` (standard) |
| **Trådar** (Slack-lik) | Meddelanden flyter linjärt, mer som Slack         | `top-level`                            |

**Problemet:** Teams API avslöjar inte vilken UI-stil en kanal använder. Om du använder fel `replyStyle`:

- `thread` i en Trådar-kanal → svar visas klumpigt nästlade
- `top-level` i en Inlägg-kanal → svar visas som separata toppnivåinlägg i stället för i tråd

**Lösning:** Konfigurera `replyStyle` per kanal baserat på hur kanalen är uppsatt:

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

## Bilagor & bilder

**Nuvarande begränsningar:**

- **DM:er:** Bilder och filbilagor fungerar via Teams bot-fil-API:er.
- **Kanaler/grupper:** Bilagor live i M365-lagring (SharePoint/OneDrive). Webhook payload innehåller endast en HTML-stub, inte den faktiska filen bytes. **Grafik API-behörigheter krävs** för att ladda ner kanalbilagor.

Utan Graph behörigheter kommer kanalmeddelanden med bilder att tas emot som text-only (bildinnehållet är inte tillgängligt för boten).
Som standard laddar OpenClaw endast ner media från Microsoft/Teams värdnamn. Åsidosätt med `channels.msteams.mediaAllowHosts` (använd `["*"]` för att tillåta alla värdar).
Auktoriseringshuvuden är bara kopplade för värdar i `channels.msteams.mediaAuthAllowHosts` (standard är Graph + Bot Framework värd). Håll denna lista strikt (undvik multi-tenant-suffix).

## Skicka filer i gruppchattar

Bots kan skicka filer i DMs med hjälp av flödet FileConsentCard (inbyggd). **skicka filer i gruppchatt/kanaler** kräver dock ytterligare inställningar:

| Kontext                                        | Hur filer skickas                                          | Krävd konfigurering                            |
| ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| **DM:er**                      | FileConsentCard → användaren accepterar → boten laddar upp | Fungerar direkt                                |
| **Gruppchattar/kanaler**                       | Ladda upp till SharePoint → dela länk                      | Kräver `sharePointSiteId` + Graph-behörigheter |
| **Bilder (alla kontexter)** | Base64-kodade inline                                       | Fungerar direkt                                |

### Varför gruppchattar behöver SharePoint

Bots har ingen personlig OneDrive-enhet (`/me/drive` Graph API slutpunkt fungerar inte för applikationsidentiteter). För att skicka filer i gruppchattar/kanaler laddar roboten upp till en **SharePoint-webbplats** och skapar en delningslänk.

### Konfigurering

1. **Lägg till Graph API-behörigheter** i Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) – ladda upp filer till SharePoint
   - `Chat.Read.All` (Application) – valfri, aktiverar per-användare-delning

2. **Ge adminmedgivande** för tenant.

3. **Hämta ditt SharePoint-site-ID:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Konfigurera OpenClaw:**

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

### Delningsbeteende

| Behörighet                              | Delningsbeteende                                                       |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `Sites.ReadWrite.All` endast            | Organisationsomfattande delningslänk (alla i orgen) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Per-användare-delning (endast chattmedlemmar)       |

Delning per användare är säkrare eftersom endast chattdeltagare kan komma åt filen. Om 'Chat.Read.All' tillstånd saknas, faller boten tillbaka till hela organisationen.

### Fallback-beteende

| Scenario                                           | Resultat                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Gruppchatt + fil + `sharePointSiteId` konfigurerad | Ladda upp till SharePoint, skicka delningslänk                                      |
| Gruppchatt + fil + ingen `sharePointSiteId`        | Försök OneDrive-uppladdning (kan misslyckas), skicka endast text |
| Personlig chatt + fil                              | FileConsentCard-flöde (fungerar utan SharePoint)                 |
| Valfri kontext + bild                              | Base64-kodad inline (fungerar utan SharePoint)                   |

### Lagringsplats för filer

Uppladdade filer lagras i en mapp `/OpenClawShared/` i den konfigurerade SharePoint-sitens standarddokumentbibliotek.

## Omröstningar (Adaptive Cards)

OpenClaw skickar Teams-omröstningar som Adaptive Cards (det finns inget inbyggt Teams-API för omröstningar).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Röster registreras av gatewayn i `~/.openclaw/msteams-polls.json`.
- Gatewayn måste vara online för att registrera röster.
- Omröstningar publicerar ännu inte automatiskt sammanfattningar (inspektera lagringsfilen vid behov).

## Adaptive Cards (godtyckliga)

Skicka valfri Adaptive Card-JSON till Teams-användare eller konversationer med verktyget eller CLI `message`.

Parametern `card` accepterar ett Adaptive Card JSON-objekt. När `card` anges är meddelandetexten frivillig.

**Agentverktyg:**

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

Se [Adaptive Cards documentation](https://adaptivecards.io/) för kortschema och exempel. För information om målformat, se [Målformat](#target-formats) nedan.

## Målformat

MSTeams-mål använder prefix för att skilja mellan användare och konversationer:

| Måltyp                                  | Format                           | Exempel                                                                  |
| --------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Användare (via ID)   | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                              |
| Användare (via namn) | `user:<display-name>`            | `user:John Smith` (kräver Graph API)                  |
| Grupp/kanal                             | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                 |
| Grupp/kanal (rå)     | `<conversation-id>`              | `19:abc123...@thread.tacv2` (om innehåller `@thread`) |

**CLI-exempel:**

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

**Agentverktygsexempel:**

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

Obs: Utan prefixet `user:` , namn standard för grupp/team upplösning. Använd alltid `användare:` när du riktar personer genom visningsnamn.

## Proaktiva meddelanden

- Proaktiva meddelanden är endast möjliga **efter** att en användare har interagerat, eftersom vi lagrar konversationsreferenser då.
- Se `/gateway/configuration` för `dmPolicy` och tillåtelselistegrindning.

## Team- och kanal-ID:n (vanlig fallgrop)

`groupId`-frågeparametern i Teams URL:er är **INTE** team-ID som används för konfiguration. Extrahera ID från URL-sökvägen istället:

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

**För konfig:**

- Lag ID = sökväg segment efter `/team/` (URL-avkodad, t.ex., `19:Bk4j...@thread.tacv2`)
- Kanal-ID = sökvägssegmentet efter `/channel/` (URL-avkodat)
- **Ignorera** query-parametern `groupId`

## Privata kanaler

Botar har begränsat stöd i privata kanaler:

| Funktion                                         | Standardkanaler | Privata kanaler                          |
| ------------------------------------------------ | --------------- | ---------------------------------------- |
| Botinstallation                                  | Ja              | Begränsad                                |
| Realtidsmeddelanden (webhook) | Ja              | Kanske fungerar inte                     |
| RSC-behörigheter                                 | Ja              | Kan bete sig annorlunda                  |
| @omnämnanden                        | Ja              | Om boten är åtkomlig                     |
| Graph API-historik                               | Ja              | Ja (med behörigheter) |

**Workarounds om privata kanaler inte fungerar:**

1. Använd standardkanaler för botinteraktioner
2. Använd DM:er – användare kan alltid skriva direkt till boten
3. Använd Graph API för historisk åtkomst (kräver `ChannelMessage.Read.All`)

## Felsökning

### Vanliga problem

- **Bilder som inte visas i kanaler:** Grafbehörigheter eller administratörens samtycke saknas. Installera om Teams appen och avsluta / öppna Teams.
- **Inga svar i kanal:** omnämnanden krävs som standard; sätt `channels.msteams.requireMention=false` eller konfigurera per team/kanal.
- **Versionsmismatch (Teams visar gammalt manifest):** ta bort + lägg till appen igen och avsluta Teams helt för att uppdatera.
- **401 Obehörig från webhook:** Förväntad vid testning manuellt utan Azure JWT - betyder att slutpunkten kan nås, men auth misslyckades. Använd Azure Web Chat för att testa korrekt.

### Fel vid uppladdning av manifest

- **"Ikonfil kan inte vara tom":** De manifest-referensikonfiler som är 0 bytes. Skapa giltiga PNG-ikoner (32x32 för `outline.png`, 192x192 för `color.png`).
- **"webApplicationInfo.Id används redan":** Appen är fortfarande installerad i en annan team/chatt. Hitta och avinstallera det först, eller vänta 5-10 minuter för förökning.
- **”Something went wrong” vid uppladdning:** Ladda upp via [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) i stället, öppna webbläsarens DevTools (F12) → Network-fliken och kontrollera svarskroppen för det faktiska felet.
- **Sideload misslyckas:** Prova ”Upload an app to your org’s app catalog” i stället för ”Upload a custom app” – detta kringgår ofta sideload-restriktioner.

### RSC-behörigheter fungerar inte

1. Verifiera att `webApplicationInfo.id` matchar botens App ID exakt
2. Ladda upp appen igen och installera om i teamet/chatten
3. Kontrollera om din organisationsadmin har blockerat RSC-behörigheter
4. Bekräfta att du använder rätt scope: `ChannelMessage.Read.Group` för team, `ChatMessage.Read.Chat` för gruppchattar

## Referenser

- [Skapa Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) – guide för Azure Bot-konfigurering
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) – skapa/hantera Teams-appar
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Ta emot kanalmeddelanden med RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC-behörighetsreferens](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot-filhantering](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (kanal/grupp kräver Graph)
- [Proaktiva meddelanden](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
