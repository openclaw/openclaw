# Integrations Documentation Index

This folder contains handoff and operational guides for third-party services integrated with OpenClaw.

## Files in this directory

### `ollama-handoff.md`

**Full paths for OpenClaw to locate:**

- **Absolute Windows path**: `C:\Users\gmone\Downloads\openclaw\docs\integrations\ollama-handoff.md`
- **Relative from repo root**: `docs/integrations/ollama-handoff.md`
- **Relative from docs root**: `integrations/ollama-handoff.md`
- **URL reference (in docs nav)**: `/integrations/ollama-handoff`

**Content includes:**
- OpenAI → Ollama migration guide (Llama 3.1 8B + Qwen 2.5 7B for 8 GB GPU)
- Config file setup and agent model switching
- Validation checklist and rollback plan
- Quick execution checklist for agent operations

### `supabase-handoff.md`

**Full paths for OpenClaw to locate:**

- **Absolute Windows path**: `C:\Users\gmone\Downloads\openclaw\docs\integrations\supabase-handoff.md`
- **Relative from repo root**: `docs/integrations/supabase-handoff.md`
- **Relative from docs root**: `integrations/supabase-handoff.md`
- **File size**: ~6.4 KB (6381 bytes)
- **Last updated**: 2026-03-03 @ 20:52 UTC

**URL reference (in docs nav):**
- `/integrations/supabase-handoff`

**Cross-references in main docs:**
- `docs/index.md` — Start here cards
- `docs/start/docs-directory.md` — Docs directory
- `docs/start/hubs.md` — Full documentation hubs (line 115)
- `docs/start/getting-started.md` — Go deeper cards
- `extensions/supabase/README.md` — Supabase extension docs

**Content includes:**
- Supabase minimal integration setup (zero-dependency, fetch-based)
- Environment variable configuration
- Helper module/script contract reference
- Common failure cases and fixes
- Agent troubleshooting checklist
- **Incident: Telegram gateway offline (2026-03-03)** with root cause, recovery, and prevention

---

## How to find this file

### From CLI (PowerShell)

```powershell
# Test existence
Test-Path "C:\Users\gmone\Downloads\openclaw\docs\integrations\supabase-handoff.md"

# Get file metadata
Get-Item "C:\Users\gmone\Downloads\openclaw\docs\integrations\supabase-handoff.md"

# List all files in integrations folder
Get-ChildItem "C:\Users\gmone\Downloads\openclaw\docs\integrations\"
```

### From VS Code

- Press `Ctrl+P` (Quick Open)
- Type: `supabase-handoff.md`
- Or: `integrations/supabase-handoff`

### From search

```bash
# From repo root
find . -name "supabase-handoff.md"
# On Windows PowerShell
Get-ChildItem -Path . -Recurse -Filter "supabase-handoff.md"
```

---

## Future integrations

This folder is the designated location for:
- Service wiring documentation
- Operational handoffs
- Incident runbooks
- Configuration guides

Add new integration docs here with similar structure (absolute paths, cross-references, metadata).
