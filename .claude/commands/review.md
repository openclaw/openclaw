Review the current changes before commit.

1. Run `git diff --staged` and `git diff` to see all changes
2. Run `pnpm check` to verify code quality
3. Analyze changes for:
   - Code style consistency with project conventions
   - Anti-redundancy violations (duplicate functions, re-export wrappers)
   - Missing `.js` extensions in imports
   - Files exceeding ~500 LOC
   - Security issues (leaked secrets, injection vulnerabilities)
   - Missing or broken tests for changed code
4. Provide a summary with actionable feedback
