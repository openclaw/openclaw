# Shadow Logger Plugin

## Overview

The `shadow-logger` is a core component of the OpenClaw multi-layered memory system. It implements **Layer 1: Shadow Logging**, acting as a passive, high-reliability recorder of all dialogue events within the system.

## Architecture

This plugin follows the **"Shadow Logging"** approach. Instead of forcing the AI Agent to decide when to remember something (which introduces latency and decision-making overhead), the plugin "taps" into the internal data stream of OpenClaw.

### The Workflow

1.  **Event Capture:** The plugin listens for internal system hooks: `message:received` and `message:sent`.
2.  **Passive Recording:** Whenever these hooks fire, the plugin immediately captures the event payload.
3.  **Direct Persistence:** The payload is sent via a direct, encrypted HTTPS connection (using `@supabase/supabase-js`) to the `shadow_log.dialogues` table in Supabase.
4.  **Decoupling:** This process is entirely decoupled from the Agent's reasoning loop. The Agent remains fast and focused, while the memory foundation is built silently in the background.

## Technical Specification

### Data Flow

`[External Event (e.g. Telegram)]` $\rightarrow$ `[MCP Layer]` $\rightarrow$ `[OpenClaw Core]` $\rightarrow$ `[Internal Hook Trigger]` $\rightarrow$ **`[Shadow Logger Plugin]`** $\rightarrow$ `[Supabase (shadow_log.dialogues)]`

### Schema Design

The plugin writes to a dedicated, isolated schema to ensure security and separation from the public API: the `shadow_log.dialogues` table. This table is designed to capture the raw, unadulterated context of every interaction.

**Key Fields:**
- `id`: Unique identifier for the dialogue entry.
- `session_id`: The unique identifier for the conversation session.
- `direction`: `inbound` (received) or `outbound` (sent).
- `content`: The actual text of the message.
- `metadata`: A `JSONB` column containing the full original context (sender IDs, channel IDs, etc.), ensuring no information is lost.
- `created_at`: Timestamp of the event.

### Future Integration (Layer 2: Distillation)

The data recorded by this plugin serves as the raw material for **Layer 2: Semantic Distillation**. A separate background process (the "Refiner") will periodically consume the `shadow_log.dialogues` table to extract:
- **Episodic Memory:** Specific events and interactions.
- **Semantic Knowledge:** High-level concepts, facts, and relationships.
- **Long-term Knowledge:** Stabilized, distilled truths.

These will be stored in the dedicated `memory` schema.

## Installation & Configuration

The plugin is managed via `pnpm` workspaces.

### Environment Variables

Ensure the following are set in your `.env` file:

| Variable | Description |
| :--- | :--- |
| `SUPABASE_PROJECT_ID` | Your unique Supabase project identifier. |
| `SUPABASE_SECRET_KEY` | Your Supabase `service_role` secret key. |

## Implementation Details

- **Runtime:** Runs as a plugin within the OpenClaw process.
- **Hooks used:** `message:received`, `message:sent`.
- **Dependency:** `@supabase/supabase-js`.
