[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceLauncher,[Parameter(Mandatory)][string]$Artifacts)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Path $Artifacts | Out-Null
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($SourceLauncher,[ref]$tokens,[ref]$errors)
if ($errors.Count -ne 0 -or $null -eq $ast.ParamBlock) { throw 'Actual source launcher parameter block did not parse.' }
$bound=Join-Path $Artifacts 'bound.json'
$expected=@{Executable=(Join-Path $PSHOME 'pwsh.exe');ArgumentLine='-NoProfile -NonInteractive -File "C:ixture with spaces
un.ps1" -Source "C:ixture source" -Stage After -TestsOnly';DataDirectory=(Join-Path $Artifacts 'isolated data');McpPort=18789;ConsoleProcess=$true;WaitForExit=$true;ProcessTimeoutSeconds=1800;NamePrefix='ProviderArtworkAfter';ResultPath=$bound}
# Run only the exact source parameter declaration plus a data receipt. No source
# launcher body, Add-Type, desktop, runtime installation or UI code executes.
$body=@'
$receipt=@{}
foreach ($name in @('Executable','ArgumentLine','DataDirectory','McpPort','ProcessTimeoutSeconds','NamePrefix','ResultPath')) { $receipt[$name]=Get-Variable -Name $name -ValueOnly }
$receipt.ConsoleProcess=[bool]$ConsoleProcess;$receipt.WaitForExit=[bool]$WaitForExit
$receipt | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding utf8NoBOM
'@
$fixture=Join-Path $Artifacts 'source-parameters-only.ps1'
($ast.ParamBlock.Extent.Text+[char]10+$body) | Set-Content -LiteralPath $fixture -Encoding utf8NoBOM
$spec=Join-Path $Artifacts 'arguments.json'
@{launcher=$fixture;sha256=(Get-FileHash $fixture -Algorithm SHA256).Hash.ToLowerInvariant();parameters=$expected} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $spec -Encoding utf8NoBOM
& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'Invoke-SourceLauncherProcess.ps1') -ArgumentsPath $spec
if ($LASTEXITCODE -ne 0) { throw 'Launcher scalar binding probe failed before native build.' }
$actual=Get-Content $bound -Raw | ConvertFrom-Json -AsHashtable
foreach ($name in $expected.Keys) { if ($actual[$name] -cne $expected[$name]) { throw "Launcher binding changed $name." } }
$negativeFixture=Join-Path $Artifacts 'source-parameters-explicit-exit.ps1'
($ast.ParamBlock.Extent.Text+[char]10+$body+[char]10+'exit 23') | Set-Content -LiteralPath $negativeFixture -Encoding utf8NoBOM
$negativeParameters=$expected.Clone()
$negativeParameters.ResultPath=Join-Path $Artifacts 'negative-bound.json'
$negativeSpec=Join-Path $Artifacts 'negative-arguments.json'
@{launcher=$negativeFixture;sha256=(Get-FileHash $negativeFixture -Algorithm SHA256).Hash.ToLowerInvariant();parameters=$negativeParameters} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $negativeSpec -Encoding utf8NoBOM
$priorNative=$PSNativeCommandUseErrorActionPreference
$PSNativeCommandUseErrorActionPreference=$false
try {
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'Invoke-SourceLauncherProcess.ps1') -ArgumentsPath $negativeSpec
    $negativeExit=$LASTEXITCODE
} finally { $PSNativeCommandUseErrorActionPreference=$priorNative }
if ($negativeExit -ne 23) { throw 'Launcher transport did not preserve explicit nonzero source-script exit.' }
@{state='exact-source-parameter-json-transport-passed';sourceLauncherSha256=(Get-FileHash $SourceLauncher -Algorithm SHA256).Hash.ToLowerInvariant();argumentLineSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($actual.ArgumentLine)));checkedParameters=$expected.Keys;explicitExitPropagation=$negativeExit;nativeDesktopExecution=$false} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Artifacts 'result.json') -Encoding utf8NoBOM
