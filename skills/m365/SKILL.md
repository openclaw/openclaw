---
name: m365
description: >
  M365, ICM, and Copilot tooling via the 1ES Agency CLI. Use when working with ICM incidents,
  engineering Copilot (Bluebird), ES Chat, Microsoft Learn, WorkIQ (M365 Copilot), or
  Azure Security Context.
---

# M365 Skill

Workflows for 1ES Agency MCP servers — `agency` handles auth + proxying.

## Prerequisites

`agency` CLI must be in PATH. Refresh in PowerShell if not found:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
agency --version  # should print 2026.2.27.4 or later
```

Installed at: `C:\Users\dchitoraga\AppData\Roaming\agency\CurrentVersion\agency.exe`

Auth is via Windows credential broker (silent — no browser prompt needed). Tokens are acquired per-resource automatically.

---

## Available MCP Servers

| Server             | Status      | Notes                                                    |
| ------------------ | ----------- | -------------------------------------------------------- |
| `icm`              | ✅ Working  | HTTP/SSE proxy to `icm-mcp-prod.azure-api.net`           |
| `bluebird`         | ✅ Working  | HTTP/SSE proxy to `mcp.bluebird-ai.net` — code search    |
| `workiq`           | ✅ Working  | stdio via `@microsoft/workiq` npm; EULA accepted         |
| `kusto`            | ✅ Working  | Direct REST preferred — see CRP skill                    |
| `ado`              | ❓ Untested | `npx @azure-devops/mcp` — same auth pattern, should work |
| `es-chat`          | ❓ Untested | HTTP proxy                                               |
| `msft-learn`       | ❓ Untested | HTTP proxy                                               |
| `security-context` | ❓ Untested | HTTP proxy                                               |

---

## ICM — Incident Manager

```powershell
agency mcp icm
```

**Auth:** `az account get-access-token --resource api://icmmcpapi-prod` → scope `mcp.tools`
**Endpoint:** `https://icm-mcp-prod.azure-api.net/v1/`
**Protocol:** HTTP/SSE — `Accept: application/json, text/event-stream` (BOTH required)

### Tools (23 total)

| Tool                                     | Args                                 | Description                               |
| ---------------------------------------- | ------------------------------------ | ----------------------------------------- |
| `get_incident_details_by_id`             | `incidentId: int`                    | Full incident metadata                    |
| `get_incident_context`                   | `incidentId: str`                    | All original metadata for incident/outage |
| `get_ai_summary`                         | `incidentId: str`                    | AI-generated summary                      |
| `get_incident_location`                  | `incidentId: str`                    | Region, AZ, datacenter, cluster, node     |
| `get_incident_customer_impact`           | `incidentId: int`                    | Overall impact                            |
| `get_impacted_s500_customers`            | `incidentId: int`                    | S500 customer list                        |
| `get_impacted_ace_customers`             | `incidentId: int`                    | ACE customer list                         |
| `get_impacted_azure_priority0_customers` | `incidentId: int`                    | P0/Life & Safety customers                |
| `get_impacted_subscription_count`        | `incidentId: int`                    | Subscription count                        |
| `get_impacted_services_regions_clouds`   | `incidentId: int`                    | Affected services/regions/clouds          |
| `get_outage_high_priority_events`        | `incidentId: int`                    | High priority events                      |
| `get_similar_incidents`                  | `incidentId: int`                    | Similar past incidents                    |
| `get_mitigation_hints`                   | `incidentId: int`                    | Mitigation suggestions                    |
| `get_support_requests_crisit`            | `incidentId: int`                    | Linked SRs and CritSits                   |
| `is_specific_customer_impacted`          | `incidentId: int, customerName: str` | Check if specific customer impacted       |
| `search_incidents_by_owning_team_id`     | `teamId: int`                        | Search by owning team                     |
| `get_teams_by_name`                      | `teamName: str`                      | Team lookup by name                       |
| `get_teams_by_public_id`                 | `publicId: str`                      | Team lookup by `TenantName\TeamName`      |
| `get_team_by_id`                         | `teamId: int`                        | Team lookup by ID                         |
| `get_on_call_schedule_by_team_id`        | `teamIds: int[]`                     | On-call schedule                          |
| `get_contact_by_alias`                   | `alias: str`                         | Contact details by alias                  |
| `get_contact_by_id`                      | `contactId: int`                     | Contact details by ID                     |
| `get_services_by_names`                  | `names: str[]`                       | Service details                           |

### Raw REST Pattern (for direct queries without agency)

```powershell
$token = (az account get-access-token --resource "api://icmmcpapi-prod" | ConvertFrom-Json).accessToken

Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(30)
$client.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", "Bearer $token") | Out-Null
$client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json, text/event-stream") | Out-Null

function Send-Icm($client, $body) {
    $content = New-Object System.Net.Http.StringContent($body, [System.Text.Encoding]::UTF8, "application/json")
    $resp = $client.PostAsync("https://icm-mcp-prod.azure-api.net/v1/", $content).Result
    $reader = New-Object System.IO.StreamReader($resp.Content.ReadAsStreamAsync().Result)
    $deadline = (Get-Date).AddSeconds(20)
    while (-not $reader.EndOfStream -and (Get-Date) -lt $deadline) {
        $line = $reader.ReadLine()
        if ($line -match '^data:') { return ($line -replace '^data:\s*', '') }
    }
}

# Must initialize first, then send notifications/initialized before tool calls
Send-Icm $client '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}'
$client.PostAsync("https://icm-mcp-prod.azure-api.net/v1/", (New-Object System.Net.Http.StringContent('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}', [System.Text.Encoding]::UTF8, "application/json"))).Result | Out-Null

# Call a tool
Send-Icm $client '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_incident_details_by_id","arguments":{"incidentId":754650885}}}'
```

**Key gotchas:**

- `Invoke-WebRequest` / `Invoke-RestMethod` **do NOT work** — they block waiting for SSE stream to "complete" (it never does). Use `HttpClient` + `ReadAsStreamAsync`.
- Must send `notifications/initialized` after `initialize` before tool calls work
- `Accept` header must include BOTH `application/json` AND `text/event-stream` — either alone returns 406

---

## Bluebird — Engineering Copilot (Code Search)

```powershell
agency mcp bluebird --org msazure --project One --repo Compute-CPlat-Core
```

**Auth:** Windows broker → scope `499b84ac-1321-427f-aa17-267ca6975798/.default`
**Endpoint:** `https://mcp.bluebird-ai.net/` (HTTP/SSE)
**Server name:** `EngineeringCopilotMini`

**NOT a chat interface** — it's an indexed code search layer for the ADO repo.

### Tools

| Tool                  | Description                                                                      |
| --------------------- | -------------------------------------------------------------------------------- |
| `search_file_content` | Full-text search with AND/OR/NOT, `ext:`, `path:`, `class:`, `method:` operators |
| `search_file_paths`   | Search by filename only (not directory paths)                                    |
| `get_file_content`    | Get file content with optional `begin_line`/`end_line` range                     |

### Search Query Syntax

- Multiple keywords → ANDed: `validate revisit` matches files with BOTH
- `OR`: `validate OR revisit`
- `NOT`: `validate NOT revisit`
- Exact phrase: `"Client not found"`
- Extension filter: `validate ext:cs`
- File filter: `QueueJobsNow file:queueRegister*`
- Path filter: `validate path:/src/services`
- Code element prefixes (C#/C/C++/Java/VB.NET only): `class:StakeholderLicense`, `method:ValidateToken`, `enum:FeatureAvailabilityState`
- **IMPORTANT**: Prefixes only work for supported languages — don't use on PowerShell/Python/TypeScript

---

## WorkIQ — M365 Copilot

```powershell
agency mcp workiq
```

**Auth:** Microsoft account via `@microsoft/workiq` npm package
**EULA:** Already accepted (2026-03-02) — `accept_eula` tool called with `https://github.com/microsoft/work-iq-mcp`

### Tools

| Tool          | Description                                                         |
| ------------- | ------------------------------------------------------------------- |
| `accept_eula` | One-time EULA acceptance (already done)                             |
| `ask_work_iq` | Ask M365 Copilot questions about emails, meetings, files, M365 data |

**Note:** Takes ~20s to initialize (npm startup). Don't assume it's broken if there's a delay.

---

## VS Code MCP Config

Written to `Q:\src\Compute-CPlat-Core\.vscode\mcp.json`. Uses PowerShell wrapper to ensure PATH is refreshed:

```json
{
  "servers": {
    "icm": {
      "type": "stdio",
      "command": "powershell.exe",
      "args": [
        "-Command",
        "$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User'); agency mcp icm"
      ]
    },
    "bluebird": {
      "type": "stdio",
      "command": "powershell.exe",
      "args": [
        "-Command",
        "$env:Path = ...; agency mcp bluebird --org msazure --project One --repo Compute-CPlat-Core"
      ]
    },
    "workiq": {
      "type": "stdio",
      "command": "powershell.exe",
      "args": ["-Command", "$env:Path = ...; agency mcp workiq"]
    }
  }
}
```

⚠️ `.vscode/` is NOT gitignored in Compute-CPlat-Core — OK to commit since `agency` is corp standard.

---

## Key Learnings

- **WSL install fails** — `agency` install needs Windows PowerShell (tries to spawn `cmd.exe` for auth)
- **PATH refresh required** — installed to user PATH; existing shells won't see it until `$env:Path` is refreshed
- **Proxy MCPs = no local source** — ICM, Bluebird are HTTP proxies; agency injects auth. No npm/PyPI packages.
- **Kusto MCP = Python** — `azure-kusto-mcp` on PyPI, run via `uvx`. Direct REST is faster — see CRP skill.
- **ICM uses SSE streaming** — must use `HttpClient` + `ReadAsStreamAsync`; `Invoke-WebRequest` hangs
- **ICM `notifications/initialized` is required** — tools return `-32603` if you skip this step after `initialize`
- **WorkIQ is slow to start** (~20s npm init) — not broken, just slow
- **Bluebird is code search, not chat** — query with identifiers, not natural language
