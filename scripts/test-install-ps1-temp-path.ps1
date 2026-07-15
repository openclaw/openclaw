$ErrorActionPreference = "Stop"

$installerPath = Join-Path $PSScriptRoot "install.ps1"

function Import-InstallerTempFunctions {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        throw "Failed to parse installer: $($errors[0].Message)"
    }

    $names = @(
        "Resolve-InstallerLongPath",
        "Resolve-InstallerTempDirectory",
        "Set-InstallerTempDirectory",
        "Get-InstallerTempDirectory"
    )
    $functions = $ast.FindAll(
        {
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $names -contains $node.Name
        },
        $true
    ) | Sort-Object { $_.Extent.StartOffset }

    foreach ($name in $names) {
        if (-not ($functions | Where-Object { $_.Name -eq $name })) {
            throw "Missing function $name"
        }
    }

    foreach ($function in $functions) {
        Set-Item -Path ("Function:\script:{0}" -f $function.Name) -Value $function.Body.GetScriptBlock()
    }
}

function Assert-Equal {
    param(
        [object]$Expected,
        [object]$Actual,
        [string]$Message
    )

    if ($Expected -ne $Actual) {
        throw "$Message. Expected '$Expected', got '$Actual'."
    }
}

$originalTemp = $env:TEMP
$originalTmp = $env:TMP
$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-install-temp-test-" + [guid]::NewGuid().ToString("N"))
$longTemp = Join-Path $sandbox "Long Temp"

try {
    New-Item -ItemType Directory -Force -Path $longTemp | Out-Null
    Import-InstallerTempFunctions

    $shortTemp = Join-Path $sandbox "MISSIN~1\Temp"

    $expanded = Resolve-InstallerLongPath -Path $shortTemp -LongPathResolver {
        param($path)
        return $longTemp
    }
    Assert-Equal $longTemp $expanded "short temp aliases should be expanded when a resolver returns a usable path"

    $unchanged = Resolve-InstallerLongPath -Path $shortTemp -LongPathResolver {
        param($path)
        throw "short alias unavailable"
    }
    Assert-Equal $shortTemp $unchanged "short temp aliases should fall back to the original value when expansion fails"

    $env:TEMP = $shortTemp
    $env:TMP = $longTemp
    $resolvedTemp = Resolve-InstallerTempDirectory -LongPathResolver {
        param($path)
        throw "short alias unavailable"
    }
    Assert-Equal $longTemp $resolvedTemp "installer temp resolution should fall back to a usable TMP directory"

    $env:TEMP = $shortTemp
    $env:TMP = $originalTmp
    Set-InstallerTempDirectory -LongPathResolver {
        param($path)
        return $longTemp
    }

    Assert-Equal $longTemp $script:InstallerTempDirectory "normalized installer temp should be stored in script scope"
    Assert-Equal $longTemp $env:TEMP "TEMP should be normalized for child commands launched by the installer"
    Assert-Equal $longTemp $env:TMP "TMP should be normalized for child commands launched by the installer"
    Assert-Equal $longTemp (Get-InstallerTempDirectory) "installer operations should reuse the normalized temp directory"
} finally {
    $env:TEMP = $originalTemp
    $env:TMP = $originalTmp
    if (Test-Path -LiteralPath $sandbox) {
        Remove-Item -LiteralPath $sandbox -Recurse -Force
    }
}

Write-Host "install.ps1 temp path tests passed"
