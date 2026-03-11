param(
  [string]$RepoRoot
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
} else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}

$RuntimeDir = Join-Path $ScriptDir "bin\runtime"
$BinDir = Join-Path $ScriptDir "bin"

function Copy-DirectoryRobust {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (!(Test-Path $Source)) {
    throw "$Label source directory not found: $Source"
  }
  if (Test-Path $Destination) {
    Remove-Item -Path $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null

  $RoboCopy = Get-Command robocopy -ErrorAction SilentlyContinue
  if ($RoboCopy) {
    & robocopy $Source $Destination /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /SL | Out-Null
    $RoboCode = $LASTEXITCODE
    if ($RoboCode -le 7) {
      return
    }
    throw "robocopy failed for $Label with exit code $RoboCode"
  }

  Copy-Item -Path $Source -Destination $Destination -Recurse -Force
}

Push-Location $RepoRoot
try {
  Write-Host "[build] compiling current repository..."
  & pnpm build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm build failed with exit code $LASTEXITCODE"
  }
  Write-Host "[build] building Control UI assets..."
  & pnpm ui:build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm ui:build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Host "[build] staging runtime into deployment\bin\runtime..."
if (Test-Path $RuntimeDir) {
  Remove-Item -Path $RuntimeDir -Recurse -Force
}
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

Copy-Item -Path (Join-Path $RepoRoot "openclaw.mjs") -Destination (Join-Path $RuntimeDir "openclaw.mjs") -Force
Copy-Item -Path (Join-Path $RepoRoot "dist") -Destination (Join-Path $RuntimeDir "dist") -Recurse -Force
Copy-Item -Path (Join-Path $RepoRoot "package.json") -Destination (Join-Path $RuntimeDir "package.json") -Force
$RuntimeDocsReferenceDir = Join-Path $RuntimeDir "docs\reference"
New-Item -ItemType Directory -Path $RuntimeDocsReferenceDir -Force | Out-Null
Copy-Item -Path (Join-Path $RepoRoot "docs\reference\templates") -Destination (Join-Path $RuntimeDocsReferenceDir "templates") -Recurse -Force
$PnpmLock = Join-Path $RepoRoot "pnpm-lock.yaml"
if (Test-Path $PnpmLock) {
  Copy-Item -Path $PnpmLock -Destination (Join-Path $RuntimeDir "pnpm-lock.yaml") -Force
}

$NodeModules = Join-Path $RepoRoot "node_modules"
if (!(Test-Path $NodeModules)) {
  throw "missing node_modules at repo root. Run 'pnpm install' first."
}
Write-Host "[build] bundling runtime dependencies into deployment\bin\runtime\node_modules..."
Copy-DirectoryRobust -Source $NodeModules -Destination (Join-Path $RuntimeDir "node_modules") -Label "node_modules"

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCommand) {
  $RawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $Arch = switch ($RawArch.ToUpperInvariant()) {
    "AMD64" { "x86_64" }
    "X86_64" { "x86_64" }
    "ARM64" { "arm64" }
    default { $null }
  }
  if ($Arch) {
    $TargetNode = Join-Path $BinDir "node-win-$Arch.exe"
    Copy-Item -Path $NodeCommand.Source -Destination $TargetNode -Force
    Write-Host "[build] bundled node: $TargetNode"
  }
}

Write-Host "[build] done: $RuntimeDir"
