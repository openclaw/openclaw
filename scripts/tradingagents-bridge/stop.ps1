$ErrorActionPreference = "Stop"

$Port = 8390
$Stopped = @()

try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
} catch {
    $connections = @()
}

foreach ($connection in $connections) {
    $processId = [int]$connection.OwningProcess
    if ($processId -le 0) { continue }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.CommandLine -notlike "*tradingagents-bridge*server.py*") { continue }
    Stop-Process -Id $processId -Force
    $Stopped += [pscustomobject]@{
        pid = $processId
        commandLine = $proc.CommandLine
    }
}

$result = [pscustomobject]@{
    schema = "openclaw.tradingagents.bridge.stop.v1"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    port = $Port
    stoppedCount = $Stopped.Count
    stopped = $Stopped
    no_live_order_sent = $true
    brokerWriteAttempted = $false
}

$result | ConvertTo-Json -Depth 8
