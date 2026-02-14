$ErrorActionPreference = "Stop"

$PackageName = if ($env:QVERISBOT_INSTALL_PACKAGE) { $env:QVERISBOT_INSTALL_PACKAGE } else { "@qverisai/qverisbot" }
$Version = if ($env:QVERISBOT_VERSION) { $env:QVERISBOT_VERSION } else { "latest" }
$NoOnboard = $false

foreach ($arg in $args) {
    if ($arg -eq "--no-onboard") {
        $NoOnboard = $true
    }
}

function Test-Command($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ensure-Node {
    if (Test-Command "node") {
        $major = [int]((node -p "process.versions.node.split('.')[0]").Trim())
        if ($major -ge 22) {
            return
        }
    }

    Write-Host "Node.js 22+ not found. Installing Node.js LTS with winget..."
    if (-not (Test-Command "winget")) {
        throw "winget is required to install Node.js automatically."
    }

    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
}

Ensure-Node

Write-Host "Installing $PackageName@$Version ..."
npm i -g "$PackageName@$Version"

if (-not $NoOnboard -and -not $env:QVERISBOT_NO_ONBOARD -and -not $env:OPENCLAW_NO_ONBOARD) {
    if (Test-Command "qverisbot") {
        qverisbot onboard
    } elseif (Test-Command "openclaw") {
        openclaw onboard
    } else {
        Write-Warning "Install succeeded but no CLI command found in PATH."
    }
}
