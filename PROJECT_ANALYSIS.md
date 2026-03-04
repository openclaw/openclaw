# OpenClaw — Phân tích dự án

> Ngày phân tích: 2026-02-24 | Phiên bản hiện tại: `2026.2.23`

---

## 1. Tổng quan

**OpenClaw** là một _personal AI assistant_ chạy trên thiết bị của người dùng (local-first).
Nó hoạt động như một **AI gateway đa kênh**: nhận tin nhắn từ nhiều nền tảng nhắn tin khác nhau, xử lý bằng LLM, và trả lời ngược lại qua cùng kênh đó hoặc bất kỳ kênh nào khác.

- **Repo:** https://github.com/openclaw/openclaw
- **Website:** https://openclaw.ai
- **Docs:** https://docs.openclaw.ai
- **License:** MIT
- **npm:** `openclaw` (dist-tag: `latest` / `beta` / `dev`)

---

## 2. Kiến trúc tổng thể

```
Messaging Channels (WhatsApp, Telegram, Slack, Discord, Teams, Signal, iMessage…)
                │
                ▼
    ┌───────────────────────────┐
    │         Gateway           │   ← Control plane (WebSocket)
    │   ws://127.0.0.1:18789    │   ← Quản lý sessions, channels, config, cron
    └────────────┬──────────────┘
                 │
    ┌────────────┼────────────────┐
    │            │                │
Pi Agent (RPC)  CLI             WebChat UI
(LLM runtime)  (openclaw …)    (browser frontend)
```

**Gateway** là trung tâm duy nhất: quản lý routing, sessions, presence, cron, webhooks và WebSocket connections. **Pi Agent** là runtime LLM (RPC mode) — xử lý prompt, tool calling, streaming. **CLI** (`openclaw …`) giao tiếp với gateway qua WebSocket.

---

## 3. Tech Stack

| Hạng mục           | Công nghệ                                 |
| ------------------ | ----------------------------------------- |
| Runtime            | Node.js ≥ 22 (Bun hỗ trợ cho dev/scripts) |
| Language           | TypeScript (ESM, strict mode)             |
| Package manager    | pnpm (lockfile: `pnpm-lock.yaml`)         |
| Build              | tsdown → `dist/`                          |
| Lint / Format      | Oxlint + Oxfmt (`pnpm check`)             |
| Tests              | Vitest + V8 coverage                      |
| CLI framework      | Commander + `@clack/prompts`              |
| Web framework      | Express 5                                 |
| WebSocket          | ws                                        |
| Protocol/Schema    | TypeBox + Zod                             |
| LLM runtime        | `@mariozechner/pi-agent-core` (Pi Agent)  |
| Mobile (iOS/macOS) | Swift / SwiftUI (`Observation` framework) |
| Mobile (Android)   | Kotlin / Jetpack Compose                  |

---

## 4. Cấu trúc thư mục

```
openclaw/
├── src/                     # Core source code
│   ├── cli/                 # CLI entry points, option wiring
│   ├── commands/            # Lệnh CLI (gateway, agent, send, onboard…)
│   ├── channels/            # Shared channel interfaces
│   ├── routing/             # Message routing logic
│   ├── gateway/             # Gateway control plane
│   ├── providers/           # Model providers (Anthropic, OpenAI, Bedrock…)
│   ├── agents/              # Agent session management
│   ├── sessions/            # Session store & lifecycle
│   ├── security/            # Exec allowlist, safe bins, prompt injection guard
│   ├── infra/               # Shared utilities (formatting, time, etc.)
│   ├── terminal/            # Terminal output (tables, themes, progress)
│   ├── media/               # Media pipeline (images, audio, video)
│   ├── tts/                 # Text-to-speech
│   ├── wizard/              # Onboarding wizard
│   ├── plugin-sdk/          # Plugin SDK public API
│   ├── slack/               # Slack channel (built-in)
│   ├── discord/             # Discord channel (built-in)
│   ├── telegram/            # Telegram channel (built-in)
│   ├── signal/              # Signal channel (built-in)
│   ├── imessage/            # iMessage legacy (built-in)
│   ├── web/                 # WhatsApp Web (Baileys) + WebChat
│   └── canvas-host/         # A2UI canvas host
│
├── extensions/              # Plugin/channel extensions (workspace packages)
│   ├── msteams/             # Microsoft Teams
│   ├── matrix/              # Matrix
│   ├── discord/             # Discord extension variant
│   ├── telegram/            # Telegram extension variant
│   ├── slack/               # Slack extension variant
│   ├── whatsapp/            # WhatsApp extension
│   ├── signal/              # Signal extension
│   ├── zalo/ + zalouser/    # Zalo channels
│   ├── voice-call/          # Voice call support
│   ├── memory-core/         # Memory plugin (core)
│   ├── memory-lancedb/      # Memory plugin (LanceDB/vector)
│   ├── lobster/             # Lobster UI theme
│   ├── bluebubbles/         # BlueBubbles (iMessage)
│   └── …                   # 35+ extensions tổng cộng
│
├── apps/
│   ├── macos/               # macOS menu bar app (Swift/SwiftUI)
│   ├── ios/                 # iOS node app (Swift/SwiftUI)
│   ├── android/             # Android node app (Kotlin)
│   └── shared/              # OpenClawKit shared Swift package
│
├── ui/                      # Web frontend (Control UI + WebChat) — Lit
├── docs/                    # Mintlify docs (docs.openclaw.ai)
├── skills/                  # Bundled skills
├── scripts/                 # Build, release, packaging scripts
├── packages/
│   ├── clawdbot/            # Bot runtime package
│   └── moltbot/             # Moltbot package
└── dist/                    # Build output (gitignored)
```

---

## 5. Channel / Messaging hỗ trợ

### Core (built-in)

| Channel           | Ghi chú                   |
| ----------------- | ------------------------- |
| WhatsApp          | Baileys (no official API) |
| Telegram          | grammY                    |
| Slack             | Bolt                      |
| Discord           | discord.js                |
| Signal            | signal-cli                |
| iMessage (legacy) | macOS only                |
| WebChat           | Built-in browser UI       |
| Google Chat       | Chat API                  |

### Extension (plugin)

| Channel                | Package                     |
| ---------------------- | --------------------------- |
| Microsoft Teams        | `extensions/msteams`        |
| Matrix                 | `extensions/matrix`         |
| Zalo                   | `extensions/zalo`           |
| Zalo Personal          | `extensions/zalouser`       |
| BlueBubbles (iMessage) | `extensions/bluebubbles`    |
| IRC                    | `extensions/irc`            |
| Mattermost             | `extensions/mattermost`     |
| Feishu/Lark            | `extensions/feishu`         |
| LINE                   | `extensions/line`           |
| Twitch                 | `extensions/twitch`         |
| Nostr                  | `extensions/nostr`          |
| Nextcloud Talk         | `extensions/nextcloud-talk` |
| Synology Chat          | `extensions/synology-chat`  |
| Tlon                   | `extensions/tlon`           |

---

## 6. AI Provider hỗ trợ

| Provider               | Ghi chú                                             |
| ---------------------- | --------------------------------------------------- |
| Anthropic (Claude)     | OAuth/API key, Claude Pro/Max, Opus 4.6 khuyến nghị |
| OpenAI (ChatGPT/Codex) | OAuth/API key                                       |
| AWS Bedrock            | Anthropic Claude + Nova/Mistral                     |
| Kilo Code              | Provider mới (2026.2.23)                            |
| Vercel AI Gateway      | Claude shorthand refs                               |
| OpenRouter             | Reasoning, nhiều model                              |
| Groq                   | Fast inference                                      |
| DashScope (Qwen)       | Alibaba                                             |
| MiniMax                | Portal auth                                         |
| Moonshot (Kimi)        | Web search tích hợp                                 |
| ZAI/GLM                | Zhipu AI                                            |
| Local (node-llama-cpp) | Peer dep, local inference                           |

---

## 7. Companion Apps

| Platform    | Tính năng                                                                |
| ----------- | ------------------------------------------------------------------------ |
| **macOS**   | Menu bar app, Voice Wake/PTT, Talk Mode, Canvas, WebChat, remote gateway |
| **iOS**     | Canvas, Voice Wake, Talk Mode, camera, screen record, Bonjour pairing    |
| **Android** | Canvas, Talk Mode, camera, screen record, optional SMS                   |

---

## 8. Tính năng nổi bật

- **Local-first Gateway**: control plane chạy local, không phụ thuộc cloud.
- **Multi-channel inbox**: 1 assistant trả lời trên nhiều kênh cùng lúc.
- **Multi-agent routing**: route kênh/tài khoản/peer sang các agent riêng biệt (workspace isolation).
- **Voice Wake + Talk Mode**: always-on speech macOS/iOS/Android (ElevenLabs TTS).
- **Live Canvas (A2UI)**: agent-driven visual workspace.
- **DM Security**: pairing code mặc định cho unknown senders; `dmPolicy="open"` phải explicit opt-in.
- **Skills platform**: bundled, managed, workspace skills với install gating.
- **Memory plugins**: memory-core (default) và memory-lancedb (vector DB).
- **MCP**: tích hợp qua `mcporter` (decoupled, không build vào core).
- **Cron + Webhooks + Gmail Pub/Sub**: automation triggers.
- **Browser control**: Playwright-based (dedicated Chromium).
- **Media pipeline**: images/audio/video, transcription, OCR.
- **Session model**: main session, group isolation, activation modes, queue modes.

---

## 9. Security Model

- **Trust boundary**: inbound DMs = untrusted. Pairing code trước khi xử lý.
- **Exec allowlist** (`safeBins`): kiểm soát binary nào agent được phép gọi.
- **Obfuscation detection**: block obfuscated shell commands trước khi exec.
- **Config redaction**: `config.get` snapshot tự động redact sensitive keys.
- **Prototype key guard**: ngăn path traversal qua `__proto__`/inherited props.
- **Principle**: strong defaults + explicit opt-in cho high-power workflows.

---

## 10. Plugin / Extension System

- Plugin load qua `jiti` (runtime TS import, không cần build trước).
- Plugin deps phải ở `dependencies` của extension `package.json` (không dùng `workspace:*` trong deps).
- `openclaw/plugin-sdk` là public API, export từ `dist/plugin-sdk/`.
- Memory: chỉ 1 plugin active tại một thời điểm.
- Skill mới ưu tiên publish lên **ClawHub** (`clawhub.ai`) thay vì merge vào core.

---

## 11. Release & Versioning

| Channel | Pattern             | npm tag  |
| ------- | ------------------- | -------- |
| stable  | `vYYYY.M.D`         | `latest` |
| beta    | `vYYYY.M.D-beta.N`  | `beta`   |
| dev     | git `main` (no tag) | `dev`    |

**Version locations cần cập nhật đồng bộ:**

- `package.json`
- `apps/android/app/build.gradle.kts`
- `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist`
- `apps/macos/Sources/OpenClaw/Resources/Info.plist`
- `docs/install/updating.md`

---

## 12. Development Commands

```bash
# Cài deps
pnpm install

# Build
pnpm build

# Dev (auto-reload)
pnpm gateway:watch

# Chạy CLI dev
pnpm openclaw <command>

# Type check
pnpm tsgo

# Lint + format check
pnpm check

# Format fix
pnpm format:fix

# Test
pnpm test

# Test coverage
pnpm test:coverage

# Build iOS
pnpm ios:build

# Build Android
pnpm android:assemble

# Build macOS app
bash scripts/package-mac-app.sh
```

---

## 13. Coding Conventions

- TypeScript ESM strict — không dùng `any`, không dùng `@ts-nocheck`.
- File ≤ 500–700 LOC (guideline, không hard limit).
- Test colocated: `*.test.ts` cạnh source.
- Import dùng `.js` extension (ESM).
- No prototype mutation — dùng class inheritance hoặc composition.
- Màu / progress: dùng `src/terminal/palette.ts`, `src/cli/progress.ts` (không hardcode ANSI).
- Tables: `src/terminal/table.ts`.
- `SwiftUI`: ưu tiên `@Observable` / `Observation` framework, không dùng `ObservableObject` mới.

---

## 14. Điểm chú ý khi phát triển

1. **Thêm kênh mới**: phải update tất cả UI surfaces (macOS, web, mobile), onboarding docs, status forms, routing, allowlists, pairing, `.github/labeler.yml`.
2. **Thêm extension**: deps của extension phải ở `extensions/<name>/package.json`, không root.
3. **Docs**: dùng Mintlify, internal links root-relative không có `.md`/`.mdx`.
4. **Commit**: dùng `scripts/committer "<msg>" <file…>` (scoped staging).
5. **Multi-agent safety**: không tạo/xóa git stash, worktree, không switch branch trừ khi được yêu cầu.
6. **Patching deps**: cần explicit approval, dùng exact version (không `^`/`~`).
7. **Carbon dependency**: không bao giờ update.

---

_File này được tạo tự động bằng cách phân tích source code, README, VISION.md, CHANGELOG.md, package.json và AGENTS.md._
