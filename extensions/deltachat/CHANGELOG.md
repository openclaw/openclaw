# Delta.Chat Extension Changelog

## 2026.2.20 (2026-02-20)

### Initial Release

- **Core messaging**: Incoming message handling via `IncomingMsg` events with self-echo filter and deduplication; outbound via `miscSendTextMessage()`
- **Reactions**: Full reactions support via `sendReaction()` RPC; configurable `reactionLevel` (off/ack/minimal/extensive)
- **Liveness reactions**: Cycling emoji (⏳ ⚙️ 🤔 💭) while the agent processes, configurable via `livenessReactionsEnabled` and `livenessReactionIntervalSeconds`
- **Ack reactions**: Configurable `ackReaction` emoji and `ackReactionScope` (off/group-mentions/group-all/direct/all)
- **QR code pairing**: `openclaw pairing generate --channel deltachat` for secure contact pairing
- **DM security policies**: `disabled`, `pairing`, `allowlist`, `open`
- **Group security policies**: `allowlist`, `open`; group config supports `requireMention`, `tools`, and `toolsBySender` per-sender overrides
- **Mention detection**: Bot name/emoji patterns gating group commands when `requireMention: true`
- **Media support**: Inbound and outbound media via Delta.Chat attachments; configurable `mediaMaxMb`
- **Chatmail support**: `chatmailQr` for privacy-focused account setup
- **Configurable data directory**: `dataDir` (default: `~/.openclaw/state/deltachat`)
- **Multiple accounts**: Account management with `accounts` config map
- **RPC server lifecycle**: Managed `rpc-server.ts` with connectivity deduplication and logger
- **Avatar setup**: Copies OpenClaw logo as bot avatar during account onboarding
- **Full test suite**: monitor, send, reactions, rpc-server, and utility test modules
- Follows OpenClaw plugin patterns: Zod schema validation, platform-specific npm optional dependencies, full channel interface
