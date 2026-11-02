[CmdletBinding()]
param([Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Authorized disposable Windows CI only.' }
$report = @{status='blocked';appActionsAdmitted=$false;sourceMutation=$false;modelAcquired=$false;command='source export winget';expectedProductField='Arg';qualification='Read-only actual runtime/catalog prerequisite observation, not download/install proof.'}
try {
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft/WindowsApps/winget.exe'
    $packages = @(Get-AppxPackage -Name Microsoft.DesktopAppInstaller | Select-Object Name,Version,PackageFullName,Publisher,Status,Architecture,InstallLocation)
    $report.appInstaller = $packages
    $report.aliasPresent = Test-Path -LiteralPath $winget
    if (!$report.aliasPresent -or $packages.Count -ne 1 -or $packages[0].Status.ToString() -cne 'Ok' -or
        $packages[0].Publisher -cne 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US') {
        throw 'Current-user first-party App Installer registration/winget alias unavailable. No package/source/policy bootstrap was attempted.'
    }
    $realWinget = Join-Path $packages[0].InstallLocation 'winget.exe'
    $signature = Get-AuthenticodeSignature -LiteralPath $realWinget
    $report.wingetSignature = @{status=$signature.Status.ToString();subject=$signature.SignerCertificate.Subject;sha256=(Hash $realWinget)}
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'WinGet signature is not valid Microsoft publisher evidence.' }
    function Read-WinGet([string[]]$Arguments) {
        $info = [Diagnostics.ProcessStartInfo]::new($winget)
        $info.UseShellExecute=$false; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.CreateNoWindow=$true
        foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
        $process = [Diagnostics.Process]::new(); $process.StartInfo=$info
        try {
            if (!$process.Start()) { throw 'WinGet did not start.' }
            $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
            if (!$process.WaitForExit(30000)) {
                # This is a read-only source/version query, never an installer or descendant app.
                $process.Kill(); $process.WaitForExit()
                throw 'Read-only WinGet query timed out; no source agreement was accepted.'
            }
            if ($process.ExitCode -ne 0) { throw "Read-only WinGet query failed ($($process.ExitCode))." }
            if (!$stdout.Wait(5000) -or !$stderr.Wait(5000)) { throw 'WinGet query streams did not settle.' }
            return $stdout.Result
        } finally { $process.Dispose() }
    }
    $report.version = (Read-WinGet @('--version')).Trim()
    $raw = Read-WinGet @('source','export','winget')
    $value = $raw | ConvertFrom-Json
    $report.actualFieldNames = @($value.PSObject.Properties.Name | Sort-Object)
    $report.source = $value
    if ($value.Name -cne 'winget' -or $value.Type -cne 'Microsoft.PreIndexed.Package' -or
        $value.Identifier -cne 'Microsoft.Winget.Source_8wekyb3d8bbwe') { throw 'Actual source identity differs; source settings left unchanged.' }
    $argument = $value.PSObject.Properties['Argument']
    $arg = $value.PSObject.Properties['Arg']
    $report.argumentFieldPresent = $null -ne $argument
    $report.productArgFieldPresent = $null -ne $arg
    # Official SourceFromPolicy::ToJsonString at WinGet 000f6b55151c emits Arg.
    # Observe actual bytes; never rename Argument or rewrite output to satisfy the product.
    if ($null -eq $arg -or $arg.Value -cne 'https://cdn.winget.microsoft.com/cache') {
        throw 'Actual source export does not provide the reviewed Arg field and URL. No output shim or source repair was attempted.'
    }
    $report.status='runtime-source-contract-compatible'
} catch { $report.failure = $_.Exception.Message }
finally { Save-Json $report (Join-Path $Artifacts 'winget-runtime-contract.json') }
if ($report.status -cne 'runtime-source-contract-compatible') { throw $report.failure }
