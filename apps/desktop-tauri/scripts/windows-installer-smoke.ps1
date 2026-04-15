[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet("nsis", "msi")]
  [string]$InstallerType,

  [string]$MsiLogPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-InstallRoot {
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenClaw Beta",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenClaw Beta",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\OpenClaw Beta"
  )

  foreach ($root in $roots) {
    if (Test-Path -LiteralPath $root) {
      $props = Get-ItemProperty -LiteralPath $root
      if ($props.InstallLocation) {
        return $props.InstallLocation.Trim('"')
      }
    }
  }

  $fallbacks = @(
    (Join-Path $env:LOCALAPPDATA "OpenClaw Beta"),
    (Join-Path $env:ProgramFiles "OpenClaw Beta"),
    (Join-Path ${env:ProgramFiles(x86)} "OpenClaw Beta")
  )

  foreach ($path in $fallbacks) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }

  return $null
}

function Start-CheckedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [int]$RetryCount = 0,
    [int]$RetryDelaySeconds = 5
  )

  for ($attempt = 0; $attempt -le $RetryCount; $attempt++) {
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -eq 0) {
      return
    }

    $shouldRetry = ($process.ExitCode -eq 1618) -and ($attempt -lt $RetryCount)
    if ($shouldRetry) {
      Start-Sleep -Seconds $RetryDelaySeconds
      continue
    }

    throw "Command failed: $FilePath $($ArgumentList -join ' ') (exit $($process.ExitCode))"
  }
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path

switch ($InstallerType) {
  "nsis" {
    Start-CheckedProcess -FilePath $resolvedInstaller -ArgumentList @("/S")
  }
  "msi" {
    if ([string]::IsNullOrWhiteSpace($MsiLogPath)) {
      $MsiLogPath = Join-Path $PWD "openclaw-msi-install.log"
    }
    Start-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @(
      "/i",
      $resolvedInstaller,
      "/qn",
      "/norestart",
      "/L*v",
      $MsiLogPath
    ) -RetryCount 12 -RetryDelaySeconds 10
  }
}

$installRoot = Get-InstallRoot
if ([string]::IsNullOrWhiteSpace($installRoot)) {
  throw "Unable to locate OpenClaw Beta install root after $InstallerType install."
}

$exePath = Join-Path $installRoot "openclaw-desktop.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "Installed executable not found at $exePath"
}

$appProcess = Start-Process -FilePath $exePath -PassThru
Start-Sleep -Seconds 8

if ($appProcess.HasExited) {
  throw "OpenClaw Beta exited immediately after launch smoke."
}

Stop-Process -Id $appProcess.Id -Force

switch ($InstallerType) {
  "nsis" {
    $uninstallerPath = Join-Path $installRoot "uninstall.exe"
    if (-not (Test-Path -LiteralPath $uninstallerPath)) {
      throw "NSIS uninstall.exe not found at $uninstallerPath"
    }
    Start-CheckedProcess -FilePath $uninstallerPath -ArgumentList @("/S")
  }
  "msi" {
    $uninstallLogPath = if ([string]::IsNullOrWhiteSpace($MsiLogPath)) {
      Join-Path $PWD "openclaw-msi-uninstall.log"
    } else {
      [System.IO.Path]::ChangeExtension($MsiLogPath, ".uninstall.log")
    }
    Start-CheckedProcess -FilePath "msiexec.exe" -ArgumentList @(
      "/x",
      $resolvedInstaller,
      "/qn",
      "/norestart",
      "/L*v",
      $uninstallLogPath
    ) -RetryCount 12 -RetryDelaySeconds 10
  }
}
