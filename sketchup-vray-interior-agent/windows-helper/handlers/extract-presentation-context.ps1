param([string]$RequestPath)

. (Join-Path $PSScriptRoot 'shared.ps1')
return (Invoke-ExtractPresentationContextHandler -RequestPath $RequestPath)
