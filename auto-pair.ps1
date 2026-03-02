# Auto-approve pairing repair after gateway startup
# Called by the startup bat file — runs in background, waits, approves

Start-Sleep -Seconds 30

cd D:\openclaw
for ($i = 0; $i -lt 10; $i++) {
    $result = & pnpm run openclaw -- devices list 2>&1 | Out-String
    
    if ($result -match "Pending") {
        # Extract the UUID request ID
        if ($result -match "([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})") {
            $requestId = $matches[1]
            & pnpm run openclaw -- devices approve $requestId 2>&1 | Out-Null
        }
        break
    }
    
    if ($result -match "Paired" -and $result -notmatch "Pending") {
        # Already paired, no repair needed
        break
    }
    
    Start-Sleep -Seconds 5
}
