param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$CommandLine
)

$mingwBin = "C:\Users\Ady\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
$gccPath = Join-Path $mingwBin "gcc.exe"
$arPath = Join-Path $mingwBin "ar.exe"

if (-not (Test-Path $gccPath)) {
    Write-Error "Missing gcc.exe at $gccPath. Install WinLibs (MinGW UCRT) first."
    exit 1
}

if (-not (Test-Path $arPath)) {
    Write-Error "Missing ar.exe at $arPath. Install WinLibs (MinGW UCRT) first."
    exit 1
}

$env:PATH = "$mingwBin;$env:PATH"

cmd.exe /d /s /c $CommandLine
exit $LASTEXITCODE
