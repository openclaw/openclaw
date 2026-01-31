$ErrorActionPreference = "Stop"

$TaskName = "MoltbotStableUpdate"
$ScriptPath = "C:\MAIBOT\scripts\update_stable.ps1"

Write-Host "Registering scheduled task '$TaskName'..."

try {
    $Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
    $Action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-ExecutionPolicy Bypass -File $ScriptPath"
    
    # Unregister if exists (to update)
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

    Register-ScheduledTask -TaskName $TaskName -Trigger $Trigger -Action $Action -Description "Updates Moltbot to latest stable version weekly"
    
    Write-Host "✅ Task registered successfully." -ForegroundColor Green
}
catch {
    Write-Host "❌ Failed to register task. Ensure you are running as Administrator." -ForegroundColor Red
    Write-Error $_
}
