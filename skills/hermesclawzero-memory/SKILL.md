---
name: hermesclawzero-memory
description: "Persistent memory capture/search against HermesClawZero sidecar API."
homepage: https://github.com/SunMe1977/HermesClawZero-ConfigSidecar
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "requires": { "bins": ["python"], "env": ["API_KEY"] },
        "primaryEnv": "API_KEY",
      },
  }
---

# HermesClawZero Memory

Use this skill to capture and retrieve long-term memory through the HermesClawZero sidecar API.

## Source
- Upstream project: https://github.com/SunMe1977/HermesClawZero-ConfigSidecar

## Configuration
- Base URL: `MEM_PUBLIC_URL` (preferred) or `OPENCLAW_URL`
- API key: `API_KEY` (preferred) or `OPENCLAW_KEY`
- Sync directory: `MEM_SYNC_DIR` (preferred) or `OPENCLAW_SYNC_DIR`

## Commands
```bash
python {baseDir}/scripts/memory.py capture "Important fact to remember"
python {baseDir}/scripts/memory.py search "what did we decide about deployment" 5
python {baseDir}/scripts/memory.py autosave "Session summary text" session-summary.md
```

## Notes
- `capture` sends text to `/capture`.
- `search` queries `/search` and prints JSON results.
- `autosave` writes a file to sync directory for sidecar indexing.

## Source
- Upstream project: https://github.com/SunMe1977/HermesClawZero-ConfigSidecar
