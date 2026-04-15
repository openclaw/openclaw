[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assetsDir = Join-Path $root "src-tauri\installer\windows\assets"
$iconPath = Join-Path $root "src-tauri\icons\icon.png"

New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

function New-Brush([string]$Color) {
  return New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($Color))
}

function Save-Bitmap {
  param(
    [int]$Width,
    [int]$Height,
    [string]$OutputPath,
    [scriptblock]$Painter
  )

  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  try {
    & $Painter $bitmap $graphics
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Draw-Icon {
  param(
    [System.Drawing.Graphics]$Graphics,
    [int]$Left,
    [int]$Top,
    [int]$Size
  )

  $icon = [System.Drawing.Image]::FromFile($iconPath)
  try {
    $Graphics.DrawImage($icon, $Left, $Top, $Size, $Size)
  } finally {
    $icon.Dispose()
  }
}

function Draw-Light-Banner {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [System.Drawing.Graphics]$Graphics,
    [int]$AccentWidth,
    [int]$IconSize
  )

  $Graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#F7F8FA"))
  $Graphics.FillRectangle((New-Brush "#FF5A57"), 0, 0, $AccentWidth, $Bitmap.Height)
  $Graphics.FillRectangle((New-Brush "#E4E8EE"), 0, $Bitmap.Height - 1, $Bitmap.Width, 1)
  Draw-Icon -Graphics $Graphics -Left ($AccentWidth + 12) -Top ([Math]::Max(0, ($Bitmap.Height - $IconSize) / 2)) -Size $IconSize
}

function Draw-Dark-Panel {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [System.Drawing.Graphics]$Graphics,
    [int]$IconSize
  )

  $Graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#F7F8FA"))
  $Graphics.FillRectangle((New-Brush "#E4E8EE"), $Bitmap.Width - 1, 0, 1, $Bitmap.Height)
  $accentBrush = New-Brush "#FFE6E5"
  try {
    $Graphics.FillEllipse($accentBrush, -28, $Bitmap.Height - 86, 76, 76)
    $Graphics.FillEllipse($accentBrush, $Bitmap.Width - 54, 18, 30, 30)
  } finally {
    $accentBrush.Dispose()
  }

  Draw-Icon -Graphics $Graphics -Left 22 -Top 22 -Size $IconSize
}

function Draw-Dialog-Panel {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [System.Drawing.Graphics]$Graphics,
    [int]$IconSize
  )

  $Graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#F7F8FA"))
  $Graphics.FillRectangle((New-Brush "#FF5A57"), 0, 0, 10, $Bitmap.Height)
  $Graphics.FillRectangle((New-Brush "#E4E8EE"), 10, 0, 1, $Bitmap.Height)

  $accentBrush = New-Brush "#FFF0EF"
  try {
    $Graphics.FillEllipse($accentBrush, 36, $Bitmap.Height - 112, 72, 72)
  } finally {
    $accentBrush.Dispose()
  }

  Draw-Icon -Graphics $Graphics -Left 34 -Top 34 -Size $IconSize
}

Save-Bitmap -Width 493 -Height 58 -OutputPath (Join-Path $assetsDir "wix-banner.bmp") -Painter {
  param($bitmap, $graphics)
  Draw-Light-Banner -Bitmap $bitmap -Graphics $graphics -AccentWidth 12 -IconSize 34
}

Save-Bitmap -Width 493 -Height 312 -OutputPath (Join-Path $assetsDir "wix-dialog.bmp") -Painter {
  param($bitmap, $graphics)
  Draw-Dialog-Panel -Bitmap $bitmap -Graphics $graphics -IconSize 72
}

Save-Bitmap -Width 150 -Height 57 -OutputPath (Join-Path $assetsDir "nsis-header.bmp") -Painter {
  param($bitmap, $graphics)
  Draw-Light-Banner -Bitmap $bitmap -Graphics $graphics -AccentWidth 10 -IconSize 30
}

Save-Bitmap -Width 164 -Height 314 -OutputPath (Join-Path $assetsDir "nsis-sidebar.bmp") -Painter {
  param($bitmap, $graphics)
  Draw-Dark-Panel -Bitmap $bitmap -Graphics $graphics -IconSize 56
}

Write-Host "Generated installer branding assets in $assetsDir"
