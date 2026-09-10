---
summary: "Microsoft Teams session routing, reply style, attachments, and file sending"
read_when:
  - Choosing between threaded and top-level replies
  - Attachments arrive without content
  - Sending files into a group chat or channel
title: "Microsoft Teams message behavior"
sidebarTitle: "Message behavior"
---

How replies are routed and threaded, and how attachments and files move in and out of Teams.

## Routing and sessions

- Session keys follow the standard agent format (see [/concepts/session](/concepts/session)):
  - Direct messages share the main session (`agent:<agentId>:main`) by default.
  - Channel/group messages use conversation id:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Reply style: threads vs posts

Teams has two channel UI styles over the same underlying data model:

| Style                    | Description                                               | Recommended `replyStyle` |
| ------------------------ | --------------------------------------------------------- | ------------------------ |
| **Posts** (classic)      | Messages appear as cards with threaded replies underneath | `thread` (default)       |
| **Threads** (Slack-like) | Messages flow linearly, more like Slack                   | `top-level`              |

**The problem:** the Teams API does not expose which UI style a channel uses. If you use the wrong `replyStyle`:

- `thread` in a Threads-style channel → replies appear nested awkwardly.
- `top-level` in a Posts-style channel → replies appear as separate top-level posts instead of in-thread.

**Solution:** configure `replyStyle` per-channel based on how the channel is set up:

```json5
{
  channels: {
    msteams: {
      replyStyle: "thread",
      teams: {
        "19:abc...@thread.tacv2": {
          channels: {
            "19:xyz...@thread.tacv2": {
              replyStyle: "top-level",
            },
          },
        },
      },
    },
  },
}
```

### Resolution precedence

When the bot sends a reply into a channel, `replyStyle` is resolved from the most specific override down to the default. The first non-`undefined` value wins:

1. **Per-channel** - `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`
2. **Per-team** - `channels.msteams.teams.<teamId>.replyStyle`
3. **Global** - `channels.msteams.replyStyle`
4. **Implicit default** - derived from `requireMention`:
   - `requireMention: true` → `thread`
   - `requireMention: false` → `top-level`

If you set `requireMention: false` globally without an explicit `replyStyle`, mentions in Posts-style channels surface as top-level posts even when the inbound was a thread reply. Pin `replyStyle: "thread"` at the global, team, or channel level to avoid surprises.

For proactive sends into a stored channel conversation (queued tool-call replies, long-running agents), the same team/channel resolution applies; group chats and personal (DM) conversations always resolve to `top-level` for proactive sends regardless of `replyStyle`.

### Thread context preservation

When `replyStyle: "thread"` is in effect and the bot was @mentioned from inside a channel thread, OpenClaw re-attaches the original thread root to the outbound conversation reference (`19:...@thread.tacv2;messageid=<root>`) so the reply lands inside the same thread. This holds for both live (in-turn) sends and proactive sends made after the Bot Framework turn context has expired (e.g., long-running agents, queued tool-call replies via `mcp__openclaw__message`).

The thread root is taken from the stored `threadId` on the conversation reference. Older stored references that predate `threadId` fall back to `activityId` (whatever inbound activity last seeded the conversation), so existing deployments keep working without a re-seed.

When `replyStyle: "top-level"` is in effect, channel-thread inbounds are intentionally answered as new top-level posts; no thread suffix is attached. This is correct for Threads-style channels; top-level posts where you expected threaded replies means `replyStyle` is set incorrectly for that channel.

## Attachments and images

**Current limitations:**

- **DMs:** images and file attachments work via Teams bot file APIs.
- **Channels/groups:** attachments live in M365 storage (SharePoint/OneDrive). The webhook payload only includes an HTML stub, not the actual file bytes. **Graph API permissions are required** to download channel attachments.
- For explicit file-first sends, use `action=upload-file` with `media` / `filePath` / `path`; optional `message` becomes the accompanying text/comment, and `filename` (or `title`) overrides the uploaded name.

Without Graph permissions, channel messages with images arrive as text-only (the image content is not accessible to the bot).
By default, OpenClaw only downloads media from Microsoft/Teams hostnames. Override with `channels.msteams.mediaAllowHosts` (use `["*"]` to allow any host).
Authorization headers are only attached for hosts in `channels.msteams.mediaAuthAllowHosts` (defaults to Graph + Bot Framework hosts). Keep this list strict (avoid multi-tenant suffixes).

## Sending files in group chats

Bots can send files in DMs using the built-in FileConsentCard flow. **Sending files in group chats/channels** requires additional setup:

| Context                  | How files are sent                           | Setup needed                                    |
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| **DMs**                  | FileConsentCard → user accepts → bot uploads | Works out of the box                            |
| **Group chats/channels** | Upload to SharePoint → native file card      | Requires `sharePointSiteId` + Graph permissions |
| **Images (any context)** | Base64-encoded inline                        | Works out of the box                            |

### Why group chats need SharePoint

Bots use an application identity, while Microsoft Graph's `/me` resource [requires a signed-in user](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0). To send files in group chats/channels, the bot uploads to a **SharePoint site** and creates a sharing link.

### Setup

1. **Add Graph API permissions** in Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) - upload files to SharePoint.
   - `ChatMember.Read.All` (Application) - least-privileged tenant-wide permission for group-chat file sends. `Chat.Read.All` also works and already covers this when group-chat history is enabled. As a per-chat alternative, use the `ChatMember.Read.Chat` [resource-specific consent permission](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent).
2. **Grant admin consent** for the tenant.
3. **Get your SharePoint site ID:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Configure OpenClaw:**

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

### Sharing behavior

| Context and permission                                                  | Sharing behavior                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Channel + `Sites.ReadWrite.All`                                         | Organization-wide sharing link (anyone in org can access) |
| Group chat + `Sites.ReadWrite.All` + a supported chat-member read grant | Per-user sharing link (only chat members can access)      |
| Group chat without a supported chat-member read grant                   | Send fails closed                                         |

Per-user sharing is more secure since only chat participants can access the file. OpenClaw requires a successful member lookup for group chats; timeouts, transport failures, empty results, and Graph API denials fail the send instead of widening access to the organization.

### Fallback behavior

| Scenario                                                         | Result                                           |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| Group chat + file + SharePoint and member permissions configured | Upload to SharePoint, send a native file card    |
| Group chat + file + missing SharePoint or member permissions     | Fail with an actionable configuration error      |
| Channel + file + `sharePointSiteId` configured                   | Upload to SharePoint, send a native file card    |
| Personal chat + file                                             | FileConsentCard flow (works without SharePoint)  |
| Any context + image                                              | Base64-encoded inline (works without SharePoint) |

### Files stored location

Uploaded files are stored in a `/OpenClawShared/` folder in the configured SharePoint site's default document library.
