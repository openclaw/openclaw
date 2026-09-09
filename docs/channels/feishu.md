---
summary: "Feishu bot overview, features, and configuration"
read_when:
  - You want to connect a Feishu/Lark bot
  - You are configuring the Feishu channel
title: Feishu
---

OpenClaw connects to Feishu/Lark (the all-in-one collaboration platform) through the official `@openclaw/feishu` plugin: bot DMs, group chats, streaming card replies, and Feishu doc/wiki/drive/Bitable tools.

**Status:** production-ready for bot DMs + group chats. WebSocket is the default event transport (no public URL needed); webhook mode is optional.

## What each page covers

- [Feishu setup](/channels/feishu/setup) — run the setup wizard and understand durable inbound events.
- [Feishu access control](/channels/feishu/access-control) — DM policy, group policy, mention gating, and chat/user ID lookup.
- [Feishu troubleshooting](/channels/feishu/troubleshooting) — silent bots, missing events, QR setup, and leaked App Secrets.
- [Feishu advanced configuration](/channels/feishu/advanced-configuration) — multiple accounts, limits, streaming, workspace tools, ACP sessions, and multi-agent routing.
- [Feishu dynamic agents](/channels/feishu/dynamic-agents) — per-user agent isolation with its own workspace per DM sender.
- [Feishu configuration reference](/channels/feishu/configuration-reference) — every `channels.feishu` key with its default.
- [Feishu message types](/channels/feishu/messaging) — received and sent message types, stickers, and thread replies.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/channels/feishu#streaming` still resolves. Each entry points at the page that now holds the content.

- <a id="quick-start" />[Quick start](/channels/feishu/setup#quick-start)
- <a id="inbound-durability" />[Inbound durability](/channels/feishu/setup#inbound-durability)
- <a id="access-control" />[Access control](/channels/feishu/access-control#access-control)
- <a id="direct-messages" />[Direct messages](/channels/feishu/access-control#direct-messages)
- <a id="group-chats" />[Group chats](/channels/feishu/access-control#group-chats)
- <a id="group-configuration-examples" />[Group configuration examples](/channels/feishu/access-control#group-configuration-examples)
- <a id="allow-all-groups%2C-no-%40mention-required" />[Allow all groups, no @mention required](/channels/feishu/access-control#allow-all-groups%2C-no-%40mention-required)
- <a id="allow-all-groups%2C-still-require-%40mention" />[Allow all groups, still require @mention](/channels/feishu/access-control#allow-all-groups%2C-still-require-%40mention)
- <a id="allow-specific-groups-only" />[Allow specific groups only](/channels/feishu/access-control#allow-specific-groups-only)
- <a id="restrict-senders-within-a-group" />[Restrict senders within a group](/channels/feishu/access-control#restrict-senders-within-a-group)
- <a id="bot-authored-messages" />[Bot-authored messages](/channels/feishu/access-control#bot-authored-messages)
- <a id="get-groupuser-ids" />[Get group/user IDs](/channels/feishu/access-control#get-groupuser-ids)
- <a id="get-group%2Fuser-ids" />[Get group/user IDs](/channels/feishu/access-control#get-group%2Fuser-ids)
- <a id="group-ids-(chat_id%2C-format%3A-oc_xxx)" />[Group IDs (chat_id, format: oc_xxx)](</channels/feishu/access-control#group-ids-(chat_id%2C-format%3A-oc_xxx)>)
- <a id="user-ids-(open_id%2C-format%3A-ou_xxx)" />[User IDs (open_id, format: ou_xxx)](</channels/feishu/access-control#user-ids-(open_id%2C-format%3A-ou_xxx)>)
- <a id="troubleshooting" />[Troubleshooting](/channels/feishu/troubleshooting#troubleshooting)
- <a id="bot-does-not-respond-in-group-chats" />[Bot does not respond in group chats](/channels/feishu/troubleshooting#bot-does-not-respond-in-group-chats)
- <a id="bot-does-not-receive-messages" />[Bot does not receive messages](/channels/feishu/troubleshooting#bot-does-not-receive-messages)
- <a id="qr-setup-does-not-react-in-the-feishu-mobile-app" />[QR setup does not react in the Feishu mobile app](/channels/feishu/troubleshooting#qr-setup-does-not-react-in-the-feishu-mobile-app)
- <a id="app-secret-leaked" />[App Secret leaked](/channels/feishu/troubleshooting#app-secret-leaked)
- <a id="advanced-configuration" />[Advanced configuration](/channels/feishu/advanced-configuration#advanced-configuration)
- <a id="multiple-accounts" />[Multiple accounts](/channels/feishu/advanced-configuration#multiple-accounts)
- <a id="message-limits" />[Message limits](/channels/feishu/advanced-configuration#message-limits)
- <a id="streaming" />[Streaming](/channels/feishu/advanced-configuration#streaming)
- <a id="quota-optimization" />[Quota optimization](/channels/feishu/advanced-configuration#quota-optimization)
- <a id="group-session-scope-and-topic-threads" />[Group session scope and topic threads](/channels/feishu/advanced-configuration#group-session-scope-and-topic-threads)
- <a id="feishu-workspace-tools" />[Feishu workspace tools](/channels/feishu/advanced-configuration#feishu-workspace-tools)
- <a id="acp-sessions" />[ACP sessions](/channels/feishu/advanced-configuration#acp-sessions)
- <a id="persistent-acp-binding" />[Persistent ACP binding](/channels/feishu/advanced-configuration#persistent-acp-binding)
- <a id="spawn-acp-from-chat" />[Spawn ACP from chat](/channels/feishu/advanced-configuration#spawn-acp-from-chat)
- <a id="multi-agent-routing" />[Multi-agent routing](/channels/feishu/advanced-configuration#multi-agent-routing)
- <a id="per-user-agent-isolation-(dynamic-agent-creation)" />[Per-user agent isolation (Dynamic Agent Creation)](</channels/feishu/dynamic-agents#per-user-agent-isolation-(dynamic-agent-creation)>)
- <a id="quick-setup" />[Quick setup](/channels/feishu/dynamic-agents#quick-setup)
- <a id="how-it-works" />[How it works](/channels/feishu/dynamic-agents#how-it-works)
- <a id="configuration-options" />[Configuration options](/channels/feishu/dynamic-agents#configuration-options)
- <a id="session-scope" />[Session scope](/channels/feishu/dynamic-agents#session-scope)
- <a id="typical-multi-user-deployment" />[Typical multi-user deployment](/channels/feishu/dynamic-agents#typical-multi-user-deployment)
- <a id="verification" />[Verification](/channels/feishu/dynamic-agents#verification)
- <a id="notes" />[Notes](/channels/feishu/dynamic-agents#notes)
- <a id="configuration-reference" />[Configuration reference](/channels/feishu/configuration-reference#configuration-reference)
- <a id="supported-message-types" />[Supported message types](/channels/feishu/messaging#supported-message-types)
- <a id="receive" />[Receive](/channels/feishu/messaging#receive)
- <a id="send" />[Send](/channels/feishu/messaging#send)
- <a id="sticker-replies" />[Sticker replies](/channels/feishu/messaging#sticker-replies)
- <a id="sticker-keyword-search" />[Sticker keyword search](/channels/feishu/messaging#sticker-keyword-search)
- <a id="threads-and-replies" />[Threads and replies](/channels/feishu/messaging#threads-and-replies)
- <a id="run-the-channel-setup-wizard" />[Run the channel setup wizard](/channels/feishu/setup#run-the-channel-setup-wizard)
- <a id="after-setup-completes%2C-restart-the-gateway-to-apply-the-changes" />[After setup completes, restart the gateway to apply the changes](/channels/feishu/setup#after-setup-completes%2C-restart-the-gateway-to-apply-the-changes)
- <a id="allow-all-groups-no-@mention-required" />[Allow all groups, no @mention required](/channels/feishu/access-control#allow-all-groups-no-@mention-required)
- <a id="allow-all-groups-still-require-@mention" />[Allow all groups, still require @mention](/channels/feishu/access-control#allow-all-groups-still-require-@mention)
- <a id="get-group/user-ids" />[Get group/user IDs](/channels/feishu/access-control#get-group/user-ids)
- <a id="group-ids-chat_id-format-oc_xxx" />[Group IDs (chat_id, format: oc_xxx)](/channels/feishu/access-control#group-ids-chat_id-format-oc_xxx)
- <a id="user-ids-open_id-format-ou_xxx" />[User IDs (open_id, format: ou_xxx)](/channels/feishu/access-control#user-ids-open_id-format-ou_xxx)
- <a id="per-user-agent-isolation-dynamic-agent-creation" />[Per-user agent isolation (Dynamic Agent Creation)](/channels/feishu/dynamic-agents#per-user-agent-isolation-dynamic-agent-creation)

## Common commands

| Command   | Description                 |
| --------- | --------------------------- |
| `/status` | Show bot status             |
| `/reset`  | Reset the current session   |
| `/model`  | Show or switch the AI model |

<Note>
Feishu/Lark does not support native slash-command menus, so send these as plain text messages.
</Note>

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
