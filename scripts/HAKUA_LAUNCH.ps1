param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PassthroughArgs
)

$ErrorActionPreference = "Stop"
$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName
$LauncherPs1 = Join-Path $ProjectDir "scripts\clawdbot-master.ps1"

& $LauncherPs1 @PassthroughArgs
