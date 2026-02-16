$newArgs = @()
foreach ($arg in $args) {
    if ($arg -eq '--target=x86_64-unknown-linux-musl') {
        $newArgs += '--target=x86_64-linux-musl'
    } else {
        $newArgs += $arg
    }
}
& zig cc @newArgs
exit $LASTEXITCODE
