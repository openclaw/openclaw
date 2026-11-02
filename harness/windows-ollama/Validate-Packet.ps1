[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$Output)
# Pure parser/seal checks. Never dot-source or execute a native workflow driver here.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$errors=@(); $scripts=@()
foreach ($path in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File | Sort-Object Name) {
    $tokens=$null; $parseErrors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($path.FullName,[ref]$tokens,[ref]$parseErrors)
    foreach ($failure in $parseErrors) { $errors+=@{path=$path.Name;error=$failure.ToString()} }
    $scripts+=@{path=$path.Name;sha256=(Get-FileHash $path.FullName -Algorithm SHA256).Hash;syntaxErrors=@($parseErrors).Count}
}
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.dll')
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.CSharp.dll')
$options=[Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::Preview)
$comparison=[IO.File]::ReadAllText((Join-Path $Source 'tests/OpenClaw.Tray.UITests/OnboardingAiPageTests.cs'))
$overlay=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'comparison-method.txt'))
$comparison=$comparison.Replace('    private bool _nativeProof;','    private bool _nativeProof;' + [char]10 + $overlay)
$csharp=@()
foreach ($item in @(@{path='comparison-in-memory.cs';text=$comparison},
    @{path='NativeOllamaOsInspectionTests.cs';text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeOllamaOsInspectionTests.cs'))},
    @{path='RealOllamaAppQualificationTests.cs';text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'RealOllamaAppQualificationTests.cs'))},
    @{path='Program.cs';text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Program.cs'))})) {
    $tree=[Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($item.text,$options)
    $diagnostics=@($tree.GetDiagnostics() | Where-Object {$_.Severity.ToString() -ceq 'Error'})
    foreach($failure in $diagnostics){$errors+=@{path=$item.path;error=$failure.ToString()}}
    $csharp+=@{path=$item.path;syntaxErrors=$diagnostics.Count}
}
$seals=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'packet-seals.json') -Raw | ConvertFrom-Json
foreach($file in $seals.files) {
    if ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) { throw "Packet seal mismatch: $($file.path)" }
}
foreach ($path in Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse) {
    if ($path.Extension -in @('.ps1','.cs','.yml','.md','.txt','.json')) {
        $text=[IO.File]::ReadAllText($path.FullName)
        if ($text.Contains([char]0) -or $text.Contains([char]6)) { throw "Control-byte corruption: $($path.Name)" }
    }
}
$report=@{qualification='PowerShell AST and C# syntax only; no workflow commands, semantic compilation, test execution, desktop, installation or launch.';powershell=$PSVersionTable.PSVersion.ToString();roslyn=[Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree].Assembly.GetName().Version.ToString();powershellScripts=$scripts;csharp=$csharp;errors=$errors;sealedFiles=$seals.files.Count}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Output -Encoding utf8NoBOM
$report | ConvertTo-Json -Depth 8
if($errors.Count -gt 0){throw 'Packet syntax errors found.'}
