---
title: "Adaptive Cards"
description: "Native structured UI for AI responses across iOS, Android, Teams, and web"
---

# Adaptive Cards

Adaptive Cards give the AI agent a way to respond with **interactive, structured content** directly inline in the chat stream. Instead of walls of markdown text, the agent can render status dashboards, option pickers, data tables, forms, and fact sheets as native UI elements.

## How it works

When the agent decides that structured content is appropriate, it calls the `adaptive_card` tool. The tool assembles an [Adaptive Card v1.5](https://adaptivecards.io/explorer/) JSON payload and embeds it in the message text. Each client platform extracts the card and renders it natively:

| Platform | Renderer | First render |
|---|---|---|
| iOS / macOS | SwiftUI | ~50ms |
| Android | Jetpack Compose | ~50ms |
| Teams | Bot Framework | Native |
| Web | Built-in renderer | ~100ms |
| Telegram | HTML + inline keyboard | Server-side |
| Slack | Block Kit | Server-side |
| Discord | Embeds + components | Server-side |
| Other channels | Plain text fallback | Instant |

## Installation

Install the Adaptive Cards plugin:

```bash
openclaw plugins install @vikrantsingh01/openclaw-adaptive-cards
```

No configuration needed. The plugin is stateless.

## When the agent uses cards

The plugin injects guidance into the system prompt so the agent makes intelligent decisions:

**Use cards for:**
- Status dashboards and fact sheets
- Option pickers (tap instead of type)
- Progress tracking and step-by-step status
- Data tables and key-value summaries
- Search results and API response summaries

**Use plain text for:**
- Conversational responses
- Long-form explanations
- Code output (use code blocks)
- Single-value answers

The agent automatically adapts based on the channel. On iOS/Android/Web, it uses full cards. On Telegram/Slack, it keeps cards simple (those channels translate cards to platform-native formats). On channels without card support, the agent prefers plain text.

## Adaptive Cards vs Canvas (A2UI)

OpenClaw has two GenUI systems that serve different purposes:

| | Adaptive Cards | Canvas (A2UI) |
|---|---|---|
| **Where** | Inline in chat bubbles | Full-screen WebView overlay |
| **Render time** | ~50ms (native) | ~300-500ms (WebView) |
| **Memory** | ~2MB per card | ~30-50MB (WebView process) |
| **Use case** | Quick inline interactions | Rich dashboards, visualizations |
| **Persistence** | Lives in chat history | Ephemeral canvas session |

Use cards for lightweight, inline, disposable interactions. Use Canvas for complex, interactive, persistent visual experiences.

## Card elements

The plugin supports all [Adaptive Cards v1.5](https://adaptivecards.io/explorer/) body elements:

| Element | What it renders |
|---|---|
| `TextBlock` | Text with weight, size, color, wrap |
| `RichTextBlock` | Styled inline text runs |
| `FactSet` | Key-value pairs |
| `ColumnSet` | Multi-column layout |
| `Container` | Grouped elements with background |
| `Image` | Image with sizing and alt text |
| `ImageSet` | Grid of images |
| `Table` | Tabular data with headers |
| `Input.Text` | Text input field |
| `Input.Number` | Number input |
| `Input.Date` | Date picker |
| `Input.Toggle` | On/off toggle |
| `Input.ChoiceSet` | Dropdown or radio selection |

### Actions

| Action | Behavior |
|---|---|
| `Action.Submit` | Sends data payload back to the agent |
| `Action.OpenUrl` | Opens a URL in the browser |
| `Action.ShowCard` | Reveals a nested card (toggleable) |

## Testing

Use the `/acard` command to test card rendering:

```
/acard test              Send a test card to verify rendering
/acard validate {...}    Validate card JSON structure
/acard {...}             Send custom card JSON
```

## Fallback text

When a channel does not support cards, the plugin auto-generates plain text from the card body:

- `TextBlock` text is extracted directly
- `FactSet` facts become `title: value` lines
- `ColumnSet` and `Container` children are recursively extracted
- `Image` alt text is shown as `[Image: altText]`
- `Table` cells are joined with `|` separators
- `Input` labels or placeholders are extracted

If the agent provides a `fallback_text` parameter, that takes precedence over auto-generation.

## Architecture

The card JSON is embedded in tool result text between HTML comment markers:

```
Here are your 3 tasks: Deploy API (done), Write tests (in progress).

<!--adaptive-card-->{"type":"AdaptiveCard","version":"1.5","body":[...]}<!--/adaptive-card-->
```

This design means:
- The gateway passes text through unmodified (no schema changes needed)
- Markers are invisible HTML comments on channels that do not parse them
- Each client independently decides whether to extract and render cards
- Backward compatible: users without the plugin see no change

## Related

- [Plugin page](https://github.com/VikrantSingh01/openclaw-adaptive-cards) on GitHub
- [Adaptive Cards v1.5 Schema Explorer](https://adaptivecards.io/explorer/)
- [Community plugins](/plugins/community) listing
