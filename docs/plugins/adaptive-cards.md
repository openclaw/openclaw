---
summary: "Adaptive Cards plugin — inline structured UI for AI responses across iOS, Android, Teams, and web"
read_when:
  - Using or developing the adaptive-cards plugin
  - Adding interactive inline card responses to a channel
title: "Adaptive Cards"
---

# Adaptive Cards

Adaptive Cards give the AI agent a way to respond with **interactive, structured content** directly inline in the chat stream. Instead of walls of markdown text, the agent can render status dashboards, option pickers, data tables, forms, and fact sheets as native UI elements.

## Installation

Install the community plugin:

```bash
openclaw plugins install @vikrantsingh01/openclaw-adaptive-cards
```

No configuration needed. The plugin is stateless.

## How it works

When the agent decides that structured content is appropriate, it calls the `adaptive_card` tool. The tool assembles an [Adaptive Card v1.6](https://adaptivecards.io/explorer/) JSON payload, validates it against the official schema via [adaptive-cards-mcp](https://github.com/AiCodingBattle/adaptive-cards-mcp), and embeds it in the message text. Each client platform extracts the card and renders it natively:

| Platform       | Renderer               | First render |
| -------------- | ---------------------- | ------------ |
| iOS / macOS    | SwiftUI                | ~50ms        |
| Android        | Jetpack Compose        | ~50ms        |
| Teams          | Bot Framework          | Native       |
| Web            | Built-in renderer      | ~100ms       |
| Telegram       | HTML + inline keyboard | Server-side  |
| Slack          | Block Kit              | Server-side  |
| Discord        | Embeds + components    | Server-side  |
| Other channels | Plain text fallback    | Instant      |

### Validation and host compatibility

Cards are validated before delivery using the MCP bridge:

- **Schema validation** against the official Adaptive Cards v1.6 JSON Schema (AJV)
- **Host compatibility** checking across 7 hosts (Teams, Outlook, Web Chat, Windows, Viva Connections, Webex, Generic)
- **Accessibility scoring** (WCAG-based, 0-100) with automatic `speak` property injection
- **Host adaptation** that downgrades or replaces unsupported elements for target hosts

## When the agent uses cards

The plugin injects channel-aware guidance into the system prompt so the agent makes intelligent decisions:

**Use cards for:**

- Status dashboards and fact sheets
- Option pickers (tap instead of type)
- Progress tracking and step-by-step status
- Data tables and key-value summaries
- Search results and API response summaries
- Approval workflows and forms

**Use plain text for:**

- Conversational responses
- Long-form explanations
- Code output (use code blocks)
- Single-value answers

The agent automatically adapts based on the channel. On iOS/Android/Web, it uses full cards. On Telegram/Slack, it keeps cards simple (those channels translate cards to platform-native formats). On channels without card support, the agent prefers plain text.

## Adaptive Cards vs Canvas (A2UI)

OpenClaw has two GenUI systems that serve different purposes:

|                 | Adaptive Cards            | Canvas (A2UI)                   |
| --------------- | ------------------------- | ------------------------------- |
| **Where**       | Inline in chat bubbles    | Full-screen WebView overlay     |
| **Render time** | ~50ms (native)            | ~300-500ms (WebView)            |
| **Memory**      | ~1-2MB per card           | ~30-50MB (WebView process)      |
| **Use case**    | Quick inline interactions | Rich dashboards, visualizations |
| **Persistence** | Lives in chat history     | Persists to disk per session    |

Use cards for lightweight, inline, disposable interactions. Use Canvas for complex, interactive, persistent visual experiences.

## Card elements

The plugin supports [Adaptive Cards v1.6](https://adaptivecards.io/explorer/) body elements:

| Element           | What it renders                               |
| ----------------- | --------------------------------------------- |
| `TextBlock`       | Text with weight, size, color, wrap, markdown |
| `RichTextBlock`   | Styled inline text runs with links            |
| `CodeBlock`       | Code snippets with language label             |
| `FactSet`         | Key-value pairs                               |
| `ColumnSet`       | Multi-column layout                           |
| `Container`       | Grouped elements with optional emphasis       |
| `Image`           | Image with sizing, alt text, person style     |
| `ImageSet`        | Grid of images                                |
| `Table`           | Tabular data with headers                     |
| `ActionSet`       | Inline actions within the card body           |
| `Carousel`        | Multi-page swipeable content                  |
| `Accordion`       | Collapsible sections                          |
| `TabSet`          | Tabbed content panels                         |
| `Rating`          | Star rating display                           |
| `ProgressBar`     | Progress indicator with label                 |
| `Badge`           | Inline status badge                           |
| `CompoundButton`  | Button with title and description             |
| `Chart.*`         | Bar, Line, Pie, Donut charts                  |
| `Input.Text`      | Text input field (single/multiline)           |
| `Input.Number`    | Number input                                  |
| `Input.Date`      | Date picker                                   |
| `Input.Time`      | Time picker                                   |
| `Input.Toggle`    | On/off toggle                                 |
| `Input.ChoiceSet` | Dropdown or radio selection                   |

### Actions

| Action                    | Behavior                                         |
| ------------------------- | ------------------------------------------------ |
| `Action.Execute`          | Server-side action with card refresh (preferred) |
| `Action.Submit`           | Sends data payload back to the agent             |
| `Action.OpenUrl`          | Opens a URL in the browser                       |
| `Action.ShowCard`         | Reveals a nested card (toggleable)               |
| `Action.ToggleVisibility` | Shows or hides elements by ID                    |

### Layout patterns

The plugin includes 21 production-ready layout patterns powered by [adaptive-cards-mcp](https://github.com/AiCodingBattle/adaptive-cards-mcp):

Notifications, Approvals, Forms, Dashboards, Reports, Status updates, Profiles, Lists, Galleries, Carousels, Accordions, and more.

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
- `RichTextBlock` inline runs are concatenated
- `FactSet` facts become `title: value` lines
- `ColumnSet` and `Container` children are recursively extracted
- `Image` alt text is shown as `[Image: altText]`
- `Table` cells are joined with `|` separators
- `CodeBlock` content is rendered as fenced code blocks
- `Carousel` pages are extracted sequentially
- `Rating` is shown as star characters
- `Input` labels or placeholders are extracted

If the agent provides a `fallback_text` parameter, that takes precedence over auto-generation.

## Architecture

The card JSON is embedded in tool result text between HTML comment markers:

```
Here are your 3 tasks: Deploy API (done), Write tests (in progress).

<!--adaptive-card-->{"type":"AdaptiveCard","version":"1.6","body":[...]}<!--/adaptive-card-->
<!--adaptive-card-data-->{"projectId":"abc123"}<!--/adaptive-card-data-->
```

This design means:

- The gateway passes text through unmodified (no schema changes needed)
- Markers are invisible HTML comments on channels that do not parse them
- Each client independently decides whether to extract and render cards
- Template data travels alongside the card for `${expression}` client-side binding
- Backward compatible: users without the plugin see no change

## Related

- [Plugin repository](https://github.com/VikrantSingh01/openclaw-adaptive-cards) on GitHub
- [MCP server](https://github.com/AiCodingBattle/adaptive-cards-mcp) powering validation and patterns
- [Adaptive Cards v1.6 Schema Explorer](https://adaptivecards.io/explorer/)
- [Community plugins](/plugins/community) listing
