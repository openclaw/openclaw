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

    $dir = Split-Path -Parent $Path
    if ($dir) {
        New-DirIfMissing -Path $dir
    }

    $Data | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-HandlerPath {
    param(
        [string]$HandlersRoot,
        [string]$Kind
    )

    switch ($Kind) {
        'ping' { return (Join-Path $HandlersRoot 'ping.ps1') }
        'capabilities' { return (Join-Path $HandlersRoot 'capabilities.ps1') }
        'extract-presentation-context' { return (Join-Path $HandlersRoot 'extract-presentation-context.ps1') }
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

    $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json -Depth 12
    if ($request.schemaVersion -ne 'sketchup-bridge-request-envelope-v1') {
        throw "Unsupported request schema version: $($request.schemaVersion)"
    }
    if (-not $request.requestId) {
        throw "Request file is missing requestId: $RequestPath"
    }
    if (-not $request.kind) {
        throw "Request file is missing kind: $RequestPath"
    }

    $handlerPath = Get-HandlerPath -HandlersRoot $HandlersRoot -Kind ([string]$request.kind)
    $startedAtUtc = [DateTime]::UtcNow.ToString('o')
    $result = [ordered]@{
        schemaVersion = 'sketchup-bridge-result-envelope-v1'
        requestId = [string]$request.requestId
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
        $result.output = & $handlerPath -RequestPath $RequestPath
    }
    catch {
        $result.status = 'failed'
        $result.error = [ordered]@{
            message = $_.Exception.Message
            type = $_.Exception.GetType().FullName
        }

        $errorCode = $_.Exception.Data['code']
        if ($errorCode) {
            $result.error.code = [string]$errorCode
        }
    }
    finally {
        $result.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    }

    $resultPath = Join-Path $OutboundDir (([string]$request.requestId) + '.result.json')
    Write-JsonFile -Path $resultPath -Data $result

    $archivePath = Join-Path $ArchiveDir ((([string]$request.requestId) + '-') + (Split-Path -Leaf $RequestPath))
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
