# Session Search

Session Search is an OpenClaw Control UI plugin for finding, inspecting, injecting, and resuming prior sessions.

It is intended for OpenClaw builds that support Plugin UI Entry Points, gateway-authenticated plugin HTTP routes, session transcript access, and the `before_prompt_build` plugin hook.

Build and focused tests passed on OpenClaw `2026.5.7` at `Ittiz/openclaw@1a68b5a09e` on Windows. Live Control UI injection was validated on OpenClaw `2026.5.10-beta.1` on MLserver. Newer compatible builds should work when they preserve the required host APIs below.

## Installation

This repository contains only the Session Search plugin files. Install it into a compatible OpenClaw source checkout or extension workspace.

Example source-checkout install:

```bash
cd /path/to/openclaw
mkdir -p extensions/session-search
cp -a /path/to/session-search-plugin/. extensions/session-search/
corepack pnpm install
corepack pnpm build
```

Then start or restart the OpenClaw gateway from that rebuilt checkout.

The plugin is loaded from `extensions/session-search/index.ts` and declares its metadata in `openclaw.plugin.json`.

## Requirements

- An OpenClaw build with Plugin UI Entry Points support.
- Plugin SDK support for `registerControlUiEntryPoint`.
- Gateway-authenticated plugin HTTP routes.
- The `before_prompt_build` plugin hook.
- Session store and transcript runtime APIs.
- Workspace bootstrap and memory-file conventions.

Older OpenClaw releases that do not include these host APIs will need the Plugin UI Entry Points core changes first.

## Features

- Adds a `Session Search` entry to the Control UI app navigation.
- Searches indexed and discovered session transcripts from the configured session store.
- Opens a session detail view with transcript metadata and message text.
- Shows an entire source session to the active agent with `Show Session to Agent`.
- Shows only selected messages to the active agent with `Show Selected Messages to Agent`.
- Marks gaps between non-consecutive selected messages so the receiving agent knows intervening messages existed.
- Clears selected messages when leaving a session detail view or switching sessions.
- Resumes a whole source session into a newly created OpenClaw session.
- Resumes from a specific message with `Resume Session from Here`, including only the source transcript up to and including that message.
- Blocks resume operations that exceed the active context window and shows `Session exceeds the active context window.` without creating or injecting a new session.

## Resume Behavior

Resume creates a new OpenClaw session and queues historical context for that new session's next prompt. It does not resurrect the original runtime state, shell sessions, browser state, hidden prompt bundle, or unsurfaced tool state.

Resume context includes:

- A resume manifest with source session key, id, title, channel, status, model/provider, timestamps, parent session key when present, source date anchor, and transcript count.
- The source transcript text, wrapped as historical conversation context.
- Daily memory files anchored to the source session date, not the current date. For example, a session dated May 24 includes the May 24 and May 23 daily memory files when they exist.
- Current workspace bootstrap markdown files that normal sessions would load. These are current file contents, not historical snapshots.

Resume from Here uses the same context model, but truncates the source transcript at the selected message.

## Agent Injection Behavior

`Show Session to Agent` and `Show Selected Messages to Agent` do not create a new session. They queue context for the currently active session and then return the user to chat.

These injection paths are intentionally transcript-focused:

- Full-session injection includes the source transcript.
- Selected-message injection includes only the selected transcript messages.
- Non-consecutive selected messages receive an omitted-message marker between included messages.
- Resume-only manifest and workspace file context are not included in these direct injection actions.

## Security Model

- Plugin pages are served through gateway-authenticated routes.
- The Control UI entry point requires `operator.read`.
- Browser requests send session keys and message indexes; transcript text is reread on the server.
- Resume and injection payloads are assembled server-side.
- The plugin does not call external services.

## Compatibility

Compatibility proof as of May 12, 2026:

- Build and focused Session Search tests passed on OpenClaw `2026.5.7` at `Ittiz/openclaw@1a68b5a09e` on Windows.
- Live Control UI session injection passed on OpenClaw `2026.5.10-beta.1` on MLserver.

This plugin is designed as an OpenClaw workspace/bundled extension. It imports OpenClaw plugin runtime helpers and expects a compatible OpenClaw build with:

- `registerControlUiEntryPoint`
- gateway-authenticated plugin HTTP routes
- `before_prompt_build`
- session store and transcript runtime APIs
- workspace bootstrap and memory file conventions

It is not currently packaged as a standalone npm plugin for older OpenClaw releases.

## Development

Focused test:

```bash
cd /path/to/openclaw
node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/session-search/index.test.ts
```

Lint:

```bash
cd /path/to/openclaw
node scripts/run-oxlint.mjs --tsconfig config/tsconfig/oxlint.extensions.json extensions/session-search
```

Format:

```bash
cd /path/to/openclaw
corepack pnpm exec oxfmt --write --threads=1 extensions/session-search
```

The running gateway executes built files from `dist`, so source changes must be rebuilt before testing through a live gateway.
