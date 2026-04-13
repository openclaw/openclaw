---
summary: "How to package and publish OpenClaw hook packs for public reuse"
read_when:
  - You want to share a hook publicly
  - You want to package hooks for npm installation
  - You want to distribute reusable Gateway automation
title: "Publishing Hook Packs"
---

# Publishing Hook Packs

OpenClaw hook packs are already shareable today.

The current public distribution path is:

1. Package one or more hooks in a normal npm package.
2. Expose them through `openclaw.hooks` in `package.json`.
3. Publish the package to npm.
4. Install it with `openclaw plugins install <package>`.

OpenClaw does **not** currently have a dedicated first-party hook marketplace or
curated hook registry page. Public sharing today is package-based, not
marketplace-based.

## Package layout

Each exported hook root must use the normal hook layout:

```text
my-hook-pack/
├── package.json
└── hooks/
    └── model-switch-notify/
        ├── HOOK.md
        └── handler.ts
```

## package.json

Declare hook roots under `openclaw.hooks`:

```json
{
  "name": "@your-scope/openclaw-hook-pack",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "hooks": ["./hooks/model-switch-notify"]
  }
}
```

Notes:

- `openclaw.hooks` entries must stay inside the package directory.
- OpenClaw accepts npm package installs, local paths, and supported archives.
- npm installs are registry-only: package name plus optional exact version or dist-tag.

## Hook contents

Each hook root should contain:

- `HOOK.md` with metadata and operator-facing documentation
- `handler.ts` or `handler.js` with the runtime implementation

Minimal `HOOK.md`:

```markdown
---
name: model-switch-notify
description: "Notify an operator when model fallback succeeds"
metadata:
  openclaw:
    events: ["gateway:startup"]
---
```

## Publish and install

Publish the package with your normal npm workflow, then install it on another
Gateway:

```bash
npm publish
openclaw plugins install @your-scope/openclaw-hook-pack
```

You can also pin a version:

```bash
openclaw plugins install @your-scope/openclaw-hook-pack@1.0.0 --pin
```

## Discovery today

There is no dedicated OpenClaw hook marketplace today.

If you want people to find your hook pack, the practical options are:

- publish it on npm
- link to it from GitHub or your docs
- mention the install command directly in the README

## Related

- [Hooks](/automation/hooks)
- [Hooks CLI](/cli/hooks)
- [Plugins CLI](/cli/plugins)
