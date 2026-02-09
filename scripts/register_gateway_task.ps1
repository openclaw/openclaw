$ErrorActionPreference = "Stop"

$TaskName = "OpenClaw Gateway"
$GatewayCmdPath = "$env:USERPROFILE\.openclaw\gateway.cmd"

Write-Host "Registering scheduled task '$TaskName' with logon trigger..."

if (-not (Test-Path $GatewayCmdPath)) {
    Write-Host "ERROR: gateway.cmd not found at $GatewayCmdPath" -ForegroundColor Red
    exit 1
}

try {
    # Unregister existing task
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

    # Logon trigger for current user
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

    # Action: run gateway.cmd
    $Action = New-ScheduledTaskAction -Execute $GatewayCmdPath

    # Settings: battery ok, no time limit, restart on failure
    $Settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -Description "OpenClaw Gateway - auto-start on logon (port 18789)"

    Write-Host "Task registered successfully." -ForegroundColor Green

    # Verify
    $task = Get-ScheduledTask -TaskName $TaskName
    Write-Host "  State: $($task.State)"
    $triggers = $task.Triggers
    foreach ($t in $triggers) {
        Write-Host "  Trigger: AtLogOn (User: $($t.UserId))"
    }
    $settings = $task.Settings
    Write-Host "  AllowStartIfOnBatteries: $($settings.AllowStartIfOnBatteries)"
    Write-Host "  DontStopIfGoingOnBatteries: $($settings.DontStopIfGoingOnBatteries)"
    Write-Host "  ExecutionTimeLimit: $($settings.ExecutionTimeLimit)"
    Write-Host "  RestartCount: $($settings.RestartCount)"
}
catch {
    Write-Host "Failed to register task. Ensure you are running as Administrator." -ForegroundColor Red
    Write-Error $_
}
