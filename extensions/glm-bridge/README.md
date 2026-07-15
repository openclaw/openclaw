# @openclaw/glm-bridge

OpenClaw harness plugin that delegates **`zai`-provider** (GLM / Zhipu AI)
turns to the **same** `@zeroaltitude/openclaw-claude-bridge` process the
Claude extension uses — just pointed at Z.ai's Anthropic-compatible endpoint
instead of real Anthropic. GLM-5.2 gets the same streaming / tool-use /
dynamic-tools richness as the Claude harness, running as a _second,
independent_ bridge process that coexists with real Claude (openclaw-7ss).

## Architecture

This is a single-file extension (`index.ts`). It owns **no bridge code and no
bridge dependency of its own**. It calls the Claude extension's
`createClaudeAppServerAgentHarness` factory (`extensions/claude/harness.ts`)
with `providerIds: ["zai"]` and a config resolver that layers Z.ai defaults
on top of operator config.

| Piece                                         | Where it lives                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| GLM harness registration + Z.ai defaults      | `extensions/glm-bridge/index.ts` (this package)                                       |
| Harness factory, run-attempt, client pool     | `extensions/claude/**` (reused unmodified)                                            |
| JSON-RPC bridge **server** (spawned per turn) | `@zeroaltitude/openclaw-claude-bridge` (declared in `extensions/claude/package.json`) |

The shared client pool (`extensions/claude/src/app-server/client.ts`) keys
each long-lived bridge process by a provider-derived pool key. GLM turns
resolve to `claude-bridge:zai` and real Claude to `claude-bridge:anthropic`,
so the two run as distinct concurrently-alive processes without disturbing
each other.

## ⚠️ Requires the Claude extension co-installed and enabled

**glm-bridge cannot run on its own.** It has no
`@zeroaltitude/openclaw-claude-bridge` dependency in its own `package.json`;
the bridge binary is resolved from the **Claude extension's** bundled install
(`managed-binary.ts` resolves `CLAUDE_PLUGIN_ROOT` to `extensions/claude`).

So you must have `@openclaw/claude` **installed and enabled** alongside
glm-bridge. If the Claude extension is missing or disabled, a GLM turn fails
at spawn time with an opaque error:

```
Managed @zeroaltitude/openclaw-claude-bridge binary was not found.
Reinstall or update OpenClaw, or run pnpm install in a source checkout.
```

If you hit that, the first thing to check is that the Claude extension is
present and enabled — not that glm-bridge is broken. (You do **not** need to
configure or use the Claude extension for Anthropic; it just needs to be
installed so its bundled bridge binary exists on disk.)

## Authentication

The bridge server talks to Z.ai's Anthropic-compatible Messages API. It needs
two things:

1. **Base URL** — defaults to `https://api.z.ai/api/anthropic`. Set
   automatically by this extension; override only to point at a different
   Anthropic-compatible endpoint.
2. **API key** — you must provide a Z.ai key. There are two supported paths:

### Option A — `zai` provider auth profile (recommended)

Configure a `zai` provider auth profile in your OpenClaw provider config. The
run-attempt path resolves the provider key and injects it as
`ANTHROPIC_API_KEY` into the spawned bridge automatically, so you don't put a
secret in this plugin's config at all.

### Option B — `appServer.env` secret

Set the key directly in the plugin's `appServer.env`, ideally via a
`secretRef` rather than a literal value so the secret never lands in
`openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "glm-bridge": {
        "config": {
          "appServer": {
            "env": {
              // Prefer secretRef over a literal here.
              "ANTHROPIC_AUTH_TOKEN": { "secretRef": "zai-api-key" },
            },
          },
        },
      },
    },
  },
}
```

Either `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` works. If **neither** a
`zai` auth profile nor an `appServer.env` key is configured, the bridge
spawns pointed at Z.ai with no credentials and the turn fails with an opaque
Z.ai `401` surfaced through the idle/exit path — so make sure exactly one of
the two options above is in place.

## Configuration

All keys live under `plugins.entries.glm-bridge.config`. The full schema is in
`openclaw.plugin.json`; the notable ones:

| Key                                                        | Default                          | Notes                                                                                                                                |
| ---------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `appServer.env.ANTHROPIC_BASE_URL`                         | `https://api.z.ai/api/anthropic` | Overridable; layered _under_ operator config.                                                                                        |
| `appServer.env.ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | —                                | Your Z.ai key (Option B above). Use a `secretRef`.                                                                                   |
| `appServer.modelProvider`                                  | `zai`                            | Provider identity stamped on the session binding + pool key. Change only when pointing at a different Anthropic-compatible endpoint. |
| `appServer.approvalPolicy`                                 | `never`                          | Codex-shaped approval policy; `never` = unattended.                                                                                  |
| `appServer.sandbox`                                        | `danger-full-access`             | Echoed to the server (informational at this layer).                                                                                  |
| `dynamicTools.exclude`                                     | `[]`                             | OpenClaw dynamic-tool names to omit from GLM turns.                                                                                  |

Defaults are merged **under** operator config: a bare install works with just
a key, and every field remains overridable (see `applyGlmDefaults` in
`index.ts`).

## Troubleshooting

- **`Managed … binary was not found`** — the Claude extension is missing or
  disabled. Install/enable `@openclaw/claude`.
- **Z.ai `401` / auth errors** — no Z.ai credential resolved. Configure a
  `zai` auth profile or set `appServer.env.ANTHROPIC_AUTH_TOKEN`.
- **`/claude status` shows a GLM pid/version** — the `/claude` command reports
  the most-recently-accessed pool entry; with both extensions active it may
  reflect whichever ran a turn last. This is cosmetic.
