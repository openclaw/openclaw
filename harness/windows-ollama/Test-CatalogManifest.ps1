[CmdletBinding()]
param([Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Authorized disposable native CI only.' }
$url = 'https://raw.githubusercontent.com/microsoft/winget-pkgs/fcb37e5558b7629d808ecc6210488848328afcb3/manifests/o/Ollama/Ollama/0.40.13/Ollama.Ollama.installer.yaml'
$path = Join-Path $Artifacts 'Ollama.Ollama.installer.yaml'
if (Test-Path $path) { throw 'Refuse stale catalog data.' }
Invoke-WebRequest -Uri $url -OutFile $path -TimeoutSec 90
if ((Hash $path) -cne 'bab1bff45cadc507a844ff09097dffcc51c3190c029c9c9076a00d43117be10d') { throw 'Pinned catalog data bytes changed.' }
$text = [IO.File]::ReadAllText($path)
foreach ($literal in @('PackageIdentifier: Ollama.Ollama','PackageVersion: 0.40.13','Architecture: x64','Architecture: arm64',
    '9E3C76E54E7184C68E88A2378B909BF59BBE454F83C076CB4F4A717E946AE719',
    '{44E83376-CE68-45EB-8FC1-393500EB558C}_is1')) {
    if (!$text.Contains($literal,[StringComparison]::OrdinalIgnoreCase)) { throw "Reviewed catalog literal missing: $literal" }
}
Save-Json @{status='pinned-public-catalog-data-verified';url=$url;manifestSha256=(Hash $path);packageId='Ollama.Ollama';version='0.40.13';architectures=@('x64','arm64');installerSha256='9e3c76e54e7184c68e88a2378b909bf59bbe454f83c076cb4f4a717e946ae719';installerExecuted=$false;qualification='Pinned public manifest data only. Not actual configured catalog resolution, released signer or acquisition proof.'} (Join-Path $Artifacts 'catalog-manifest.json')
