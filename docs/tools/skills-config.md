---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Skills config schema and examples"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying skills config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adjusting bundled allowlist or install behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Skills Config"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Skills Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All skills-related configuration lives under `skills` in `~/.openclaw/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allowBundled: ["gemini", "peekaboo"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    load: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      watch: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      watchDebounceMs: 250,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    install: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      preferBrew: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "nano-banana-pro": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "GEMINI_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          GEMINI_API_KEY: "GEMINI_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      peekaboo: { enabled: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sag: { enabled: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowBundled`: optional allowlist for **bundled** skills only. When set, only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bundled skills in the list are eligible (managed/workspace skills unaffected).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `load.extraDirs`: additional skill directories to scan (lowest precedence).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `load.watch`: watch skill folders and refresh the skills snapshot (default: true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `load.watchDebounceMs`: debounce for skill watcher events in milliseconds (default: 250).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `install.preferBrew`: prefer brew installers when available (default: true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn` | `bun`, default: npm).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  This only affects **skill installs**; the Gateway runtime should still be Node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (Bun not recommended for WhatsApp/Telegram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `entries.<skillKey>`: per-skill overrides.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-skill fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled`: set `false` to disable a skill even if it’s bundled/installed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `env`: environment variables injected for the agent run (only if not already set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apiKey`: optional convenience for skills that declare a primary env var.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keys under `entries` map to the skill name by default. If a skill defines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `metadata.openclaw.skillKey`, use that key instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Changes to skills are picked up on the next agent turn when the watcher is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sandboxed skills + env vars（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a session is **sandboxed**, skill processes run inside Docker. The sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
does **not** inherit the host `process.env`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use one of:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.sandbox.docker.env` (or per-agent `agents.list[].sandbox.docker.env`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- bake the env into your custom sandbox image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Global `env` and `skills.entries.<skill>.env/apiKey` apply to **host** runs only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
