# Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels Completeness

Use this rubric when assigning category Completeness scores for the
`feishu-qq-bot-wechat-yuanbao-zalo-zalo-personal-regional-channels` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Feishu, QQ Bot, WeChat, Yuanbao, Zalo, Zalo Personal, regional channels` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

## Scoring Questions

For each category, ask:

- Can the intended user or operator complete the category workflow end to end?
- Are the taxonomy features present as supported capabilities rather than isolated implementation fragments?
- Are the important lifecycle stages represented: setup, normal operation, status/inspection, recovery, and upgrade or removal where relevant?
- Are the important environment, provider, platform, channel, or security branches present for this surface?
- Do the known gaps leave major user-visible capability branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when the category supports the full operator-visible workflow described by taxonomy and the category note evidence.
- Lower Completeness when only the happy path exists, when important variants are undocumented or unimplemented, or when recovery/status paths are missing.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Channel Setup and Operations: Docs channel index, Official external channel catalog entries, Core channel-plugin catalog, Channel setup wizard, Missing-plugin, Cross-channel ingress/access/refactor concerns, Feishu/Lark bot channel setup, WebSocket default mode, DM pairing, Message delivery, Feishu document, Multi-account credential handling, QQ Open Platform AppID/AppSecret setup, C2C private chat, Group activation, Rich media messages, Slash commands, Multi-account gateway connections, Tencent Yuanbao external channel, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog, Zalo Bot Creator / Marketplace bot, Long-polling default mode, Bot token, Group policy schema, Text, Status probes, WeChat/Weixin personal messaging, Plugin install, Direct-message pairing, Core-side catalog metadata, External sidecar/helper process behavior, zalouser channel plugin, QR login, DM pairing, Message send, Doctor/status checks for runtime availability, Explicit unofficial-account risk, QQ Open Platform AppID/AppSecret setup and, C2C private chat, Group activation, Inbound and outbound rich media including, Slash commands, Multi-account gateway connections, Tencent Yuanbao external channel `openclaw-plugin-yuanbao, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog, Zalo Bot Creator / Marketplace bot, Long-polling default mode and optional HTTPS, Bot token, Group policy schema and fail-closed group, Text, Status probes and troubleshooting for token/config/webhook problems, zalouser` channel plugin for Zalo Personal, QR login, DM pairing, Message send, Doctor/status checks for runtime availability and, Explicit unofficial-account risk and operator safeguards
- Access and Identity: Feishu/Lark bot channel setup, WebSocket default mode, DM pairing, Message delivery, Feishu document, Multi-account credential handling, QQ Open Platform AppID/AppSecret setup, C2C private chat, Group activation, Rich media messages, Slash commands, Multi-account gateway connections, Tencent Yuanbao external channel, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog, Zalo Bot Creator / Marketplace bot, Long-polling default mode, Bot token, Group policy schema, Text, Status probes, WeChat/Weixin personal messaging, Plugin install, Direct-message pairing, Core-side catalog metadata, External sidecar/helper process behavior, zalouser channel plugin, QR login, DM pairing, Message send, Doctor/status checks for runtime availability, Explicit unofficial-account risk, QQ Open Platform AppID/AppSecret setup and, C2C private chat, Group activation, Inbound and outbound rich media including, Slash commands, Multi-account gateway connections, Tencent Yuanbao external channel `openclaw-plugin-yuanbao, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog, zalouser` channel plugin for Zalo Personal, QR login, DM pairing, Message send, Doctor/status checks for runtime availability and, Explicit unofficial-account risk and operator safeguards
- Conversation Routing and Delivery: Feishu/Lark bot channel setup, WebSocket default mode, DM pairing, Message delivery, Feishu document, Multi-account credential handling, QQ Open Platform AppID/AppSecret setup, C2C private chat, Group activation, Rich media messages, Slash commands, Multi-account gateway connections, Tencent Yuanbao external channel, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog, Zalo Bot Creator / Marketplace bot, Long-polling default mode, Bot token, Group policy schema, Text, Status probes, WeChat/Weixin personal messaging, Plugin install, Direct-message pairing, Core-side catalog metadata, External sidecar/helper process behavior, zalouser channel plugin, QR login, DM pairing, Message send, Doctor/status checks for runtime availability, Explicit unofficial-account risk, QQ Open Platform AppID/AppSecret setup and, C2C private chat, Group activation, Inbound and outbound rich media including, Slash commands, Multi-account gateway connections, Tencent Yuanbao external channel `openclaw-plugin-yuanbao, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog, Zalo Bot Creator / Marketplace bot, Long-polling default mode and optional HTTPS, Bot token, Group policy schema and fail-closed group, Text, Status probes and troubleshooting for token/config/webhook problems, zalouser` channel plugin for Zalo Personal, QR login, DM pairing, Message send, Doctor/status checks for runtime availability and, Explicit unofficial-account risk and operator safeguards
- Media and Rich Content: Feishu/Lark bot channel setup, WebSocket default mode, DM pairing, Message delivery, Feishu document, Multi-account credential handling, QQ Open Platform AppID/AppSecret setup, C2C private chat, Group activation, Rich media messages, Slash commands, Multi-account gateway connections, Tencent Yuanbao external channel, AppKey/AppSecret setup, DMs, Outbound queue strategy, Core-side official external catalog, Zalo Bot Creator / Marketplace bot, Long-polling default mode, Bot token, Group policy schema, Text, Status probes, QQ Open Platform AppID/AppSecret setup and, C2C private chat, Group activation, Inbound and outbound rich media including, Slash commands, Multi-account gateway connections, Zalo Bot Creator / Marketplace bot, Long-polling default mode and optional HTTPS, Bot token, Group policy schema and fail-closed group, Text, Status probes and troubleshooting for token/config/webhook problems

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
