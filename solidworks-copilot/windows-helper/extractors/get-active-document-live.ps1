param(
    [string]$RequestPath,
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Request {
    param([string]$Path)
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 10)
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Data
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $Data | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function New-ExtractorFailure {
    param(
        [string]$Code,
        [string]$Message,
        [hashtable]$Details = @{}
    )

    $exception = New-Object System.Exception($Message)
    $exception.Data['code'] = $Code
    foreach ($key in $Details.Keys) {
        $exception.Data[$key] = $Details[$key]
    }
    return $exception
}

function Get-DocTypeFromPath {
    param(
        [string]$Path,
        [string]$Title
    )

    $candidate = $Path
    if (-not $candidate) {
        $candidate = $Title
    }

    $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
    switch ($extension) {
        '.sldasm' { return 'assembly' }
        '.sldprt' { return 'part' }
        '.slddrw' { return 'drawing' }
        default { return 'unknown' }
    }
}

$request = Get-Request -Path $RequestPath
$isWindowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
if (-not $isWindowsHost) {
    throw (New-ExtractorFailure -Code 'host-platform-unsupported' -Message 'Live get-active-document extraction requires a Windows host.' -Details @{
        extractor = 'get-active-document-live'
        platform = [System.Environment]::OSVersion.Platform.ToString()
    })
}

try {
    $swApp = [System.Runtime.InteropServices.Marshal]::GetActiveObject('SldWorks.Application')
}
catch {
    throw (New-ExtractorFailure -Code 'solidworks-host-not-running' -Message 'SolidWorks is not running on the Windows helper host.' -Details @{
        extractor = 'get-active-document-live'
        progId = 'SldWorks.Application'
    })
}

$activeDoc = $swApp.ActiveDoc
if ($null -eq $activeDoc) {
    throw (New-ExtractorFailure -Code 'solidworks-no-active-document' -Message 'SolidWorks is running, but there is no active document.' -Details @{
        extractor = 'get-active-document-live'
        progId = 'SldWorks.Application'
    })
}

$warnings = @()
$unsupportedFields = @()
$partialRead = $false

$title = ''
try {
    $title = [string]$activeDoc.GetTitle()
}
catch {
    $title = 'Unknown'
    $warnings += 'Could not read active document title from SolidWorks COM object.'
    $partialRead = $true
}

$path = ''
try {
    $path = [string]$activeDoc.GetPathName()
}
catch {
    $warnings += 'Could not read active document path from SolidWorks COM object.'
    $partialRead = $true
}

$configuration = $null
try {
    $configuration = [string]$activeDoc.ConfigurationManager.ActiveConfiguration.Name
}
catch {
    $warnings += 'Could not read active configuration; leaving data.configuration null.'
    $unsupportedFields += 'data.configuration'
    $partialRead = $true
}

$isDirty = $null
try {
    $isDirty = [bool]$activeDoc.GetSaveFlag()
}
catch {
    $warnings += 'Could not determine dirty state; leaving data.isDirty null.'
    $unsupportedFields += 'data.isDirty'
    $partialRead = $true
}

$payload = [ordered]@{
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    mode = 'live-extractor'
    kind = 'get-active-document'
    data = [ordered]@{
        name = $title
        path = $path
        type = (Get-DocTypeFromPath -Path $path -Title $title)
        configuration = $configuration
        units = $null
        isDirty = $isDirty
    }
    diagnostics = [ordered]@{
        warnings = $warnings
        partialRead = $partialRead
        unsupportedFields = @('data.units') + $unsupportedFields
        confidenceHints = @(
            'Attached to a running SolidWorks host through COM.',
            'Only active document summary is live; deeper metadata extraction is not implemented yet.'
        )
        liveExtraction = [ordered]@{
            extractor = 'get-active-document-live'
            transport = 'com-get-active-object'
            solidworksHostRunning = $true
            activeDocumentPresent = $true
        }
    }
}

Write-JsonFile -Path $OutputPath -Data $payload
return $payload
