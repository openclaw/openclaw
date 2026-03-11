param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

# Forward all arguments to the local repo CLI
pnpm openclaw @Args

# Exit with the same exit code
exit $LASTEXITCODE
