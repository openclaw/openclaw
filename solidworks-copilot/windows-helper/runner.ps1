param(
    [string]$QueueRoot = (Join-Path $PSScriptRoot '../queue'),
    [switch]$RunOnce,
    [int]$PollIntervalSeconds = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-DirIfMissing {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Data
    )

    $json = $Data | ConvertTo-Json -Depth 10
    $dir = Split-Path -Parent $Path
    if ($dir) {
        New-DirIfMissing -Path $dir
    }
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

function Get-HandlerPath {
    param(
        [string]$HandlersRoot,
        [string]$Kind
    )

    switch ($Kind) {
        'ping' { return (Join-Path $HandlersRoot 'ping.ps1') }
        'capabilities' { return (Join-Path $HandlersRoot 'capabilities.ps1') }
        'get-active-document' { return (Join-Path $HandlersRoot 'get-active-document.ps1') }
        'get-document-metadata' { return (Join-Path $HandlersRoot 'get-document-metadata.ps1') }
        'get-selection-context' { return (Join-Path $HandlersRoot 'get-selection-context.ps1') }
        'get-assembly-summary' { return (Join-Path $HandlersRoot 'get-assembly-summary.ps1') }
        'extract-poc-context' { return (Join-Path $HandlersRoot 'extract-poc-context.ps1') }
        default { throw "Unsupported request kind: $Kind" }
    }
}

function Invoke-Request {
    param(
        [string]$RequestPath,
        [string]$HandlersRoot,
        [string]$OutboundDir,
        [string]$ArchiveDir
    )

    $raw = Get-Content -LiteralPath $RequestPath -Raw
    $request = $raw | ConvertFrom-Json

    if (-not $request.schemaVersion) {
        throw "Request file is missing schemaVersion: $RequestPath"
    }
    if ($request.schemaVersion -ne 'solidworks-bridge-request-envelope-v1') {
        throw "Unsupported request schema version: $($request.schemaVersion)"
    }
    if (-not $request.requestId) {
        throw "Request file is missing requestId: $RequestPath"
    }
    if (-not $request.kind) {
        throw "Request file is missing kind: $RequestPath"
    }

    $requestId = [string]$request.requestId
    $handlerPath = Get-HandlerPath -HandlersRoot $HandlersRoot -Kind ([string]$request.kind)
    $startedAtUtc = [DateTime]::UtcNow.ToString('o')

    $result = [ordered]@{
        schemaVersion = 'solidworks-bridge-result-envelope-v1'
        requestId = $requestId
        kind = [string]$request.kind
        status = 'succeeded'
        startedAtUtc = $startedAtUtc
        finishedAtUtc = $null
        host = $env:COMPUTERNAME
        handler = (Split-Path -Leaf $handlerPath)
        output = $null
        error = $null
    }

    try {
        $handlerOutput = & $handlerPath -RequestPath $RequestPath
        $result.output = $handlerOutput
    }
    catch {
        $errorCode = $_.Exception.Data['code']
        $details = @{}
        foreach ($key in $_.Exception.Data.Keys) {
            if ($key -ne 'code') {
                $details[[string]$key] = $_.Exception.Data[$key]
            }
        }

        $result.status = 'failed'
        $result.error = [ordered]@{
            message = $_.Exception.Message
            type = $_.Exception.GetType().FullName
        }
        if ($errorCode) {
            $result.error.code = [string]$errorCode
        }
        if ($details.Count -gt 0) {
            $result.error.details = $details
        }
    }
    finally {
        $result.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    }

    $outPath = Join-Path $OutboundDir ($requestId + '.result.json')
    Write-JsonFile -Path $outPath -Data $result

    $archiveName = ('{0}-{1}' -f $requestId, (Split-Path -Leaf $RequestPath))
    $archivePath = Join-Path $ArchiveDir $archiveName
    Move-Item -LiteralPath $RequestPath -Destination $archivePath -Force
}

if ([System.IO.Path]::IsPathRooted($QueueRoot)) {
    $resolvedQueueRoot = [System.IO.Path]::GetFullPath($QueueRoot)
}
else {
    $resolvedQueueRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $QueueRoot))
}
$inboundDir = Join-Path $resolvedQueueRoot 'inbound'
$outboundDir = Join-Path $resolvedQueueRoot 'outbound'
$archiveDir = Join-Path $resolvedQueueRoot 'archive'
$handlersRoot = Join-Path $PSScriptRoot 'handlers'

New-DirIfMissing -Path $inboundDir
New-DirIfMissing -Path $outboundDir
New-DirIfMissing -Path $archiveDir

function Process-PendingRequests {
    $files = @(Get-ChildItem -LiteralPath $inboundDir -Filter '*.json' -File | Sort-Object Name)
    foreach ($file in $files) {
        Invoke-Request -RequestPath $file.FullName -HandlersRoot $handlersRoot -OutboundDir $outboundDir -ArchiveDir $archiveDir
    }
    return $files.Count
}

if ($RunOnce) {
    Process-PendingRequests | Out-Null
    return
}

while ($true) {
    $count = Process-PendingRequests
    if ($count -eq 0) {
        Start-Sleep -Seconds $PollIntervalSeconds
    }
}
