# Send message to OpenClaw Gateway via WebSocket
param(
    [string]$message = "Hello! This is a test message from PowerShell gateway test.",
    [string]$port = "19001"
)

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [Threading.CancellationToken]::None
$endpoint = "ws://127.0.0.1:$port/"

Write-Host "Connecting to $endpoint..."
$ws.ConnectAsync($endpoint, $ct).Wait()

# Receive challenge
$buffer = [byte[]]::new(4096)
$receiveTask = $ws.ReceiveAsync($buffer, $ct)
$receiveTask.Wait()
$result = $receiveTask.Result
$challengeText = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
Write-Host "Received: $challengeText"

$challenge = $challengeText | ConvertFrom-Json

if ($challenge.event -eq "connect.challenge") {
    Write-Host "Sending auth response..."
    # Use environment variable or placeholder
    $token = if ($env:OPENCLAW_GATEWAY_TOKEN) { $env:OPENCLAW_GATEWAY_TOKEN } else { "test-token-placeholder" }
    $authResponse = @{
        type = "auth"
        method = "token"
        token = $token
        nonce = $challenge.payload.nonce
    } | ConvertTo-Json -Compress

    $ws.SendAsync([ArraySegment[byte]][System.Text.Encoding]::UTF8.GetBytes($authResponse), 'Text', $true, $ct).Wait()
    Write-Host "Auth sent"
}

# Wait for auth success
$buffer = [byte[]]::new(4096)
$receiveTask = $ws.ReceiveAsync($buffer, $ct)
$receiveTask.Wait()
$result = $receiveTask.Result
$authText = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
Write-Host "Auth response: $authText"

$auth = $authText | ConvertFrom-Json

if ($auth.event -eq "connect.success") {
    Write-Host "Authenticated! Sending message..."

    $chatRequest = @{
        id = "ps-test-1"
        method = "agent"
        params = @{
            message = $message
            sessionKey = "main"
        }
    } | ConvertTo-Json -Compress

    $ws.SendAsync([ArraySegment[byte]][System.Text.Encoding]::UTF8.GetBytes($chatRequest), 'Text', $true, $ct).Wait()
    Write-Host "Message sent: $message"

    # Wait for response
    $timeout = 60
    $elapsed = 0
    $responseReceived = $false

    while ($elapsed -lt $timeout -and $ws.State -eq 'Open') {
        $buffer = [byte[]]::new(8192)
        $receiveTask = $ws.ReceiveAsync($buffer, $ct)

        if ($receiveTask.Wait(1000)) {
            $result = $receiveTask.Result
            $responseText = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
            Write-Host "Response: $responseText"
            $responseReceived = $true

            # Check if it's a final response
            $resp = $responseText | ConvertFrom-Json
            if ($resp.event -eq "agent.stop") {
                Write-Host "Agent finished processing"
                break
            }
        }
        $elapsed++
    }

    if ($responseReceived) {
        Write-Host "`n=== SUCCESS: Message delivered and response received ==="
    } else {
        Write-Host "`n=== WARNING: No response received within timeout ==="
    }
}

$ws.CloseAsync('NormalClosure', "", $ct).Wait()
Write-Host "Connection closed"
