# OpenClaw Extended — Development Guide

## Architecture

```
openclaw-extended/
├── upstream/                     # git submodule → github.com/openclaw/openclaw
│   ├── src/                      # OpenClaw source (DO NOT MODIFY)
│   ├── extensions/               # Built-in extensions (DO NOT MODIFY)
│   └── dist/                     # Built output
├── extensions/                   # YOUR custom extensions
│   └── hello-world/              # Example extension
│       ├── package.json          # Extension manifest
│       ├── openclaw.plugin.json  # Plugin metadata
│       ├── index.ts              # Plugin entry point
│       └── *.test.ts             # Tests
├── config/                       # Custom configuration overrides
├── scripts/                      # Utility scripts
│   ├── create-extension.mjs      # Extension scaffolding
│   └── update-upstream.sh        # Upstream sync
├── package.json                  # Workspace root
├── pnpm-workspace.yaml           # Workspace config
├── tsconfig.json                 # TypeScript config
└── vitest.config.ts              # Test config
```

### Key Principle

**Never modify files inside `upstream/`.** All customization happens via extensions in your `extensions/` directory. This ensures clean upstream updates.

## Initial Setup

```bash
# 1. Clone with submodule
git clone --recurse-submodules <your-repo-url>
cd openclaw-extended

# 2. Install upstream dependencies + build
pnpm upstream:install
pnpm upstream:build

# 3. Install workspace dependencies
pnpm install
```

## Creating a New Extension

### Quick scaffold

```bash
node scripts/create-extension.mjs my-feature
```

This creates `extensions/my-feature/` with all boilerplate files.

### Manual creation

Every extension needs 3 files:

#### `package.json`

```json
{
  "name": "@openclaw-extended/my-feature",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "devDependencies": { "openclaw": "workspace:*" },
  "peerDependencies": { "openclaw": ">=2026.1.26" },
  "openclaw": { "extensions": ["./index.ts"] }
}
```

#### `openclaw.plugin.json`

```json
{
  "id": "my-feature",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

#### `index.ts`

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

export default {
  id: "my-feature",
  name: "My Feature",
  description: "What this extension does",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Your plugin logic here
  },
};
```

## What You Can Register

The `OpenClawPluginApi` exposes these registration methods:

| Method                  | Purpose                 | Example                  |
| ----------------------- | ----------------------- | ------------------------ |
| `api.registerTool()`    | AI-usable tools         | Custom search, API calls |
| `api.registerChannel()` | Messaging channels      | Custom chat platform     |
| `api.registerCli()`     | CLI subcommands         | `openclaw my-command`    |
| `api.runtime`           | Access runtime services | Memory, config, tools    |

### Examples from upstream

Look at `upstream/extensions/` for real-world patterns:

- **Channel plugin**: `upstream/extensions/telegram/` — registers a messaging channel
- **Tool plugin**: `upstream/extensions/memory-core/` — registers AI tools + CLI
- **Auth plugin**: `upstream/extensions/google-gemini-cli-auth/` — OAuth flow

## Running & Testing

```bash
# Run gateway with your extensions loaded
pnpm dev:gateway

# Run tests for your extensions
pnpm test

# Watch mode
pnpm test:watch

# Lint + format check
pnpm check
```

## Updating Upstream (OpenClaw)

When a new OpenClaw version is released:

```bash
# Option A: automated script
bash scripts/update-upstream.sh

# Option B: manual
git -C upstream fetch origin main
git -C upstream checkout origin/main
cd upstream && pnpm install && pnpm build && cd ..
pnpm install
pnpm test  # verify your extensions still work
git add upstream
git commit -m "chore: update openclaw submodule to $(git -C upstream describe --tags --always)"
```

### Handling breaking changes

1. Run `pnpm test` after update — failures show what broke
2. Check `upstream/CHANGELOG.md` for breaking changes
3. Update your extensions' `import` statements if API changed
4. Bump `peerDependencies.openclaw` version if needed

## Extension Development Patterns

### Accessing configuration

```typescript
register(api: OpenClawPluginApi) {
  api.registerTool((ctx) => {
    const myKey = ctx.config.get("MY_EXTENSION_KEY");
    // ...
  }, { names: ["my_tool"] });
}
```

### Composing with upstream extensions

Your extensions can complement upstream ones. For example, add a custom memory backend alongside `memory-core`:

```typescript
register(api: OpenClawPluginApi) {
  api.registerTool((ctx) => {
    // Use runtime services from upstream
    const existingTools = api.runtime.tools;
    // Add your enhanced version
    return [{ name: "enhanced_memory_search", /* ... */ }];
  }, { names: ["enhanced_memory_search"] });
}
```

### Multiple extensions

Each extension is independent. Create as many as you need:

```
extensions/
├── custom-auth/        # Authentication extension
├── analytics/          # Usage analytics
├── custom-channel/     # New messaging platform
└── ai-tools/           # Custom AI tools
```

## Troubleshooting

| Issue                                      | Fix                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `Cannot find module 'openclaw/plugin-sdk'` | Run `pnpm upstream:build` then `pnpm install`                        |
| Submodule empty after clone                | Run `git submodule update --init --recursive`                        |
| Extension not loading                      | Check `openclaw.extensions` in `package.json` points to `./index.ts` |
| Type errors after upstream update          | Check CHANGELOG, update imports if API changed                       |
