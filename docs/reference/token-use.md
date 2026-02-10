---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How OpenClaw builds prompt context and reports token usage + costs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Explaining token usage, costs, or context windows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging context growth or compaction behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Token Use and Costs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Token use & costs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw tracks **tokens**, not characters. Tokens are model-specific, but most（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenAI-style models average ~4 characters per token for English text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How the system prompt is built（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw assembles its own system prompt on every run. It includes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool list + short descriptions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills list (only metadata; instructions are loaded on demand with `read`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Self-update instructions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace + bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` when new, plus `MEMORY.md` and/or `memory.md` when present). Large files are truncated by `agents.defaults.bootstrapMaxChars` (default: 20000). `memory/*.md` files are on-demand via memory tools and are not auto-injected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Time (UTC + user timezone)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reply tags + heartbeat behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime metadata (host/OS/model/thinking)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See the full breakdown in [System Prompt](/concepts/system-prompt).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What counts in the context window（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Everything the model receives counts toward the context limit:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System prompt (all sections listed above)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Conversation history (user + assistant messages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool calls and tool results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attachments/transcripts (images, audio, files)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Compaction summaries and pruning artifacts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider wrappers or safety headers (not visible, but still counted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For a practical breakdown (per injected file, tools, skills, and system prompt size), use `/context list` or `/context detail`. See [Context](/concepts/context).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to see current token usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use these in chat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status` → **emoji‑rich status card** with the session model, context usage,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  last response input/output tokens, and **estimated cost** (API key only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage off|tokens|full` → appends a **per-response usage footer** to every reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Persists per session (stored as `responseUsage`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - OAuth auth **hides cost** (tokens only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage cost` → shows a local cost summary from OpenClaw session logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Other surfaces:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **TUI/Web TUI:** `/status` + `/usage` are supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **CLI:** `openclaw status --usage` and `openclaw channels list` show（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider quota windows (not per-response costs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost estimation (when shown)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Costs are estimated from your model pricing config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
models.providers.<provider>.models[].cost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are **USD per 1M tokens** for `input`, `output`, `cacheRead`, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`cacheWrite`. If pricing is missing, OpenClaw shows tokens only. OAuth tokens（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
never show dollar cost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cache TTL and pruning impact（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider prompt caching only applies within the cache TTL window. OpenClaw can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
optionally run **cache-ttl pruning**: it prunes the session once the cache TTL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
has expired, then resets the cache window so subsequent requests can re-use the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
freshly cached context instead of re-caching the full history. This keeps cache（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
write costs lower when a session goes idle past the TTL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure it in [Gateway configuration](/gateway/configuration) and see the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
behavior details in [Session pruning](/concepts/session-pruning).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Heartbeat can keep the cache **warm** across idle gaps. If your model cache TTL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is `1h`, setting the heartbeat interval just under that (e.g., `55m`) can avoid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
re-caching the full prompt, reducing cache write costs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For Anthropic API pricing, cache reads are significantly cheaper than input（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tokens, while cache writes are billed at a higher multiplier. See Anthropic’s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prompt caching pricing for the latest rates and TTL multipliers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example: keep 1h cache warm with heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      primary: "anthropic/claude-opus-4-6"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    models:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "anthropic/claude-opus-4-6":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        params:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          cacheRetention: "long"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      every: "55m"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tips for reducing token pressure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `/compact` to summarize long sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Trim large tool outputs in your workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep skill descriptions short (skill list is injected into the prompt).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer smaller models for verbose, exploratory work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Skills](/tools/skills) for the exact skill list overhead formula.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
