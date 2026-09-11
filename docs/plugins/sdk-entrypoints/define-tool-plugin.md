---
summary: "The tool-only entry helper, its schemas, and generated manifest metadata"
title: "Plugin SDK defineToolPlugin helper"
sidebarTitle: "defineToolPlugin"
read_when:
  - You are writing a plugin that only adds agent tools
  - You need the defineToolPlugin signature and its manifest output
---

The entry helper for plugins that only add agent tools. Part of the
[Plugin entry points](/plugins/sdk-entrypoints) reference.

## `defineToolPlugin`

**Import:** `openclaw/plugin-sdk/tool-plugin`

For plugins that only add agent tools. Keeps the source small, infers config
and tool-parameter types from TypeBox schemas, wraps plain return values in
the OpenClaw tool-result format, and exposes static metadata that
`openclaw plugins build` writes into the plugin manifest (`contracts.tools`,
`configSchema`).

```typescript
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: "stock-quotes",
  name: "Stock Quotes",
  description: "Fetch stock quotes.",
  configSchema: Type.Object({
    apiKey: Type.Optional(Type.String({ description: "API key." })),
  }),
  tools: (tool) => [
    tool({
      name: "quote",
      label: "Quote",
      description: "Fetch a quote.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Ticker symbol." }),
      }),
      outputSchema: Type.Object(
        {
          symbol: Type.String(),
          hasKey: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      execute: async ({ symbol }, config) => ({ symbol, hasKey: Boolean(config.apiKey) }),
    }),
  ],
});
```

- `configSchema` is optional; omitting it uses a strict empty object schema
  (the generated manifest still includes `configSchema`).
- `execute` returns a plain string or JSON-serializable value; the helper
  wraps it as a text tool result with `details` set to the original
  (unstringified) return value.
- `outputSchema` optionally describes that original `details` value for Code
  Mode and Tool Search. Catalog calls reject an invalid schema before execution
  and validate the final value before returning it.
- For custom tool results, `openclaw/plugin-sdk/tool-results` exports
  `textResult` and `jsonResult`.
- Tool names are static, so `openclaw plugins build` derives
  `contracts.tools` from the declared tools without hand-duplicated names.
- Runtime loading stays strict: installed plugins still need
  `openclaw.plugin.json` and `package.json` `openclaw.extensions`. OpenClaw
  never executes plugin code to infer missing manifest data.
