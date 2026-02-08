# Server-Side TTS for Web UI Chat

A step-by-step guide to adding natural-sounding server-side text-to-speech to the
OpenClaw web chat UI. This uses the gateway's existing TTS infrastructure (Edge TTS
by default -- Microsoft neural voices, free, no API key) and falls back to the
browser's built-in Speech API if the server is unreachable.

## Table of contents

- [Architecture overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Step 1: Create the TTS HTTP endpoint](#step-1-create-the-tts-http-endpoint)
- [Step 2: Register the handler in the gateway](#step-2-register-the-handler-in-the-gateway)
- [Step 3: Wire gateway URL and token into the chat UI](#step-3-wire-gateway-url-and-token-into-the-chat-ui)
- [Step 4: Update speakText() to use server-side TTS](#step-4-update-speaktext-to-use-server-side-tts)
- [TTS configuration reference](#tts-configuration-reference)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)
- [Appendix A: Complete source -- tts-http.ts](#appendix-a-complete-source----tts-httpts)
- [Appendix B: Complete source -- chat.ts changes](#appendix-b-complete-source----chatts-changes)
- [Appendix C: Complete source -- server-http.ts diff](#appendix-c-complete-source----server-httpts-diff)
- [Appendix D: Complete source -- app-render.ts diff](#appendix-d-complete-source----app-renderts-diff)

---

## Architecture overview

```
Browser (Web Chat UI)
  |
  | POST /api/tts/synthesize  { text: "Hello world" }
  | Authorization: Bearer <gateway-token>
  |
  v
Gateway HTTP Server (server-http.ts)
  |
  | handleTtsHttpRequest() -- auth check, parse JSON body
  |
  v
TTS Engine (src/tts/tts.ts)
  |
  | textToSpeech({ text, cfg })
  | Tries providers in order: primary -> fallbacks
  | Default: Edge TTS (no API key needed)
  |
  v
Audio file written to temp dir
  |
  | Stream file bytes back as Content-Type: audio/mpeg (or audio/opus, etc.)
  |
  v
Browser receives audio blob
  |
  | URL.createObjectURL(blob) -> new Audio(blobUrl) -> audio.play()
  |
  v
User hears natural neural voice

  [On any failure: falls back to browser SpeechSynthesis API]
```

### Data flow summary

1. User enables TTS via the speaker toggle button in the chat compose area
2. When an assistant reply arrives (or a stream finishes), `speakText()` fires
3. The cleaned text is POSTed to the gateway's `/api/tts/synthesize` endpoint
4. The gateway authenticates the request, calls `textToSpeech()`, and streams audio bytes back
5. The browser creates a blob URL, plays it via `HTMLAudioElement`
6. If any step fails (network error, 4xx/5xx, timeout), the browser Speech API is used as fallback

---

## Prerequisites

- **Node.js 22+** and **pnpm** installed
- An OpenClaw repository clone with the gateway buildable (`pnpm install && pnpm build`)
- The `node-edge-tts` package (already in OpenClaw's dependencies -- no extra install needed)
- No API keys required for Edge TTS (OpenAI/ElevenLabs are optional paid alternatives)

---

## Step 1: Create the TTS HTTP endpoint

Create a new file `src/gateway/tts-http.ts` that handles `POST /api/tts/synthesize`.

### What it does

- Matches only `POST /api/tts/synthesize` (returns `false` for other routes so the chain continues)
- Authenticates via Bearer token using the same `authorizeGatewayConnect` pattern as other HTTP handlers
- Reads a JSON body `{ text: string }` (max 16 KB)
- Calls `textToSpeech({ text, cfg })` from `src/tts/tts.ts`
- Streams the resulting audio file back with the correct `Content-Type` derived from the file extension
- Handles stream errors gracefully

### Key design decisions

1. **Auth pattern**: Reuses `authorizeGatewayConnect` + `getBearerToken` (same as `openai-http.ts`).
   The UI already stores a gateway token in `localStorage` and sends it with WebSocket connections --
   we reuse that same token for HTTP auth.

2. **Content-Type**: Derived dynamically from the audio file extension (`.mp3` -> `audio/mpeg`,
   `.opus` -> `audio/opus`, etc.) because Edge TTS output format is configurable.

3. **Cleanup**: The TTS engine (`textToSpeech`) schedules temp file cleanup on a 5-minute timer via
   `scheduleCleanup()`, so we don't need to clean up in the HTTP handler.

4. **Error handling**: The read stream has an `'error'` handler that responds with JSON if headers
   haven't been sent, or cleanly ends the response if they have.

See [Appendix A](#appendix-a-complete-source----tts-httpts) for the full source.

---

## Step 2: Register the handler in the gateway

In `src/gateway/server-http.ts`, add the import and register the handler in `handleRequest()`.

### Import

Add to the import block at the top of the file:

```typescript
import { handleTtsHttpRequest } from "./tts-http.js";
```

### Handler registration

Add the handler call in the `handleRequest()` function, after `handleSlackHttpRequest`
and before the plugin handler. The position matters -- handlers are tried sequentially
and the first match wins:

```typescript
if (await handleSlackHttpRequest(req, res)) {
  return;
}
// --- Add TTS handler here ---
if (
  await handleTtsHttpRequest(req, res, {
    auth: resolvedAuth,
    trustedProxies,
  })
) {
  return;
}
// --- End TTS handler ---
if (handlePluginRequest && (await handlePluginRequest(req, res))) {
  return;
}
```

See [Appendix C](#appendix-c-complete-source----server-httpts-diff) for the exact diff.

---

## Step 3: Wire gateway URL and token into the chat UI

The chat module needs the gateway's HTTP URL and auth token to call the TTS endpoint.
The simplest approach is module-level state set from the app render layer.

### In `ui/src/ui/views/chat.ts`

Add module-level state and an exported setter after the `voiceState` declaration:

```typescript
// --- Server-side TTS connection state ---
let ttsGatewayHttpUrl: string | null = null;
let ttsGatewayToken: string | null = null;

/** Set the gateway connection info for server-side TTS. Call from app-render. */
export function setTtsGatewayInfo(gatewayWsUrl: string, token: string) {
  // Convert ws:// -> http://, wss:// -> https://
  ttsGatewayHttpUrl = gatewayWsUrl
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/+$/, "");
  ttsGatewayToken = token || null;
}
```

### In `ui/src/ui/app-render.ts`

Import `setTtsGatewayInfo` alongside `renderChat`:

```typescript
import { renderChat, setTtsGatewayInfo } from "./views/chat.ts";
```

Call it before `renderChat` using a comma expression in the ternary:

```typescript
${
  state.tab === "chat"
    ? (setTtsGatewayInfo(state.settings.gatewayUrl, state.settings.token),
      renderChat(
        { /* ...existing props... */ },
        () => (state as any).requestUpdate?.(),
      ))
    : nothing
}
```

This ensures the gateway connection info is always current when the chat tab renders.
`state.settings.gatewayUrl` is the WebSocket URL (e.g. `ws://127.0.0.1:3000`) and
`state.settings.token` is the persisted gateway token from `localStorage`.

See [Appendix D](#appendix-d-complete-source----app-renderts-diff) for the exact diff.

---

## Step 4: Update speakText() to use server-side TTS

Refactor `speakText()` in `ui/src/ui/views/chat.ts` to try the server endpoint first.

### Extract the browser TTS into a helper

Rename the old `speakText` body to `speakWithBrowserTts(clean: string)`:

```typescript
function speakWithBrowserTts(clean: string) {
  if (!("speechSynthesis" in globalThis)) {
    return;
  }
  const utterance = new SpeechSynthesisUtterance(clean);
  if (preferredVoice) {
    utterance.voice = preferredVoice;
  }
  utterance.rate = 1.05;
  utterance.pitch = 1.0;
  utterance.onstart = () => {
    voiceState.speaking = true;
    ttsRerender?.();
  };
  utterance.onend = () => {
    voiceState.speaking = false;
    ttsRerender?.();
  };
  utterance.onerror = () => {
    voiceState.speaking = false;
    ttsRerender?.();
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}
```

### New `speakText()` with server-first approach

```typescript
function speakText(text: string) {
  if (!voiceState.ttsEnabled) {
    return;
  }
  const clean = cleanTextForSpeech(text);
  if (!clean) {
    return;
  }

  // Try server-side TTS first (Edge TTS neural voices)
  if (ttsGatewayHttpUrl) {
    voiceState.speaking = true;
    ttsRerender?.();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ttsGatewayToken) {
      headers.Authorization = `Bearer ${ttsGatewayToken}`;
    }

    fetch(`${ttsGatewayHttpUrl}/api/tts/synthesize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: clean }),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`TTS server error: ${res.status}`);
        }
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          voiceState.speaking = false;
          ttsRerender?.();
          URL.revokeObjectURL(url);
        };
        audio.onerror = () => {
          voiceState.speaking = false;
          ttsRerender?.();
          URL.revokeObjectURL(url);
        };
        audio.play().catch(() => {
          voiceState.speaking = false;
          ttsRerender?.();
          URL.revokeObjectURL(url);
        });
      })
      .catch(() => {
        // Fall back to browser TTS
        speakWithBrowserTts(clean);
      });
    return;
  }

  // Fallback: browser Speech API
  speakWithBrowserTts(clean);
}
```

### Key details

- **Blob URL lifecycle**: `URL.revokeObjectURL(url)` is called in all exit paths (`onended`,
  `onerror`, `play().catch()`) to prevent memory leaks during long sessions.
- **Fallback**: The `.catch()` on the entire fetch chain triggers `speakWithBrowserTts(clean)`,
  so any network/server failure silently falls back to browser voices.
- **Speaking state**: `voiceState.speaking` is set to `true` immediately when the fetch starts
  (so the UI shows the speaking indicator), and reset in all completion/error paths.

See [Appendix B](#appendix-b-complete-source----chatts-changes) for the complete changes.

---

## TTS configuration reference

TTS configuration lives under `messages.tts` in your OpenClaw config (`~/.openclaw/config.yaml`
or `openclaw.json`). The server-side endpoint uses whatever provider is configured.

### Minimal setup (Edge TTS, no API key)

No configuration needed beyond enabling TTS. Edge TTS is the default provider when no
API keys are present.

```yaml
messages:
  tts:
    auto: "always"
    provider: "edge"
```

### Edge TTS with custom voice

```yaml
messages:
  tts:
    auto: "always"
    provider: "edge"
    edge:
      enabled: true
      voice: "en-US-AriaNeural" # or en-US-MichelleNeural, en-GB-SoniaNeural, etc.
      lang: "en-US"
      outputFormat: "audio-24khz-48kbitrate-mono-mp3"
      rate: "+10%" # speak slightly faster
```

### Available Edge TTS voices (popular English)

| Voice                  | Gender | Accent       |
| ---------------------- | ------ | ------------ |
| `en-US-MichelleNeural` | Female | US (default) |
| `en-US-AriaNeural`     | Female | US           |
| `en-US-GuyNeural`      | Male   | US           |
| `en-US-JennyNeural`    | Female | US           |
| `en-GB-SoniaNeural`    | Female | British      |
| `en-GB-RyanNeural`     | Male   | British      |
| `en-AU-NatashaNeural`  | Female | Australian   |

Run `npx edge-tts --list-voices` for the full list.

### OpenAI TTS (paid, higher quality)

```yaml
messages:
  tts:
    auto: "always"
    provider: "openai"
    openai:
      apiKey: "sk-..." # or set OPENAI_API_KEY env var
      model: "gpt-4o-mini-tts" # or tts-1, tts-1-hd
      voice: "nova" # alloy, ash, coral, echo, fable, onyx, nova, sage, shimmer
```

### ElevenLabs TTS (paid, most natural)

```yaml
messages:
  tts:
    auto: "always"
    provider: "elevenlabs"
    elevenlabs:
      apiKey: "xi-..." # or set ELEVENLABS_API_KEY env var
      voiceId: "pMsXgVXv3BLzUgSXRplE"
      modelId: "eleven_multilingual_v2"
      voiceSettings:
        stability: 0.5
        similarityBoost: 0.75
        speed: 1.0
```

### Provider fallback order

If the primary provider fails, OpenClaw tries the remaining providers in order:
`[primary] -> [other providers]`. For example, if `provider: "openai"` and OpenAI fails,
it tries ElevenLabs (if keyed), then Edge TTS.

### Key config fields

| Field               | Type                           | Default                           | Description                          |
| ------------------- | ------------------------------ | --------------------------------- | ------------------------------------ |
| `auto`              | `off\|always\|inbound\|tagged` | `off`                             | When to auto-generate TTS            |
| `provider`          | `edge\|openai\|elevenlabs`     | `edge`                            | Primary TTS provider                 |
| `maxTextLength`     | number                         | `4096`                            | Hard cap for TTS input (chars)       |
| `timeoutMs`         | number                         | `30000`                           | API request timeout (ms)             |
| `edge.voice`        | string                         | `en-US-MichelleNeural`            | Edge neural voice name               |
| `edge.outputFormat` | string                         | `audio-24khz-48kbitrate-mono-mp3` | Edge output format                   |
| `edge.rate`         | string                         | (none)                            | Speech rate adjustment (e.g. `+10%`) |
| `edge.pitch`        | string                         | (none)                            | Pitch adjustment (e.g. `-5%`)        |

For the full configuration schema, see `src/config/types.tts.ts` and the
[TTS documentation](/tts).

---

## Verification

### 1. Build

```bash
pnpm build
```

Ensure no type errors.

### 2. Start the gateway

```bash
pnpm openclaw gateway run --port 3000
```

### 3. Open the web chat

```
http://localhost:5173/chat?session=agent:main:main&gatewayUrl=ws://127.0.0.1:3000
```

(Adjust the port to match your gateway.)

### 4. Test TTS

1. Click the speaker toggle button in the chat compose area to enable TTS
2. Send a message and wait for the assistant's reply
3. Verify you hear natural-sounding speech (Edge TTS neural voice)

### 5. Verify in browser DevTools

Open the Network tab and look for:

```
POST /api/tts/synthesize  ->  200  audio/mpeg  (some KB)
```

### 6. Test fallback

1. Stop the gateway
2. Send another message (or replay a cached session)
3. Verify the browser's built-in Speech API kicks in (mechanical-sounding voice)
4. No errors should appear in the console (the fallback is silent)

### 7. Test auth

```bash
curl -X POST http://localhost:3000/api/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello"}' \
  -w "\n%{http_code}\n"
```

Should return `401 Unauthorized` (no Bearer token).

With a valid token:

```bash
curl -X POST http://localhost:3000/api/tts/synthesize \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{"text": "Hello from OpenClaw"}' \
  --output test.mp3

# Play it
afplay test.mp3   # macOS
```

---

## Troubleshooting

### No audio plays, no network request visible

- Check that the speaker toggle button is active (highlighted)
- Ensure the gateway URL is correct in the UI settings (Overview tab -> Gateway Access)
- Check the browser console for errors

### 401 Unauthorized from the TTS endpoint

- The gateway token in the UI must match the gateway's configured auth
- Check Overview tab -> Gateway Token field
- For local development without auth, the gateway may accept local requests automatically

### Edge TTS fails with timeout

- Edge TTS depends on Microsoft's public endpoints -- it may be slow or unavailable
- Increase timeout: `messages.tts.edge.timeoutMs: 60000`
- Or switch to OpenAI/ElevenLabs as primary: `messages.tts.provider: "openai"`
- The endpoint will return a 500 with a JSON error; the UI falls back to browser TTS

### Audio plays but sounds wrong / cuts off

- Check `messages.tts.edge.outputFormat` -- the default MP3 format works best in browsers
- Ensure `maxTextLength` is not too low (default 4096 chars)
- Very long texts are truncated; enable summaries: `/tts summary on`

### Browser fallback voice sounds mechanical

This is expected -- browser voices use the OS's built-in speech synthesis. The code
selects the best available voice (macOS Premium > Enhanced > Google > Microsoft > basic),
but quality varies by OS. The server-side TTS (Edge/OpenAI/ElevenLabs) is the primary
path for natural-sounding speech.

---

## Appendix A: Complete source -- tts-http.ts

File: `src/gateway/tts-http.ts`

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { loadConfig } from "../config/config.js";
import { textToSpeech } from "../tts/tts.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendMethodNotAllowed,
  sendUnauthorized,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const AUDIO_CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".wav": "audio/wav",
};

function resolveAudioContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return AUDIO_CONTENT_TYPES[ext] ?? "audio/mpeg";
}

type TtsHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
};

const MAX_BODY_BYTES = 16 * 1024;

export async function handleTtsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TtsHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/tts/synthesize") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
  if (body === undefined) {
    return true;
  }

  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    sendInvalidRequest(res, "Missing or empty `text` field.");
    return true;
  }

  const cfg = loadConfig();
  const result = await textToSpeech({ text, cfg });

  if (!result.success || !result.audioPath) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: result.error ?? "TTS conversion failed" }));
    return true;
  }

  try {
    const stat = statSync(result.audioPath);
    const contentType = resolveAudioContentType(result.audioPath);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);
    const stream = createReadStream(result.audioPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Failed to stream audio file" }));
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Failed to read audio file" }));
  }

  return true;
}
```

---

## Appendix B: Complete source -- chat.ts changes

File: `ui/src/ui/views/chat.ts`

### Addition 1: Server-side TTS state (after voiceState declaration)

```typescript
// --- Server-side TTS connection state ---
let ttsGatewayHttpUrl: string | null = null;
let ttsGatewayToken: string | null = null;

/** Set the gateway connection info for server-side TTS. Call from app-render. */
export function setTtsGatewayInfo(gatewayWsUrl: string, token: string) {
  // Convert ws:// -> http://, wss:// -> https://
  ttsGatewayHttpUrl = gatewayWsUrl
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/+$/, "");
  ttsGatewayToken = token || null;
}
```

### Addition 2: Browser TTS helper (extracted from old speakText)

```typescript
function speakWithBrowserTts(clean: string) {
  if (!("speechSynthesis" in globalThis)) {
    return;
  }
  const utterance = new SpeechSynthesisUtterance(clean);
  if (preferredVoice) {
    utterance.voice = preferredVoice;
  }
  utterance.rate = 1.05;
  utterance.pitch = 1.0;
  utterance.onstart = () => {
    voiceState.speaking = true;
    ttsRerender?.();
  };
  utterance.onend = () => {
    voiceState.speaking = false;
    ttsRerender?.();
  };
  utterance.onerror = () => {
    voiceState.speaking = false;
    ttsRerender?.();
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}
```

### Addition 3: New speakText() with server-first approach

```typescript
function speakText(text: string) {
  if (!voiceState.ttsEnabled) {
    return;
  }
  const clean = cleanTextForSpeech(text);
  if (!clean) {
    return;
  }

  // Try server-side TTS first (Edge TTS neural voices)
  if (ttsGatewayHttpUrl) {
    voiceState.speaking = true;
    ttsRerender?.();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ttsGatewayToken) {
      headers.Authorization = `Bearer ${ttsGatewayToken}`;
    }

    fetch(`${ttsGatewayHttpUrl}/api/tts/synthesize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: clean }),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`TTS server error: ${res.status}`);
        }
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          voiceState.speaking = false;
          ttsRerender?.();
          URL.revokeObjectURL(url);
        };
        audio.onerror = () => {
          voiceState.speaking = false;
          ttsRerender?.();
          URL.revokeObjectURL(url);
        };
        audio.play().catch(() => {
          voiceState.speaking = false;
          ttsRerender?.();
          URL.revokeObjectURL(url);
        });
      })
      .catch(() => {
        // Fall back to browser TTS
        speakWithBrowserTts(clean);
      });
    return;
  }

  // Fallback: browser Speech API
  speakWithBrowserTts(clean);
}
```

---

## Appendix C: Complete source -- server-http.ts diff

File: `src/gateway/server-http.ts`

### Import addition (at top of file, with other handler imports)

```diff
 import { handleOpenAiHttpRequest } from "./openai-http.js";
 import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
 import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";
+import { handleTtsHttpRequest } from "./tts-http.js";
```

### Handler registration (inside handleRequest(), after handleSlackHttpRequest)

```diff
       if (await handleSlackHttpRequest(req, res)) {
         return;
       }
+      if (
+        await handleTtsHttpRequest(req, res, {
+          auth: resolvedAuth,
+          trustedProxies,
+        })
+      ) {
+        return;
+      }
       if (handlePluginRequest && (await handlePluginRequest(req, res))) {
         return;
       }
```

---

## Appendix D: Complete source -- app-render.ts diff

File: `ui/src/ui/app-render.ts`

### Import change

```diff
-import { renderChat } from "./views/chat.ts";
+import { renderChat, setTtsGatewayInfo } from "./views/chat.ts";
```

### Render call change (in the chat tab ternary)

```diff
         ${
           state.tab === "chat"
-            ? renderChat(
+            ? (setTtsGatewayInfo(state.settings.gatewayUrl, state.settings.token),
+              renderChat(
                 {
                   /* ...existing props unchanged... */
                 },
                 () => (state as any).requestUpdate?.(),
-              )
+              ))
             : nothing
         }
```

---

## Files modified summary

| File                         | Action   | Purpose                                          |
| ---------------------------- | -------- | ------------------------------------------------ |
| `src/gateway/tts-http.ts`    | **New**  | HTTP handler for `POST /api/tts/synthesize`      |
| `src/gateway/server-http.ts` | Modified | Register handler in the sequential chain         |
| `ui/src/ui/views/chat.ts`    | Modified | Server-first `speakText()` with browser fallback |
| `ui/src/ui/app-render.ts`    | Modified | Pass gateway URL + token to chat TTS module      |
