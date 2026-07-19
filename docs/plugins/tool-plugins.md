---
summary: "Build agent tools with definePluginEntry and openclaw plugins init/build/validate"
title: "Tool plugins"
sidebarTitle: "Tool Plugins"
read_when:
  - You want to build a simple OpenClaw plugin that only adds agent tools
  - You need to scaffold, generate, validate, test, or publish a tool-only plugin
---

Tool plugins use the same canonical entry contract as other non-channel
plugins: `definePluginEntry(...)` plus `api.registerTool(...)`. The
`openclaw plugins init`, `build`, and `validate` commands keep the manifest's
static discovery metadata aligned with that entry.

For provider, channel, hook, service, or mixed-capability plugins, start with
[Building plugins](/plugins/building-plugins), [Channel Plugins](/plugins/sdk-channel-plugins),
or [Provider Plugins](/plugins/sdk-provider-plugins) instead.

## Requirements

- Node 22.22.3+, Node 24.15+, or Node 25.9+.
- TypeScript ESM package output.
- `typebox` in `dependencies` when the runtime entry uses TypeBox schemas.
- A package root that ships `dist/`, `openclaw.plugin.json`, and
  `package.json`.

## Quickstart

```bash
openclaw plugins init stock-quotes --name "Stock Quotes"
cd stock-quotes
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

`plugins init` scaffolds:

| File                   | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `src/index.ts`         | `definePluginEntry` entry with one registered `echo` tool         |
| `src/index.test.ts`    | Registration test asserting the tool list                         |
| `tsconfig.json`        | NodeNext TypeScript output to `dist/`                             |
| `vitest.config.ts`     | Vitest config for `src/**/*.test.ts`                              |
| `package.json`         | Scripts, runtime deps, `openclaw.extensions: ["./dist/index.js"]` |
| `openclaw.plugin.json` | Generated manifest metadata for the initial tool                  |

`npm run plugin:build` runs `npm run build` and then
`openclaw plugins build --entry ./dist/index.js`. `npm run plugin:validate`
rebuilds and runs `openclaw plugins validate --entry ./dist/index.js`.

`openclaw plugins init <id>` options:

| Flag                 | Default            | Effect                                 |
| -------------------- | ------------------ | -------------------------------------- |
| `--directory <path>` | `<id>`             | Output directory                       |
| `--name <name>`      | Title-cased `<id>` | Display name                           |
| `--type <type>`      | `tool`             | Scaffold type: `tool` or `provider`    |
| `--force`            | off                | Overwrite an existing output directory |

## Register a tool

Use `buildJsonPluginConfigSchema(...)` for a JSON config contract and
register the concrete tool from the entry's `register(api)` callback:

```typescript
import { Type } from "typebox";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type StockQuotesConfig = {
  apiKey?: string;
  baseUrl?: string;
};

export default definePluginEntry({
  id: "stock-quotes",
  name: "Stock Quotes",
  description: "Fetch stock quote snapshots.",
  configSchema: buildJsonPluginConfigSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      apiKey: { type: "string", description: "Quote API key." },
      baseUrl: { type: "string", description: "Quote API base URL." },
    },
  }),
  register(api) {
    const config = (api.pluginConfig ?? {}) as StockQuotesConfig;
    api.registerTool({
      name: "stock_quote",
      label: "Stock Quote",
      description: "Fetch a stock quote snapshot.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Ticker symbol, for example OPEN." }),
      }),
      outputSchema: Type.Object(
        {
          symbol: Type.String(),
          configured: Type.Boolean(),
          baseUrl: Type.String(),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, { symbol }, signal) {
        signal?.throwIfAborted();
        return jsonResult({
          symbol: symbol.toUpperCase(),
          configured: Boolean(config.apiKey),
          baseUrl: config.baseUrl ?? "https://api.example.com",
        });
      },
    });
  },
});
```

Tool names are stable API. Pick names that are unique, lowercase, and
specific enough to avoid collisions with core tools or other plugins.

## Optional and factory tools

Pass `{ optional: true }` when users should explicitly allowlist the tool
before it is sent to a model. `plugins build` writes the matching
`toolMetadata.<tool>.optional` manifest entry.

```typescript
api.registerTool(workflowTool, { optional: true });
```

Use a factory when the concrete tool depends on runtime tool context. A
factory must declare its stable manifest name with `name` (or every possible
name with `names`), because build and validate do not invoke the factory:

```typescript
api.registerTool((ctx) => (ctx.sandboxed ? null : createLocalWorkflowTool(api)), {
  name: "local_workflow",
  optional: true,
});
```

Use direct registrations when tool names are static. If a factory computes
names that cannot be declared up front, maintain `contracts.tools` yourself
instead of using the authoring generator.

## Return values

Tool handlers return `AgentToolResult`. The focused result helpers cover the
common cases:

```typescript
import { jsonResult, textResult } from "openclaw/plugin-sdk/core";

return textResult("queued", { queued: true });
return jsonResult({ queued: true, id: "job-123" });
```

`textResult(text, details)` controls the model-visible text while preserving
structured details. `jsonResult(value)` renders JSON text and preserves the
original value in `details`.

## Output contracts

Add `outputSchema` when a tool returns stable JSON-compatible `details`.
[Code Mode](/tools/code-mode) and [Tool Search](/tools/tool-search) use the
schema as a bounded output hint, and catalog calls validate the final details
after tool hooks.

Include every non-throwing result variant, including structured errors, or
omit the schema when the result is not stable. Do not put secrets in schema
descriptions. Use `{ additionalProperties: false }` on object layers when the
schema is complete.

## Generated metadata

OpenClaw reads the plugin manifest before it loads plugin runtime code. The
authoring commands import the selected entry in a controlled registration
capture, without calling tool factories or handlers, and derive:

- plugin `id`, `name`, and `description`
- JSON `configSchema`
- registered static tool names
- declared factory `name`/`names`
- optional-tool markers

Rerun the generator after any of those values change:

```bash
npm run build
openclaw plugins build --entry ./dist/index.js
```

The generator preserves manifest-owned fields and activation policy while it
refreshes generated identity, schema, and tool contracts. `contracts.tools`
is the discovery contract that lets OpenClaw identify the owning plugin
without loading every installed runtime.

## Package metadata

`plugins build` also aligns `package.json` to the selected runtime entry:

```json
{
  "type": "module",
  "files": ["dist", "openclaw.plugin.json", "README.md"],
  "dependencies": {
    "typebox": "^1.1.38"
  },
  "peerDependencies": {
    "openclaw": ">=2026.5.17"
  },
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

Ship built JavaScript (`./dist/index.js`), not a TypeScript source entry.

## Validate in CI

`plugins build --check` fails without rewriting files when generated metadata
is stale:

```bash
npm run build
openclaw plugins build --entry ./dist/index.js --check
openclaw plugins validate --entry ./dist/index.js
npm test
```

`plugins validate` checks that:

- `openclaw.plugin.json` exists and passes the normal manifest loader.
- The selected entry has the canonical `definePluginEntry` shape and a JSON
  config schema.
- Generated manifest fields match captured tool registrations.
- Every factory declares stable names through registration options.
- `package.json` points `openclaw.extensions` at the selected runtime entry.

## Install and publish

Install and inspect a local package from a separate OpenClaw checkout or
installed CLI:

```bash
openclaw plugins install ./stock-quotes
openclaw plugins inspect stock-quotes --runtime
```

For a packaged smoke test, use `npm pack` and install the tarball. Publish
through ClawHub once the package is ready:

```bash
clawhub package publish ./stock-quotes --dry-run
clawhub package publish ./stock-quotes
openclaw plugins install clawhub:your-org/stock-quotes
```

See [ClawHub publishing](/clawhub/publishing) for owner scope and release
review.

## Troubleshooting

### `plugin entry not found: ./dist/index.js`

Run `npm run build`, then rerun the authoring command with the built entry.

### `plugin entry must export a definePluginEntry result with a JSON config schema`

Export the `definePluginEntry(...)` result as the module default. Wrap JSON
schemas with `buildJsonPluginConfigSchema(...)`.

### `tool factories must declare a stable name`

Pass `{ name: "tool_name" }` or `{ names: ["one", "two"] }` as the second
argument to `api.registerTool(factory, options)`.

### `openclaw.plugin.json generated metadata is stale`

Run `openclaw plugins build --entry ./dist/index.js`, then commit both
`openclaw.plugin.json` and `package.json` changes.

### Tool does not appear after install

Check these in order:

1. `openclaw plugins inspect <plugin-id> --runtime`
2. `openclaw plugins validate --root <plugin-root> --entry ./dist/index.js`
3. `openclaw.plugin.json` has the expected `contracts.tools` names.
4. `package.json` has `openclaw.extensions: ["./dist/index.js"]`.
5. The Gateway was restarted or reloaded after installation.

## See also

- [Building plugins](/plugins/building-plugins)
- [Plugin entry points](/plugins/sdk-entrypoints)
- [Plugin SDK subpaths](/plugins/sdk-subpaths)
- [Plugin manifest](/plugins/manifest)
- [Plugins CLI](/cli/plugins)
- [ClawHub publishing](/clawhub/publishing)
