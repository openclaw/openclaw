---
name: m365
description: >
  M365, ICM, and Copilot tooling via the 1ES Agency CLI. Use when working with ICM incidents,
  engineering Copilot (Bluebird), ES Chat, Microsoft Learn, WorkIQ (M365 Copilot), or
  Azure Security Context.
---

# M365 Skill

Workflows for 1ES Agency MCP servers — **no source code needed**, `agency` handles auth + proxying.

## Prerequisites

`agency` CLI must be in PATH. Refresh in PowerShell if not found:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
agency --version  # should print 2026.2.27.4 or later
```

Installed at: `C:\Users\dchitoraga\AppData\Roaming\agency\CurrentVersion\agency.exe`

Auth is automatic via EntraID (`az login` session). No tokens needed.

---

## Available MCP Servers

All proxy MCPs talk to HTTP endpoints — `agency` injects the EntraID Bearer token automatically.

### ICM — Incident Manager

```powershell
agency mcp icm
```

Use for: looking up live incidents by team/severity, checking if a BVT failure correlates with a known outage, querying incident history.

No extra args required — connects to `icm.ad.msft.net` REST API.

**Key questions to ask:**

- "Are there any active Sev1/Sev2 incidents for Azure Compute / CRP?"
- "Show me recent incidents for team `Compute CRP`"
- "Was there an incident on [date] affecting [region]?"

---

### Bluebird — Engineering Copilot Mini

```powershell
agency mcp bluebird --org msazure --project One --repo Compute-CPlat-Core
```

Use for: engineering knowledge questions, 1ES docs, build/pipeline guidance.

Options:

- `--org` / `--project` / `--repo` — auto-detected from git remote if omitted
- `--branch` — defaults to repo default branch
- `--mini` / `--full` — mode (mini = faster, less context)
- `--local` — force local STDIO mode (downloads from NuGet instead of HTTP proxy)

---

### ES Chat

```powershell
agency mcp es-chat
```

Use for: sending/reading ES Chat messages, channel interactions. Corp internal messaging proxy.

---

### Microsoft Learn

```powershell
agency mcp msft-learn
```

Use for: querying Microsoft Learn docs, getting SDK reference, finding official guidance.
Faster than web_fetch for corp/Azure docs.

---

### Azure Security Context

```powershell
agency mcp security-context
```

Use for: security posture queries, threat context, compliance checks.
Docs: https://aka.ms/security-ai

---

### WorkIQ — M365 Copilot Integration

```powershell
agency mcp workiq
```

Use for: M365 Copilot integrations, work item / task management via natural language.
Run via `npx @microsoft/workiq`.

---

## VS Code MCP Config

To wire MCPs into VS Code Copilot, add to `.vscode/mcp.json` in the repo:

```json
{
  "servers": {
    "kusto-crp": {
      "command": "agency",
      "args": [
        "mcp",
        "kusto",
        "--service-uri",
        "https://<cluster>.kusto.windows.net",
        "--database",
        "<db>"
      ],
      "type": "stdio"
    },
    "icm": {
      "command": "agency",
      "args": ["mcp", "icm"],
      "type": "stdio"
    },
    "bluebird": {
      "command": "agency",
      "args": [
        "mcp",
        "bluebird",
        "--org",
        "msazure",
        "--project",
        "One",
        "--repo",
        "Compute-CPlat-Core"
      ],
      "type": "stdio"
    },
    "ado": {
      "command": "agency",
      "args": ["mcp", "ado"],
      "type": "stdio"
    }
  }
}
```

Or globally at `~/.copilot/mcp-config.json` for all repos.

⚠️ `agency` must be in PATH when VS Code starts — set it in system env vars, not just the PowerShell session.

---

## Key Learnings

- **WSL install fails** — `agency` install needs Windows PowerShell (tries to spawn `cmd.exe` for auth)
- **PATH refresh required** — installed to user PATH; existing PowerShell sessions won't see it until `$env:Path` is refreshed or a new shell is opened
- **Proxy MCPs = no local source** — ICM, Bluebird, ES Chat, Security Context are HTTP proxies; agency injects auth. No npm/PyPI packages.
- **Kusto MCP = Python** — `azure-kusto-mcp` on PyPI, run via `uvx`. Source at `/tmp/azure_kusto_mcp-0.0.14/` (local copy from session 2026-02-27).
