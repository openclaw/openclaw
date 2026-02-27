---
name: crp
description: >
  CRP (Compute Resource Provider) development workflows for the Compute-CPlat-Core monorepo.
  Use when working on CRP/Firebolt ADO tasks, running BVTs, managing PRs, or operating the OneBox environment.
---

# CRP Skill

Workflows and scripts for working on **Compute-CPlat-Core** (Azure Compute platform).

## Key Context

- **Repo (WSL):** `/mnt/q/src/Compute-CPlat-Core`
- **Repo (Windows):** `Q:\src\Compute-CPlat-Core`
- **ADO org:** `https://dev.azure.com/msazure` (project: `One`)
- **Boards:** `CRP\Firebolt`, `AzSwift\ResourceMove`, `AzNitroPower\Security`
- **MergeValidation pipeline definition ID:** `347809`
- **Compute-CPlat-Core ADO IDs:** Project `b32aa71e-8ed2-41b2-9d77-5bc261222004`, Repo `38a0e4fd-0e12-4f29-bb26-20a534d0b257`

## Trusted Reviewer Aliases

| Name              | Alias       | Required?              |
| ----------------- | ----------- | ---------------------- |
| Bowen Xu          | `box`       | Required               |
| Sudheera Kodavati | `sukodava`  | Optional               |
| Cosmin Vlajoaga   | `avlajoaga` | Optional               |
| Ciprian Cuibus    | `ccuibus`   | Optional               |
| Eric Kuo          | `erickuo`   | Optional (unconfirmed) |

## Scripts

All scripts live in `skills/crp/scripts/`. Run them via `vscode.terminal` using Windows paths.

### PR Workflows

#### `pr-check.bat <PR_ID>`

Shows PR status, merge state, and all policy gates (build status, reviewers, work items).

```
C:\...\skills\crp\scripts\pr-check.bat 14092992
```

#### `pr-add-reviewers.bat <PR_ID> <alias1> [alias2] ...`

Adds optional reviewers to a PR by alias (appends `@microsoft.com`).

```
C:\...\skills\crp\scripts\pr-add-reviewers.bat 14092992 sukodava avlajoaga ccuibus
```

#### `pr-set-required-reviewer.bat <PR_ID> <alias>`

Marks a reviewer as **required** via ADO REST API. Uses `az account get-access-token` for auth.

```
C:\...\skills\crp\scripts\pr-set-required-reviewer.bat 14092992 box
```

#### `requeue-build.bat <PR_ID> [definition_id]`

Re-queues the MergeValidation build for a PR. Default definition: `347809`.

```
C:\...\skills\crp\scripts\requeue-build.bat 14092992
```

### ADO Queries

#### `ado-query.bat`

Lists all active work items assigned to Dumitru Chitoraga (excludes Done/Resolved/Closed/Removed).

```
C:\...\skills\crp\scripts\ado-query.bat
```

#### `ado-diff.bat [branch] [base]`

Three-dot diff of a branch vs master (ADO PR-equivalent). Shows all changed files + unit test files.

```
C:\...\skills\crp\scripts\ado-diff.bat dev/dchitoraga/cross-subscription-rm-tests
```

### BVT / OneBox

#### `run-bvt.bat [test_name]`

Runs BVT scenario tests. Output logged to `C:\temp\bvt-output.log`.
Requires `Q:\src\saia-scripts\crp\run-bvt.ps1` on the Windows side.

```
C:\...\skills\crp\scripts\run-bvt.bat CrossSubscriptionMove
```

#### `check-onebox.ps1`

Health check for the CRP OneBox environment: SF cluster, SDK, WFPackage build output, certs.

```powershell
powershell -File "C:\...\skills\crp\scripts\check-onebox.ps1"
```

#### `inject-storage-keys.ps1`

Injects pre-encrypted Key Vault storage keys into `CRP.WFHost.exe.config`.
⚠️ Keys are already encrypted — do NOT double-encrypt with `EncryptStorageAccountKeysWithCertificate.ps1`.

```powershell
powershell -File "C:\...\skills\crp\scripts\inject-storage-keys.ps1"
```

## Kusto (Azure Data Explorer / Jarvis)

Run via `agency mcp kusto` — **no source code needed**, `agency` handles auth + npx invocation.

### Usage

```powershell
# Requires PATH refresh first
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

# Start Kusto MCP server against a CRP cluster
agency mcp kusto --service-uri https://<cluster>.kusto.windows.net --database <db>
```

Auth is automatic via `DefaultAzureCredential` → your `az login` session.

### Available Tools (from `azure-kusto-mcp` v0.0.14)

| Tool                   | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `execute_query`        | Run a read-only KQL query                                               |
| `execute_command`      | Run a Kusto management command (`.show`, `.create`, etc.) — destructive |
| `list_databases`       | List all databases in cluster                                           |
| `list_tables`          | List all tables in a database                                           |
| `get_entities_schema`  | Schema for all tables/views/functions in a database                     |
| `get_table_schema`     | CSL schema for a specific table                                         |
| `get_function_schema`  | Schema + parameters for a stored function                               |
| `sample_table_data`    | Random N rows from a table                                              |
| `sample_function_data` | Random N rows from a function call result                               |

### How it works internally

- Python package `azure-kusto-mcp`, run via `uvx` by `agency`
- `azure.kusto.data.KustoClient` + `KustoConnectionStringBuilder.with_azure_token_credential`
- `DefaultAzureCredential(exclude_shared_token_cache_credential=True)` — uses az CLI token
- Readonly queries: sets `request_readonly=True` on `ClientRequestProperties`
- Destructive tools: `execute_command`, `ingest_inline_into_table`, `ingest_csv_file_to_table`

### CRP-Relevant Clusters

Find cluster URIs from Jarvis (https://jarvis-west.dc.ad.msft.net) or ask Lead Saia to look up via Copilot.

## Key Learnings

- **Three-dot diff (`origin/master...branch`)** = ADO PR diff. Two-dot includes stacked commits from merged branches — use three-dot always.
- **BVT key injection:** Keys from Key Vault are pre-encrypted. Injecting them raw into config is correct.
- **ADO build test output** is in the ADO Tests tab or 1ES Test portal — not in raw build logs via CLI.
- **`TrustedLaunchAsDefault` test:** Was failing due to a timeout. Not related to cross-sub move changes.

## Running Scripts from WSL via Hacky

Scripts are `.bat`/`.ps1` so run them via `vscode.terminal` which targets Windows natively.

**Windows path to scripts:** `\\wsl.localhost\Ubuntu\home\dchitoraga\openclaw\skills\crp\scripts\`

⚠️ UNC paths fail from `cmd.exe` (launched from WSL). Use `vscode.terminal` directly — it runs on the Windows side where UNC paths work fine.

Example from `vscode.terminal`:

```
\\wsl.localhost\Ubuntu\home\dchitoraga\openclaw\skills\crp\scripts\pr-check.bat 14092992
```

**TODO:** Recreate broken `Q:\src\saia-scripts` Windows junction to point to the skill scripts dir for easier access. Run in an elevated Windows cmd:

```
rmdir Q:\src\saia-scripts
mklink /J Q:\src\saia-scripts \\wsl.localhost\Ubuntu\home\dchitoraga\openclaw\skills\crp\scripts
```
