# BlueBubbles extension (developer reference)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This directory contains the **BlueBubbles external channel plugin** for OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you’re looking for **how to use BlueBubbles as an agent/tool user**, see:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills/bluebubbles/SKILL.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Layout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Extension package: `extensions/bluebubbles/` (entry: `index.ts`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel implementation: `extensions/bluebubbles/src/channel.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Webhook handling: `extensions/bluebubbles/src/monitor.ts` (register via `api.registerHttpHandler`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- REST helpers: `extensions/bluebubbles/src/send.ts` + `extensions/bluebubbles/src/probe.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime bridge: `extensions/bluebubbles/src/runtime.ts` (set via `api.runtime`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Catalog entry for onboarding: `src/channels/plugins/catalog.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Internal helpers (use these, not raw API calls)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `probeBlueBubbles` in `extensions/bluebubbles/src/probe.ts` for health checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sendMessageBlueBubbles` in `extensions/bluebubbles/src/send.ts` for text delivery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `resolveChatGuidForTarget` in `extensions/bluebubbles/src/send.ts` for chat lookup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sendBlueBubblesReaction` in `extensions/bluebubbles/src/reactions.ts` for tapbacks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sendBlueBubblesTyping` + `markBlueBubblesChatRead` in `extensions/bluebubbles/src/chat.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `downloadBlueBubblesAttachment` in `extensions/bluebubbles/src/attachments.ts` for inbound media.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `buildBlueBubblesApiUrl` + `blueBubblesFetchWithTimeout` in `extensions/bluebubbles/src/types.ts` for shared REST plumbing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Webhooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles posts JSON to the gateway HTTP server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Normalize sender/chat IDs defensively (payloads vary by version).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skip messages marked as from self.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Route into core reply pipeline via the plugin runtime (`api.runtime`) and `openclaw/plugin-sdk` helpers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For attachments/stickers, use `<media:...>` placeholders when text is empty and attach media paths via `MediaUrl(s)` in the inbound context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config (core)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.serverUrl` (base URL), `channels.bluebubbles.password`, `channels.bluebubbles.webhookPath`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Action gating: `channels.bluebubbles.actions.reactions` (default true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Message tool notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reactions:** the `react` action requires a `target` (phone number or chat identifier) in addition to `messageId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `action=react target=+15551234567 messageId=ABC123 emoji=❤️`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
