# Performance Tuning

Common causes of slow responses and how to fix them.

## 1. MEMORY.md Too Large

**Symptom:** Every message takes 10-30 seconds. Compaction keeps firing.

**Cause:** `MEMORY.md` in your workspace is injected into every turn as
system context. A 25KB MEMORY.md adds ~8,000 tokens to every request.

**Fix:** Keep `MEMORY.md` under 2KB. Move details to `memory/*.md` files
which are searched on-demand via `memory_search`, not loaded every turn.

```markdown
# MEMORY.md — keep this lean
## Quick Reference
- Key fact 1
- Key fact 2
## Rules
- Important constraint
```

**Target:** Under 50 lines, under 2KB.

## 2. Context Window Saturation

**Symptom:** "Compaction failed: Compaction timed out" at 99% context.

**Cause:** Context fills up faster than compaction can shrink it.
Large workspace files (MEMORY.md, SOUL.md, AGENTS.md, TOOLS.md, etc.)
consume fixed space every turn, leaving less room for actual conversation.

**Fix:**
- Trim all workspace `.md` files to essentials
- Use `/new` to start fresh sessions for new tasks
- Set compaction mode to `safeguard` (triggers earlier)

```json5
{
  agents: {
    defaults: {
      compaction: { mode: "safeguard" }
    }
  }
}
```

## 3. Ollama Discovery Spam

**Symptom:** Repeated "Failed to discover Ollama models" in gateway logs.
Each attempt takes up to 5 seconds, blocking model resolution.

**Fix:** See [Suppress Ollama Discovery](./suppress-ollama-discovery.md).

```bash
export OPENCLAW_OLLAMA_DISABLED=1
```

## 4. Prompt Cache Misses

**Symptom:** 0% cache hit rate in `/status`. Every turn reprocesses
the entire context from scratch.

**Cause:** Any change to the system prompt prefix invalidates the
Anthropic prompt cache. If workspace files change between turns (even
timestamps), the cache breaks.

**Fix:**
- Avoid files that change on every turn (no timestamps in MEMORY.md)
- Keep workspace files stable between conversations
- Larger, fewer files cache better than many small ones

## 5. Heavy Workspace Injection

**Symptom:** Slow first response after gateway restart.

**Cause:** OpenClaw reads and injects all workspace `.md` files as
project context on every turn.

**Fix:**
- Only keep essential files in workspace root
- Move reference docs to subdirectories (not auto-injected)
- Keep total workspace `.md` size under 5KB

Files auto-injected:
- `MEMORY.md` — persistent context (keep small!)
- `SOUL.md` — persona/tone
- `AGENTS.md` — agent instructions
- `IDENTITY.md` — who the agent is
- `USER.md` — about the human
- `TOOLS.md` — tool-specific notes
- `HEARTBEAT.md` — periodic task list
- `BOOTSTRAP.md` — first-run setup

## 6. NOX/Python Import Chain

**Symptom:** Python scripts take 5-10 seconds to start. Warnings about
pynvml, torchao version mismatches.

**Cause:** Importing any `nox.*` module triggers `nox/__init__.py` which
eagerly imports the entire framework — GPU libraries, torch, CUDA, etc.

**Fix:** Import submodules directly, bypassing the chain:

```python
# Bad — triggers full NOX import
from nox.pitcrew import PitCrew

# Good — direct import
import sys
sys.path.insert(0, '/path/to/NOX/nox')
from pitcrew.crew import PitCrew
```

Or add lazy imports to `nox/__init__.py`.
