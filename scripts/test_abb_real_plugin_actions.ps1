$ErrorActionPreference = 'Stop'

$nodeScript = 'd:\OpenClaw\Develop\openclaw\scripts\run_abb_real_action_once.mjs'
$outFile = 'd:\OpenClaw\Develop\openclaw\scripts\_real_plugin_actions_report.json'

$steps = @(
  @{ action = 'scan_controllers'; params = @{} },
  @{ action = 'connect'; params = @{ host = '127.0.0.1'; port = 7000; allowVirtualController = $true } },
  @{ action = 'get_status'; params = @{} },
  @{ action = 'get_system_info'; params = @{} },
  @{ action = 'get_service_info'; params = @{} },
  @{ action = 'get_speed'; params = @{} },
  @{ action = 'set_speed'; params = @{ speed = 25 } },
  @{ action = 'get_joints'; params = @{} },
  @{ action = 'get_world_position'; params = @{} },
  @{ action = 'get_event_log'; params = @{ categoryId = 0; limit = 10 } },
  @{ action = 'list_tasks'; params = @{} },
  @{ action = 'analyze_logs'; params = @{ categoryId = 0; limit = 10; error_hint = 'T_ROB1 MainModule 行3 错误' } },
  @{ action = 'movj'; params = @{ joints = @(1, 2); speed = 5 } }
)

$report = New-Object System.Collections.Generic.List[object]

foreach ($s in $steps) {
  $paramFile = "d:\OpenClaw\Develop\openclaw\scripts\_tmp_params_$($s.action).json"
  ($s.params | ConvertTo-Json -Compress -Depth 20) | Set-Content -Path $paramFile -Encoding Ascii
  $output = & node $nodeScript $s.action ("@" + $paramFile)
  $raw = ($output | Out-String).Trim()

  $parsed = $null
  try { $parsed = $raw | ConvertFrom-Json } catch {
    $parsed = [pscustomobject]@{ ok = $false; action = $s.action; error = "invalid-json-output"; raw = $raw }
  }

  $stepSuccess = $false
  if ($parsed.ok -eq $true) {
    if ($null -ne $parsed.details -and $null -ne $parsed.details.success) {
      $stepSuccess = [bool]$parsed.details.success
    }
    else {
      $stepSuccess = $true
    }
  }

  $report.Add([pscustomobject]@{
      action  = $s.action
      ok      = $stepSuccess
      text    = [string]$parsed.text
      error   = [string]$parsed.error
      details = $parsed.details
      raw     = $raw
    }) | Out-Null

  Remove-Item -Path $paramFile -ErrorAction SilentlyContinue
}

$report | ConvertTo-Json -Depth 30 | Set-Content -Path $outFile -Encoding UTF8
Write-Output "REAL_PLUGIN_ACTIONS_DONE"
