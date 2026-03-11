param(
  [string]$UsbRoot,

  [string]$ConfigRoot,

  [ValidateSet("init", "run", "status", "dashboard")]
  [string]$Action = "run",

  [switch]$Dashboard
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

function Invoke-NodeEval {
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [string[]]$Args = @()
  )

  $tmpBase = [System.IO.Path]::GetTempFileName()
  $tmpFile = "$tmpBase.cjs"
  Move-Item -LiteralPath $tmpBase -Destination $tmpFile -Force

  try {
    Set-Content -LiteralPath $tmpFile -Value $Script -Encoding UTF8
    $output = & $NodeBin $tmpFile @Args
    if ($LASTEXITCODE -ne 0) {
      throw "node eval failed"
    }
    return (($output | ForEach-Object { "$_" }) -join "`n")
  } finally {
    Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
  }
}

function New-HexToken {
  param([int]$Bytes = 24)
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    if ($null -ne $rng) {
      $rng.Dispose()
    }
  }
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
    # Keep dashboard URL token and gateway runtime auth token in sync.
    $env:OPENCLAW_GATEWAY_TOKEN = $resolvedToken
  }
}

function Get-ResolvedWorkspacePath {
  $workspace = Get-ConfigValue -Path "agents.defaults.workspace"
  if (($workspace -is [string]) -and -not [string]::IsNullOrWhiteSpace($workspace)) {
    return $workspace
  }
  return $WorkspaceDir
}

function Ensure-WorkspaceBootstrap {
  $workspace = Get-ResolvedWorkspacePath
  & $LocalOpenClaw setup --workspace $workspace *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "failed to ensure workspace bootstrap files via 'openclaw setup --workspace $workspace'"
  }
}

function Ensure-WorkspaceMemoryFile {
  $workspace = Get-ResolvedWorkspacePath
  $memoryDir = Join-Path $workspace "memory"
  $memoryUpper = Join-Path $workspace "MEMORY.md"
  $memoryLower = Join-Path $workspace "memory.md"

  New-Item -ItemType Directory -Path $memoryDir -Force | Out-Null
  if (-not (Test-Path -LiteralPath $memoryUpper) -and -not (Test-Path -LiteralPath $memoryLower)) {
    @'
# MEMORY.md

Long-term notes for this workspace.

- Keep stable preferences and durable facts here.
- Put day-by-day notes in `memory/YYYY-MM-DD.md`.
'@ | Set-Content -LiteralPath $memoryUpper -Encoding UTF8
    Write-Host "[init] created $memoryUpper"
  }
}

function Sync-OpenAICodexAuthProfiles {
  $nodeScript = @'
const fs=require("fs");
const path=require("path");

const stateDir=process.argv[1];
const codexHome=process.argv[2];
if (!stateDir || !codexHome) {
  process.stdout.write("skip");
  process.exit(0);
}

const codexAuthPath=path.join(codexHome, "auth.json");
let codexRaw;
try {
  codexRaw=JSON.parse(fs.readFileSync(codexAuthPath, "utf8"));
} catch {
  process.stdout.write("no-codex-auth");
  process.exit(0);
}
const tokens=codexRaw?.tokens;
const access=typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
const refresh=typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : "";
if (!access || !refresh) {
  process.stdout.write("no-codex-tokens");
  process.exit(0);
}
const accountId=typeof tokens?.account_id === "string" && tokens.account_id.trim()
  ? tokens.account_id.trim()
  : undefined;

const decodeJwtExpiryMs=(token)=>{
  try {
    const parts=token.split(".");
    if (parts.length < 2) return null;
    const base64=parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded=base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload=JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const exp=typeof payload?.exp === "number" ? payload.exp : Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
};
const expires=decodeJwtExpiryMs(access) ?? (Date.now() - 60 * 1000);

const authStorePath=path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
let store={ version: 1, profiles: {} };
try {
  const parsed=JSON.parse(fs.readFileSync(authStorePath, "utf8"));
  if (parsed && typeof parsed === "object") {
    store=parsed;
  }
} catch {
  // use defaults
}
if (!store.profiles || typeof store.profiles !== "object") {
  store.profiles={};
}

const profileIds=Object.entries(store.profiles)
  .filter((entry) => {
    const profile=entry[1];
    return Boolean(
      profile &&
      typeof profile === "object" &&
      profile.provider === "openai-codex" &&
      profile.type === "oauth",
    );
  })
  .map((entry) => entry[0]);
if (profileIds.length === 0) {
  profileIds.push("openai-codex:default");
}

let changed=false;
for (const id of profileIds) {
  const previous=store.profiles[id];
  const previousObj=previous && typeof previous === "object" ? previous : {};
  const previousAccess=typeof previousObj.access === "string" ? previousObj.access.trim() : "";
  const previousRefresh=typeof previousObj.refresh === "string" ? previousObj.refresh.trim() : "";
  const previousExpires=typeof previousObj.expires === "number"
    ? previousObj.expires
    : Number(previousObj.expires);
  const needsUpdate=
    !previousAccess ||
    !previousRefresh ||
    !Number.isFinite(previousExpires) ||
    previousExpires <= Date.now() + 60_000;
  if (!needsUpdate) {
    continue;
  }
  const next={
    ...previousObj,
    type:"oauth",
    provider:"openai-codex",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
  if (JSON.stringify(previousObj) !== JSON.stringify(next)) {
    changed=true;
  }
  store.profiles[id]=next;
}
if (changed) {
  fs.mkdirSync(path.dirname(authStorePath), { recursive: true });
  fs.writeFileSync(authStorePath, JSON.stringify(store, null, 2) + "\n");
}

const oauthPath=path.join(stateDir, "credentials", "oauth.json");
let oauthStore={};
try {
  const parsed=JSON.parse(fs.readFileSync(oauthPath, "utf8"));
  if (parsed && typeof parsed === "object") {
    oauthStore=parsed;
  }
} catch {
  // missing oauth file is fine
}
const previousOauth=oauthStore["openai-codex"];
const previousOauthObj=previousOauth && typeof previousOauth === "object" ? previousOauth : {};
const previousOauthAccess=typeof previousOauthObj.access === "string" ? previousOauthObj.access.trim() : "";
const previousOauthRefresh=typeof previousOauthObj.refresh === "string" ? previousOauthObj.refresh.trim() : "";
const previousOauthExpires=typeof previousOauthObj.expires === "number"
  ? previousOauthObj.expires
  : Number(previousOauthObj.expires);
const oauthNeedsUpdate=
  !previousOauthAccess ||
  !previousOauthRefresh ||
  !Number.isFinite(previousOauthExpires) ||
  previousOauthExpires <= Date.now() + 60_000;
const nextOauth={
  ...previousOauthObj,
  access,
  refresh,
  expires,
  ...(accountId ? { accountId } : {}),
};
const oauthChanged=oauthNeedsUpdate && JSON.stringify(previousOauthObj) !== JSON.stringify(nextOauth);
if (oauthChanged) {
  oauthStore["openai-codex"]=nextOauth;
  fs.mkdirSync(path.dirname(oauthPath), { recursive: true });
  fs.writeFileSync(oauthPath, JSON.stringify(oauthStore, null, 2) + "\n");
}

if (changed || oauthChanged) {
  process.stdout.write(`updated:${profileIds.length}`);
} else {
  process.stdout.write("noop");
}
'@

  $result = (Invoke-NodeEval -Script $nodeScript -Args @($StateDir, $CodexHomeDir)).Trim()
  switch -Regex ($result) {
    '^updated:(\d+)$' {
      Write-Host "[init] synced openai-codex OAuth credentials into state ($($Matches[1]) profile(s))"
    }
    '^no-codex-auth$' {
      Write-Warning "$CodexHomeDir\auth.json not found; openai-codex OAuth may require re-login."
    }
    '^no-codex-tokens$' {
      Write-Warning "$CodexHomeDir\auth.json is missing access/refresh tokens; openai-codex OAuth may fail."
    }
  }
}

function Print-DashboardHint {
  param([switch]$OpenInBrowser)

  Write-Host "[hint] Open dashboard with tokenized URL:"
  $output = & $LocalOpenClaw dashboard --no-open 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "openclaw failed: dashboard --no-open"
  }

  $lines = @($output | ForEach-Object { "$_" })
  foreach ($line in $lines) {
    Write-Host $line
  }

  $url = $null
  foreach ($line in $lines) {
    if ($line -match '^Dashboard URL:\s*(.+)$') {
      $url = $Matches[1].Trim()
      break
    }
  }

  if ($OpenInBrowser) {
    if ([string]::IsNullOrWhiteSpace($url)) {
      Write-Warning "Could not parse dashboard URL. Use the output above."
      return
    }
    try {
      Start-Process $url | Out-Null
      Write-Host "Opened in your browser. Keep that tab to control OpenClaw."
    } catch {
      Write-Warning "Browser auto-open failed. Use the URL above."
    }
  }
}

function Print-ConfigValue {
  param([string]$Path)
  $output = & $LocalOpenClaw config get $Path 2>$null
  if ($LASTEXITCODE -ne 0) {
    return "(unset)"
  }
  $line = (($output | ForEach-Object { "$_" }) | Select-Object -Last 1)
  if ([string]::IsNullOrWhiteSpace($line)) {
    return "(unset)"
  }
  return $line.Trim()
}

function Apply-BaseConfig {
  # Only fill defaults when keys are missing. Never overwrite imported custom config.
  Set-ConfigDefault -Path "gateway.mode" -Value "local"
  Set-ConfigDefault -Path "gateway.port" -Value "18789"
  Set-ConfigDefault -Path "gateway.bind" -Value "loopback"
  Set-ConfigDefault -Path "gateway.auth.mode" -Value "token"
  Set-ConfigDefault -Path "agents.defaults.workspace" -Value $WorkspaceDir
  Set-ConfigDefault -Path "agents.defaults.model.primary" -Value "openai-codex/gpt-5.4"
  Sync-OpenAICodexAuthProfiles
  Ensure-GatewayToken
  Ensure-WorkspaceBootstrap
  Ensure-WorkspaceMemoryFile
}

function Print-Status {
  Write-Host "OPENCLAW_CONFIG_ROOT=$(Split-Path -Parent $env:OPENCLAW_CONFIG_PATH)"
  Write-Host "OPENCLAW_STATE_DIR=$env:OPENCLAW_STATE_DIR"
  Write-Host "OPENCLAW_CONFIG_PATH=$env:OPENCLAW_CONFIG_PATH"
  Write-Host "CODEX_HOME=$env:CODEX_HOME"
  Write-Host "OPENCLAW_CMD=$LocalOpenClaw"
  Write-Host "NODE_BIN=$NodeBin"
  Write-Host (Print-ConfigValue -Path "gateway.mode")
  Write-Host (Print-ConfigValue -Path "gateway.port")
  Write-Host (Print-ConfigValue -Path "gateway.bind")
  Write-Host (Print-ConfigValue -Path "gateway.auth.mode")
  Write-Host (Print-ConfigValue -Path "agents.defaults.workspace")
  Write-Host (Print-ConfigValue -Path "agents.defaults.model.primary")
}

switch ($Action) {
  "init" {
    Apply-BaseConfig
    Print-Status
  }
  "run" {
    Apply-BaseConfig
    Print-Status
    if ($Dashboard) {
      Print-DashboardHint -OpenInBrowser
    }
    Invoke-OpenClaw gateway run
  }
  "dashboard" {
    Apply-BaseConfig
    Print-DashboardHint -OpenInBrowser
  }
  "status" {
    Print-Status
  }
}
