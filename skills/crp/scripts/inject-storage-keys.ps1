# inject-storage-keys.ps1
# Reads encrypted storage account keys from Key Vault cache and injects them
# into the CRP OneBox WFHost config file.
#
# IMPORTANT: Keys from Key Vault are ALREADY encrypted (base64 + cert thumbprint).
# Do NOT run EncryptStorageAccountKeysWithCertificate.ps1 on them — that double-encrypts.
#
# Usage: Run from PowerShell (elevated if needed) on the Windows host.

param(
    [string]$ConfigPath = "Q:\src\Compute-CPlat-Core\src\CRP\crp\debug-AMD64\distrib\CRP\WFPackage\CRP.WFHost.exe.config",
    [string]$KeyCachePath = "C:\temp\storage-keys-cache.json"
)

if (-not (Test-Path $ConfigPath)) {
    Write-Error "Config not found: $ConfigPath"
    exit 1
}

if (-not (Test-Path $KeyCachePath)) {
    Write-Error "Key cache not found: $KeyCachePath — export keys from Key Vault first"
    exit 1
}

$keys = Get-Content $KeyCachePath | ConvertFrom-Json
$xml = [xml](Get-Content $ConfigPath)

foreach ($key in $keys.PSObject.Properties) {
    $node = $xml.SelectSingleNode("//add[@key='$($key.Name)']")
    if ($node) {
        $node.value = $key.Value
        Write-Output "Injected: $($key.Name)"
    } else {
        Write-Warning "Key not found in config: $($key.Name)"
    }
}

$xml.Save($ConfigPath)
Write-Output "Done. Config saved: $ConfigPath"
