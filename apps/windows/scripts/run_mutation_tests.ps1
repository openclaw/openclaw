#Requires -Version 7.0
<#
.SYNOPSIS
    Runs Stryker.NET mutation tests for OpenClaw Windows.
.DESCRIPTION
    Wraps dotnet stryker with the project's stryker-config.json configuration.
    Requires Windows and .NET 9 SDK.
.PARAMETER OpenReport
    Open the HTML report in the default browser after the run.
.PARAMETER Threshold
    Override the break threshold (default: 60 from stryker-config.json).
#>
param(
    [switch]$OpenReport,
    [int]$Threshold = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

Push-Location $projectRoot

try {
    if (-not (Get-Command 'dotnet-stryker' -ErrorAction SilentlyContinue)) {
        Write-Host "Installing dotnet-stryker tool..."
        dotnet tool install --global dotnet-stryker
    }

    $args = @()
    if ($Threshold -gt 0) {
        $args += "--break-at", $Threshold
    }

    Write-Host "Running Stryker.NET mutation tests..."
    dotnet stryker @args

    $reportPath = Join-Path $projectRoot "StrykerOutput" "reports" "mutation-report.html"
    if ($OpenReport -and (Test-Path $reportPath)) {
        Start-Process $reportPath
    }

    Write-Host "Mutation testing complete. Report: $reportPath"
}
finally {
    Pop-Location
}
