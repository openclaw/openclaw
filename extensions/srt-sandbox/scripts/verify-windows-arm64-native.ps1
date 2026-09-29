[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $NodeRoot,
  [Parameter(Mandatory = $true)] [string] $OutputDirectory
)

$ErrorActionPreference = "Stop"

if ($env:VSCMD_ARG_TGT_ARCH -ne "arm64") {
  throw "Run this from an ARM64 Visual Studio developer prompt."
}

$nodeInclude = Join-Path $NodeRoot "include\node"
$nodeLibrary = Join-Path $NodeRoot "node.lib"
$source = Join-Path $PSScriptRoot "..\native\phase-e-maintainer.cc"
foreach ($path in @($nodeInclude, $nodeLibrary, $source)) {
  if (-not (Test-Path $path)) { throw "Required native build input is absent: $path" }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$object = Join-Path $OutputDirectory "phase-e-maintainer.obj"
$addon = Join-Path $OutputDirectory "phase_e_maintainer.node"

# This intentionally invokes the MSVC ARM64 compiler and linker directly. It
# is a native compile/link gate, not a source-text inspection or cross-host
# approximation. NodeRoot must be an official win-arm64 Node distribution.
& cl.exe /nologo /std:c++17 /EHsc /LD /DWIN32 /D_WINDOWS /DNODE_GYP_MODULE_NAME=phase_e_maintainer `
  /I $nodeInclude /c $source /Fo$object
if ($LASTEXITCODE -ne 0) { throw "ARM64 native compilation failed." }

& link.exe /nologo /DLL /MACHINE:ARM64 /OUT:$addon $object $nodeLibrary netapi32.lib advapi32.lib fwpuclnt.lib crypt32.lib
if ($LASTEXITCODE -ne 0) { throw "ARM64 native linking failed." }

$header = [System.IO.File]::ReadAllBytes($addon)[0..1]
if ($header[0] -ne 0x4d -or $header[1] -ne 0x5a) { throw "Linked addon is not a PE image." }
& dumpbin.exe /headers $addon
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect linked addon headers." }
& dumpbin.exe /imports $addon
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect linked addon imports." }
Get-FileHash -Algorithm SHA256 $addon
Write-Host "Windows ARM64 native addon gate passed: $addon"
