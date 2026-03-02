param(
    [int]$Port = 18789
)

$ErrorActionPreference = "Stop"

Write-Host "--- Ngrok Startup Orchestrator ---" -ForegroundColor Cyan

# Check if ngrok is already running
$ngrokProcess = Get-Process -Name "ngrok" -ErrorAction SilentlyContinue
if ($ngrokProcess) {
    Write-Host "Ngrok is already running (PID: $($ngrokProcess.Id))." -ForegroundColor Yellow
    exit 0
}

Write-Host "Starting Ngrok on port $Port..." -ForegroundColor Yellow

# Start ngrok in a new minimized window
# This assumes ngrok is in the PATH or in the project root
$NgrokCommand = "ngrok http $Port --log=stdout"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c $NgrokCommand" -WindowStyle Minimized

# Wait a few seconds for it to initialize
Start-Sleep -Seconds 3

Write-Host "Ngrok started in background." -ForegroundColor Green
