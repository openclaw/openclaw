$ErrorActionPreference = 'Stop'
$exe = 'C:\Program Files\SketchUp\SketchUp 2026\SketchUp\SketchUp.exe'
$pluginDir = 'C:\Users\mertb\AppData\Roaming\SketchUp\SketchUp 2026\SketchUp\Plugins'
$probeDir = 'C:\OpenClaw\SketchUpPoC\bootstrap\plugin-autoload-probe-20260410'
$probeFile = Join-Path $probeDir 'autoload-ping.json'
$pluginFile = Join-Path $pluginDir 'zz_openclaw_autoload_probe.rb'

New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue

@'
require 'json'
require 'fileutils'
require 'time'
path = 'C:\OpenClaw\SketchUpPoC\bootstrap\plugin-autoload-probe-20260410\autoload-ping.json'
FileUtils.mkdir_p(File.dirname(path))
File.write(path, JSON.pretty_generate({
  wroteAtUtc: Time.now.utc.iso8601,
  pid: Process.pid,
  rubyVersion: RUBY_VERSION,
  sketchupVersion: (Sketchup.version.to_s rescue nil),
  modelTitle: (Sketchup.active_model&.title rescue nil),
  modelPath: (Sketchup.active_model&.path rescue nil)
}) + "\n")
UI.start_timer(5, false) { Sketchup.quit }
'@ | Set-Content -LiteralPath $pluginFile -Encoding UTF8

$proc = Start-Process -FilePath $exe -PassThru
$deadline = (Get-Date).AddSeconds(25)
$seen = $false
while((Get-Date) -lt $deadline){
  if(Test-Path -LiteralPath $probeFile){ $seen = $true; break }
  Start-Sleep -Milliseconds 500
}

$artifact = $null
if($seen){
  try { $artifact = Get-Content -LiteralPath $probeFile -Raw | ConvertFrom-Json -Depth 20 } catch { $artifact = Get-Content -LiteralPath $probeFile -Raw }
}

$proc.Refresh()
$running = -not $proc.HasExited
if($running){ Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $pluginFile -Force -ErrorAction SilentlyContinue

[pscustomobject]@{
  probeSeen = $seen
  probeFile = $probeFile
  pluginFile = $pluginFile
  processId = $proc.Id
  processStillRunningAtCollection = $running
  artifact = $artifact
} | ConvertTo-Json -Depth 20
