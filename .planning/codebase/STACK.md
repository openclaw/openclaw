# Technology Stack

**Analysis Date:** 2026-02-02

## Languages

**Primary:**
- TypeScript 5.9.3 - Core application code, CLI, and business logic
- Kotlin - Android mobile application

**Secondary:**
- Swift - iOS and macOS native applications
- JavaScript - Web UI (React-based)
- Shell scripting - Installation and deployment scripts

## Runtime

**Environment:**
- Node.js 22.12.0+ - Core runtime for CLI and server components
- Bun - Supported for TypeScript execution and development

**Package Manager:**
- pnpm@10.23.0 - Primary package manager with workspace support
- npm - Fallback for publishing and core operations

## Frameworks

**Core:**
- Hono 4.11.7 - Lightweight web framework for HTTP server
- Express 5.2.1 - REST API framework for gateway services
- ESM modules - Module system architecture

**Mobile:**
- Android Jetpack Compose - Native Android UI
- SwiftUI - Native iOS/macOS UI
- Kotlin Coroutines - Concurrency for Android

**Testing:**
- Vitest 4.0.18 - Test runner for unit and integration tests
- V8 coverage engine - Code coverage with 70% thresholds

**Build/Dev:**
- TypeScript Compiler - Main build system
- Oxlint 1.42.0 - Linting and type checking
- Oxfmt 0.27.0 - Code formatting
- Rolldown 1.0.0-rc.2 - Bundler for UI components

## Key Dependencies

**Critical:**
- @whiskeysockets/baileys 7.0.0-rc.9 - WhatsApp web client integration
- @slack/bolt 4.6.0 - Slack bot framework
- @line/bot-sdk 10.6.0 - LINE messaging API client
- @grammyjs/core 1.39.3 - Telegram bot framework
- Discord API Types 0.38.38 - TypeScript types for Discord

**AI/ML:**
- OpenAI 6.17.0 - OpenAI API client
- Anthropic SDK - Claude AI integration
- AWS SDK v3 @aws-sdk/client-bedrock - AWS Bedrock support
- Google AI APIs - Gemini integration
- Mistral AI SDK - Mistral model support
- Ollama 0.6.3 - Local LLM hosting

**Media Processing:**
- Sharp 0.34.5 - Image processing
- pdfjs-dist 5.4.624 - PDF processing
- @mozilla/readability 0.6.0 - Content extraction
- node-edge-tts 1.2.9 - Text-to-speech

**Database:**
- SQLite - Primary database via sqlite-vec 0.1.7-alpha.2
- LanceDB @lancedb/lancedb 0.23.0 - Vector database for memory extensions
- sqlite-vec - Vector search capabilities

**Infrastructure:**
- WebSocket (ws 8.19.0) - Real-time communication
- jiti 2.6.1 - TypeScript JIT execution
- dotenv 17.2.3 - Environment variable management

## Configuration

**Environment:**
- Configuration via environment variables
- .env file support with substitution
- CLI-based config management (`openclaw config`)

**Build:**
- TypeScript configuration in tsconfig.json
- Workspace-based monorepo structure
- Separate build configs for extensions and UI

## Platform Requirements

**Development:**
- Node.js 22.12.0+
- pnpm@10.23.0
- Bun (optional, for faster execution)
- macOS/Windows/Linux for development

**Production:**
- Node.js runtime
- macOS app bundle (Swift/SwiftUI)
- Android APK (Kotlin/Compose)
- iOS app bundle (Swift/SwiftUI)

---

*Stack analysis: 2026-02-02*
