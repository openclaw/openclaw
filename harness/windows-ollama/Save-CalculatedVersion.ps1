[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$Artifacts,[Parameter(Mandatory)][ValidateSet('Before','After')][string]$Stage)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
$Source = Resolve-ExistingDirectory $Source
$Artifacts = Resolve-ExistingDirectory $Artifacts
$project = Join-Path $Source 'src/OpenClaw.SetupEngine.UI/OpenClaw.SetupEngine.UI.csproj'
$raw = & dotnet msbuild $project -nologo -p:RuntimeIdentifier=win-x64 -p:WriteVersionInfoToBuildLog=false -getProperty:GitVersionOutputFile,WriteVersionInfoToBuildLog,DisableGitVersionTask,GetVersion,UpdateVersionProperties
if ($LASTEXITCODE -ne 0) { throw 'Evaluated GitVersion property query failed.' }
$values = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
$properties = $values.Properties
if ($properties.WriteVersionInfoToBuildLog -cne 'false' -or $properties.DisableGitVersionTask -cne 'false' -or
    $properties.GetVersion -cne 'true' -or $properties.UpdateVersionProperties -cne 'true') { throw 'Version computation or ordinary assembly version projection was not retained.' }
$path = [IO.Path]::GetFullPath($properties.GitVersionOutputFile, (Split-Path -Parent $project))
$computed = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$head = (Invoke-Git $Source @('rev-parse','HEAD')).Trim()
if ($computed.Sha -cne $head -or [string]::IsNullOrWhiteSpace($computed.FullSemVer)) { throw 'Actual computed GitVersion output does not bind this source HEAD.' }
Save-Json @{qualification='Actual computed version file following the affected build, not injected version values.';stage=$Stage;head=$head;
    evaluated=$properties;computedFile=$path;computedFileSha256=(Hash $path);sha=$computed.Sha;fullSemVer=$computed.FullSemVer;
    sourceBinding='Product and test-overlay postimages remain separately frozen; GitVersion HEAD alone is insufficient.'} (Join-Path $Artifacts "$Stage-calculated-version.json")
