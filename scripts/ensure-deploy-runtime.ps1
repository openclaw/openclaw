param(
  [Parameter(Mandatory = $true)]
  [string]$DeployDir,
  [Parameter(Mandatory = $true)]
  [string]$SourceDir
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$msg) {
  Write-Host "[ensure] $msg"
}

function Ensure-Hashtable([object]$obj) {
  if ($null -eq $obj) { return @{} }
  if ($obj -is [hashtable]) { return $obj }
  $ht = @{}
  foreach ($p in $obj.PSObject.Properties) {
    $ht[$p.Name] = $p.Value
  }
  return $ht
}

function Set-ObjectProperty([object]$obj, [string]$name, [object]$value) {
  if ($obj.PSObject.Properties.Name -contains $name) {
    $obj.$name = $value
  } else {
    $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
  }
}

function To-JsonObject([string]$path) {
  if (-not (Test-Path $path)) {
    return $null
  }
  try {
    return Get-Content -Raw -Path $path | ConvertFrom-Json
  } catch {
    throw "Invalid JSON: $path"
  }
}

function Save-Json([string]$path, [object]$json) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $json | ConvertTo-Json -Depth 100 | Set-Content -Path $path -Encoding UTF8
}

function Copy-Dir([string]$src, [string]$dst) {
  if (-not (Test-Path $src)) {
    return $false
  }
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  robocopy $src $dst /E /XJ /XD node_modules src test /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
  return ($LASTEXITCODE -le 7)
}

function Has-Value([object]$v) {
  if ($null -eq $v) { return $false }
  if ($v -is [string]) { return -not [string]::IsNullOrWhiteSpace($v) }
  if ($v -is [hashtable]) { return ($v.Count -gt 0) }
  if ($v.PSObject -and $v.PSObject.Properties) { return ($v.PSObject.Properties.Count -gt 0) }
  return $true
}

function Find-FeishuConfigFromBackups([string]$userRoot) {
  $candidates = Get-ChildItem -Path $userRoot -Filter 'openclaw.json.bak*' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  foreach ($f in $candidates) {
    try {
      $cfg = Get-Content -Raw $f.FullName | ConvertFrom-Json
      if ($cfg.channels -and $cfg.channels.feishu) {
        return $cfg.channels.feishu
      }
    } catch {
    }
  }
  return $null
}

function FeishuHasCredentials([object]$feishuCfg) {
  if ($null -eq $feishuCfg) { return $false }
  if ((Has-Value $feishuCfg.appId) -and (Has-Value $feishuCfg.appSecret)) {
    return $true
  }

  if ($feishuCfg.accounts) {
    foreach ($acc in $feishuCfg.accounts.PSObject.Properties) {
      $v = $acc.Value
      if ((Has-Value $v.appId) -and (Has-Value $v.appSecret)) {
        return $true
      }
    }
  }

  return $false
}

function Ensure-Clawhub {
  if (Get-Command clawhub -ErrorAction SilentlyContinue) {
    return
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Strong validation failed: clawhub not found and npm is unavailable. Please install Node/npm and run `npm i -g clawhub`.'
  }

  Write-Info 'clawhub not found. Installing via npm i -g clawhub ...'
  npm i -g clawhub | Out-Null
  if (-not (Get-Command clawhub -ErrorAction SilentlyContinue)) {
    throw 'Strong validation failed: failed to install clawhub. Run `npm i -g clawhub` manually and retry publish.'
  }
}

function Ensure-RequiredSkills([string]$packageDir, [array]$requiredSkillSlugs, [string]$sourceDir) {
  Ensure-Clawhub
  $skillsDir = Join-Path $packageDir 'skills'
  New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null

  $localSkillSources = @(
    (Join-Path $env:USERPROFILE '.openclaw\skills'),
    (Join-Path $sourceDir 'skills'),
    (Join-Path (Split-Path -Parent (Split-Path -Parent $sourceDir)) 'skills')
  )

  foreach ($slug in $requiredSkillSlugs) {
    $target = Join-Path $skillsDir $slug
    if (Test-Path $target) {
      Write-Info "Required skill already present: $slug"
      continue
    }

    $copied = $false
    foreach ($srcRoot in $localSkillSources) {
      if (-not (Test-Path $srcRoot)) { continue }
      $srcSkill = Join-Path $srcRoot $slug
      if (-not (Test-Path $srcSkill)) { continue }

      Write-Info "Copying required skill from local source: $slug ($srcRoot)"
      New-Item -ItemType Directory -Path $target -Force | Out-Null
      robocopy $srcSkill $target /E /XJ /XD node_modules /NFL /NDL /NJH /NJS /NC /NS > $null
      $copied = (Test-Path $target)
      if ($copied) { break }
    }

    if (-not $copied) {
      Write-Info "Installing required skill from registry: $slug"
      $cmdLine = "clawhub install $slug"
      $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdLine) -WorkingDirectory $packageDir -NoNewWindow -PassThru
      if (-not (Wait-Process -Id $proc.Id -Timeout 120 -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        throw "Strong validation failed: clawhub install timed out for skill '$slug'"
      }
      if ($proc.ExitCode -ne 0) {
        throw "Strong validation failed: clawhub install failed for skill '$slug' (exit code $($proc.ExitCode))"
      }
    }

    if (-not (Test-Path $target)) {
      throw "Strong validation failed: required skill not installed: $slug"
    }
  }
}

function Ensure-PluginRuntimeDependencies([string]$extensionsDir, [string]$pluginId) {
  $pluginDir = Join-Path $extensionsDir $pluginId
  $pluginPackageJson = Join-Path $pluginDir 'package.json'
  if (-not (Test-Path $pluginPackageJson)) {
    return
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Strong validation failed: npm is unavailable. Cannot install runtime dependencies for plugin '$pluginId'."
  }

  # Feishu currently requires axios at runtime via @larksuiteoapi/node-sdk.
  if ($pluginId -eq 'feishu') {
    $axiosPath = Join-Path $pluginDir 'node_modules\axios'
    if (Test-Path $axiosPath) {
      Write-Info 'Feishu runtime dependency check passed (axios present).'
      return
    }
  }

  Write-Info "Installing runtime dependencies for plugin: $pluginId"
  Push-Location $pluginDir
  try {
    if (Test-Path package.json) { (Get-Content package.json) -replace '"workspace:\*"', '"*"' | Set-Content package.json }
      cmd /c npm install --omit=dev --no-audit --no-fund | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Strong validation failed: npm install failed for plugin '$pluginId' (exit code $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }

  if ($pluginId -eq 'feishu') {
    $axiosPath = Join-Path $pluginDir 'node_modules\axios'
    if (-not (Test-Path $axiosPath)) {
      throw "Strong validation failed: plugin '$pluginId' still missing runtime module 'axios' after dependency install"
    }
  }
}

function Ensure-CoreRuntimeDependencies([string]$packageDir, [array]$moduleNames) {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Strong validation failed: npm is unavailable. Cannot install core runtime dependencies.'
  }

  foreach ($name in $moduleNames) {
    $modulePath = Join-Path $packageDir ("node_modules\" + $name)
    if (Test-Path $modulePath) {
      continue
    }

    Write-Info "Installing missing core runtime dependency: $name"
    Push-Location $packageDir
    try {
      cmd /c npm install --omit=dev --no-audit --no-fund $name | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "Strong validation failed: npm install failed for core dependency '$name' (exit code $LASTEXITCODE)"
      }
    } finally {
      Pop-Location
    }

    if (-not (Test-Path $modulePath)) {
      throw "Strong validation failed: core runtime dependency still missing after install: $name"
    }
  }
}

function Ensure-CoreRuntimeShims([string]$packageDir) {
  $yamlDir = Join-Path $packageDir 'node_modules\yaml'
  $yamlIndex = Join-Path $yamlDir 'index.js'
  $yamlDistIndex = Join-Path $yamlDir 'dist\index.js'
  $lineDir = Join-Path $packageDir 'node_modules\@line\bot-sdk'
  $lineIndex = Join-Path $lineDir 'index.js'
  $lineDistIndex = Join-Path $lineDir 'dist\index.js'

  if ((Test-Path $yamlDir) -and (-not (Test-Path $yamlIndex)) -and (Test-Path $yamlDistIndex)) {
    Write-Info 'Creating runtime shim: node_modules/yaml/index.js -> dist/index.js'
    @(
      "export * from './dist/index.js';",
      "import yamlDefault from './dist/index.js';",
      "export default yamlDefault;"
    ) | Set-Content -Path $yamlIndex -Encoding UTF8
  }

  if ((Test-Path $lineDir) -and (-not (Test-Path $lineIndex)) -and (Test-Path $lineDistIndex)) {
    Write-Info 'Creating runtime shim: node_modules/@line/bot-sdk/index.js -> dist/index.js'
    @(
      "export * from './dist/index.js';",
      "import lineSdkDefault from './dist/index.js';",
      "export default lineSdkDefault;"
    ) | Set-Content -Path $lineIndex -Encoding UTF8
  }
}

$runtimeConfigPath = Join-Path $DeployDir 'config.runtime.json'
$fallbackConfigPath = Join-Path $DeployDir 'config.json'
$userConfigPath = Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
$packageExtensionsDir = Join-Path $DeployDir 'openclaw-runtime-next\package\extensions'
$sourceExtensionsDir = Join-Path $SourceDir 'extensions'
$userExtensionsDir = Join-Path $env:USERPROFILE '.openclaw\extensions'
$userRootDir = Join-Path $env:USERPROFILE '.openclaw'
$modelPluginDir = Join-Path $SourceDir 'models\Plugin'
$packageDir = Join-Path $DeployDir 'openclaw-runtime-next\package'

if (-not (Test-Path $runtimeConfigPath)) {
  if (Test-Path $fallbackConfigPath) {
    Copy-Item -Path $fallbackConfigPath -Destination $runtimeConfigPath -Force
    Write-Info "Created config.runtime.json from config.json"
  } elseif (Test-Path $userConfigPath) {
    Copy-Item -Path $userConfigPath -Destination $runtimeConfigPath -Force
    Write-Info "Created config.runtime.json from user config"
  } else {
    throw 'No runtime config source found (config.runtime.json/config.json/user config).'
  }
}

$runtimeCfg = To-JsonObject -path $runtimeConfigPath
if ($null -eq $runtimeCfg) {
  throw "Runtime config missing: $runtimeConfigPath"
}
$userCfg = To-JsonObject -path $userConfigPath

$runtimePlugins = Ensure-Hashtable $runtimeCfg.plugins
$runtimeEntries = Ensure-Hashtable $runtimePlugins.entries
$runtimeInstalls = Ensure-Hashtable $runtimePlugins.installs

# Always-required plugins for this deployment.
$requiredPluginIds = @('abb-robot-control', 'feishu', 'qwen-portal-auth')

# Merge user plugin entries so previously working plugins are not dropped.
if ($null -ne $userCfg -and $null -ne $userCfg.plugins -and $null -ne $userCfg.plugins.entries) {
  foreach ($prop in $userCfg.plugins.entries.PSObject.Properties) {
    $runtimeEntries[$prop.Name] = $prop.Value
  }
}

foreach ($pluginId in $requiredPluginIds) {
  if (-not $runtimeEntries.ContainsKey($pluginId)) {
    $runtimeEntries[$pluginId] = @{ enabled = $true }
  } else {
    $entry = Ensure-Hashtable $runtimeEntries[$pluginId]
    $entry['enabled'] = $true
    $runtimeEntries[$pluginId] = $entry
  }
}

# robot-kinematic is loaded from trusted discovery to avoid duplicate id ambiguity across extension roots.
if ($runtimeEntries.ContainsKey('robot-kinematic')) {
  $runtimeEntries.Remove('robot-kinematic')
}
if ($runtimeInstalls.ContainsKey('robot-kinematic')) {
  $runtimeInstalls.Remove('robot-kinematic')
}

# Enforce explicit trusted plugin allow-list to avoid accidental auto-loading from user directories.
$trustedPluginIds = @($runtimeEntries.Keys + @('robot-kinematic') | Sort-Object -Unique)
$runtimePlugins['allow'] = $trustedPluginIds

# Preserve Feishu channel config from user config when runtime config does not have it.
$runtimeChannels = Ensure-Hashtable $runtimeCfg.channels
if (-not $runtimeChannels.ContainsKey('feishu')) {
  if ($null -ne $userCfg -and $null -ne $userCfg.channels -and $null -ne $userCfg.channels.feishu) {
    $runtimeChannels['feishu'] = $userCfg.channels.feishu
    Write-Info 'Imported channels.feishu from user config.'
  } else {
    $bakFeishu = Find-FeishuConfigFromBackups -userRoot $userRootDir
    if ($null -ne $bakFeishu) {
      $runtimeChannels['feishu'] = $bakFeishu
      Write-Info 'Imported channels.feishu from user config backup.'
    }
  }
}

# Normalize Feishu runtime behavior for inbound message handling.
if ($runtimeChannels.ContainsKey('feishu')) {
  $fei = Ensure-Hashtable $runtimeChannels['feishu']
  $fei['enabled'] = $true
  if (-not $fei.ContainsKey('connectionMode') -or -not (Has-Value $fei['connectionMode'])) {
    $fei['connectionMode'] = 'websocket'
  }
  # Avoid DM pairing gate after restart/publish; keep DM channel open for this deployment profile.
  $fei['dmPolicy'] = 'open'
  $allow = @()
  if ($fei.ContainsKey('allowFrom') -and $null -ne $fei['allowFrom']) {
    foreach ($x in $fei['allowFrom']) { $allow += "$x" }
  }
  if (-not ($allow -contains '*')) {
    $allow += '*'
  }
  $fei['allowFrom'] = $allow
  # In DM/group without explicit @ mention, requireMention=true can cause incoming messages to be ignored.
  $fei['requireMention'] = $false
  $runtimeChannels['feishu'] = $fei
}

# Strong validation for Feishu when plugin is enabled.
$feishuEnabled = $false
if ($runtimeEntries.ContainsKey('feishu')) {
  $feishuEntry = Ensure-Hashtable $runtimeEntries['feishu']
  if ($feishuEntry.ContainsKey('enabled')) {
    $feishuEnabled = [bool]$feishuEntry['enabled']
  }
}
if ($feishuEnabled) {
  $feishuCfg = $null
  if ($runtimeChannels.ContainsKey('feishu')) {
    $feishuCfg = $runtimeChannels['feishu']
  }
  if (-not (FeishuHasCredentials -feishuCfg $feishuCfg)) {
    throw 'Strong validation failed: Feishu is enabled but credentials are missing. Fill channels.feishu.appId/appSecret (or channels.feishu.accounts.*.appId/appSecret) in C:\Users\HB\.openclaw\openclaw.json, then rerun publish.'
  }
}

$runtimePlugins['entries'] = $runtimeEntries
$runtimePlugins['installs'] = $runtimeInstalls
Set-ObjectProperty -obj $runtimeCfg -name 'plugins' -value $runtimePlugins
Set-ObjectProperty -obj $runtimeCfg -name 'channels' -value $runtimeChannels

Save-Json -path $runtimeConfigPath -json $runtimeCfg
Write-Info "Updated runtime config: $runtimeConfigPath"

# Ensure plugin files exist in deploy runtime extensions.
New-Item -ItemType Directory -Path $packageExtensionsDir -Force | Out-Null

$pluginIdsToSync = @($runtimeEntries.Keys)
foreach ($pluginId in $pluginIdsToSync) {
  if ($pluginId -eq 'robot-kinematic') {
    continue
  }

  $srcCandidates = @(
    (Join-Path $sourceExtensionsDir $pluginId),
    (Join-Path $userExtensionsDir $pluginId)
  )

  if ($pluginId -eq 'robot-kinematic') {
    $srcCandidates += $modelPluginDir
  }

  $src = $null
  foreach ($candidate in $srcCandidates) {
    if (Test-Path $candidate) {
      $src = $candidate
      break
    }
  }

  if ($null -eq $src) {
    continue
  }

  $dst = Join-Path $packageExtensionsDir $pluginId
  if (Copy-Dir -src $src -dst $dst) {
    Write-Info "Synced plugin $pluginId from $src"
  } else {
    throw "Failed to sync plugin $pluginId from $src"
  }
}

# Ensure only one robot-kinematic source is visible to runtime to avoid duplicate plugin id warnings.
$runtimeRobotKinematicMirror = Join-Path $packageExtensionsDir 'robot-kinematic'
if (Test-Path $runtimeRobotKinematicMirror) {
  Remove-Item -Path $runtimeRobotKinematicMirror -Recurse -Force -ErrorAction SilentlyContinue
  Write-Info 'Removed deploy mirror for robot-kinematic to avoid duplicate plugin id detection.'
}

# Ensure critical plugin runtime dependencies after sync.
Ensure-PluginRuntimeDependencies -extensionsDir $packageExtensionsDir -pluginId 'feishu'

# Ensure critical core runtime dependency required by dist entry path.
Ensure-CoreRuntimeDependencies -packageDir $packageDir -moduleNames @('chalk')
Ensure-CoreRuntimeShims -packageDir $packageDir

Write-Info 'Runtime ensure completed successfully.'

# Strong validation + auto-install for required common skills.
$requiredSkills = @(
  'openclaw-aisa-web-search-tavily',
  'find-skills',
  'summarize',
  'xiucheng-self-improving-agent'
)
Ensure-RequiredSkills -packageDir $packageDir -requiredSkillSlugs $requiredSkills -sourceDir $SourceDir
Write-Info 'Required common skills are installed and validated.'

exit 0


