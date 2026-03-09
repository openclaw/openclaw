# Ada Voice Agent

LiveKit voice agent for Ada — real-time voice calls using Gemini Live 2.5 Flash Native Audio.

## Quick Reference

```bash
npm run dev    # Development: tsx main.ts dev
npm start      # Production: node --import tsx main.ts start
npm run build  # TypeScript compile to dist/
```

Systemd service: `systemctl --user restart livekit-agent`

## Stack

- LiveKit Agents SDK (`@livekit/agents` ^1.0.48)
- Gemini Live 2.5 Flash Native Audio via `@livekit/agents-plugin-google`
- Silero VAD for voice activity detection
- Zod for tool parameter schemas
- TypeScript 5 (ESM, strict), executed via `tsx`

## Environment Variables (.env.local)

```
LIVEKIT_URL                    # ws://localhost:7880
LIVEKIT_API_KEY                # API key
LIVEKIT_API_SECRET             # API secret
GOOGLE_CLOUD_PROJECT           # GCP project (shiftmindlab)
GOOGLE_CLOUD_LOCATION          # Region (us-central1)
GOOGLE_APPLICATION_CREDENTIALS # Path to service account JSON
OPENCLAW_GATEWAY_URL           # http://localhost:18789
OPENCLAW_GATEWAY_TOKEN         # Gateway auth token
OPENCLAW_AGENT_ID              # Session key (main)
```

## Project Structure

```
main.ts              # Entry point — defines agent, prewarms VAD, starts server
src/
  agent.ts           # AdaAgent class — tools, system instructions, personality
  context-loader.ts  # Loads Ada's context from ~/.openclaw/workspace/ files
  openclaw-bridge.ts # HTTP bridge to OpenClaw gateway for tool invocation
```

## Architecture

1. **Startup**: main.ts prewarms Silero VAD → defines agent entry → starts LiveKit server
2. **Connection**: Agent connects to LiveKit room, creates AgentSession with VAD + Gemini realtime LLM
3. **Voice call**: Audio streams via WebRTC, VAD detects speech, Gemini transcribes + responds with native audio
4. **Tools**: Agent calls tools during conversation → OpenClawBridge POSTs to gateway → result fed back to LLM

## Agent Tools

| Tool | What it does | Backend |
|------|-------------|---------|
| `send_whatsapp` | Send WhatsApp messages | Bridge → OpenClaw `message` tool |
| `send_telegram` | Send Telegram messages | Bridge → OpenClaw `message` tool |
| `memory_search` | Search Ada's memories | Bridge → OpenClaw `memory_search` |
| `memory_read` | Read specific memory files | Bridge → OpenClaw `memory_get` |
| `get_weather` | Current weather info | Direct HTTP to wttr.in |
| `web_fetch` | Fetch URL content | Bridge → OpenClaw `web_fetch` |

## Context Loading

`context-loader.ts` reads from `~/.openclaw/workspace/`:
- `SOUL.md` — core personality
- `IDENTITY.md` — identity/background
- `USER.md` — info about Anson
- `MEMORY.md` — long-term memories
- `memory/{YYYY-MM-DD}.md` — today's daily notes

Concatenated into the LLM system prompt.

## OpenClaw Bridge

- `OpenClawBridge.invokeTool(name, args)` → POST to gateway `/tools/invoke`
- Auth: `Bearer <OPENCLAW_GATEWAY_TOKEN>` header
- Returns string result or error message (never throws)

## Conventions

- TypeScript strict mode, ESM modules
- Class-based: `AdaAgent extends voice.Agent`
- Tool definitions use Zod schemas with async `execute` functions
- Error handling: try-catch with user-friendly string returns
- Files kept small and single-responsibility (<100 LOC each)
- camelCase variables/functions, PascalCase classes
