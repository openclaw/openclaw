Perform a security audit on the codebase:

1. **Hardcoded secrets**: Search for API keys, tokens, passwords in source files
2. **Injection risks**: Check for unsanitized user input in commands, tools, and channel handlers
3. **Auth flows**: Review authentication and authorization patterns
4. **Dependencies**: Run `pnpm audit` and analyze results
5. **File permissions**: Check for overly permissive file access patterns

Report findings in structured format with severity ratings (Critical/High/Medium/Low).
$ARGUMENTS
