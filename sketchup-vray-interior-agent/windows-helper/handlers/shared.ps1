Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BridgeRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
}

function Get-BridgeRequest {
    param([string]$RequestPath)
    return (Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json -Depth 12)
}

function New-BridgeFailure {
    param(
        [string]$Code,
        [string]$Message
    )

    $exception = New-Object System.Exception($Message)
    $exception.Data['code'] = $Code
    return $exception
}

function Get-SeededExamplePath {
    return (Join-Path (Join-Path (Get-BridgeRoot) 'examples') 'extract-presentation-context/result.seeded.json')
}

function Get-ArtifactPath {
    param(
        [string]$RequestId
    )

    $bridgeRoot = Get-BridgeRoot
    return (Join-Path (Join-Path $bridgeRoot 'artifacts') ($RequestId + '.json'))
}

function Invoke-ExtractPresentationContextLiveExtractor {
    param(
        [string]$RequestPath
    )

    $request = Get-BridgeRequest -RequestPath $RequestPath
    $bridgeRoot = Get-BridgeRoot
    $artifactPath = Get-ArtifactPath -RequestId ([string]$request.requestId)
    $extractorPath = Join-Path (Join-Path $bridgeRoot 'windows-helper') 'extractors/extract-presentation-context-live.ps1'

    & $extractorPath -RequestPath $RequestPath -OutputPath $artifactPath
    return (Get-Content -LiteralPath $artifactPath -Raw | ConvertFrom-Json -Depth 12)
}

function Invoke-ExtractPresentationContextHandler {
    param([string]$RequestPath)

    $request = Get-BridgeRequest -RequestPath $RequestPath
    $mode = 'seeded'
    if ($request.payload -and $request.payload.extractionMode) {
        $mode = [string]$request.payload.extractionMode
    }

    switch ($mode) {
        'seeded' {
            return (Get-Content -LiteralPath (Get-SeededExamplePath) -Raw | ConvertFrom-Json -Depth 12)
        }
        'prefer-live' {
            try {
                return (Invoke-ExtractPresentationContextLiveExtractor -RequestPath $RequestPath)
            }
            catch {
                $code = $_.Exception.Data['code']
                if (-not $code) {
                    $code = 'extract-presentation-context-live-extractor-failed'
                }

                $seeded = Get-Content -LiteralPath (Get-SeededExamplePath) -Raw | ConvertFrom-Json -Depth 12
                $seeded.diagnostics.partialRead = $true
                $seeded.diagnostics.warnings += "Live extract-presentation-context extractor failed with code '$code': $($_.Exception.Message)"
                $seeded.diagnostics.warnings += 'Falling back to seeded SketchUp presentation context because extractionMode=prefer-live.'
                return $seeded
            }
        }
        'live-only' {
            return (Invoke-ExtractPresentationContextLiveExtractor -RequestPath $RequestPath)
        }
        default {
            throw (New-BridgeFailure -Code 'invalid-extraction-mode' -Message "Unsupported extractionMode: $mode")
        }
    }
}
