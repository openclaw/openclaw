param([string]$RequestPath)

. (Join-Path $PSScriptRoot 'shared.ps1')

$request = Get-BridgeRequest -RequestPath $RequestPath
return @{
    ok = $true
    requestId = [string]$request.requestId
    service = 'sketchup-vray-windows-helper'
}
