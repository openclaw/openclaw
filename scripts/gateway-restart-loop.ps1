# Gateway Restart Loop (Inteligente)
# Restart imediato com circuit breaker: 3 crashes em 5 min = para e avisa
# Criado 27/02/2026

$maxCrashes = 3
$windowMinutes = 5
$crashTimes = @()
$logFile = "C:\Users\lucas\.openclaw\logs\restart-loop.log"
$gatewayCmd = "C:\Users\lucas\.openclaw\gateway.cmd"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "$ts - $msg"
    Write-Host "$ts - $msg"
}

New-Item -Path (Split-Path $logFile) -ItemType Directory -Force -ErrorAction SilentlyContinue | Out-Null
Log "Restart loop iniciado"

while ($true) {
    # Limpa crashes fora da janela
    $cutoff = (Get-Date).AddMinutes(-$windowMinutes)
    $crashTimes = @($crashTimes | Where-Object { $_ -gt $cutoff })

    if ($crashTimes.Count -ge $maxCrashes) {
        Log "CIRCUIT BREAKER! $maxCrashes crashes em $windowMinutes min. Parando loop."
        break
    }

    Log "Iniciando gateway..."
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $gatewayCmd -WorkingDirectory "C:\Users\lucas\iris-2.0" -PassThru -NoNewWindow -Wait

    $exitCode = $proc.ExitCode
    $crashTimes += Get-Date
    Log "Gateway encerrou (exit code: $exitCode). Crash #$($crashTimes.Count)/$maxCrashes na janela."

    Start-Sleep -Seconds 3
}

Log "Loop encerrado. Verifique o gateway manualmente."
