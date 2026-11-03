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
# This stage-only evaluation cannot build/capture or mutate source. The native
# Git smoke below writes only its uniquely owned proof repository and no commits.
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
# Exercise the ACTUAL current driver function, not a hand-written substitute.
$gitFunctions=@($ast.FindAll({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ieq 'Git'
},$true))
if ($gitFunctions.Count -ne 1) { throw 'Expected one current driver Git function.' }
$functionText=$gitFunctions[0].Extent.Text
$functionSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($functionText))).ToLowerInvariant()
$application=Get-Command git -CommandType Application -ErrorAction Stop
$tempRoot=if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$smokeRoot=Join-Path $tempRoot ('provider-artwork-native-git-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
$repository=Join-Path $smokeRoot 'proof.git'
& $application.Source init --bare --object-format=sha1 --quiet $repository
if ($LASTEXITCODE -ne 0) { throw 'Owned native Git smoke repository initialization failed.' }
$fixture=Join-Path $smokeRoot 'fixture.txt'
[IO.File]::WriteAllBytes($fixture,[Text.Encoding]::UTF8.GetBytes('OpenClaw native Git application smoke.'+[char]10))
# Independent Git blob-format SHA1 of these exact 39 fixture bytes. No commit is created.
$expectedSha='23dac5b69b37a75f3a4c111044a841b8a6b76761'
$written=(& $application.Source -C $repository hash-object -w $fixture).Trim()
if ($LASTEXITCODE -ne 0 -or $written -cne $expectedSha) { throw 'Native Git smoke fixture identity differs.' }
$observed=& {
    param($definition,$ownedRepository,$expected)
    $Source=$ownedRepository
    . ([scriptblock]::Create($definition))
    $currentFunction=Get-Command Git -CommandType Function -ErrorAction Stop
    (& $currentFunction @('rev-parse','--verify',($expected+'^{blob}'))).Trim()
} $functionText $repository $expectedSha
if ($observed -cne $expectedSha) { throw 'Extracted current driver Git wrapper did not return the expected native object SHA.' }
$nativeGitSmoke=@{state='passed';expectedSha=$expectedSha;observedSha=$observed;driverFunctionSha256=$functionSha;application=$application.Source;ownedRepository=$repository;sourceCommitCreated=$false}
$result=[pscustomobject]@{nativeGitSmoke=$nativeGitSmoke;state='packet-parse-and-stage-normalization-passed';cases=$cases.Count;nativeUiExecution=$false;nativeGitExecution=$true;driverSha256=(Get-FileHash $driver -Algorithm SHA256).Hash;parsedFiles=$parsed;runId=$env:GITHUB_RUN_ID;createdUtc=[DateTimeOffset]::UtcNow}
$json=$result | ConvertTo-Json -Depth 8
if ($Receipt) { $json | Set-Content -LiteralPath $Receipt -Encoding utf8NoBOM }
$json
