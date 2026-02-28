param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$LayerName,
  [Parameter(Mandatory = $true)][string]$NewText,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"

function Write-Json($obj) {
  $obj | ConvertTo-Json -Compress
}

try {
  $app = New-Object -ComObject Photoshop.Application
  $app.DisplayDialogs = 3
} catch {
  Write-Output (Write-Json @{ status = "error"; code = "E_PHOTOSHOP_UNAVAILABLE"; message = $_.Exception.Message })
  exit 1
}

try {
  $doc = $app.Open($InputPath)

  $availableLayers = @()
  $target = $null
  foreach ($layer in $doc.ArtLayers) {
    try {
      if ($layer.Kind -eq 2) {
        $availableLayers += [string]$layer.Name
      }
    } catch {}
    if ($layer.Name -eq $LayerName) {
      $target = $layer
      break
    }
  }
  if ($null -eq $target) {
    $joined = ($availableLayers -join ", ")
    throw "E_LAYER_NOT_FOUND: $LayerName | AVAILABLE_LAYERS: $joined"
  }

  $textItem = $target.TextItem
  $beforeText = $textItem.Contents
  $beforeFont = $textItem.Font
  $beforeSize = $textItem.Size

  $textItem.Contents = $NewText

  if ($textItem.Font -ne $beforeFont -or $textItem.Size -ne $beforeSize) {
    $textItem.Contents = $beforeText
    throw "E_STYLE_MISMATCH: font/size changed unexpectedly"
  }

  $opts = New-Object -ComObject Photoshop.PhotoshopSaveOptions
  $doc.SaveAs($OutputPath, $opts, $true)
  $doc.Close(2)
  Write-Output (Write-Json @{ status = "ok"; code = "OK" })
  exit 0
} catch {
  try {
    if ($doc -ne $null) {
      $doc.Close(2)
    }
  } catch {}
  Write-Output (Write-Json @{ status = "error"; code = "E_EXEC_FAILED"; message = $_.Exception.Message })
  exit 1
}
