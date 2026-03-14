# SEC-67: Compaction Safeguard Mode (Default)

## Current Behavior

Compaction mode defaults to `"safeguard"` which applies stricter guardrails during session history compression.

- `src/config/defaults.ts` line 524-526: `mode: "safeguard"`
- `src/agents/pi-extensions/compaction-safeguard.ts` (806 lines): full safeguard extension with required summary headings, cancellation on edge cases, recent turns preservation (default 3, max 12)
- `src/agents/pi-embedded-runner/extensions.ts` lines 60-88: `resolveCompactionMode` selects the extension

## Dev-Mode Behavior

When `--dev-mode`, set default compaction mode to `"default"` instead of `"safeguard"`. This gives faster, less conservative compression.

## Implementation Plan

### File: `src/agents/pi-embedded-runner/extensions.ts`

`defaults.ts` is called during config loading which may run before `setDevMode()`. The safe location is `resolveCompactionMode()` at line 60, which runs at runtime during extension building (after startup is complete).

```typescript
import { isDevMode } from "../../globals.js";

// In resolveCompactionMode() (~line 60-62):
function resolveCompactionMode(config: OpenClawConfig): CompactionMode {
  const configured = config.agents?.compaction?.mode;
  if (configured) return configured;
  return isDevMode() ? "default" : "safeguard";
}
```

## Files to modify

| File                                          | Change                                         |
| --------------------------------------------- | ---------------------------------------------- |
| `src/agents/pi-embedded-runner/extensions.ts` | Override in `resolveCompactionMode` (~line 60) |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Low. `"default"` mode is the original pre-safeguard behavior. No code paths break — the compaction just uses the less strict extension.
