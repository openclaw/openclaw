---
summary: "Microsoft Teams bot support status, capabilities, and configuration"
read_when:
  - Working on MS Teams provider features
---
# Microsoft Teams (Bot Framework)

Updated: 2026-01-08

Status: text + DM attachments are supported; channel/group attachments require Microsoft Graph permissions.

## Goals
- Talk to Clawdbot via Teams DMs, group chats, or channels.
- Keep routing deterministic: replies always go back to the provider they arrived on.
- Default to safe channel behavior (mentions required unless configured otherwise).

## How it works
1. Create an **Azure Bot** (App ID + secret + tenant ID).
2. Build a **Teams app package** that references the bot and includes the RSC permissions below.
3. Upload/install the Teams app into a team (or personal scope for DMs).
4. Configure `msteams` in `~/.clawdbot/clawdbot.json` (or env vars) and start the gateway.
5. The gateway listens for Bot Framework webhook traffic on `/api/messages` by default.

## Setup (minimal text-only)
1. **Bot registration**
   - Create an Azure Bot and note:
     - App ID
     - Client secret (App password)
     - Tenant ID (single-tenant)

2. **Teams app manifest**
   - Include a `bot` entry with `botId = <App ID>`.
   - Scopes: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (required for personal scope file handling).
   - Add RSC permissions (below).

3. **Configure Clawdbot**
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

   You can also use environment variables instead of config keys:
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

4. **Bot endpoint**
   - Set the Azure Bot Messaging Endpoint to:
     - `https://<host>:3978/api/messages` (or your chosen path/port).

5. **Run the gateway**
   - The Teams provider starts automatically when `msteams` config exists and credentials are set.

## Current Teams RSC Permissions (Manifest)
These are the **existing resourceSpecific permissions** in our Teams app manifest. They only apply inside the team where the app is installed.

- `ChannelMessage.Read.Group` (Application)
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

## Example Teams Manifest (redacted)
Minimal, valid example with the required fields. Replace IDs and URLs.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "Clawdbot" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "Clawdbot in Teams", "full": "Clawdbot in Teams" },
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
        { "name": "TeamSettings.Read.Group", "type": "Application" }
      ]
    }
  }
}
```

### Manifest caveats (must-have fields)
- `bots[].botId` **must** match the Azure Bot App ID.
- `webApplicationInfo.id` **must** match the Azure Bot App ID.
- `bots[].scopes` must include the surfaces you plan to use (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` is required for file handling in personal scope.
- `authorization.permissions.resourceSpecific` must include channel read/send if you want channel traffic.
- Reinstall the app after manifest changes; Teams caches app metadata.

## Capabilities: RSC only vs Graph

### With **Teams RSC only** (app installed, no Graph API permissions)
Works:
- Read channel message **text** content.
- Send channel message **text** content.
- Receive **personal (DM)** file attachments.

Does NOT work:
- Channel/group **image or file contents** (payload only includes HTML stub).
- Downloading attachments stored in SharePoint/OneDrive.
- Reading message history (beyond the live webhook event).

### With **Teams RSC + Microsoft Graph Application permissions**
Adds:
- Downloading hosted contents (images pasted into messages).
- Downloading file attachments stored in SharePoint/OneDrive.
- Reading channel/chat message history via Graph.

## Graph-enabled media + history (required for channels)
If you need images/files in **channels** or want to fetch **message history**, you must enable Microsoft Graph permissions and grant admin consent.

1. In Entra ID (Azure AD) **App Registration**, add Microsoft Graph **Application permissions**:
   - `ChannelMessage.Read.All` (channel attachments + history)
   - `Chat.Read.All` or `ChatMessage.Read.All` (group chats)
2. **Grant admin consent** for the tenant.
3. Bump the Teams app **manifest version**, re-upload, and **reinstall the app in Teams**.
4. **Fully quit and relaunch Teams** to clear cached app metadata.

## Configuration
Key settings (see `/gateway/configuration` for shared provider patterns):

- `msteams.enabled`: enable/disable the provider.
- `msteams.appId`, `msteams.appPassword`, `msteams.tenantId`: bot credentials.
- `msteams.webhook.port` (default `3978`)
- `msteams.webhook.path` (default `/api/messages`)
- `msteams.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing)
- `msteams.allowFrom`: allowlist for DMs (AAD object IDs or UPNs).
- `msteams.textChunkLimit`: outbound text chunk size.
- `msteams.requireMention`: require @mention in channels/groups (default true).
- `msteams.replyStyle`: `thread | top-level`.
- `msteams.teams.<teamId>.replyStyle`: per-team override.
- `msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per-channel override.

## Routing & Sessions
- Direct messages use session key: `msteams:<userId>` (shared main session).
- Channel/group messages use session keys based on conversation id:
  - `msteams:channel:<conversationId>`
  - `msteams:group:<conversationId>`

## Attachments & Images
- **DMs:** attachments work via Teams bot file APIs.
- **Channels/groups:** attachments live in M365 storage; payloads only include HTML stubs. Graph is required to fetch the actual bytes.

## Proactive messaging
- Proactive messages are only possible **after** a user has interacted, because we store conversation references at that point.
- See `/gateway/configuration` for `dmPolicy` and allowlist gating.

## Troubleshooting
- **Images not showing in channels:** Graph permissions or admin consent missing. Reinstall the Teams app and fully quit/reopen Teams.
- **No responses in channel:** mentions are required by default; set `msteams.requireMention=false` or configure per team/channel.
- **Version mismatch (Teams still shows old manifest):** remove + re-add the app and fully quit Teams to refresh.

## References
- Teams bot file handling (channel/group requires Graph):
  - https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
