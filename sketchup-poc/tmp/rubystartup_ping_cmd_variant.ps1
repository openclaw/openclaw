$ErrorActionPreference = 'Stop'
$exe = 'C:\Program Files\SketchUp\SketchUp 2026\SketchUp\SketchUp.exe'
$rb = 'C:\OpenClaw\SketchUpPoC\bootstrap\rubystartup-ping-20260410\minimal-ping.rb'
$immediatePath = 'C:\OpenClaw\SketchUpPoC\bootstrap\rubystartup-ping-20260410\minimal-ping.immediate.json'
$delayedPath = 'C:\OpenClaw\SketchUpPoC\bootstrap\rubystartup-ping-20260410\minimal-ping.delayed.json'

Remove-Item $immediatePath,$delayedPath -Force -ErrorAction SilentlyContinue
$cmd = 'start "" /B "' + $exe + '" -RubyStartup "' + $rb + '"'
cmd.exe /c $cmd | Out-Null
Start-Sleep -Seconds 5
try {
  $wshell = New-Object -ComObject WScript.Shell
  $null = $wshell.AppActivate('SketchUp')
} catch {
}
Start-Sleep -Seconds 15
$procs = @(Get-Process SketchUp -ErrorAction SilentlyContinue)
$result = [pscustomobject]@{
  command = $cmd
  immediateSeen = Test-Path -LiteralPath $immediatePath
  delayedSeen = Test-Path -LiteralPath $delayedPath
  immediateArtifact = if (Test-Path -LiteralPath $immediatePath) { Get-Content -LiteralPath $immediatePath -Raw | ConvertFrom-Json } else { $null }
  delayedArtifact = if (Test-Path -LiteralPath $delayedPath) { Get-Content -LiteralPath $delayedPath -Raw | ConvertFrom-Json } else { $null }
  runningPids = @($procs | Select-Object -ExpandProperty Id)
}
$procs | Stop-Process -Force -ErrorAction SilentlyContinue
$result | ConvertTo-Json -Depth 20
