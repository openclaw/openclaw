# perf(cli): add help fast path for built-in and plugin subcommands

## Problem

`openclaw <subcommand> --help` paths still run through the full CLI bootstrap, including plugin scanning and runtime registration. This makes help output noticeably slow for commands like `memory`, `plugins`, and `pairing`.

## Approach

A three-layer help fast path that short-circuits before the heavy bootstrap:

1. **Root help** (existing) — `openclaw --help` uses precomputed root help text.
2. **Built-in subcommand help** (new) — Detects `--help`/`-h` on a known built-in subcommand, builds a minimal Commander program with only the target command registered, and exits before the normal bootstrap path.
3. **Plugin subcommand help** (new) — For plugin-owned top-level commands (e.g. `memory`), uses metadata-only registration with a command-to-plugin narrowing map. No runtime modules are loaded.

On the normal (non-fast-path) code path, plugin registration now accepts a `helpOnly` flag. When set, it routes through the metadata-only loader instead of the full runtime registry.

## Changes

### CLI entry (`src/cli/run-main.ts`)

- `shouldUseSubcommandHelpFastPath()` — detects subcommand help invocations
- `createMinimalHelpProgram()` — lightweight Commander setup shared by both fast paths
- `outputSubcommandHelpFastPath()` — built-in subcommand help: registers only the target command
- `outputPluginSubcommandHelpFastPath()` — plugin subcommand help: metadata-only with `HELP_FAST_PATH_PLUGIN_IDS_BY_PRIMARY` narrowing
- Dispatch block in `runCli()` tries fast paths before falling through to normal bootstrap
- Normal path passes `helpOnly: true` to plugin registration when `--help`/`-h` is present

### Plugin CLI registration (`src/plugins/cli.ts`)

- New `RegisterPluginCliOptions.helpOnly` — when `true`, uses `loadPluginCliMetadataRegistry` instead of `loadPluginCliCommandRegistry`
- `PluginCliLoaderOptions` now supports `onlyPluginIds` for narrowing plugin search scope
- All loader function signatures updated to accept the unified options type

### Subcommand registration (`src/cli/program/register.subclis.ts`)

- `pairing` register(): early return on `hasHelpOrVersion()`, skips `registerPluginCliCommands`
- `plugins` register(): same pattern — registers `plugins` CLI first, returns early on help

### Memory plugin (`extensions/memory-core/index.ts`)

- Runtime modules (tools, runtime-provider, provider-adapters, dreaming) moved behind `ensureMemoryCoreRuntime()` — a lazy singleton that loads all runtime modules in parallel on first access
- `cli-metadata` registration mode: registers CLI descriptors only, returns immediately
- `full` registration mode: loads runtime via `ensureMemoryCoreRuntime()`, registers tools, memory runtime, dreaming, flush plan
- Top-level imports reduced to `definePluginEntry`, `registerMemoryCli`, flush plan constants, and `buildPromptSection`

### Tests

- `src/cli/run-main.test.ts` — `shouldUseSubcommandHelpFastPath` unit tests
- `src/cli/program/register.subclis.test.ts` — pairing/plugins help skip plugin bootstrap; pairing run keeps plugin bootstrap
- `src/plugins/cli.test.ts` — metadata-only loader with `onlyPluginIds`; `loadOpenClawPlugins` not called on help-only path

## Benchmark

Measured on macOS ARM64 with source-built dist:

| Command                   | Before | After | Speedup |
| ------------------------- | -----: | ----: | ------: |
| `openclaw memory --help`  |  0.81s | 0.05s | **16×** |
| `openclaw plugins --help` |  0.49s | 0.05s | **10×** |
| `openclaw pairing --help` |  0.31s | 0.04s |  **8×** |

## Test Results

```
vitest run — 3 files, 39 tests, all passing
```

## Commit History

- `904056c` perf(cli): add help fast path for built-in and plugin subcommands
- `b984d66` perf(memory-core): lazy-load runtime modules, split cli-metadata from full registration

## Notes

- The `HELP_FAST_PATH_PLUGIN_IDS_BY_PRIMARY` map is intentionally minimal (`memory → memory-core`). New hotspots can be added incrementally without structural changes.
- The mutation gate and Plan Mode (Slice 5-6 from the upstreaming notes) are separate work and not included in this PR.
- `vitest` passes for the three affected test files. Full test suite was not run (no CI access from local clone).
