param(
  [string]$UsbRoot,

  [string]$ConfigRoot,

  [ValidateSet("init", "run", "status")]
  [string]$Action = "run"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($UsbRoot)) {
  $UsbRoot = Join-Path $ScriptDir "data"
}
$UsbRoot = (Resolve-Path (New-Item -ItemType Directory -Path $UsbRoot -Force)).Path

if ([string]::IsNullOrWhiteSpace($ConfigRoot)) {
  if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_CONFIG_ROOT)) {
    $ConfigRoot = $env:OPENCLAW_CONFIG_ROOT
  } else {
    $ConfigRoot = Join-Path $ScriptDir "config"
  }
}
$ConfigRoot = (Resolve-Path (New-Item -ItemType Directory -Path $ConfigRoot -Force)).Path

$LocalOpenClaw = Join-Path $ScriptDir "bin\openclaw.cmd"
if (-not (Test-Path $LocalOpenClaw)) {
  throw "Missing local launcher: $LocalOpenClaw"
}

function Get-BundledNodePath {
  $rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($rawArch.ToUpperInvariant()) {
    "AMD64" { "x86_64" }
    "X86_64" { "x86_64" }
    "ARM64" { "arm64" }
    default { $null }
  }
  if (-not $arch) {
    throw "Unsupported architecture: $rawArch"
  }
  $nodePath = Join-Path $ScriptDir "bin\node-win-$arch.exe"
  if (-not (Test-Path $nodePath)) {
    throw "Missing bundled Node: $nodePath`nHint: copy Node 22+ to deployment\bin\node-win-$arch.exe"
  }
  return $nodePath
}

$NodeBin = Get-BundledNodePath

$StateDir = Join-Path $UsbRoot "state-win"
$ConfigPath = Join-Path $ConfigRoot "openclaw-win.json"
$WorkspaceDir = Join-Path $UsbRoot "workspace"
$CodexHomeDir = Join-Path $UsbRoot "codex-home"

New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
New-Item -ItemType Directory -Path $WorkspaceDir -Force | Out-Null
New-Item -ItemType Directory -Path $CodexHomeDir -Force | Out-Null

$env:OPENCLAW_STATE_DIR = $StateDir
$env:OPENCLAW_CONFIG_PATH = $ConfigPath
$env:CODEX_HOME = $CodexHomeDir

function Invoke-OpenClaw {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $LocalOpenClaw @Args
  if ($LASTEXITCODE -ne 0) {
    throw "openclaw failed: $($Args -join ' ')"
  }
}

function New-HexToken {
  param([int]$Bytes = 24)
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return -join ($buffer | ForEach-Object { $_.ToString("x2") })
}

function Get-ConfigValue {
  param([string]$Path)
  if (-not (Test-Path $ConfigPath)) {
    return $null
  }
  try {
    $cfg = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    $value = $cfg
    foreach ($part in $Path.Split(".")) {
      if ($null -eq $value -or -not $value.PSObject.Properties.Name.Contains($part)) {
        return $null
      }
      $value = $value.$part
    }
    if ($null -eq $value) {
      return $null
    }
    if (($value -is [string]) -and [string]::IsNullOrWhiteSpace($value)) {
      return $null
    }
    return $value
  }
  catch {
    return $null
  }
}

function Set-ConfigDefault {
  param(
    [string]$Path,
    [string]$Value
  )
  $existing = Get-ConfigValue -Path $Path
  if ($null -eq $existing) {
    Invoke-OpenClaw config set $Path $Value | Out-Null
  }
}

function Ensure-GatewayToken {
  $hasToken = $false
  if (Test-Path $ConfigPath) {
    try {
      $cfg = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
      $token = $cfg.gateway.auth.token
      if (-not [string]::IsNullOrWhiteSpace($token)) {
        $hasToken = $true
      }
    } catch {
      $hasToken = $false
    }
  }
  if (-not $hasToken) {
    $token = New-HexToken
    Invoke-OpenClaw config set gateway.auth.token $token | Out-Null
    Write-Host "[init] generated gateway.auth.token in $ConfigPath"
  }
  $resolvedToken = Get-ConfigValue -Path "gateway.auth.token"
  if (($resolvedToken -is [string]) -and -not [string]::IsNullOrWhiteSpace($resolvedToken)) {
    $env:OPENCLAW_GATEWAY_TOKEN = $resolvedToken
  }
}

function Apply-BaseConfig {
  Set-ConfigDefault -Path "gateway.mode" -Value "local"
  Set-ConfigDefault -Path "gateway.port" -Value "18789"
  Set-ConfigDefault -Path "gateway.bind" -Value "loopback"
  Set-ConfigDefault -Path "gateway.auth.mode" -Value "token"
  Set-ConfigDefault -Path "agents.defaults.workspace" -Value $WorkspaceDir
  Set-ConfigDefault -Path "agents.defaults.model.primary" -Value "openai-codex/gpt-5.4"
  Ensure-GatewayToken
}

function Print-Status {
  Write-Host "OPENCLAW_CONFIG_ROOT=$(Split-Path -Parent $env:OPENCLAW_CONFIG_PATH)"
  Write-Host "OPENCLAW_STATE_DIR=$env:OPENCLAW_STATE_DIR"
  Write-Host "OPENCLAW_CONFIG_PATH=$env:OPENCLAW_CONFIG_PATH"
  Write-Host "CODEX_HOME=$env:CODEX_HOME"
  Write-Host "OPENCLAW_CMD=$LocalOpenClaw"
  Write-Host "NODE_BIN=$NodeBin"
  Invoke-OpenClaw config get gateway.mode
  Invoke-OpenClaw config get gateway.port
  Invoke-OpenClaw config get gateway.bind
  Invoke-OpenClaw config get gateway.auth.mode
  Invoke-OpenClaw config get agents.defaults.workspace
  Invoke-OpenClaw config get agents.defaults.model.primary
}

switch ($Action) {
  "init" {
    Apply-BaseConfig
    Print-Status
  }
  "run" {
    Apply-BaseConfig
    Print-Status
    Invoke-OpenClaw gateway run
  }
  "status" {
    Print-Status
  }
}
