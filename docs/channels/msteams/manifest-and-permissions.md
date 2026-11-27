---
summary: "Microsoft Teams app manifest, RSC permissions, and the Graph permissions each capability needs"
read_when:
  - Building or updating the Teams app manifest
  - Deciding which RSC or Microsoft Graph permissions to grant
  - Channel images or history are missing
title: "Microsoft Teams manifest and permissions"
sidebarTitle: "Manifest and permissions"
---

The Teams app manifest, the resource-specific consent permissions it declares, and the Microsoft Graph permissions that unlock media and history.

## Current Teams RSC permissions (manifest)

These are the **existing resourceSpecific permissions** in our Teams app manifest. They only apply inside the team/chat where the app is installed.

**For channels (team scope):**

- `ChannelMessage.Read.Group` (Application) - receive all channel messages without @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**For group chats:**

- `ChatMessage.Read.Chat` (Application) - receive all group chat messages without @mention

Add RSC permissions via the Teams CLI:

```bash
teams app rsc add <teamsAppId> ChannelMessage.Read.Group --type Application
```

## Example Teams manifest (redacted)

Minimal, valid example with the required fields. Replace IDs and URLs.

```json5
{
  $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  manifestVersion: "1.23",
  version: "1.0.0",
  id: "00000000-0000-0000-0000-000000000000",
  name: { short: "OpenClaw" },
  developer: {
    name: "Your Org",
    websiteUrl: "https://example.com",
    privacyUrl: "https://example.com/privacy",
    termsOfUseUrl: "https://example.com/terms",
  },
  description: { short: "OpenClaw in Teams", full: "OpenClaw in Teams" },
  icons: { outline: "outline.png", color: "color.png" },
  accentColor: "#5B6DEF",
  bots: [
    {
      botId: "11111111-1111-1111-1111-111111111111",
      scopes: ["personal", "team", "groupChat"],
      isNotificationOnly: false,
      supportsCalling: false,
      supportsVideo: false,
      supportsFiles: true,
    },
  ],
  webApplicationInfo: {
    id: "11111111-1111-1111-1111-111111111111",
  },
  authorization: {
    permissions: {
      resourceSpecific: [
        { name: "ChannelMessage.Read.Group", type: "Application" },
        { name: "ChannelMessage.Send.Group", type: "Application" },
        { name: "Member.Read.Group", type: "Application" },
        { name: "Owner.Read.Group", type: "Application" },
        { name: "ChannelSettings.Read.Group", type: "Application" },
        { name: "TeamMember.Read.Group", type: "Application" },
        { name: "TeamSettings.Read.Group", type: "Application" },
        { name: "ChatMessage.Read.Chat", type: "Application" },
      ],
    },
  },
}
```

### Manifest caveats (must-have fields)

- `bots[].botId` **must** match the Azure Bot App ID.
- `webApplicationInfo.id` **must** match the Azure Bot App ID.
- `bots[].scopes` must include the surfaces you plan to use (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` is required for file handling in personal scope.
- `authorization.permissions.resourceSpecific` must include channel read/send for channel traffic.

### Updating an existing app

```bash
# Download, edit, and re-upload the manifest
teams app manifest download <teamsAppId> manifest.json
# Edit manifest.json locally...
teams app manifest upload manifest.json <teamsAppId>
# Version is auto-bumped if content changed
```

After updating, reinstall the app in each team, and **fully quit and relaunch Teams** (not just close the window) to clear cached app metadata.

<details>
<summary>Manual manifest update (without CLI)</summary>

1. Update `manifest.json` with the new settings.
2. **Increment the `version` field** (e.g., `1.0.0` → `1.1.0`).
3. **Re-zip** the manifest with icons (`manifest.json`, `outline.png`, `color.png`).
4. Upload the new zip:
   - **Teams Admin Center:** Teams apps → Manage apps → find your app → Upload new version.
   - **Sideload:** Teams → Apps → Manage your apps → Upload a custom app.

</details>

## Capabilities: RSC only vs Graph

### With **Teams RSC only** (app installed, no Graph API permissions)

Works:

- Read channel message **text** content.
- Send channel message **text** content.
- Receive **personal (DM)** file attachments.

Does NOT work:

- Channel/group **image or file contents** (payload only includes an HTML stub).
- Downloading attachments stored in SharePoint/OneDrive.
- Reading message history beyond the live webhook event.

### With **Teams RSC + Microsoft Graph Application permissions**

Adds:

- Downloading hosted content (images pasted into messages).
- Downloading file attachments stored in SharePoint/OneDrive.
- Reading channel/chat message history via Graph.

### RSC vs Graph API

| Capability              | RSC permissions      | Graph API                           |
| ----------------------- | -------------------- | ----------------------------------- |
| **Real-time messages**  | Yes (via webhook)    | No (polling only)                   |
| **Historical messages** | No                   | Yes (can query history)             |
| **Setup complexity**    | App manifest only    | Requires admin consent + token flow |
| **Works offline**       | No (must be running) | Yes (query anytime)                 |

**Bottom line:** RSC is for real-time listening; Graph API is for historical access. To catch up on missed messages while offline, you need Graph API with `ChannelMessage.Read.All` (requires admin consent).

## Graph-enabled media + history

Enable only the Microsoft Graph application permissions needed for the Teams scopes and data you use:

1. Entra ID (Azure AD) **App Registration** → add Graph **Application permissions**:
   - `ChannelMessage.Read.All` for channel attachments and channel history.
   - `Chat.Read.All` for group-chat attachments and group-chat history.
   - `Files.Read.All` when attachment bytes must be downloaded from SharePoint/OneDrive storage; history-only setups do not need it.
2. **Grant admin consent** for the tenant.
3. Bump the Teams app **manifest version**, re-upload, and **reinstall the app in Teams**.
4. **Fully quit and relaunch Teams** to clear cached app metadata.

### Channel/group file recovery (`graphMediaFallback`)

Teams can remove file markers from the HTML activity sent to a bot. In that case, the Bot Framework activity is indistinguishable from an ordinary HTML message; the complete attachment reference exists only on the Graph copy of the message.

Enable the fallback after granting the permissions above:

```json5
{
  channels: {
    msteams: {
      graphMediaFallback: true,
    },
  },
}
```

This applies to channels and group chats only. It adds one Graph message lookup whenever an HTML activity produced no directly downloadable media, including ordinary or mention-only messages. The default is `false` so existing installations do not gain extra Graph traffic or permission errors automatically.

**User mentions:** @mentions work out of the box for users already in the conversation. To dynamically search and mention users **not in the current conversation**, add `User.Read.All` (Application) permission and grant admin consent.
