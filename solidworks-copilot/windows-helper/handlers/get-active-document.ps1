param([string]$RequestPath)

. (Join-Path $PSScriptRoot 'shared.ps1')
return (Invoke-GetActiveDocumentHandler -RequestPath $RequestPath)
