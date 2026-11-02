[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Output)
# Static-only preparation: parse text and compare hashes. Never load or execute the proof sources.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.dll')
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.CSharp.dll')
$options = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::Preview)
$rows = @()
$errors = @()
foreach ($name in @('OnboardingAiPageTests.private-postimage.txt','OnboardingOllamaPageTests.private-postimage.txt',
    'NativeOllamaOsInspectionTests.cs','OllamaPrivateMountedPresentation.cs')) {
    $path = Join-Path $PSScriptRoot $name
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText([IO.File]::ReadAllText($path),$options)
    $diagnostics = @($tree.GetDiagnostics() | Where-Object {$_.Severity.ToString() -ceq 'Error'})
    foreach ($diagnostic in $diagnostics) { $errors += @{path=$name;diagnostic=$diagnostic.ToString()} }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash) { throw 'Parser input changed.' }
    $rows += @{path=$name;sha256=$hash;syntaxErrors=$diagnostics.Count}
}
$original = [IO.File]::ReadAllText((Join-Path $Source 'tests/OpenClaw.Tray.UITests/OnboardingAiPageTests.cs'))
$marker = '    private bool _nativeProof;'
if ([regex]::Matches($original,[regex]::Escape($marker)).Count -ne 1) { throw 'Comparison anchor must be unique.' }
$method = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'comparison-method.txt'))
$expected = $original.Replace($marker,$marker + [char]10 + $method)
$actual = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'OnboardingAiPageTests.private-postimage.txt'))
if ($actual -cne $expected) { throw 'Comparison postimage does not match exact insertion.' }
$acceptedInput = Join-Path $PSScriptRoot 'OnboardingOllamaPageTests.accepted-input.txt'
if ((Get-FileHash -LiteralPath $acceptedInput -Algorithm SHA256).Hash.ToLowerInvariant() -cne
    '36e55db282974627f2d0fbfa46bdebb18557ac0602e6fc0028dde8999137d945') { throw 'Accepted product test preimage differs.' }
$original = [IO.File]::ReadAllText($acceptedInput)
$old = '                OnboardingNativeProof.ActivateOwned(window);'
if ([regex]::Matches($original,[regex]::Escape($old)).Count -ne 1) { throw 'Mounted presentation boundary must be unique.' }
$new = "                if (OllamaPrivateMountedPresentation.IsRequested)" + [char]10 +
    "                    await OllamaPrivateMountedPresentation.PresentAsync(window);" + [char]10 +
    "                else" + [char]10 + "    " + $old
$actual = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'OnboardingOllamaPageTests.private-postimage.txt'))
if ($actual -cne $original.Replace($old,$new)) { throw 'Mounted overlay changes more than the declared presentation boundary.' }
$tokens = $null
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($PSCommandPath,[ref]$tokens,[ref]$parseErrors)
foreach ($diagnostic in $parseErrors) { $errors += @{path='Test-PrivateCaptureOverlaySyntax.ps1';diagnostic=$diagnostic.ToString()} }
$report = @{
    qualification='Static PowerShell AST and C# syntax/postimage checks only. No semantic compilation, tests, native execution, UI capture, install, CI, VM, commit or push.'
    powershell=$PSVersionTable.PSVersion.ToString()
    roslyn=[Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree].Assembly.GetName().Version.ToString()
    csharp=$rows; errors=$errors
    comparisonInsertionExact=$true; mountedPresentationOnlyExact=$true
    mountedOverlayInput='Repaired candidate preimage, not a possibly changing shared worktree.'
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Output -Encoding utf8NoBOM
$report | ConvertTo-Json -Depth 8
if ($errors.Count -gt 0) { throw 'Static parser diagnostics found.' }
