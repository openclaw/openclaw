# PR Description: Fix Embedded Agent Script Generation (Issue #12836)

## Problem

The embedded agent was generating broken scripts due to:

1.  **Incompatible Shell**: Defaulting to `/bin/sh` (which can be `dash` or other minimal shells) even when `bash` is available. This caused scripts using bash-specific syntax (e.g., `[[ ]]`, arrays, `set -o pipefail`) to fail.
2.  **Shell Injection Risks**: Lack of explicit guidance in the system prompt regarding safe variable handling, leading to potential shell injection vulnerabilities when the agent attempts to interpolate variables directly into commands.

## Changes

- **`src/agents/shell-utils.ts`**: Updated `getShellConfig` to explicitly prefer `bash` if available on the system, falling back to `sh` only if `bash` is not found. Also restored specific invalidation logic for `fish` shell users to ensure they fall back to `bash` or `sh` properly.
- **`src/agents/system-prompt.ts`**: Updated the `exec` tool description to include a warning: _"use 'env' param for dynamic data to avoid shell injection"_. This instructs the agent to use environment variables for passing data safely.

## Verification

- **New Test**: Added `src/agents/shell-integration.test.ts` to verify that `getShellConfig` upgrades `sh` to `bash` when valid.
- **Regression Test**: `src/agents/shell-utils.test.ts` was updated/verified to ensure `fish` shell users still get a valid compatible shell.
- **Full Test Suite**: Ran `pnpm test` to ensure no regressions across the codebase.
