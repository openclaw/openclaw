Write-Output "=== Service Fabric SDK ==="
if (Test-Path "C:\Program Files\Microsoft SDKs\Service Fabric") {
    Write-Output "SF SDK: INSTALLED"
} else {
    Write-Output "SF SDK: NOT FOUND"
}

Write-Output "`n=== SF PowerShell Module ==="
$sfMod = Get-Module -ListAvailable ServiceFabric -ErrorAction SilentlyContinue
if ($sfMod) { Write-Output "SF Module: $($sfMod.Version)" } else { Write-Output "SF Module: NOT FOUND" }

Write-Output "`n=== SF Local Cluster ==="
try {
    $cluster = Connect-ServiceFabricCluster -ConnectionEndpoint localhost:19000 -TimeoutSec 3 -WarningAction SilentlyContinue 2>$null
    Write-Output "Local cluster: CONNECTED"
} catch {
    Write-Output "Local cluster: NOT RUNNING"
}

Write-Output "`n=== Az CLI ==="
$az = Get-Module -ListAvailable Az.Accounts -ErrorAction SilentlyContinue
if ($az) { Write-Output "Az.Accounts: $($az[0].Version)" } else { Write-Output "Az.Accounts: NOT FOUND" }

Write-Output "`n=== CRP Build Output (WFPackage) ==="
$buildPath = "Q:\src\Compute-CPlat-Core\src\CRP\crp\debug-AMD64\distrib\CRP\WFPackage"
if (Test-Path $buildPath) {
    Write-Output "WFPackage: EXISTS"
    Get-ChildItem $buildPath | ForEach-Object { Write-Output "  $_" }
} else {
    Write-Output "WFPackage: NOT FOUND at $buildPath"
}

Write-Output "`n=== CRP Certificates ==="
$certs = Get-ChildItem Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like "*CRPOneBox*" -or $_.Subject -like "*ace*" }
if ($certs) {
    $certs | ForEach-Object { Write-Output "  $($_.Subject) (expires $($_.NotAfter))" }
} else {
    Write-Output "No CRP/ACE certs found in LocalMachine\My"
}
