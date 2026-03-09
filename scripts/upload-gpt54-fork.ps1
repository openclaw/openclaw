$inputData = "protocol=https`nhost=github.com`n`n"
$creds = $inputData | git credential fill
$token = ($creds | Select-String '^password=').ToString().Substring(9)

$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

$repo = "ethereall11/openclaw"
$branch = "feature/gpt54-computer-use-plugin"
$root = "C:\Users\14400\source\repos\openclaw-main"

$mainRef = Invoke-RestMethod -Method Get -Headers $headers -Uri "https://api.github.com/repos/$repo/git/ref/heads/main"
$mainSha = $mainRef.object.sha

try {
  Invoke-RestMethod -Method Post -Headers $headers -Uri "https://api.github.com/repos/$repo/git/refs" -Body (@{
    ref = "refs/heads/$branch"
    sha = $mainSha
  } | ConvertTo-Json) | Out-Null
} catch {
  if ($_.Exception.Message -notmatch "Reference already exists") {
    throw
  }
}

$files = @(
  @{ local = "docs/design/gpt-5.4-computer-use-plugin.md"; remote = "docs/design/gpt-5.4-computer-use-plugin.md" },
  @{ local = "docs/design/gpt-5.4-computer-use-discussion.md"; remote = "docs/design/gpt-5.4-computer-use-discussion.md" },
  @{ local = "extensions/computer-use/package.json"; remote = "extensions/computer-use/package.json" },
  @{ local = "extensions/computer-use/openclaw.plugin.json"; remote = "extensions/computer-use/openclaw.plugin.json" },
  @{ local = "extensions/computer-use/index.ts"; remote = "extensions/computer-use/index.ts" },
  @{ local = "extensions/computer-use/README.md"; remote = "extensions/computer-use/README.md" },
  @{ local = "extensions/computer-use/src/computer-use-tool.ts"; remote = "extensions/computer-use/src/computer-use-tool.ts" },
  @{ local = "scripts/upload-gpt54-fork.ps1"; remote = "scripts/upload-gpt54-fork.ps1" }
)

foreach ($item in $files) {
  $abs = Join-Path $root $item.local
  $uri = "https://api.github.com/repos/$repo/contents/$($item.remote -replace '\\','/')?ref=$branch"
  $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($abs))

  $existingSha = $null
  try {
    $existing = Invoke-RestMethod -Method Get -Headers $headers -Uri $uri
    $existingSha = $existing.sha
  } catch {
    $existingSha = $null
  }

  $body = @{
    message = "Add GPT-5.4 computer-use plugin scaffold"
    content = $content
    branch = $branch
  }

  if ($existingSha) {
    $body.sha = $existingSha
  }

  Invoke-RestMethod -Method Put -Headers $headers -Uri ("https://api.github.com/repos/$repo/contents/" + ($item.remote -replace '\\','/')) -Body ($body | ConvertTo-Json) | Out-Null
}

Write-Output "pushed:$repo@$branch"
