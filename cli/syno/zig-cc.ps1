$hasTarget = $false
$newArgs = @()
foreach ($arg in $args) {
    if ($arg -like '--target=*') {
        $hasTarget = $true
        if ($arg -eq '--target=x86_64-unknown-linux-musl') {
            $newArgs += '--target=x86_64-linux-musl'
        } else {
            $newArgs += $arg
        }
    } else {
        $newArgs += $arg
    }
}
if (-not $hasTarget) {
    $newArgs = @('--target=x86_64-linux-musl') + $newArgs
}
& zig cc @newArgs
exit $LASTEXITCODE
