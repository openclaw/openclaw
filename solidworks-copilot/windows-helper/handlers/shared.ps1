Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BridgeRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
}

function Get-BridgeRequest {
    param([string]$RequestPath)
    return (Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json -Depth 10)
}

function Get-ArtifactPath {
    param(
        [string]$RequestId
    )

    $bridgeRoot = Get-BridgeRoot
    return (Join-Path (Join-Path $bridgeRoot 'artifacts') ($RequestId + '.json'))
}

function New-BridgeFailure {
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

function Invoke-SeededProbeHandler {
    param(
        [string]$RequestPath,
        [string]$Kind,
        [string[]]$ExtraWarnings = @()
    )

    $request = Get-BridgeRequest -RequestPath $RequestPath
    $bridgeRoot = Get-BridgeRoot
    $artifactPath = Get-ArtifactPath -RequestId ([string]$request.requestId)
    $scriptPath = Join-Path (Join-Path $bridgeRoot 'scripts') 'solidworks_probe.py'

    $arguments = @($scriptPath, $Kind, '--output-path', $artifactPath)
    foreach ($warning in $ExtraWarnings) {
        $arguments += @('--warning', $warning)
    }
    python3 @arguments | Out-Null

    return (Get-Content -LiteralPath $artifactPath -Raw | ConvertFrom-Json -Depth 10)
}

function Invoke-GetActiveDocumentLiveExtractor {
    param(
        [string]$RequestPath
    )

    $request = Get-BridgeRequest -RequestPath $RequestPath
    $bridgeRoot = Get-BridgeRoot
    $artifactPath = Get-ArtifactPath -RequestId ([string]$request.requestId)
    $extractorPath = Join-Path (Join-Path $bridgeRoot 'windows-helper') 'extractors/get-active-document-live.ps1'

    & $extractorPath -RequestPath $RequestPath -OutputPath $artifactPath
    return (Get-Content -LiteralPath $artifactPath -Raw | ConvertFrom-Json -Depth 10)
}

function Invoke-GetActiveDocumentHandler {
    param(
        [string]$RequestPath
    )

    $request = Get-BridgeRequest -RequestPath $RequestPath
    $mode = 'seeded'
    if ($request.payload -and $request.payload.extractionMode) {
        $mode = [string]$request.payload.extractionMode
    }

    switch ($mode) {
        'seeded' {
            return (Invoke-SeededProbeHandler -RequestPath $RequestPath -Kind 'get-active-document')
        }
        'prefer-live' {
            try {
                return (Invoke-GetActiveDocumentLiveExtractor -RequestPath $RequestPath)
            }
            catch {
                $code = $_.Exception.Data['code']
                if (-not $code) {
                    $code = 'get-active-document-live-extractor-failed'
                }
                $warning = "Live get-active-document extractor failed with code '$code': $($_.Exception.Message)"
                return (Invoke-SeededProbeHandler -RequestPath $RequestPath -Kind 'get-active-document' -ExtraWarnings @(
                    $warning,
                    'Falling back to seeded get-active-document data because extractionMode=prefer-live.'
                ))
            }
        }
        'live-only' {
            return (Invoke-GetActiveDocumentLiveExtractor -RequestPath $RequestPath)
        }
        default {
            throw (New-BridgeFailure -Code 'invalid-extraction-mode' -Message "Unsupported extractionMode for get-active-document: $mode" -Details @{
                extractor = 'get-active-document'
                allowedModes = 'seeded,prefer-live,live-only'
            })
        }
    }
}
