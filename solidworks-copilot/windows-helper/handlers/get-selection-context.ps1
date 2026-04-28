param([string]$RequestPath)

. (Join-Path $PSScriptRoot 'shared.ps1')
return (Invoke-SeededProbeHandler -RequestPath $RequestPath -Kind 'get-selection-context')
