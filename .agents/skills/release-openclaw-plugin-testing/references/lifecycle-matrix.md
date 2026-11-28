# Plugin lifecycle proof matrix

## Existing Baseline

Run or verify these before inventing new coverage:

```bash
OPENCLAW_TESTBOX=1 pnpm check:changed
pnpm run test:extensions:package-boundary:canary
pnpm run test:extensions:package-boundary:compile
pnpm test:docker:plugins
OPENCLAW_PLUGINS_E2E_CLAWHUB=0 pnpm test:docker:plugins
pnpm test:docker:plugin-update
```

For full bundled install/uninstall proof, shard the packaged sweep:

```bash
OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL=8 \
OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=<0-7> \
pnpm test:docker:bundled-plugin-install-uninstall
```

This example partitions the selected package's plugin inventory over shards `0-7`.
Private QA plugins are source-mode only unless a package explicitly includes
them.

## New Testbox Harness Plan

If more certainty is needed, add or run a `plugin-lifecycle-matrix` Docker lane
that uses one package tarball and sharded plugin lists. Per plugin:

1. Start with a clean `HOME`.
2. Capture `plugins list --json`.
3. `plugins install <id>`.
4. `plugins inspect <id> --json`.
5. `plugins disable <id>`, then assert disabled visibility.
6. `plugins enable <id>`, except config-required plugins without config.
7. `plugins registry --refresh`.
8. `doctor --non-interactive`.
9. `plugins uninstall <id> --force`.
10. Assert the plugin's `plugins.entries` value is exactly `{ enabled: false }`,
    while its allow/deny entries, install record, managed directory, and bundled
    runtime load paths are gone. Use the existing harness's source-qualified
    uninstall expectations for historical targets.
11. Assert diagnostics contain no `level: "error"` and output redacts
    secret-looking values.

Keep `memory-lancedb` special: it is config-required. First assert install does
not enable it without embedding config, then run a second configured case.

## Doctor/Fix Matrix

Seed bad states and require `doctor --fix --non-interactive` to repair them,
then run doctor again and require idempotence:

- stale `plugins.allow`
- stale `plugins.entries`
- stale channel config for missing channel plugin
- invalid `plugins.entries.<id>.config`
- packaged bundled path in `plugins.load.paths`
- legacy `plugins.installs`
- disabled channel/plugin config that must not stage runtime deps
- root-owned global package tree that must remain unmodified

## Gateway Bootstrap Matrix

Start packaged OpenClaw in Docker with clean state:

- provider plugins enabled, no credentials: ready with warnings, no crash
- channel plugins configured disabled: no runtime deps staged
- startup-activation plugins enabled: ready and reflected in status
- invalid single plugin config: bad plugin skipped/quarantined, others remain

Assert:

- gateway reaches ready
- `openclaw status --json` includes plugin diagnostics
- `openclaw plugins inspect --all --json` is parseable
- package tree is not mutated
- logs contain no raw tokens

## Config Round-Trip Representatives

Use representative plugin families instead of every plugin for deep config
round-trip:

- providers: `openai`, `anthropic`, `mistral`, `openrouter`
- channels: `telegram`, `discord`, `slack`, `whatsapp`
- memory: `memory-lancedb`
- feature/runtime: `browser`, `acpx`, `tokenjuice`

For each representative:

1. Write config through CLI when possible.
2. Read it back through `config get` or JSON.
3. Run `plugins inspect`.
4. Run `doctor --non-interactive`.
5. Trigger gateway config reload if applicable.
6. Compare config hash before/after no-op commands.

## External SDK Smoke

In a package Docker lane, create tiny external plugins and install them from:

- local directory
- `.tgz`
- `file:` npm spec

Cover CJS and ESM shapes, plus at least one plugin importing focused
`openclaw/plugin-sdk/*` subpaths. Assert `plugins inspect` sees its tool,
gateway method, CLI command, or service.
