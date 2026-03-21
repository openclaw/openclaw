## Feature Request: Transparent exec logging — show commands before/as they run

### Summary

When an agent uses the `exec` tool to run commands on the host machine, there is no built-in way for users to see what is being executed in real time — especially in chat-based sessions (Telegram, Discord, etc.) where the terminal is not visible.

### Problem

Users interacting with OpenClaw via messaging channels (Telegram, Discord, web chat) have no visibility into what shell commands are being run on their machine. The agent can silently execute git commits, push to remote repos, install software, or modify files — and the user only sees the final result (or nothing, if it runs in the background).

This creates a trust gap: users grant the agent exec access but have no transparency into what is actually running.

### Proposed Solution

Add a configuration option to log exec calls to the active channel before (or as) they run — without requiring confirmation:

```json
{
  "agents": {
    "defaults": {
      "execTransparency": "log"
    }
  }
}
```

Modes:

- `"off"` — current behavior (silent)
- `"log"` — post a brief notice to the channel before running: `🔧 Running: git push fork fix/... --no-verify`
- `"confirm"` — existing approval flow (require explicit approval)

### User Story

> As a user managing an AI agent via Telegram, I want to see what commands are being run on my machine — not to approve each one, but simply to have visibility and be able to catch anything unexpected.

### Why this matters

- Agents with exec access can make changes that are hard to reverse (git force-push, file deletions, config changes)
- Chat-only users have zero visibility into what is running
- `"log"` mode provides transparency with zero friction — no approval required, just awareness
- Aligns with responsible AI assistant design principles

### Prior art

- `set -x` in bash shows commands as they run
- `make --dry-run` previews what would execute
- Docker's `--progress=plain` shows build steps inline

### Implementation notes

The `exec` tool handler already has access to the command string before execution. A pre-execution hook that sends a brief message to the originating channel would be sufficient for `"log"` mode.
