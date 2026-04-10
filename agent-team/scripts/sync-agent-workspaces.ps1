[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$AgentId,
  [switch]$All,
  [switch]$Clean,
  [switch]$IncludeSharedSkills,
  [switch]$IncludeSharedState,
  [switch]$IncludeConfig,
  [switch]$Prune,
  [string]$OpenClawRoot = (Join-Path $HOME ".openclaw")
)

# sync-agent-workspaces.ps1
#
# Deploy the agent-team/ folder into $HOME\.openclaw as live agent workspaces.
#
# Usage:
#   ./sync-agent-workspaces.ps1 -All -IncludeSharedSkills -IncludeSharedState -IncludeConfig
#   ./sync-agent-workspaces.ps1 -All -Clean -IncludeSharedSkills -IncludeSharedState -IncludeConfig
#   ./sync-agent-workspaces.ps1 -AgentId scout -IncludeSharedState
#
# -Clean wipes $OpenClawRoot/workspace-*\ and $OpenClawRoot/skills\ before copying.
# -Clean never touches $OpenClawRoot/.env or $OpenClawRoot/openclaw.json (unless
# -IncludeConfig also passed, which rewrites openclaw.json from source).
#
# Script now lives at agent-team/scripts/sync-agent-workspaces.ps1.
# Repo root is resolved as the parent of agent-team/.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-TeamRoot {
  (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Get-RepoRoot {
  (Resolve-Path (Join-Path (Get-TeamRoot) "..")).Path
}

function Ensure-Directory {
  [CmdletBinding(SupportsShouldProcess = $true)]
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    if ($PSCmdlet.ShouldProcess($Path, "Create directory")) {
      New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
  }
}

function Get-ManagedChildren {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return @()
  }

  Get-ChildItem -LiteralPath $Path -Force | Where-Object {
    $_.Name -notin @(".git", ".DS_Store", "Thumbs.db")
  }
}

function Sync-DirectoryContent {
  [CmdletBinding(SupportsShouldProcess = $true)]
  param(
    [string]$Source,
    [string]$Destination,
    [switch]$Mirror
  )

  Ensure-Directory -Path $Destination -WhatIf:$WhatIfPreference

  $sourceChildren = Get-ManagedChildren -Path $Source
  $sourceNames = @{}

  foreach ($child in $sourceChildren) {
    $sourceNames[$child.Name] = $true
    $destChild = Join-Path $Destination $child.Name

    if ($child.PSIsContainer) {
      Sync-DirectoryContent -Source $child.FullName -Destination $destChild -Mirror:$Mirror -WhatIf:$WhatIfPreference
      continue
    }

    if ($PSCmdlet.ShouldProcess($destChild, "Copy file from $($child.FullName)")) {
      Copy-Item -LiteralPath $child.FullName -Destination $destChild -Force
    }
  }

  if (-not $Mirror) {
    return
  }

  foreach ($destChild in Get-ManagedChildren -Path $Destination) {
    if (-not $sourceNames.ContainsKey($destChild.Name)) {
      if ($PSCmdlet.ShouldProcess($destChild.FullName, "Remove stale item")) {
        Remove-Item -LiteralPath $destChild.FullName -Recurse -Force
      }
    }
  }
}

function Get-AgentWorkspacePath {
  param(
    [string]$Agent,
    [string]$Root
  )

  Join-Path $Root ("workspace-" + $Agent)
}

function Get-OpenClawConfigPath {
  param([string]$Root)

  Join-Path $Root "openclaw.json"
}

function Ensure-FilesIndex {
  param([string]$WorkspacePath)

  $filesDir = Join-Path $WorkspacePath "files"
  Ensure-Directory -Path $filesDir -WhatIf:$WhatIfPreference

  $indexPath = Join-Path $filesDir "index.md"
  if (-not (Test-Path -LiteralPath $indexPath)) {
    $body = @"
# Files Index

Append one line per artifact written, format: `YYYY-MM-DD HH:MM  filename  one-line summary`.
This index is the agent's own history of what it produced and when. Scan the tail at session start.
"@
    if ($PSCmdlet.ShouldProcess($indexPath, "Create files/index.md")) {
      Set-Content -LiteralPath $indexPath -Value $body -Encoding UTF8
    }
  }
}

$teamRoot = Get-TeamRoot
$repoRoot = Get-RepoRoot
$agentsRoot = Join-Path $teamRoot "agents"
$sharedSkillsRoot = Join-Path $teamRoot "shared-skills"
$sharedStateRoot = Join-Path $teamRoot "shared-state"
$configRoot = Join-Path $teamRoot "config"
$openClawConfigPath = Get-OpenClawConfigPath -Root $OpenClawRoot
$openClawCommand = Get-Command "openclaw" -ErrorAction SilentlyContinue
$canApplyIdentity = ($null -ne $openClawCommand) -and (Test-Path -LiteralPath $openClawConfigPath)

if (-not (Test-Path -LiteralPath $agentsRoot)) {
  throw "Missing agent-team/agents directory at $agentsRoot"
}

$knownAgents = Get-ChildItem -LiteralPath $agentsRoot -Directory |
  Sort-Object Name |
  Select-Object -ExpandProperty Name

if ($AgentId -and $All) {
  throw "Use either -AgentId or -All, not both."
}

if (-not $AgentId -and -not $All) {
  throw "Specify -AgentId <id> or -All."
}

if ($AgentId) {
  if ($AgentId -notin $knownAgents) {
    throw "Unknown agent id '$AgentId'. Known agents: $($knownAgents -join ', ')"
  }
  $targetAgents = @($AgentId)
} else {
  $targetAgents = $knownAgents
}

# --- Clean mode: wipe workspace-*/ and skills/, preserve .env + openclaw.json ---
if ($Clean) {
  Write-Host "Clean mode: wiping workspace-*/ and skills/ under $OpenClawRoot ..."
  if (Test-Path -LiteralPath $OpenClawRoot) {
    foreach ($ws in Get-ChildItem -LiteralPath $OpenClawRoot -Directory -Filter 'workspace-*') {
      if ($PSCmdlet.ShouldProcess($ws.FullName, "Remove stale workspace directory")) {
        Remove-Item -LiteralPath $ws.FullName -Recurse -Force
      }
    }
    $skillsDir = Join-Path $OpenClawRoot "skills"
    if (Test-Path -LiteralPath $skillsDir) {
      if ($PSCmdlet.ShouldProcess($skillsDir, "Remove stale skills directory")) {
        Remove-Item -LiteralPath $skillsDir -Recurse -Force
      }
    }
  }
  Write-Host "Clean complete. (.env and openclaw.json preserved.)"
  Write-Host ""
}

foreach ($targetAgent in $targetAgents) {
  $sourceAgentDir = Join-Path $agentsRoot $targetAgent
  $destWorkspace = Get-AgentWorkspacePath -Agent $targetAgent -Root $OpenClawRoot

  Ensure-Directory -Path $destWorkspace -WhatIf:$WhatIfPreference
  Sync-DirectoryContent -Source $sourceAgentDir -Destination $destWorkspace -Mirror:$Prune -WhatIf:$WhatIfPreference

  if ($IncludeSharedState) {
    $destShared = Join-Path $destWorkspace "shared"
    Sync-DirectoryContent -Source $sharedStateRoot -Destination $destShared -Mirror:$Prune -WhatIf:$WhatIfPreference
  }

  # Ensure per-agent files/ + files/index.md exist
  Ensure-FilesIndex -WorkspacePath $destWorkspace

  if ($canApplyIdentity) {
    if ($WhatIfPreference) {
      Write-Host "What if: Would apply agent identity for $targetAgent from $destWorkspace into $openClawConfigPath."
    } else {
      try {
        & $openClawCommand.Source "agents" "set-identity" "--agent" $targetAgent "--workspace" $destWorkspace "--from-identity" | Out-Null
        Write-Host "Applied identity from IDENTITY.md for $targetAgent."
      } catch {
        Write-Warning ("Failed to apply identity for {0} from {1}: {2}" -f $targetAgent, $destWorkspace, $_.Exception.Message)
      }
    }
  }
}

if ($IncludeSharedSkills) {
  $destSkillsRoot = Join-Path $OpenClawRoot "skills"
  Sync-DirectoryContent -Source $sharedSkillsRoot -Destination $destSkillsRoot -Mirror:$Prune -WhatIf:$WhatIfPreference
}

if ($IncludeConfig) {
  $sourceConfig = Join-Path $configRoot "openclaw.json"
  $destConfig = Join-Path $OpenClawRoot "openclaw.json"

  if (Test-Path -LiteralPath $sourceConfig) {
    if ($PSCmdlet.ShouldProcess($destConfig, "Copy config from $sourceConfig")) {
      Copy-Item -LiteralPath $sourceConfig -Destination $destConfig -Force
    }
  } else {
    Write-Warning "Config source not found: $sourceConfig"
  }

  $sourceScheduled = Join-Path $configRoot "scheduled-jobs.json"
  if (Test-Path -LiteralPath $sourceScheduled) {
    $destScheduled = Join-Path $OpenClawRoot "scheduled-jobs.json"
    if ($PSCmdlet.ShouldProcess($destScheduled, "Copy scheduled-jobs.json from $sourceScheduled")) {
      Copy-Item -LiteralPath $sourceScheduled -Destination $destScheduled -Force
    }
  }

  $sourceEnvExample = Join-Path $configRoot ".env.example"
  $sourceEnv = Join-Path $configRoot ".env"
  $destEnv = Join-Path $OpenClawRoot ".env"

  if (Test-Path -LiteralPath $destEnv) {
    Write-Host "Skipped .env copy because $destEnv already exists. Fill in tokens there manually."
  } elseif (Test-Path -LiteralPath $sourceEnv) {
    if ($PSCmdlet.ShouldProcess($destEnv, "Copy .env from $sourceEnv")) {
      Copy-Item -LiteralPath $sourceEnv -Destination $destEnv -Force
      Write-Host "Copied .env to $destEnv. Fill in real tokens before starting the gateway."
    }
  } elseif (Test-Path -LiteralPath $sourceEnvExample) {
    if ($PSCmdlet.ShouldProcess($destEnv, "Copy .env template from $sourceEnvExample")) {
      Copy-Item -LiteralPath $sourceEnvExample -Destination $destEnv -Force
      Write-Host "Copied .env.example template to $destEnv. Fill in real tokens before starting the gateway."
    }
  }
}

Write-Host "Synced agent workspaces: $($targetAgents -join ', ')"
if ($Clean) {
  Write-Host "Cleaned before sync."
}
if ($IncludeSharedState) {
  Write-Host "Included shared state."
}
if ($IncludeSharedSkills) {
  Write-Host "Included shared skills."
}
if ($IncludeConfig) {
  Write-Host "Included config (openclaw.json + scheduled-jobs.json + .env template)."
}
if (-not $canApplyIdentity) {
  Write-Host "Skipped live identity update because openclaw CLI or $openClawConfigPath was not found."
}
