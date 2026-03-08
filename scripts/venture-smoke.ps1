param(
  [string]$BaseUrl = "http://127.0.0.1:18789",
  [string]$GatewayToken = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($GatewayToken)) {
  if ($env:OPENCLAW_GATEWAY_TOKEN) {
    $GatewayToken = $env:OPENCLAW_GATEWAY_TOKEN
  } else {
    throw "Gateway token required. Pass -GatewayToken or set OPENCLAW_GATEWAY_TOKEN."
  }
}

function Invoke-JsonPost {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][object]$Body
  )

  $tmpFile = Join-Path $env:TEMP ("venture-smoke-" + [Guid]::NewGuid().ToString("N") + ".json")
  $jsonBody = $Body | ConvertTo-Json -Depth 8 -Compress
  Set-Content -NoNewline -Path $tmpFile -Value $jsonBody

  try {
    $raw = & curl.exe --http1.1 -sS -i -X POST $Url `
      -H ("Authorization: Bearer {0}" -f $Token) `
      -H "Content-Type: application/json" `
      --data-binary ("@{0}" -f $tmpFile)

    $normalized = (($raw -join "`n") -replace "`r`n", "`n")
    $statusMatches = [regex]::Matches($normalized, "HTTP/\d\.\d\s+(\d+)")
    $parts = $normalized -split "`n`n"
    $bodyText = if ($parts.Count -gt 0) { $parts[$parts.Count - 1].Trim() } else { "" }
    $status = if ($statusMatches.Count -gt 0) { [int]$statusMatches[$statusMatches.Count - 1].Groups[1].Value } else { -1 }

    $parsed = $null
    try { $parsed = $bodyText | ConvertFrom-Json -ErrorAction Stop } catch {}
    return @{
      Status = $status
      BodyRaw = $bodyText
      BodyJson = $parsed
    }
  } finally {
    Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
  }
}

function New-MarketJobBody {
  return @{
    moduleId = "market-intelligence"
    input = @{
      query = "AI automation opportunities"
      signals = @(
        @{
          source = "manual"
          topic = "Automated local lead gen"
          momentum = 0.85
          pain = 0.9
          monetization = 0.75
        }
      )
    }
    priority = "high"
  }
}

function New-FunnelJobBody {
  return @{
    moduleId = "funnel-builder"
    input = @{
      offerName = "AI Ops Blueprint"
      audience = "SMB operators"
      channel = "web"
      goal = "checkout"
      hasUpsell = $true
    }
    priority = "normal"
  }
}

function Wait-JobTerminal {
  param(
    [Parameter(Mandatory = $true)][string]$JobId,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $resp = Invoke-JsonPost -Url ("{0}/v1/venture/jobs/status" -f $BaseUrl.TrimEnd("/")) -Token $GatewayToken -Body @{ jobId = $JobId }
    if ($resp.Status -eq 200 -and $resp.BodyJson -and $resp.BodyJson.job) {
      $status = [string]$resp.BodyJson.job.status
      Write-Host ("status[{0}]={1}" -f $JobId, $status)
      if ($status -eq "succeeded" -or $status -eq "failed") {
        return $resp
      }
    } else {
      Write-Host ("status[{0}] unexpected response: {1} {2}" -f $JobId, $resp.Status, $resp.BodyRaw)
    }
    Start-Sleep -Milliseconds 250
  }
  throw ("Timeout waiting for terminal status for job {0}" -f $JobId)
}

Write-Host "== venture smoke: enqueue market-intelligence =="
$marketEnqueue = Invoke-JsonPost -Url ("{0}/v1/venture/jobs" -f $BaseUrl.TrimEnd("/")) -Token $GatewayToken -Body (New-MarketJobBody)
Write-Host ("enqueue status: {0}" -f $marketEnqueue.Status)
Write-Host ("enqueue body: {0}" -f $marketEnqueue.BodyRaw)
if (-not $marketEnqueue.BodyJson -or -not $marketEnqueue.BodyJson.job -or -not $marketEnqueue.BodyJson.job.id) {
  throw "Market-intelligence enqueue failed."
}
$marketJobId = [string]$marketEnqueue.BodyJson.job.id

Write-Host "== venture smoke: enqueue funnel-builder =="
$funnelEnqueue = Invoke-JsonPost -Url ("{0}/v1/venture/jobs" -f $BaseUrl.TrimEnd("/")) -Token $GatewayToken -Body (New-FunnelJobBody)
Write-Host ("enqueue status: {0}" -f $funnelEnqueue.Status)
Write-Host ("enqueue body: {0}" -f $funnelEnqueue.BodyRaw)
if (-not $funnelEnqueue.BodyJson -or -not $funnelEnqueue.BodyJson.job -or -not $funnelEnqueue.BodyJson.job.id) {
  throw "Funnel-builder enqueue failed."
}
$funnelJobId = [string]$funnelEnqueue.BodyJson.job.id

Write-Host "== venture smoke: polling market job =="
$marketFinal = Wait-JobTerminal -JobId $marketJobId -TimeoutSeconds 25
Write-Host ("market final: {0}" -f $marketFinal.BodyRaw)

Write-Host "== venture smoke: polling funnel job =="
$funnelFinal = Wait-JobTerminal -JobId $funnelJobId -TimeoutSeconds 25
Write-Host ("funnel final: {0}" -f $funnelFinal.BodyRaw)

Write-Host "venture smoke complete"

