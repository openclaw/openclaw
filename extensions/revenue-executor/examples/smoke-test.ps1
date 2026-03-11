param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$HookToken
)

$payloadPath = Join-Path $PSScriptRoot "hook-agent-request.json"
$payload = Get-Content -Raw -Path $payloadPath | ConvertFrom-Json

if ($null -ne $payload.sessionKey) {
  Write-Warning "sessionKey detected in payload and removed to honor hooks.allowRequestSessionKey=false"
  $payload.PSObject.Properties.Remove("sessionKey")
}

$body = $payload | ConvertTo-Json -Depth 20

if ($body -match '"sessionKey"\s*:') {
  throw "Payload still contains sessionKey. Aborting request because hooks.allowRequestSessionKey=false."
}

$headers = @{
  Authorization = "Bearer $HookToken"
  "Content-Type" = "application/json"
}

$uri = "$BaseUrl/hooks/agent"
Write-Host "POST $uri"
$response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body

if ($null -ne $response.runId -and [string]::IsNullOrWhiteSpace([string]$response.runId) -eq $false) {
  Write-Host "RUN_ID=$($response.runId)"
}

$response | ConvertTo-Json -Depth 10
