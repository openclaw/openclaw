---
summary: "Plugin trust tier classification — content, sandboxed, and native security boundaries"
read_when:
  - You want to understand the security model for plugins
  - You are building a plugin and need to know what capabilities each tier grants
  - You are evaluating whether a third-party plugin is safe to install
title: "Plugin Trust Tiers"
---

# Plugin trust tiers

OpenClaw classifies every plugin into one of three **trust tiers**. The tier
determines the maximum set of capabilities a plugin can access at runtime.

## Tier definitions

| Tier | Format | Runtime access | Example |
|------|--------|---------------|---------|
| **content** | `bundle` (Codex, Claude, Cursor) | Metadata, skills, commands, hook-packs. No in-process code execution. | Community prompt packs, skill bundles |
| **sandboxed** | _(reserved)_ | Future — ACP/subprocess-isolated tool execution with explicit capability grants. | _(not yet available)_ |
| **native** | `openclaw` | Full `api.runtime` access: tools, hooks, providers, HTTP routes, services, channels. | First-party and community TypeScript plugins |

## How tiers are assigned

Trust tier is resolved automatically when a plugin is loaded, based on its
`format` field in the manifest:

| `format` | Tier |
|----------|------|
| `"bundle"` | `content` |
| `"openclaw"` | `native` |
| _(undefined)_ | `content` (safe fallback) |

The resolution logic lives in `src/plugins/trust.ts` (`resolveTrustTier()`).
The `bundleFormat` (codex/claude/cursor) and `origin` (bundled/global/workspace/config)
parameters are accepted for forward compatibility but do not currently affect
tier assignment.

## Current capabilities by tier

### Content tier

- Skill definitions (prompt templates, workflows)
- Command definitions
- Hook-packs (declarative hook configurations)
- Settings files
- All paths boundary-checked to stay inside the plugin root

Content-tier plugins **cannot**:

- Execute arbitrary TypeScript/JavaScript in-process
- Register tools, providers, or HTTP routes
- Access `api.runtime`

### Native tier

Native plugins have full access to the OpenClaw plugin API:

- `registerTool` — agent tools with schemas
- `registerHook` — lifecycle hooks (26 hook points)
- `registerProvider` — LLM provider backends
- `registerHttpRoute` — HTTP endpoints
- `registerChannel` — messaging channels
- `registerService` — background services
- `registerCommand` — CLI commands
- `registerContextEngine` — context engines

### Sandboxed tier (reserved)

The sandboxed tier is reserved for future use. It will enable plugins to
execute tools in an isolated subprocess with explicit capability grants,
using the Agent Communication Protocol (ACP). This tier bridges the gap
between content-only bundles and full native access.

## CLI output

Trust tier appears in both `plugins list --verbose` and `plugins info`:

```
$ openclaw plugins list --verbose
my-bundle (loaded)
  format: bundle
  source: ~/.openclaw/extensions/my-bundle
  origin: global
  trust: content

$ openclaw plugins info my-native-plugin
Trust tier: native
```

## Security rationale

The tier system follows the principle of **least privilege**:

- Bundle content is safe by default — no code execution, boundary-checked paths
- Native plugins are explicitly trusted — they run in-process with full API access
- The safe fallback for unknown formats is `content`, not `native`
- The reserved `sandboxed` tier will allow expanding bundle capabilities
  without granting full native access

This classification makes the implicit trust boundary between bundles and
native plugins explicit in the type system, CLI output, and documentation.
