---
summary: "Microsoft Teams known limitations, common failures, and reference links"
read_when:
  - The Teams bot is silent, or images do not arrive
  - A manifest upload or RSC permission is rejected
  - Checking what the Teams path does not support
title: "Microsoft Teams troubleshooting"
sidebarTitle: "Troubleshooting"
---

What the Teams path does not support, the failures operators hit most often, and where to read more.

## Known limitations

### Webhook timeouts

Teams delivers messages via HTTP webhook. OpenClaw applies fixed HTTP server
timeouts to that webhook listener: 30s inactivity, 30s total request, and 15s
to receive headers. Optional inbound media and context enrichment has a shared
10-second budget. The SDK returns after the raw activity is durably appended;
the agent turn drains independently and replies proactively. If request
handling or durable admission misses the transport window, Teams may retry the
activity, and the ingress tombstone rejects a repeated event ID.

### Teams cloud and service URL support

This SDK-backed Teams path is live-validated for Microsoft Teams public cloud.

Inbound replies use the incoming Teams SDK turn context. Out-of-context proactive operations - sends, edits, deletes, cards, polls, file-consent messages, and queued long-running replies - use the stored conversation reference `serviceUrl`. Public cloud defaults to the Teams SDK public cloud environment and allows stored references on the public Teams Connector host: `https://smba.trafficmanager.net/`.

Public cloud is the default. You do not need to set `channels.msteams.cloud` or `channels.msteams.serviceUrl` for normal public-cloud bots.

For non-public Teams clouds, set `cloud` and the matching proactive boundary when Microsoft publishes one:

- `channels.msteams.cloud` selects the Teams SDK cloud preset for authentication, JWT validation, token services, and Graph scope.
- `channels.msteams.serviceUrl` selects the Bot Connector endpoint boundary used to validate stored conversation references before proactive sends, edits, deletes, cards, polls, file-consent messages, and queued long-running replies. It is required for USGov and DoD SDK clouds. For China/21Vianet, OpenClaw uses the SDK `China` preset and accepts stored/configured service URLs only on Azure China Bot Framework channel hosts.

Microsoft publishes the global proactive Bot Connector endpoints in the [Create the conversation](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages?tabs=dotnet#create-the-conversation) section of the Teams proactive messaging docs. Use the incoming activity's `serviceUrl` when available; otherwise use Microsoft's table below.

| Teams environment | OpenClaw config                                             | Proactive `serviceUrl`                             |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Public            | no cloud/serviceUrl config needed                           | `https://smba.trafficmanager.net/teams`            |
| GCC               | set `serviceUrl`; no separate Teams SDK cloud preset exists | `https://smba.infra.gcc.teams.microsoft.com/teams` |
| GCC High          | `cloud: "USGov"` + `serviceUrl`                             | `https://smba.infra.gov.teams.microsoft.us/teams`  |
| DoD               | `cloud: "USGovDoD"` + `serviceUrl`                          | `https://smba.infra.dod.teams.microsoft.us/teams`  |
| China/21Vianet    | `cloud: "China"`                                            | use the incoming activity's `serviceUrl`           |

Example for GCC, where Microsoft documents a separate proactive service URL but the Teams SDK exposes no separate GCC cloud preset:

```json
{
  "channels": {
    "msteams": {
      "serviceUrl": "https://smba.infra.gcc.teams.microsoft.com/teams"
    }
  }
}
```

Example for GCC High:

```json
{
  "channels": {
    "msteams": {
      "cloud": "USGov",
      "serviceUrl": "https://smba.infra.gov.teams.microsoft.us/teams"
    }
  }
}
```

`channels.msteams.serviceUrl` is restricted to supported Microsoft Teams Bot Connector hosts. When a service URL is configured, OpenClaw checks that the stored conversation `serviceUrl` uses the same host before proactive sends, edits, deletes, cards, polls, or queued long-running replies run. With the default public-cloud config, OpenClaw fails closed if a stored conversation points outside the public Teams Connector host. Receive a fresh message from the conversation after changing cloud/service URL settings so the stored conversation reference is current.

China/21Vianet has no separate global proactive `smba` URL in Microsoft's Teams proactive endpoint table. Configure `cloud: "China"` so the Teams SDK uses Azure China auth, token, and JWT endpoints. Proactive sends then require a stored conversation reference from an incoming China Teams activity, or an explicitly configured service URL, on the Azure China Bot Framework channel boundary (`*.botframework.azure.cn`). Graph-backed Teams helpers are disabled for `cloud: "China"` until OpenClaw routes Graph requests through the Azure China Graph endpoint.

### Formatting

Teams markdown is more limited than Slack or Discord:

- Basic formatting works: **bold**, _italic_, `code`, links.
- Text edits, file captions, and finalized streaming replies use the same Markdown conversion and user-mention formatting as normal messages. Streaming previews may show unfinished Markdown until the final reply replaces them.
- Complex markdown (tables, nested lists) may not render correctly.
- Adaptive Cards are supported for approval prompts, polls, and semantic presentation sends (see [Cards and actions](/channels/msteams/cards-and-actions)).

## Troubleshooting

### Common issues

- **Images not showing in channels:** Graph permissions or admin consent missing. Reinstall the Teams app and fully quit/reopen Teams.
- **No responses in channel:** mentions are required by default; set `channels.msteams.requireMention=false` or configure per team/channel.
- **Version mismatch (Teams still shows old manifest):** remove + re-add the app and fully quit Teams to refresh.
- **401 Unauthorized from webhook:** expected when testing manually without an Azure JWT; means the endpoint is reachable but auth failed. Use Azure Web Chat to test properly.

### Manifest upload errors

- **"Icon file cannot be empty":** the manifest references icon files that are 0 bytes. Create valid PNG icons (32x32 for `outline.png`, 192x192 for `color.png`).
- **"webApplicationInfo.Id already in use":** the app is still installed in another team/chat. Find and uninstall it first, or wait 5-10 minutes for propagation.
- **"Something went wrong" on upload:** upload via [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) instead, open browser DevTools (F12) → Network tab, and check the response body for the actual error.
- **Sideload failing:** try "Upload an app to your org's app catalog" instead of "Upload a custom app"; this often bypasses sideload restrictions.

### RSC permissions not working

1. Verify `webApplicationInfo.id` matches your bot's App ID exactly.
2. Re-upload the app and reinstall in the team/chat.
3. Check if your org admin has blocked RSC permissions.
4. Confirm you are using the right scope: `ChannelMessage.Read.Group` for teams, `ChatMessage.Read.Chat` for group chats.

## References

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot setup guide
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - create/manage Teams apps
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (channel/group requires Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [@microsoft/teams.cli](https://www.npmjs.com/package/@microsoft/teams.cli) - Teams CLI for bot management

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
