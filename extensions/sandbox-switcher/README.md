# Sandbox Mode Quick Switcher

Quick switching between sandboxed/unsandboxed modes for the same local model.

## Use Case

When running local models (Ollama, LM Studio), you face a trade-off:

- **Unsandboxed (fast)**: No Docker overhead, but risky for file operations
- **Sandboxed (safe)**: Docker isolation, but slower startup

This extension makes switching instant via `/agent` command, with clear visibility of sandbox status.

## Configuration

Add agents with different sandbox modes to `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "list": [
      {
        "id": "qwen",
        "name": "Qwen (Fast)",
        "model": { "primary": "ollama/qwen3:8b" },
        "sandbox": { "mode": "off" }
      },
      {
        "id": "qwen-sandbox",
        "name": "Qwen (Safe)",
        "model": { "primary": "ollama/qwen3:8b" },
        "sandbox": { "mode": "all" }
      }
    ]
  }
}
```

## Usage

```bash
/agent              # Show selector with sandbox status:
                    #   qwen (qwen3:8b, sandbox: off)
                    #   qwen-sandbox (qwen3:8b, sandbox: all)

/agent qwen         # Fast mode: no Docker required
/agent qwen-sandbox # Safe mode: runs in Docker sandbox
```

## Features

- ✅ Shows sandbox mode before switching
- ✅ Validates Docker is running for sandboxed agents
- ✅ Opens new terminal window per agent
- ✅ Clean session isolation

## Platform Support

- ✅ macOS (Terminal.app via AppleScript)
- 🚧 Linux (TODO: gnome-terminal/xterm support)
- 🚧 Windows (TODO: Windows Terminal/cmd support)

## Example Workflow

1. **Code Review** (safe, read-only):

   ```bash
   /agent qwen    # Fast, no Docker needed
   ```

2. **Refactoring** (risky, writes files):
   ```bash
   /agent qwen-sandbox    # Safe, runs in Docker
   ```

## Author

First open source contribution by @pearyj
Built with AI pair programming assistance 🤖
