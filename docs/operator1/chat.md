---
title: "Chat"
summary: "The primary interface for sending messages to agents, viewing conversation history, managing sessions, and using voice input and text-to-speech."
---

# Chat

Chat is where you talk with Operator1 agents. You can see past conversations, send messages, use voice, and attach files.

Go to **Chat** in the sidebar to start.

---

## Layout

The page has three main regions:

| Region                      | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| **Session sidebar** (left)  | Browse, search, and switch between conversations                        |
| **Message thread** (center) | Scrollable history of the active conversation                           |
| **Input area** (bottom)     | Compose and send messages with optional attachments, voice, and queuing |

The chat header runs across the top of the message thread showing the active agent and session controls.

---

## Session sidebar

The sidebar lists all sessions for the active agent, grouped by recency.

### Time groups

Sessions are organized into four time bands:

| Group          | Age                    |
| -------------- | ---------------------- |
| **Today**      | Less than 24 hours ago |
| **Yesterday**  | 24–48 hours ago        |
| **7 Days Ago** | 2–7 days ago           |
| **Older**      | More than 7 days ago   |

Each entry shows the session title (derived from the first message or a user-set label), a relative timestamp, and a token count badge.

### Channel icons

Sessions originating from external messaging channels display a colored icon indicating the source:

| Channel         | Icon color |
| --------------- | ---------- |
| Telegram        | Blue       |
| Discord         | Indigo     |
| Slack           | Emerald    |
| Signal          | Sky        |
| iMessage        | Green      |
| WhatsApp        | Green      |
| Web             | Primary    |
| Matrix          | Teal       |
| Microsoft Teams | Blue       |

Cron and heartbeat sessions are hidden from the default list.

### Pinned sessions

Pin any session to keep it at the top of the list regardless of recency. Pin/unpin via the session context menu. Pinned state is stored in `localStorage` and persists across page reloads.

### Session actions

Hover a session entry to reveal the `...` menu with:

| Action          | Description                                           |
| --------------- | ----------------------------------------------------- |
| **Rename**      | Set a custom label for the session                    |
| **Archive**     | Move the session out of the active list (recoverable) |
| **Delete**      | Permanently delete the session and its history        |
| **Pin / Unpin** | Toggle pinned status                                  |

### Search

A search input at the top of the sidebar filters sessions by title in real time.

### New Chat

Click **New Chat** (top of the sidebar) to start a fresh session. A new session key is generated from the current timestamp.

### Collapsing the sidebar

A chevron button on the sidebar edge collapses it to icon-only mode, giving the message thread more horizontal space.

---

## Chat header

The header at the top of the message thread shows context for the active session:

- **Agent emoji and name** — pulled from the agent's identity configuration
- **Agent role and department** — displayed as secondary text
- **Session title** — editable inline (click the pencil icon)
- **Model selector** — choose the AI model for this session
- **Archive** — archive the current session from the header

### Model selector

Click the model name to open a grouped dropdown showing all available models organized by provider (Anthropic, OpenAI, Google, and others). Each entry shows the model ID and context window size (e.g., `200k`). The selected model is applied to the next message sent.

---

## Message thread

The message thread shows the full conversation history for the active session.

### Message bubbles

Each message bubble shows:

- **Role indicator** — agent emoji + name for assistant messages; your identifier for user messages
- **Message content** — rendered as markdown (headings, code blocks, tables, lists)
- **Token delta** — for assistant messages, the cumulative context tokens used; for user messages, the incremental input tokens added this turn
- **Timestamp** — shown on hover

### Tool call cards

When an agent uses a tool, a collapsible **tool call card** appears inline. The card shows the tool name, input arguments, and the result. Click to expand/collapse. Use the **tool display mode** toggle in the input toolbar to show all tool cards expanded or collapsed globally.

To view the full output of a tool result, click **View output** on the card — this opens the **Context Panel** on the right as a scrollable viewer.

### Streaming bubble

While the agent is generating a response, a streaming bubble shows the partial output as it arrives. A **pause indicator** appears if the response stream is paused (queue mode). The bubble uses the same markdown rendering as finalized messages.

### Message actions

Hover any message to reveal action icons:

| Action         | Description                                                 |
| -------------- | ----------------------------------------------------------- |
| **Copy**       | Copy message text to clipboard                              |
| **Reply**      | Quote this message in the input field                       |
| **👍 / 👎**    | Rate the assistant response (submitted via `chat.feedback`) |
| **Regenerate** | Re-send the last user message and get a new response        |

Regenerate removes the last user message and everything after it from the thread, then re-sends the same content.

### Scroll controls

Two floating action buttons appear when you scroll away from the bottom:

- **Scroll to top** (↑) — appears after scrolling down more than 300 px
- **Scroll to bottom** (↓) — a **New messages** pill appears when new messages arrive while you are scrolled up; clicking it jumps to the latest message

---

## Input area

The input area sits at the bottom of the page and contains a textarea, a context bar, and an action toolbar.

### Textarea

Type your message and press **Enter** to send, or **Shift+Enter** for a newline. The placeholder rotates through agent-specific prompts to suggest what you can ask.

**Reply-to quote** — if you clicked Reply on a message, a quote block prefixes your draft. An `×` button clears the quote without affecting the rest of your text.

**Autocomplete** — typing special trigger characters opens an autocomplete menu:

| Trigger | Completes               |
| ------- | ----------------------- |
| `/`     | Slash commands (skills) |
| `@`     | Agent mentions          |
| `#`     | Session references      |

Use ↑ / ↓ to navigate, **Enter** to select, **Esc** to dismiss.

### Attachments

Click the **paperclip** icon to attach images. Image files are read as base64 and included in the message payload. Thumbnails of attached images appear above the textarea with an `×` to remove each one before sending.

### Voice input

Click the **microphone** icon to start voice input. The system uses browser-native speech recognition when available (real-time interim transcript displayed below the input). If browser speech recognition is unavailable or fails due to a network error, it automatically falls back to server-side transcription (requires a configured STT provider such as Whisper, OpenAI, or Groq). Transcribed text is appended to the current draft.

### Text-to-speech (TTS)

Click the **speaker** icon to cycle through TTS auto-play modes:

| Mode        | Behavior                                                         |
| ----------- | ---------------------------------------------------------------- |
| **Off**     | No auto-play                                                     |
| **Always**  | Speak every assistant response when streaming ends               |
| **Inbound** | Speak only responses triggered by inbound channel messages       |
| **Tagged**  | Speak only responses containing `[[tts]]` or `[[tts:text]]` tags |

The active mode is stored in the gateway config and persists across sessions. Markdown formatting (headings, bold, code, links) is stripped before synthesis.

### Queue mode

Queue mode lets you compose multiple messages before sending them. The agent processes them one at a time.

- **Add to queue** (list icon) — adds the current draft to the queue without sending immediately
- **Start queue** (play icon) — begins processing all queued messages in order
- **Stop queue** (stop icon) — halts queue processing after the current message finishes

The queue count badge on the toolbar shows how many messages are pending.

### Send / Stop

- While idle: **Send** button (or Enter) sends the message
- While generating: **Stop** button aborts the current run

### Tool display toggle

The wrench icon toggles tool call cards between **collapsed** and **expanded** display modes globally for the current session view.

### Context bar

A thin bar above the input toolbar shows context window usage for the active session:

```
12.4k / 200k  ████░░░░░░░░░░░░░░░░░░░░░
```

The filled portion represents how much of the model's context window is currently used. Values are formatted as `k` (thousands) or `M` (millions). When no model context window data is available, the bar is hidden.

---

## Empty state

When a session has no messages yet, a centered empty state panel shows quick-start suggestions. Click any suggestion to populate the input field.

---

## Keyboard shortcuts

| Key             | Action                     |
| --------------- | -------------------------- |
| **Enter**       | Send message               |
| **Shift+Enter** | Insert newline             |
| **↑ / ↓**       | Navigate autocomplete menu |
| **Esc**         | Dismiss autocomplete menu  |
