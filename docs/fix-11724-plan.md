# Fix for Issue #11724: Python Scripts with Import Statements Fail

**Status:** ✅ Implemented

## Problem

When OpenClaw's exec tool runs commands containing Python code with `import` statements, it mistakenly interprets them as ImageMagick commands. This happens because:

1. Multi-line commands with newlines are passed directly to the shell
2. The shell tries to execute each line as a separate command
3. `import` is also an ImageMagick command

Example error:

```
import-im6.q16: unable to open X server
/bin/bash: line 6: from: command not found
```

## Solution Implemented

Auto-detect multi-line scripts and execute them via temporary files for local execution:

1. **Detection** (`detectScriptContent`): Check for:
   - Shebang (`#!`)
   - Newlines + Python keywords (`import`, `from`, `def`, `class`)

2. **Temp File Creation** (for `host=gateway` or sandbox only):
   - Write script to temp file with executable permissions
   - Handle shebang parsing (including `/usr/bin/env` style)
   - Use workspace temp path for sandbox compatibility
   - Return command to execute temp file

3. **`host=node` Rejection**: Multi-line scripts are rejected with a clear error message because the temp file won't exist on remote nodes.

4. **Cleanup**: Remove temp file after execution (success or failure)

## Files Modified

- `src/agents/bash-tools.exec.ts` - Added script detection and temp file handling
- `src/agents/bash-tools.exec.script-content.test.ts` - New test file with Python availability checks

## Changes Summary

### Added Functions

```typescript
function detectScriptContent(command: string): { isScript: boolean; reason?: string };
```

### Modified Logic

- After workdir/env setup, detect if command contains script content
- If detected and `host=node`: throw error with helpful message
- If detected and `host=gateway` or sandbox:
  - Parse shebang to extract interpreter (handles `env` style)
  - Create temp file in appropriate location (tmpdir for gateway, workspace for sandbox)
  - Execute temp file with detected interpreter
  - Clean up temp file in promise handlers

## Host Behavior

| Host      | Multi-line Script Behavior                  |
| --------- | ------------------------------------------- |
| `gateway` | ✅ Auto-convert to temp file                |
| `sandbox` | ✅ Auto-convert to temp file (in workspace) |
| `node`    | ❌ Rejected with helpful error              |

## Testing

Run tests with:

```bash
pnpm test src/agents/bash-tools.exec.script-content.test.ts
```

Tests check for Python availability and skip if not present.

## Related

- Issue: https://github.com/openclaw/openclaw/issues/11724
