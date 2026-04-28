$exe = 'C:\Program Files\SketchUp\SketchUp 2026\SketchUp\SketchUp.exe'
$rb = 'C:\OpenClaw\SketchUpPoC\bootstrap\sketchup-poc-docless-diagnostic-001.bootstrap.rb'
[pscustomobject]@{
  exeExists = Test-Path -LiteralPath $exe
  rubyExists = Test-Path -LiteralPath $rb
}
$p = Start-Process -FilePath $exe -ArgumentList @('-RubyStartup', $rb) -PassThru
$p | Select-Object Id, HasExited
