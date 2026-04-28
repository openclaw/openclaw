param([string]$RequestPath)

. (Join-Path $PSScriptRoot 'shared.ps1')

$null = Get-BridgeRequest -RequestPath $RequestPath
return @{
    host = 'windows-helper'
    sketchUp = @{
        extractionSurface = 'ruby-startup-live-or-seeded-fallback'
        supportedExtractionModes = @(
            'seeded',
            'prefer-live',
            'live-only'
        )
        activeScene = $true
        organizationSummary = $true
        materialSummary = $true
        cameraShotSummary = $true
        livePrerequisites = @{
            requiresWindowsHost = $true
            requiresModelPath = $true
            attachToActiveInstance = $false
            keepSketchUpOpenSupported = $true
        }
    }
    vray = @{
        available = $false
        renderReadiness = $false
        source = 'not-connected-yet'
    }
    commands = @(
        'ping',
        'capabilities',
        'extract-presentation-context'
    )
}
