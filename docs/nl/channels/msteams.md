---
summary: "Ondersteuningsstatus, mogelijkheden en configuratie van Microsoft Teams-bots"
read_when:
  - Werken aan MS Teams-kanaalfuncties
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> "Laat alle hoop varen, gij die hier binnentreedt."

Bijgewerkt: 2026-01-21

Status: tekst + DM-bijlagen worden ondersteund; het verzenden van bestanden in kanalen/groepen vereist `sharePointSiteId` + Graph-rechten (zie [Bestanden verzenden in groepschats](#sending-files-in-group-chats)). Polls worden verzonden via Adaptive Cards.

## Plugin vereist

Microsoft Teams wordt geleverd als een plugin en is niet inbegrepen bij de core-installatie.

**Breaking change (2026.1.15):** MS Teams is uit de core verplaatst. Als je het gebruikt, moet je de plugin installeren.

Uitleg: dit houdt core-installaties lichter en laat MS Teams-afhankelijkheden onafhankelijk updaten.

Installeren via CLI (npm‑register):

```bash
openclaw plugins install @openclaw/msteams
```

Lokale checkout (bij draaien vanuit een git-repo):

```bash
openclaw plugins install ./extensions/msteams
```

Als je Teams kiest tijdens configuratie/onboarding en een git-checkout wordt gedetecteerd,
zal OpenClaw automatisch het lokale installatiepad aanbieden.

Details: [Plugins](/tools/plugin)

## Snelle installatie (beginner)

1. Installeer de Microsoft Teams-plugin.
2. Maak een **Azure Bot** aan (App ID + client secret + tenant ID).
3. Configureer OpenClaw met deze referenties.
4. Stel `/api/messages` bloot (standaard poort 3978) via een publieke URL of tunnel.
5. Installeer het Teams-app-pakket en start de Gateway.

Minimale config:

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

Let op: groepschats zijn standaard geblokkeerd (`channels.msteams.groupPolicy: "allowlist"`). Om groepsantwoorden toe te staan, stel `channels.msteams.groupAllowFrom` in (of gebruik `groupPolicy: "open"` om elk lid toe te staan, met mention‑vereiste).

## Doelen

- Met OpenClaw praten via Teams DM’s, groepschats of kanalen.
- Routering deterministisch houden: antwoorden gaan altijd terug naar het kanaal waar ze zijn ontvangen.
- Standaard veilig kanaalgedrag (mentions vereist tenzij anders geconfigureerd).

## Config-wegschrijvingen

Standaard mag Microsoft Teams config-updates wegschrijven die worden getriggerd door `/config set|unset` (vereist `commands.config: true`).

Uitschakelen met:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Toegangsbeheer (DM’s + groepen)

**DM-toegang**

- Standaard: `channels.msteams.dmPolicy = "pairing"`. Onbekende afzenders worden genegeerd tot goedkeuring.
- `channels.msteams.allowFrom` accepteert AAD-object-ID’s, UPN’s of weergavenamen. De wizard zet namen om naar ID’s via Microsoft Graph wanneer de referenties dat toestaan.

**Groepstoegang**

- Standaard: `channels.msteams.groupPolicy = "allowlist"` (geblokkeerd tenzij je `groupAllowFrom` toevoegt). Gebruik `channels.defaults.groupPolicy` om de standaard te overschrijven wanneer niet ingesteld.
- `channels.msteams.groupAllowFrom` bepaalt welke afzenders groepschats/kanalen kunnen triggeren (valt terug op `channels.msteams.allowFrom`).
- Stel `groupPolicy: "open"` in om elk lid toe te staan (standaard nog steeds mention‑vereist).
- Om **geen kanalen** toe te staan, stel `channels.msteams.groupPolicy: "disabled"` in.

Voorbeeld:

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

**Teams + kanaal‑toegestane lijst**

- Beperk groeps-/kanaalantwoorden door teams en kanalen te vermelden onder `channels.msteams.teams`.
- Sleutels kunnen team-ID’s of namen zijn; kanaalsleutels kunnen conversatie-ID’s of namen zijn.
- Wanneer `groupPolicy="allowlist"` en een teams‑toegestane lijst aanwezig is, worden alleen vermelde teams/kanalen geaccepteerd (mention‑vereist).
- De configuratiewizard accepteert `Team/Channel`‑items en slaat ze voor je op.
- Bij opstarten zet OpenClaw team-/kanaal- en gebruikersnamen in de toegestane lijst om naar ID’s (wanneer Graph-rechten dit toestaan)
  en logt de mapping; niet-opgeloste items blijven zoals ingevoerd.

Voorbeeld:

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

## Hoe het werkt

1. Installeer de Microsoft Teams-plugin.
2. Maak een **Azure Bot** aan (App ID + secret + tenant ID).
3. Bouw een **Teams-app-pakket** dat naar de bot verwijst en de onderstaande RSC-rechten bevat.
4. Upload/installeer de Teams-app in een team (of persoonlijke scope voor DM’s).
5. Configureer `msteams` in `~/.openclaw/openclaw.json` (of omgevingsvariabelen) en start de Gateway.
6. De Gateway luistert standaard naar Bot Framework-webhookverkeer op `/api/messages`.

## Azure Bot-installatie (Vereisten)

Voordat je OpenClaw configureert, moet je een Azure Bot-resource aanmaken.

### Stap 1: Azure Bot maken

1. Ga naar [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Vul het tabblad **Basics** in:

   | Waarde             | Waarde                                                                                    |
   | ------------------ | ----------------------------------------------------------------------------------------- |
   | **Bot handle**     | Je botnaam, bijv. `openclaw-msteams` (moet uniek zijn) |
   | **Subscription**   | Selecteer je Azure-abonnement                                                             |
   | **Resource group** | Nieuw aanmaken of bestaand gebruiken                                                      |
   | **Pricing tier**   | **Free** voor dev/test                                                                    |
   | **Type of App**    | **Single Tenant** (aanbevolen – zie opmerking hieronder)               |
   | **Creation type**  | **Create new Microsoft App ID**                                                           |

> **Deprecatiebericht:** Het aanmaken van nieuwe multi-tenant bots is na 2025-07-31 afgeschaft. Gebruik **Single Tenant** voor nieuwe bots.

3. Klik **Review + create** → **Create** (wacht ~1–2 minuten)

### Stap 2: Referenties ophalen

1. Ga naar je Azure Bot-resource → **Configuration**
2. Kopieer **Microsoft App ID** → dit is je `appId`
3. Klik **Manage Password** → ga naar de App-registratie
4. Onder **Certificates & secrets** → **New client secret** → kopieer de **Value** → dit is je `appPassword`
5. Ga naar **Overview** → kopieer **Directory (tenant) ID** → dit is je `tenantId`

### Stap 3: Messaging-endpoint configureren

1. In Azure Bot → **Configuration**
2. Stel **Messaging endpoint** in op je webhook-URL:
   - Productie: `https://your-domain.com/api/messages`
   - Lokale dev: gebruik een tunnel (zie [Lokale ontwikkeling](#local-development-tunneling) hieronder)

### Stap 4: Teams-kanaal inschakelen

1. In Azure Bot → **Channels**
2. Klik **Microsoft Teams** → Configure → Save
3. Accepteer de Servicevoorwaarden

## Lokale ontwikkeling (Tunneling)

Teams kan `localhost` niet bereiken. Gebruik een tunnel voor lokale ontwikkeling:

**Optie A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Optie B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (Alternatief)

In plaats van handmatig een manifest-ZIP te maken, kun je de [Teams Developer Portal](https://dev.teams.microsoft.com/apps) gebruiken:

1. Klik **+ New app**
2. Vul basisinfo in (naam, beschrijving, ontwikkelaarsinfo)
3. Ga naar **App features** → **Bot**
4. Selecteer **Enter a bot ID manually** en plak je Azure Bot App ID
5. Vink scopes aan: **Personal**, **Team**, **Group Chat**
6. Klik **Distribute** → **Download app package**
7. In Teams: **Apps** → **Manage your apps** → **Upload a custom app** → selecteer de ZIP

Dit is vaak eenvoudiger dan handmatig JSON-manifests bewerken.

## De bot testen

**Optie A: Azure Web Chat (verifieer eerst de webhook)**

1. In Azure Portal → je Azure Bot-resource → **Test in Web Chat**
2. Stuur een bericht – je zou een antwoord moeten zien
3. Dit bevestigt dat je webhook-endpoint werkt vóór Teams-installatie

**Optie B: Teams (na app-installatie)**

1. Installeer de Teams-app (sideload of org-catalogus)
2. Zoek de bot in Teams en stuur een DM
3. Controleer Gateway-logs op inkomende activiteit

## Installatie (minimaal, alleen tekst)

1. **Installeer de Microsoft Teams-plugin**
   - Via npm: `openclaw plugins install @openclaw/msteams`
   - Via een lokale checkout: `openclaw plugins install ./extensions/msteams`

2. **Bot-registratie**
   - Maak een Azure Bot aan (zie hierboven) en noteer:
     - App ID
     - Client secret (App-wachtwoord)
     - Tenant ID (single-tenant)

3. **Teams-app-manifest**
   - Voeg een `bot`‑item toe met `botId = <App ID>`.
   - Scopes: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (vereist voor bestandsverwerking in persoonlijke scope).
   - Voeg RSC-rechten toe (hieronder).
   - Maak iconen: `outline.png` (32x32) en `color.png` (192x192).
   - Zip alle drie bestanden samen: `manifest.json`, `outline.png`, `color.png`.

4. **OpenClaw configureren**

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

   Je kunt ook omgevingsvariabelen gebruiken in plaats van config-sleutels:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot-endpoint**
   - Stel het Azure Bot Messaging Endpoint in op:
     - `https://<host>:3978/api/messages` (of je gekozen pad/poort).

6. **Gateway starten**
   - Het Teams-kanaal start automatisch wanneer de plugin is geïnstalleerd en `msteams`‑config met referenties bestaat.

## Contextgeschiedenis

- `channels.msteams.historyLimit` bepaalt hoeveel recente kanaal-/groepsberichten in de prompt worden opgenomen.
- Valt terug op `messages.groupChat.historyLimit`. Stel `0` in om uit te schakelen (standaard 50).
- DM-geschiedenis kan worden beperkt met `channels.msteams.dmHistoryLimit` (gebruikersbeurten). Per‑gebruiker‑overschrijvingen: `channels.msteams.dms["<user_id>"].historyLimit`.

## Huidige Teams RSC-rechten (Manifest)

Dit zijn de **bestaande resourceSpecific-rechten** in ons Teams-app-manifest. Ze gelden alleen binnen het team/de chat waar de app is geïnstalleerd.

**Voor kanalen (team-scope):**

- `ChannelMessage.Read.Group` (Application) – alle kanaalberichten ontvangen zonder @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Voor groepschats:**

- `ChatMessage.Read.Chat` (Application) – alle groepschatberichten ontvangen zonder @mention

## Voorbeeld Teams-manifest (geredigeerd)

Minimaal, geldig voorbeeld met de vereiste velden. Vervang ID’s en URL’s.

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

### Manifest‑kanttekeningen (verplichte velden)

- `bots[].botId` **moet** overeenkomen met de Azure Bot App ID.
- `webApplicationInfo.id` **moet** overeenkomen met de Azure Bot App ID.
- `bots[].scopes` moet de oppervlakken bevatten die je wilt gebruiken (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` is vereist voor bestandsverwerking in persoonlijke scope.
- `authorization.permissions.resourceSpecific` moet kanaal lezen/verzenden bevatten als je kanaalverkeer wilt.

### Een bestaande app bijwerken

Om een reeds geïnstalleerde Teams-app bij te werken (bijv. om RSC-rechten toe te voegen):

1. Werk je `manifest.json` bij met de nieuwe instellingen
2. **Verhoog het veld `version`** (bijv. `1.0.0` → `1.1.0`)
3. **Zip opnieuw** het manifest met iconen (`manifest.json`, `outline.png`, `color.png`)
4. Upload de nieuwe zip:
   - **Optie A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → zoek je app → Upload new version
   - **Optie B (Sideload):** In Teams → Apps → Manage your apps → Upload a custom app
5. **Voor teamkanalen:** herinstalleer de app in elk team zodat nieuwe rechten ingaan
6. **Teams volledig afsluiten en opnieuw starten** (niet alleen het venster sluiten) om gecachte app‑metadata te wissen

## Mogelijkheden: alleen RSC vs Graph

### Met **alleen Teams RSC** (app geïnstalleerd, geen Graph API-rechten)

Werkt:

- Kanaalbericht **tekst** lezen.
- Kanaalbericht **tekst** verzenden.
- **Persoonlijke (DM)** bestandsbijlagen ontvangen.

Werkt niet:

- **Afbeeldings- of bestandsinhoud** in kanalen/groepen (payload bevat alleen HTML‑stub).
- Bijlagen downloaden die in SharePoint/OneDrive zijn opgeslagen.
- Berichtgeschiedenis lezen (buiten de live webhook‑event).

### Met **Teams RSC + Microsoft Graph Application-rechten**

Toevoegen:

- Gehoste inhoud downloaden (afbeeldingen die in berichten zijn geplakt).
- Bestandsbijlagen downloaden die in SharePoint/OneDrive zijn opgeslagen.
- Kanaal-/chatberichtgeschiedenis lezen via Graph.

### RSC vs Graph API

| Mogelijkheid                | RSC-rechten                           | Graph API                                      |
| --------------------------- | ------------------------------------- | ---------------------------------------------- |
| **Realtime berichten**      | Ja (via webhook)   | Nee (alleen polling)        |
| **Historische berichten**   | Nee                                   | Ja (geschiedenis opvragen)  |
| **Installatiecomplexiteit** | Alleen app-manifest                   | Vereist admin‑toestemming + tokenflow          |
| **Werkt offline**           | Nee (moet draaien) | Ja (op elk moment opvragen) |

**Kortom:** RSC is voor realtime luisteren; Graph API is voor historische toegang. Om gemiste berichten in te halen terwijl je offline was, heb je Graph API nodig met `ChannelMessage.Read.All` (vereist admin‑toestemming).

## Graph‑ingeschakelde media + geschiedenis (vereist voor kanalen)

Als je afbeeldingen/bestanden in **kanalen** nodig hebt of **berichtgeschiedenis** wilt ophalen, moet je Microsoft Graph-rechten inschakelen en admin‑toestemming verlenen.

1. In Entra ID (Azure AD) **App Registration**, voeg Microsoft Graph **Application permissions** toe:
   - `ChannelMessage.Read.All` (kanaalbijlagen + geschiedenis)
   - `Chat.Read.All` of `ChatMessage.Read.All` (groepschats)
2. **Verleen admin‑toestemming** voor de tenant.
3. Verhoog de Teams-app **manifestversie**, upload opnieuw en **herinstalleer de app in Teams**.
4. **Teams volledig afsluiten en opnieuw starten** om gecachte app‑metadata te wissen.

## Bekende beperkingen

### Webhook‑timeouts

Teams levert berichten via HTTP‑webhooks. Als verwerking te lang duurt (bijv. trage LLM‑antwoorden), kun je zien:

- Gateway‑timeouts
- Teams die het bericht opnieuw probeert te verzenden (duplicaten)
- Verloren antwoorden

OpenClaw handelt dit af door snel te antwoorden en proactief replies te sturen, maar zeer trage reacties kunnen nog steeds problemen geven.

### Opmaak

Teams‑markdown is beperkter dan Slack of Discord:

- Basisopmaak werkt: **vet**, _cursief_, `code`, links
- Complexe markdown (tabellen, geneste lijsten) rendert mogelijk niet correct
- Adaptive Cards worden ondersteund voor polls en het verzenden van kaarten (zie hieronder)

## Configuratie

Belangrijke instellingen (zie `/gateway/configuration` voor gedeelde kanaalpatronen):

- `channels.msteams.enabled`: kanaal in-/uitschakelen.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: bot‑referenties.
- `channels.msteams.webhook.port` (standaard `3978`)
- `channels.msteams.webhook.path` (standaard `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (standaard: pairing)
- `channels.msteams.allowFrom`: toegestane lijst voor DM’s (AAD‑object‑ID’s, UPN’s of weergavenamen). De wizard zet namen om naar ID’s tijdens installatie wanneer Graph‑toegang beschikbaar is.
- `channels.msteams.textChunkLimit`: uitgaande tekst‑chunkgrootte.
- `channels.msteams.chunkMode`: `length` (standaard) of `newline` om op lege regels (alinea‑grenzen) te splitsen vóór lengte‑chunking.
- `channels.msteams.mediaAllowHosts`: toegestane lijst voor inkomende bijlagehosts (standaard Microsoft/Teams‑domeinen).
- `channels.msteams.mediaAuthAllowHosts`: toegestane lijst voor het toevoegen van Authorization‑headers bij media‑retries (standaard Graph + Bot Framework‑hosts).
- `channels.msteams.requireMention`: @mention vereisen in kanalen/groepen (standaard true).
- `channels.msteams.replyStyle`: `thread | top-level` (zie [Antwoordstijl](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: per‑team overschrijving.
- `channels.msteams.teams.<teamId>.requireMention`: per‑team overschrijving.
- `channels.msteams.teams.<teamId>.tools`: standaard per‑team tool‑beleid‑overschrijvingen (`allow`/`deny`/`alsoAllow`) gebruikt wanneer een kanaaloverschrijving ontbreekt.
- `channels.msteams.teams.<teamId>.toolsBySender`: standaard per‑team per‑afzender tool‑beleid‑overschrijvingen (`"*"` wildcard ondersteund).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per‑kanaal overschrijving.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: per‑kanaal overschrijving.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: per‑kanaal tool‑beleid‑overschrijvingen (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: per‑kanaal per‑afzender tool‑beleid‑overschrijvingen (`"*"` wildcard ondersteund).
- `channels.msteams.sharePointSiteId`: SharePoint‑site‑ID voor bestandsuploads in groepschats/kanalen (zie [Bestanden verzenden in groepschats](#sending-files-in-group-chats)).

## Routering & sessies

- Sessiesleutels volgen het standaard agent‑formaat (zie [/concepts/session](/concepts/session)):
  - Directe berichten delen de hoofdsessie (`agent:<agentId>:<mainKey>`).
  - Kanaal-/groepsberichten gebruiken conversatie‑ID:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Antwoordstijl: Threads vs Posts

Teams introduceerde recent twee kanaal‑UI‑stijlen boven hetzelfde datamodel:

| Stijl                                         | Beschrijving                                             | Aanbevolen `replyStyle`                 |
| --------------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| **Posts** (klassiek)       | Berichten verschijnen als kaarten met antwoorden eronder | `thread` (standaard) |
| **Threads** (Slack‑achtig) | Berichten lopen lineair, meer zoals Slack                | `top-level`                             |

**Het probleem:** De Teams‑API geeft niet bloot welke UI‑stijl een kanaal gebruikt. Gebruik je de verkeerde `replyStyle`:

- `thread` in een Threads‑kanaal → antwoorden verschijnen onhandig genest
- `top-level` in een Posts‑kanaal → antwoorden verschijnen als losse top‑level posts i.p.v. in de thread

**Oplossing:** Configureer `replyStyle` per kanaal op basis van de kanaalinstelling:

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

## Bijlagen & afbeeldingen

**Huidige beperkingen:**

- **DM’s:** Afbeeldingen en bestandsbijlagen werken via Teams bot file‑API’s.
- **Kanalen/groepen:** Bijlagen staan in M365‑opslag (SharePoint/OneDrive). De webhook‑payload bevat alleen een HTML‑stub, niet de daadwerkelijke bytes. **Graph API‑rechten zijn vereist** om kanaalbijlagen te downloaden.

Zonder Graph‑rechten worden kanaalberichten met afbeeldingen als alleen tekst ontvangen (de afbeeldingsinhoud is niet toegankelijk voor de bot).
Standaard downloadt OpenClaw alleen media van Microsoft/Teams‑hostnamen. Overschrijf met `channels.msteams.mediaAllowHosts` (gebruik `["*"]` om elke host toe te staan).
Authorization‑headers worden alleen toegevoegd voor hosts in `channels.msteams.mediaAuthAllowHosts` (standaard Graph + Bot Framework‑hosts). Houd deze lijst strikt (vermijd multi‑tenant suffixen).

## Bestanden verzenden in groepschats

Bots kunnen bestanden in DM’s verzenden via de FileConsentCard‑flow (ingebouwd). **Bestanden verzenden in groepschats/kanalen** vereist echter extra installatie:

| Context                                   | Hoe bestanden worden verzonden                       | Benodigde setup                            |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| **DM’s**                                  | FileConsentCard → gebruiker accepteert → bot uploadt | Werkt out of the box                       |
| **Groepschats/kanalen**                   | Upload naar SharePoint → deel‑link                   | Vereist `sharePointSiteId` + Graph‑rechten |
| **Afbeeldingen (elk)** | Base64‑gecodeerd inline                              | Werkt out of the box                       |

### Waarom groepschats SharePoint nodig hebben

Bots hebben geen persoonlijke OneDrive‑schijf (het `/me/drive` Graph API‑endpoint werkt niet voor applicatie‑identiteiten). Om bestanden in groepschats/kanalen te verzenden, uploadt de bot naar een **SharePoint‑site** en maakt een deel‑link.

### Installatie

1. **Voeg Graph API‑rechten toe** in Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) – bestanden uploaden naar SharePoint
   - `Chat.Read.All` (Application) – optioneel, maakt per‑gebruiker deel‑links mogelijk

2. **Verleen admin‑toestemming** voor de tenant.

3. **Haal je SharePoint‑site‑ID op:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Configureer OpenClaw:**

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

### Delen gedrag

| Bevoegdheden                            | Delen gedrag                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `Sites.ReadWrite.All` alleen            | Organisatiebrede deel‑link (iedereen in de org heeft toegang) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Per‑gebruiker deel‑link (alleen chatleden hebben toegang)     |

Per‑gebruiker delen is veiliger omdat alleen chatdeelnemers toegang hebben. Als het recht `Chat.Read.All` ontbreekt, valt de bot terug op organisatiebreed delen.

### Fallback‑gedrag

| Scenario                                                 | Resultaat                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Groepschat + bestand + `sharePointSiteId` geconfigureerd | Upload naar SharePoint, stuur deel‑link                                   |
| Groepschat + bestand + geen `sharePointSiteId`           | Poging OneDrive‑upload (kan falen), stuur alleen tekst |
| Persoonlijke chat + bestand                              | FileConsentCard‑flow (werkt zonder SharePoint)         |
| Elke context + afbeelding                                | Base64‑gecodeerd inline (werkt zonder SharePoint)      |

### Opslaglocatie van bestanden

Geüploade bestanden worden opgeslagen in een map `/OpenClawShared/` in de standaard documentbibliotheek van de geconfigureerde SharePoint‑site.

## Polls (Adaptive Cards)

OpenClaw verzendt Teams‑polls als Adaptive Cards (er is geen native Teams‑poll‑API).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Stemmen worden door de Gateway vastgelegd in `~/.openclaw/msteams-polls.json`.
- De Gateway moet online blijven om stemmen te registreren.
- Polls plaatsen nog geen automatische resultaat‑samenvattingen (inspecteer indien nodig het opslagbestand).

## Adaptive Cards (vrij)

Stuur elke Adaptive Card‑JSON naar Teams‑gebruikers of conversaties met de `message`‑tool of CLI.

De parameter `card` accepteert een Adaptive Card‑JSON‑object. Wanneer `card` wordt meegegeven, is berichttekst optioneel.

**Agent‑tool:**

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

Zie [Adaptive Cards‑documentatie](https://adaptivecards.io/) voor schema en voorbeelden. Voor doel‑formatdetails, zie [Target formats](#target-formats) hieronder.

## Target formats

MSTeams‑doelen gebruiken prefixes om onderscheid te maken tussen gebruikers en conversaties:

| Doeltype                               | Formaat                          | Voorbeeld                                                            |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| Gebruiker (op ID)   | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                          |
| Gebruiker (op naam) | `user:<display-name>`            | `user:John Smith` (vereist Graph API)             |
| Groep/kanaal                           | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                             |
| Groep/kanaal (raw)  | `<conversation-id>`              | `19:abc123...@thread.tacv2` (als `@thread` bevat) |

**CLI‑voorbeelden:**

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

**Agent‑tool‑voorbeelden:**

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

Let op: zonder de prefix `user:` worden namen standaard als groep/team opgezocht. Gebruik altijd `user:` wanneer je personen op weergavenaam target.

## Proactieve berichten

- Proactieve berichten zijn alleen mogelijk **nadat** een gebruiker heeft geïnteracteerd, omdat we dan conversatie‑referenties opslaan.
- Zie `/gateway/configuration` voor `dmPolicy` en gating via toegestane lijsten.

## Team- en kanaal‑ID’s (veelgemaakte valkuil)

De queryparameter `groupId` in Teams‑URL’s is **NIET** het team‑ID dat voor configuratie wordt gebruikt. Haal ID’s uit het URL‑pad:

**Team‑URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**Kanaal‑URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Voor config:**

- Team‑ID = padsegment na `/team/` (URL‑gedecodeerd, bijv. `19:Bk4j...@thread.tacv2`)
- Kanaal‑ID = padsegment na `/channel/` (URL‑gedecodeerd)
- **Negeer** de queryparameter `groupId`

## Privékanalen

Bots hebben beperkte ondersteuning in privékanalen:

| Functie                                         | Standaardkanalen | Privékanalen                        |
| ----------------------------------------------- | ---------------- | ----------------------------------- |
| Bot‑installatie                                 | Ja               | Beperkt                             |
| Realtime berichten (webhook) | Ja               | Werkt mogelijk niet                 |
| RSC‑rechten                                     | Ja               | Kan anders werken                   |
| @mentions                          | Ja               | Als bot toegankelijk is             |
| Graph API‑geschiedenis                          | Ja               | Ja (met rechten) |

**Workarounds als privékanalen niet werken:**

1. Gebruik standaardkanalen voor bot‑interacties
2. Gebruik DM’s – gebruikers kunnen de bot altijd direct berichten
3. Gebruik Graph API voor historische toegang (vereist `ChannelMessage.Read.All`)

## Problemen oplossen

### Veelvoorkomende problemen

- **Afbeeldingen verschijnen niet in kanalen:** Graph‑rechten of admin‑toestemming ontbreken. Herinstalleer de Teams‑app en sluit/open Teams volledig.
- **Geen antwoorden in kanaal:** mentions zijn standaard vereist; stel `channels.msteams.requireMention=false` in of configureer per team/kanaal.
- **Versiemismatch (Teams toont oud manifest):** verwijder en voeg de app opnieuw toe en sluit Teams volledig.
- **401 Unauthorized van webhook:** Verwacht bij handmatig testen zonder Azure JWT – betekent dat het endpoint bereikbaar is maar authenticatie faalt. Gebruik Azure Web Chat om correct te testen.

### Manifest‑uploadfouten

- **"Icon file cannot be empty":** Het manifest verwijst naar iconen van 0 bytes. Maak geldige PNG‑iconen (32x32 voor `outline.png`, 192x192 voor `color.png`).
- **"webApplicationInfo.Id already in use":** De app is nog geïnstalleerd in een ander team/chat. Verwijder die eerst of wacht 5–10 minuten op propagatie.
- **"Something went wrong" bij upload:** Upload via [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com), open DevTools (F12) → Network‑tab en controleer de response‑body voor de echte fout.
- **Sideload mislukt:** Probeer "Upload an app to your org's app catalog" i.p.v. "Upload a custom app" – dit omzeilt vaak sideload‑beperkingen.

### RSC‑rechten werken niet

1. Controleer of `webApplicationInfo.id` exact overeenkomt met de App ID van je bot
2. Upload de app opnieuw en herinstalleer in het team/de chat
3. Controleer of je org‑admin RSC‑rechten heeft geblokkeerd
4. Bevestig dat je de juiste scope gebruikt: `ChannelMessage.Read.Group` voor teams, `ChatMessage.Read.Chat` voor groepschats

## Referenties

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) – Azure Bot‑installatiehandleiding
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) – Teams‑apps maken/beheren
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (kanaal/groep vereist Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
