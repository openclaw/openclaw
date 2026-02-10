---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Matrix support status, capabilities, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on Matrix channel features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Matrix"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Matrix (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Matrix is an open, decentralized messaging protocol. OpenClaw connects as a Matrix **user**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
on any homeserver, so you need a Matrix account for the bot. Once it is logged in, you can DM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the bot directly or invite it to rooms (Matrix "groups"). Beeper is a valid client option too,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
but it requires E2EE to be enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: supported via plugin (@vector-im/matrix-bot-sdk). Direct messages, rooms, threads, media, reactions,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
polls (send + poll-start as text), location, and E2EE (with crypto support).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Matrix ships as a plugin and is not bundled with the core install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install via CLI (npm registry):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local checkout (when running from a git repo):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you choose Matrix during configure/onboarding and a git checkout is detected,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw will offer the local install path automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the Matrix plugin:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - From npm: `openclaw plugins install @openclaw/matrix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - From a local checkout: `openclaw plugins install ./extensions/matrix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create a Matrix account on a homeserver:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Browse hosting options at [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or host it yourself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Get an access token for the bot account:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Use the Matrix login API with `curl` at your home server:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   curl --request POST \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     --url https://matrix.example.org/_matrix/client/v3/login \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     --header 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     --data '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     "type": "m.login.password",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     "identifier": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "type": "m.id.user",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "user": "your-user-name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     "password": "your-password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Replace `matrix.example.org` with your homeserver URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or set `channels.matrix.userId` + `channels.matrix.password`: OpenClaw calls the same（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     login endpoint, stores the access token in `~/.openclaw/credentials/matrix/credentials.json`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     and reuses it on next start.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Configure credentials:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (or `MATRIX_USER_ID` + `MATRIX_PASSWORD`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or config: `channels.matrix.*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If both are set, config takes precedence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - With access token: user ID is fetched automatically via `/whoami`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - When set, `channels.matrix.userId` should be the full Matrix ID (example: `@bot:example.org`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Restart the gateway (or finish onboarding).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Start a DM with the bot or invite it to a room from any Matrix client（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   (Element, Beeper, etc.; see [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Beeper requires E2EE,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   so set `channels.matrix.encryption: true` and verify the device.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config (access token, user ID auto-fetched):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    matrix: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      homeserver: "https://matrix.example.org",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accessToken: "syt_***",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dm: { policy: "pairing" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
E2EE config (end to end encryption enabled):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    matrix: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      homeserver: "https://matrix.example.org",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accessToken: "syt_***",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      encryption: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dm: { policy: "pairing" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Encryption (E2EE)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
End-to-end encryption is **supported** via the Rust crypto SDK.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable with `channels.matrix.encryption: true`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the crypto module loads, encrypted rooms are decrypted automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound media is encrypted when sending to encrypted rooms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On first connection, OpenClaw requests device verification from your other sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify the device in another Matrix client (Element, etc.) to enable key sharing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the crypto module cannot be loaded, E2EE is disabled and encrypted rooms will not decrypt;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  OpenClaw logs a warning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you see missing crypto module errors (for example, `@matrix-org/matrix-sdk-crypto-nodejs-*`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  allow build scripts for `@matrix-org/matrix-sdk-crypto-nodejs` and run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` or fetch the binary with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Crypto state is stored per account + access token in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(SQLite database). Sync state lives alongside it in `bot-storage.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the access token (device) changes, a new store is created and the bot must be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
re-verified for encrypted rooms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Device verification:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When E2EE is enabled, the bot will request verification from your other sessions on startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open Element (or another client) and approve the verification request to establish trust.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Once verified, the bot can decrypt messages in encrypted rooms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Routing model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replies always go back to Matrix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs share the agent's main session; rooms map to group sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.matrix.dm.policy = "pairing"`. Unknown senders get a pairing code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing list matrix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing approve matrix <CODE>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Public DMs: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.dm.allowFrom` accepts full Matrix user IDs (example: `@user:server`). The wizard resolves display names to user IDs when directory search finds a single exact match.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Rooms (groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.matrix.groupPolicy = "allowlist"` (mention-gated). Use `channels.defaults.groupPolicy` to override the default when unset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allowlist rooms with `channels.matrix.groups` (room IDs or aliases; names are resolved to IDs when directory search finds a single exact match):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    matrix: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "!roomId:example.org": { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "#alias:example.org": { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["@owner:example.org"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requireMention: false` enables auto-reply in that room.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `groups."*"` can set defaults for mention gating across rooms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `groupAllowFrom` restricts which senders can trigger the bot in rooms (full Matrix user IDs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-room `users` allowlists can further restrict senders inside a specific room (use full Matrix user IDs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The configure wizard prompts for room allowlists (room IDs, aliases, or names) and resolves names only on an exact, unique match.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On startup, OpenClaw resolves room/user names in allowlists to IDs and logs the mapping; unresolved entries are ignored for allowlist matching.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Invites are auto-joined by default; control with `channels.matrix.autoJoin` and `channels.matrix.autoJoinAllowlist`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To allow **no rooms**, set `channels.matrix.groupPolicy: "disabled"` (or keep an empty allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Legacy key: `channels.matrix.rooms` (same shape as `groups`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Threads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reply threading is supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.threadReplies` controls whether replies stay in threads:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `off`, `inbound` (default), `always`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.replyToMode` controls reply-to metadata when not replying in a thread:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `off` (default), `first`, `all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Capabilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Feature         | Status                                                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | ------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Direct messages | ✅ Supported                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Rooms           | ✅ Supported                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Threads         | ✅ Supported                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Media           | ✅ Supported                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| E2EE            | ✅ Supported (crypto module required)                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Reactions       | ✅ Supported (send/read via tools)                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Polls           | ✅ Send supported; inbound poll starts are converted to text (responses/ends ignored) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Location        | ✅ Supported (geo URI; altitude ignored)                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Native commands | ✅ Supported                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run this ladder first:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then confirm DM pairing state if needed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common failures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logged in but room messages ignored: room blocked by `groupPolicy` or room allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DMs ignored: sender pending approval when `channels.matrix.dm.policy="pairing"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Encrypted rooms fail: crypto support or encryption settings mismatch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For triage flow: [/channels/troubleshooting](/channels/troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference (Matrix)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.enabled`: enable/disable channel startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.homeserver`: homeserver URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.userId`: Matrix user ID (optional with access token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.accessToken`: access token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.password`: password for login (token stored).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.deviceName`: device display name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.encryption`: enable E2EE (default: false).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.initialSyncLimit`: initial sync limit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.threadReplies`: `off | inbound | always` (default: inbound).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.textChunkLimit`: outbound text chunk size (chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (default: pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.dm.allowFrom`: DM allowlist (full Matrix user IDs). `open` requires `"*"`. The wizard resolves names to IDs when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (default: allowlist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.groupAllowFrom`: allowlisted senders for group messages (full Matrix user IDs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.allowlistOnly`: force allowlist rules for DMs + rooms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.groups`: group allowlist + per-room settings map.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.rooms`: legacy group allowlist/config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.replyToMode`: reply-to mode for threads/tags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.mediaMaxMb`: inbound/outbound media cap (MB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.autoJoin`: invite handling (`always | allowlist | off`, default: always).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.autoJoinAllowlist`: allowed room IDs/aliases for auto-join.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.matrix.actions`: per-action tool gating (reactions/messages/pins/memberInfo/channelInfo).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
