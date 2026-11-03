[CmdletBinding()]
param([string]$Receipt)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$driver=Join-Path $PSScriptRoot 'Invoke-ProviderArtworkProof.ps1'
$parsed=@()
$ast=$null
foreach ($file in Get-ChildItem $PSScriptRoot -File -Filter '*.ps1') {
    $tokens=$null
    $errors=$null
    $current=[System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
    if ($errors.Count -ne 0) { throw ($errors | Out-String) }
    $parsed += @{path=$file.Name;sha256=(Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
    if ($file.FullName -ieq $driver) { $ast=$current }
}
if ($null -eq $ast) { throw 'Driver was not parsed.' }
$assignments=@($ast.FindAll({param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$Stage'
},$true))
if ($assignments.Count -ne 1) { throw 'Expected one canonical stage-normalization assignment.' }
# Evaluate only the actual reviewed normalization statement, never the driver.
# This gate cannot build, launch, capture, modify source or allocate a host.
$normalize=[scriptblock]::Create($assignments[0].Extent.Text)
$cases=@(
    @{input='Before';expected='Before'}, @{input='before';expected='Before'},
    @{input='BEFORE';expected='Before'}, @{input='bEfOrE';expected='Before'},
    @{input='After';expected='After'}, @{input='after';expected='After'},
    @{input='AFTER';expected='After'}, @{input='aFtEr';expected='After'}
)
foreach ($case in $cases) {
    $Stage=$case.input
    . $normalize
    if ($Stage -cne $case.expected) { throw "Stage normalization failed for $($case.input)." }
    $before=$Stage -ceq 'Before'
    if ($before -ne ($case.expected -ceq 'Before')) { throw 'Normalized stage selects the wrong provenance branch.' }
}
$result=[pscustomobject]@{state='packet-parse-and-stage-normalization-passed';cases=$cases.Count;nativeExecution=$false;driverSha256=(Get-FileHash $driver -Algorithm SHA256).Hash;parsedFiles=$parsed;runId=$env:GITHUB_RUN_ID;createdUtc=[DateTimeOffset]::UtcNow}
$json=$result | ConvertTo-Json -Depth 8
if ($Receipt) { $json | Set-Content -LiteralPath $Receipt -Encoding utf8NoBOM }
$json
