# Scoped Exec Permissions

## Goal

Extend toolsBySender to support command-level scoping for exec tool.

## Current State

- `toolsBySender` matches tool names: `exec`, `read`, etc.
- No way to allow only specific exec commands

## Desired State

Allow patterns like:

```yaml
toolsBySender:
  "+15550003333":
    allow:
      - "exec:gog calendar freebusy*"
      - "exec:gog calendar events*"
```

## Implementation

### 1. Pattern Format

- `exec:<command-prefix>` - matches exec calls where command starts with prefix
- `exec:*` or just `exec` - matches all exec calls (current behavior)
- Prefix matching with optional `*` wildcard at end

### 2. Changes Needed

#### src/config/group-policy.ts

- Update `resolveChannelDMToolsPolicy()` to return the full policy (allow/deny lists)
- Add `checkToolAccess(toolName: string, toolArgs?: object)` function
- For exec tool, extract command and check against `exec:<command>` patterns

#### src/gateway/tools-invoke-http.ts (or wherever exec is invoked)

- Before running exec, call policy check with command
- Pass command string to policy matcher

#### Pattern Matching Logic

```typescript
function matchesToolPattern(pattern: string, toolName: string, execCommand?: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;

  // Handle exec:command patterns
  if (toolName === "exec" && pattern.startsWith("exec:")) {
    const commandPattern = pattern.slice(5); // Remove 'exec:'
    if (!execCommand) return false;
    if (commandPattern.endsWith("*")) {
      return execCommand.startsWith(commandPattern.slice(0, -1));
    }
    return execCommand === commandPattern;
  }

  return false;
}
```

### 3. Config Example

```json
{
  "channels": {
    "whatsapp": {
      "toolsBySender": {
        "+15550002222": { "allow": ["*"] },
        "+15550003333": {
          "allow": [
            "exec:gog calendar freebusy",
            "exec:gog calendar events --",
            "web_search",
            "web_fetch"
          ]
        },
        "*": { "deny": ["*"] }
      }
    }
  }
}
```

### 4. Files to Modify

- `src/config/group-policy.ts` - add command-aware matching
- `src/gateway/tools-invoke-http.ts` - pass exec command to policy check
- `src/config/group-policy.test.ts` - add tests for scoped exec
