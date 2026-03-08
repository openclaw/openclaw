param(
  [string]$BaseUrl = "https://openclaw-production-56fa.up.railway.app",
  [string]$Token = "",
  [string]$WakeText = "Test from Railway",
  [string]$AgentMessage = "say hello from diagnostics"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Token)) {
  if ($env:OPENCLAW_HOOKS_TOKEN) {
    $Token = $env:OPENCLAW_HOOKS_TOKEN
  } else {
    throw "Token required. Pass -Token or set OPENCLAW_HOOKS_TOKEN."
  }
}

function Get-Classification([int]$StatusCode) {
  switch ($StatusCode) {
    200 { "SUCCESS_OR_SYNC_OK" }
    202 { "SUCCESS_ASYNC_ACCEPTED" }
    400 { "BAD_REQUEST_OR_SCHEMA_JSON_ERROR" }
    401 { "AUTH_TOKEN_MISMATCH_OR_MISSING" }
    404 { "ROUTE_OR_CONFIG_NOT_LOADED" }
    429 { "AUTH_RATE_LIMITED" }
    default { "UNCLASSIFIED" }
  }
}

function Invoke-Hook {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][hashtable]$Payload
  )

  $uri = ("{0}{1}" -f $BaseUrl.TrimEnd("/"), $Path)
  $body = $Payload | ConvertTo-Json -Compress
  $tmpFile = Join-Path $env:TEMP ("openclaw-hook-" + [Guid]::NewGuid().ToString("N") + ".json")
  Set-Content -NoNewline -Path $tmpFile -Value $body

  Write-Host ("`n=== POST {0} ===" -f $uri)
  Write-Host ("RequestBody: {0}" -f $body)

  try {
    $responseText = & curl.exe --http1.1 -sS -i -X POST $uri `
      -H ("Authorization: Bearer {0}" -f $Token) `
      -H "Content-Type: application/json" `
      --data-binary ("@{0}" -f $tmpFile)

    $normalized = (($responseText -join "`n") -replace "`r`n", "`n")
    $statusMatches = [regex]::Matches($normalized, "HTTP/\d\.\d\s+(\d+)")
    $segments = $normalized -split "`n`n"
    $raw = if ($segments.Count -gt 0) { $segments[$segments.Count - 1].Trim() } else { "" }

    if ($statusMatches.Count -gt 0) {
      $status = [int]$statusMatches[$statusMatches.Count - 1].Groups[1].Value
    } else {
      $status = -1
      $raw = if ([string]::IsNullOrWhiteSpace($raw)) { $normalized } else { $raw }
    }
  } catch {
    $status = -1
    $raw = $_.Exception.Message
  } finally {
    Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
  }

  $classification = if ($status -eq -1) { "NETWORK_OR_RUNTIME_ERROR" } else { Get-Classification -StatusCode $status }
  Write-Host ("StatusCode: {0}" -f $status)
  Write-Host ("Classification: {0}" -f $classification)
  Write-Host ("ResponseBodyRaw: {0}" -f $raw)

  try {
    $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
    Write-Host ("ResponseBodyJson: {0}" -f ($parsed | ConvertTo-Json -Depth 8 -Compress))
  } catch {
    Write-Host "ResponseBodyJson: <non-json>"
  }
}

Invoke-Hook -Path "/hooks/wake" -Payload @{
  text = $WakeText
  mode = "now"
}

Invoke-Hook -Path "/hooks/agent" -Payload @{
  message = $AgentMessage
  name = "n8n"
  wakeMode = "now"
}
