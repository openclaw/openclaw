param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$PngPath
)

$ErrorActionPreference = "Stop"

function Write-Json($obj) {
  $obj | ConvertTo-Json -Compress
}

try {
  $app = New-Object -ComObject Photoshop.Application
  $app.DisplayDialogs = 3
  $doc = $app.Open($InputPath)
  $opts = New-Object -ComObject Photoshop.ExportOptionsSaveForWeb
  $opts.Format = 13
  $opts.PNG8 = $false
  $opts.Transparency = $true
  $doc.Export($PngPath, 2, $opts)
  $doc.Close(2)
  Write-Output (Write-Json @{ status = "ok"; code = "OK" })
  exit 0
} catch {
  try {
    if ($doc -ne $null) {
      $doc.Close(2)
    }
  } catch {}
  Write-Output (Write-Json @{ status = "error"; code = "E_EXPORT_FAILED"; message = $_.Exception.Message })
  exit 1
}
