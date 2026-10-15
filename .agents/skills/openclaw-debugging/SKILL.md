---
name: openclaw-debugging
description: Debug OpenClaw model/provider/tool-surface/code-mode/streaming and live/Crabbox behavior; choose logs, probes, proof path before code changes; fetch stored sessions, transcripts, attachments as evidence.
---

# OpenClaw Debugging

Behavior differs between local tests, live models, providers, code mode, Tool
Search, Crabbox, CI: get debug signal before guessing.

## Read First

- `docs/logging.md`: log files, `openclaw logs`, targeted debug flags.
- `docs/reference/test.md`: local test commands.
- `docs/tools/code-mode.md`: code-mode exec/wait + tool catalog rules.
- `$openclaw-testing`: test-lane choice.
- `$crabbox`: broad, Docker, package, Linux, live-key, CI-parity proof.

## Default Loop

1. State suspected boundary: config, tool construction, provider payload, fetch,
   stream/SSE, transcript replay, worker/runtime, package/dist, CI.
2. Add/enable narrowest signal proving boundary.
3. Reproduce with same provider/model/config. Never randomly switch models
   unless model itself = tested variable.
4. Compare configured state with actual run activation.
5. Patch root cause.
6. Rerun exact failing probe; broaden only if contract requires.

## Model Transport Logs

Model request shape/stream timing: targeted env flags over global debug:

```bash
OPENCLAW_DEBUG_MODEL_TRANSPORT=1 openclaw gateway
OPENCLAW_DEBUG_MODEL_PAYLOAD=tools OPENCLAW_DEBUG_SSE=events openclaw gateway
OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted OPENCLAW_DEBUG_SSE=peek openclaw gateway
```

Useful flags:

- `OPENCLAW_DEBUG_MODEL_TRANSPORT=1`: request start, fetch response, SDK
  headers, first SSE event, stream done, transport errors at `info`.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=summary`: bounded payload summary.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=tools`: all model-facing tool names.
- `OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted`: capped, redacted JSON payload.
  Only while debugging; prompts/message text may still appear.
- `OPENCLAW_DEBUG_SSE=events`: first-event + stream-completion timing.
- `OPENCLAW_DEBUG_SSE=peek`: first five redacted SSE events.
- `OPENCLAW_DEBUG_CODE_MODE=1`: code-mode tool-surface diagnostics.

Watch logs:

```bash
openclaw logs --follow
```

## Common Boundaries

- **Config vs activation:** enabled config can coexist with disabled run tools,
  raw run, empty allowlist, missing model tool support. Check actual visible
  tools before enforcing provider payload invariants.
- **Tool surface:** inspect final model-visible tool names, not only registry/
  config. Code mode = exactly `exec` + `wait` only after actual activation.
- **Provider payload:** before SDK call, log fields, model id, service tier,
  reasoning, input size, metadata keys, prompt-cache key presence, tool names.
- **Fetch vs SSE:** fetch response proves HTTP headers arrived; first SSE event
  proves provider body progress. Gap here = stream/body/provider issue, not
  tool execution.
- **Worker/dist:** touching workers, dynamic imports, package exports, lazy
  runtime boundaries, published paths → `pnpm build`.
- **Live keys:** missing provider keys → configured secret workflow before
  declaring live proof blocked. Env checks presence-only; never print secrets.

## Fetching Sessions and Transcripts

Chat-session bug report: fetch actual transcript, sender attribution,
attachments as evidence.

CLI first (needs configured install; safe against live gateway):

```bash
openclaw sessions list --agent <agentId> --json
openclaw sessions tail
openclaw sessions export-trajectory
```

Docs: store layout `docs/reference/database-schemas.md`;
CLI https://docs.openclaw.ai/cli/sessions.

Raw store: CLI unavailable (e.g. remote host over SSH) or event-level detail needed:

- Per-agent data plane: `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`.
  Canonical schema: `src/state/openclaw-agent-schema.sql`.
- Hosted/systemd state: service user's home (e.g. `/home/openclaw/.openclaw/...`),
  not root's. Root may have separate stray install with different agents.
  Expected agent dir missing: locate real DB with
  `find / -maxdepth 6 -name openclaw-agent.sqlite`.
- Web chat URL session-id fragment: `/chat/<agentId>/<slug>-<hex>`.
  Resolve in `session_nodes`: `session_key LIKE '%<hex>%'` →
  `current_session_id`, `display_name`. Key shape:
  `agent:<agentId>:<surface>:<uuid>`; subagent sessions use surface `subagent`.
- Transcript: `transcript_events` (`session_id`, `seq`, `event_json`).
  `event_json.message`: `role` (`user`/`assistant`/`toolResult`) +
  `content` (string or parts of type `text`/`toolCall`/`image`).
- Sender provenance: real user messages carry `message.__openclaw`
  (`senderId`, `senderName`, `senderIsOwner`); runtime-synthesized inputs do not.
  Distinguish operator-authored text from injected prompts with this.
- Full-text transcript search: `session_transcript_fts`.
- Attachments: `media://inbound/<file>` URLs → `<state-dir>/media/inbound/<file>`.
- User-attached images ≠ `image` content parts. Message envelope carries
  `message.__openclaw.media[]` entries: `url` (`media://inbound/<file>`),
  `contentType`, `kind`, `fileName`. Parts-only extractor misses every image;
  grep raw `event_json` for `media://`. Remote host: scp files locally
  (one remote path per scp argument); read there.

Hosts without `sqlite3` binary still have Node: `node:sqlite` needs no dependencies.

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.argv[1],{readOnly:true});
console.log(JSON.stringify(db.prepare(
  "SELECT seq,event_json FROM transcript_events WHERE session_id=? ORDER BY seq"
).all(process.argv[2])))' <db-path> <session-id>
```

- Always open live stores `readOnly: true`; never write running gateway's state
  (root `AGENTS.md` Validation rules).
- Realistic-data work: copy DB into dev state dir first.

## Code Pointers

- Model payload + Responses stream:
  `src/agents/openai-transport-stream.ts`
- Guarded fetch/timing:
  `src/agents/provider-transport-fetch.ts`
- OpenAI/Codex provider wrappers:
  `src/llm/providers/stream-wrappers/openai.ts`
- Tool construction, Tool Search, code-mode activation:
  `src/agents/embedded-agent-runner/run/attempt.ts`
- Code-mode runtime and worker:
  `src/agents/code-mode.ts`
  `src/agents/code-mode.worker.ts`
- Tool Search catalog:
  `src/agents/tool-search.ts`

## Proof Choice

- Single helper/payload bug: local targeted Vitest.
- Docs/logging-only: `pnpm check:docs` + `git diff --check`.
- Worker/dist/lazy import/package surface: targeted tests + `pnpm build`.
- Live provider/model behavior: same provider/model, debug flags, real key if available.
- Docker/package/Linux/CI-parity: current dedicated Linux worker when capable;
  otherwise `$crabbox`.
- CI failure: exact SHA, relevant job only; logs only after failure/completion.

## Output Habit

Report:

- boundary tested
- exact command/env shape, redacted
- observed signal, e.g. tool names or first SSE event timing
- fix location
- narrow proof + remaining risk
