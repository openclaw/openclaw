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

function Remove-DirectoryRobust {
  param(
    [Parameter(Mandatory = $true)][string]$PathToRemove
  )

  if (!(Test-Path -LiteralPath $PathToRemove)) {
    return
  }

  # PowerShell Remove-Item can fail on deep/cyclic pnpm trees on Windows.
  # Use cmd rmdir first, then fall back to long-path .NET delete if needed.
  & cmd /c "rmdir /s /q `"$PathToRemove`"" 2>$null | Out-Null
  if (Test-Path -LiteralPath $PathToRemove) {
    try {
      Remove-Item -LiteralPath $PathToRemove -Recurse -Force -ErrorAction Stop
    } catch {
      if (Test-Path -LiteralPath $PathToRemove) {
        try {
          $FullPath = [System.IO.Path]::GetFullPath($PathToRemove)
          $LongPath = if ($FullPath.StartsWith("\\?\")) { $FullPath } else { "\\?\$FullPath" }
          [System.IO.Directory]::Delete($LongPath, $true)
        } catch {
          if (Test-Path -LiteralPath $PathToRemove) {
            throw "failed to remove directory: $PathToRemove"
          }
        }
      }
    }
  }
}

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
    Remove-DirectoryRobust -PathToRemove $Destination
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

function Assert-NoExternalLinks {
  param(
    [Parameter(Mandatory = $true)][string]$RootPath
  )

  if (!(Test-Path -LiteralPath $RootPath)) {
    return
  }

  $NormalizedRoot = [System.IO.Path]::GetFullPath($RootPath).TrimEnd('\')
  $ReparseItems = Get-ChildItem -LiteralPath $RootPath -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue
  foreach ($Item in $ReparseItems) {
    $Targets = @()
    if ($null -ne $Item.Target) {
      if ($Item.Target -is [Array]) {
        $Targets = $Item.Target
      } else {
        $Targets = @($Item.Target)
      }
    }

    foreach ($RawTarget in $Targets) {
      if ([string]::IsNullOrWhiteSpace($RawTarget)) {
        continue
      }

      $ResolvedTarget = $RawTarget
      if (-not [System.IO.Path]::IsPathRooted($RawTarget)) {
        $ResolvedTarget = Join-Path $Item.DirectoryName $RawTarget
      }

      try {
        $NormalizedTarget = [System.IO.Path]::GetFullPath($ResolvedTarget).TrimEnd('\')
      } catch {
        continue
      }

      if (!$NormalizedTarget.StartsWith($NormalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "external link detected under runtime: $($Item.FullName) -> $RawTarget"
      }
    }
  }
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
  Remove-DirectoryRobust -PathToRemove $RuntimeDir
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

Write-Host "[build] bundling runtime dependencies into deployment\bin\runtime\node_modules..."
Push-Location $RuntimeDir
try {
  & pnpm install --prod --frozen-lockfile --ignore-workspace --config.link-workspace-packages=false --config.prefer-workspace-packages=false --config.inject-workspace-packages=false --config.package-import-method=copy
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install (runtime) failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Assert-NoExternalLinks -RootPath $RuntimeDir

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
    Copy-Item -Path $NodeCommand.Source -Destination (Join-Path $RuntimeDir "node-win-$Arch.exe") -Force
    Write-Host "[build] bundled node: $TargetNode"
  }
}

Write-Host "[build] done: $RuntimeDir"
