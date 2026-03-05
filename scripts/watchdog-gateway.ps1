# Watchdog Gateway Iris 2.0 (com restart loop)
# Verifica se o restart loop esta rodando, inicia se nao
# Atualizado 27/02/2026

$logFile = "C:\Users\lucas\.openclaw\logs\watchdog.log"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# Verifica se o gateway esta rodando
$gateway = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    try {
        $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
        $cmdline -match "entry\.js" -and $cmdline -match "gateway"
    } catch { $false }
}

if ($gateway) {
    exit 0
} else {
    # Verifica se o restart loop ja esta rodando
    $loop = Get-Process -Name "powershell" -ErrorAction SilentlyContinue | Where-Object {
        try {
            $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
            $cmdline -match "gateway-restart-loop"
        } catch { $false }
    }

    if ($loop) {
        Add-Content -Path $logFile -Value "$timestamp - Gateway down mas restart loop ativo. Aguardando..."
        exit 0
    }

    Add-Content -Path $logFile -Value "$timestamp - Gateway E loop DOWN! Iniciando restart loop..."
    Start-Process -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "C:\Users\lucas\iris-2.0\scripts\gateway-restart-loop.ps1" -WindowStyle Hidden
}
