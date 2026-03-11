param(
  [Parameter(Mandatory = $true)]
  [string]$RunId,

  [string]$Service = "openclaw",
  [string]$Environment = "production",
  [string]$Since = "24h",
  [int]$Lines = 2000
)

Write-Host "Searching Railway logs for runId: $RunId"
$logs = railway logs --service $Service --environment $Environment --lines $Lines --since $Since --json 2>&1

$matches = $logs | Select-String -Pattern $RunId -CaseSensitive:$false
if ($matches) {
  $matches | ForEach-Object { $_.Line }
  exit 0
}

Write-Host "No exact runId match found. Checking revenue keywords..."
$keywordMatches = $logs | Select-String -Pattern "execute_revenue_command|ghl|stripe|callback|hooks/agent" -CaseSensitive:$false
if ($keywordMatches) {
  $keywordMatches | Select-Object -First 100 | ForEach-Object { $_.Line }
  exit 0
}

Write-Host "No matching revenue traces found in selected log window."
exit 1
