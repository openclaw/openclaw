[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$Output)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$errors=@();$scripts=@();$csharp=@()
foreach($f in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File){
    $tokens=$null;$failures=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$tokens,[ref]$failures)
    foreach($x in $failures){$errors+=@{path=$f.Name;error=$x.ToString()}}
    $scripts+=@{path=$f.Name;syntaxErrors=@($failures).Count}
}
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.dll')
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.CSharp.dll')
$options=[Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::Preview)
$inputs=@(Get-ChildItem -LiteralPath $PSScriptRoot -File|Where-Object {$_.Extension -ceq '.cs' -or $_.Name -like '*.private-postimage.txt'})
$inputs+=@(Get-Item (Join-Path $Source 'src/OpenClaw.SetupEngine.UI/Controls/OllamaWindowsSetupDialog.cs'),
    (Join-Path $Source 'tests/OpenClaw.SetupEngine.Tests/ProviderArtworkSourceContractTests.cs'),
    (Join-Path $Source 'tests/OpenClaw.Tray.UITests/OnboardingOllamaPageTests.cs'))
foreach($f in $inputs){
    $tree=[Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText([IO.File]::ReadAllText($f.FullName),$options)
    $failures=@($tree.GetDiagnostics()|Where-Object {$_.Severity.ToString() -ceq 'Error'})
    foreach($x in $failures){$errors+=@{path=$f.Name;error=$x.ToString()}}
    $csharp+=@{path=$f.Name;sha256=(Get-FileHash $f.FullName -Algorithm SHA256).Hash;syntaxErrors=$failures.Count}
}
$seals=Get-Content (Join-Path $PSScriptRoot 'packet-seals.json') -Raw|ConvertFrom-Json
foreach($f in $seals.files){if((Get-FileHash (Join-Path $PSScriptRoot $f.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw "Packet seal mismatch: $($f.path)"}}
@{qualification='Static text/AST/C# syntax only. No native semantic compilation, build/test/capture, acquisition/install/CI/VM/launch.';
    powershell=$PSVersionTable.PSVersion.ToString();roslyn=[Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree].Assembly.GetName().Version.ToString();
    powershellScripts=$scripts;csharp=$csharp;errors=$errors;sealedFiles=$seals.files.Count}|ConvertTo-Json -Depth 8|Set-Content $Output
if($errors.Count -ne 0){throw 'Static syntax diagnostics found.'}
