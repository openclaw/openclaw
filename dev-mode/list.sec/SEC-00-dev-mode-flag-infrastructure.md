# SEC-00: Dev-Mode Flag Infrastructure (Foundation)

> This is the foundation all other plans depend on. Must be implemented first.

## Goal

Add a persistent `--dev-mode 1` / `--dev-mode 0` global flag that all security-gated code can check via `isDevMode()`.

## Implementation Plan

### Step 1: Add global state in `src/globals.ts`

Add alongside existing `setVerbose`/`isVerbose` pattern:

```typescript
let globalDevMode = false;

export function setDevMode(v: boolean): void {
  globalDevMode = v;
}

export function isDevMode(): boolean {
  return globalDevMode;
}
```

### Step 2: Persist the flag to config

Add to `src/config/types.cli.ts`:

```typescript
export type CliConfig = {
  banner?: { taglineMode?: CliBannerTaglineMode };
  devMode?: boolean;
};
```

### Step 3: Create CLI command `openclaw --dev-mode <0|1>`

In `src/cli/program/build-program.ts` or a new `register.dev-mode.ts`:

```typescript
program
  .command("--dev-mode") // or a subcommand approach
  .argument("<value>", "1 to enable, 0 to disable")
  .action(async (value) => {
    const enabled = value === "1";
    // Write to config file
    await setConfigValue("cli.devMode", enabled);
    console.log(`Dev mode ${enabled ? "enabled" : "disabled"}.`);
  });
```

Since `openclaw --dev-mode 1` uses a top-level flag style, it may be better as a program-level option with special handling in the pre-action hook or entry point (`src/entry.ts` / `src/cli/run-main.ts`).

**Alternative (likely better):** Handle in `src/cli/profile.ts` alongside `--dev` and `--profile` parsing, since those are also parsed before command registration:

1. Parse `--dev-mode` from argv early (like `--profile` is parsed)
2. If `--dev-mode 1` or `--dev-mode 0`, write to config and exit
3. On every normal startup, read `cli.devMode` from config and call `setDevMode()`

### Step 4: Load on startup

In `src/cli/run-main.ts` or the pre-action hook (`src/cli/program/preaction.ts`):

```typescript
import { setDevMode } from "../globals.js";
import { loadConfig } from "../config/io.js";

const config = await loadConfig();
setDevMode(config.cli?.devMode === true);
```

### Step 5: Environment variable fallback

Also support `OPENCLAW_DEV_MODE=1` env var:

```typescript
export function isDevMode(): boolean {
  return globalDevMode || process.env.OPENCLAW_DEV_MODE === "1";
}
```

### Step 6: Auto-enable Hub plugin when dev-mode

When `isDevMode()` is true on startup, automatically inject the hub plugin path into the plugin loader so agents get `hub_notify`, `hub_pending`, `hub_done` tools without manual config.

In the startup flow (after `setDevMode(true)` and before plugin loading), add the hub plugin path:

```typescript
import { isDevMode } from "../globals.js";
import path from "node:path";

// During startup, before plugins are loaded:
if (isDevMode()) {
  // Resolve hub plugin path relative to the openclaw install
  const hubPluginPath = path.resolve(__dirname, "../../dev-mode/hub");

  // Inject into plugin load paths via runtime config override
  const currentPaths = config.plugins?.load?.paths ?? [];
  if (!currentPaths.includes(hubPluginPath)) {
    setConfigOverride("plugins.load.paths", [...currentPaths, hubPluginPath]);
  }

  // Ensure plugins are enabled
  if (config.plugins?.enabled === false) {
    setConfigOverride("plugins.enabled", true);
  }
}
```

This goes in the same startup location as Step 4 (after config load, before plugin discovery). The hub plugin path is injected as a runtime override — not persisted to the config file — so disabling dev-mode cleanly removes it.

**Alternative:** If the plugin loader has a hook or extension point, use that instead. Check `src/plugins/loader.ts` for `loadOpenClawPlugins()` — it reads `plugins.load.paths` from config, so the runtime override approach works.

## Files to modify

| File                                                    | Change                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/globals.ts`                                        | Add `setDevMode()` / `isDevMode()`                                         |
| `src/config/types.cli.ts`                               | Add `devMode?: boolean` to `CliConfig`                                     |
| `src/cli/profile.ts` or `src/entry.ts`                  | Parse `--dev-mode 0/1` from argv, persist to config                        |
| `src/cli/run-main.ts` or `src/cli/program/preaction.ts` | Load `cli.devMode` on startup, call `setDevMode()`, inject hub plugin path |
| `src/config/runtime-overrides.ts`                       | Used (not modified) — `setConfigOverride` for hub plugin path              |

## Dependencies

None — this is the foundation.

## Risk

Low. Adds a new config key and two global functions. No existing behavior changes unless `isDevMode()` is explicitly checked. Hub plugin auto-load uses runtime overrides (not persisted), so `--dev-mode 0` cleanly disables everything.
