---
summary: "Schema ng config ng Skills at mga halimbawa"
read_when:
  - Pagdaragdag o pagbabago ng skills config
  - Pag-aayos ng bundled allowlist o behavior ng pag-install
title: "Skills Config"
x-i18n:
  source_path: tools/skills-config.md
  source_hash: e265c93da7856887
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:57Z
---

# Skills Config

Lahat ng configuration na may kinalaman sa skills ay nasa ilalim ng `skills` sa `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Mga field

- `allowBundled`: opsyonal na allowlist para **bundled** skills lang. Kapag naka-set, ang
  mga bundled skill lang na nasa listahan ang puwedeng gamitin (hindi apektado ang managed/workspace skills).
- `load.extraDirs`: karagdagang mga directory ng skill na i-scan (pinakamababang precedence).
- `load.watch`: bantayan ang mga folder ng skill at i-refresh ang snapshot ng skills (default: true).
- `load.watchDebounceMs`: debounce para sa mga event ng skill watcher sa millisecond (default: 250).
- `install.preferBrew`: unahin ang mga brew installer kapag available (default: true).
- `install.nodeManager`: preference ng node installer (`npm` | `pnpm` | `yarn` | `bun`, default: npm).
  Nakaaapekto lang ito sa **skill installs**; ang Gateway runtime ay dapat manatiling Node
  (hindi inirerekomenda ang Bun para sa WhatsApp/Telegram).
- `entries.<skillKey>`: mga override kada-skill.

Mga field kada-skill:

- `enabled`: itakda ang `false` para i-disable ang isang skill kahit bundled/installed ito.
- `env`: mga environment variable na ini-inject para sa agent run (kung hindi pa naka-set).
- `apiKey`: opsyonal na convenience para sa mga skill na nagde-declare ng primary env var.

## Mga tala

- Ang mga key sa ilalim ng `entries` ay nagmamapa sa pangalan ng skill bilang default. Kung ang isang skill ay may
  `metadata.openclaw.skillKey`, iyon ang gamitin na key.
- Ang mga pagbabago sa skills ay makukuha sa susunod na turn ng agent kapag naka-enable ang watcher.

### Sandboxed skills + env vars

Kapag ang isang session ay **sandboxed**, ang mga proseso ng skill ay tumatakbo sa loob ng Docker. Ang sandbox
ay **hindi** nagmamana ng host `process.env`.

Gumamit ng isa sa mga ito:

- `agents.defaults.sandbox.docker.env` (o kada-agent `agents.list[].sandbox.docker.env`)
- i-bake ang env sa iyong custom sandbox image

Ang global `env` at `skills.entries.<skill>.env/apiKey` ay nalalapat lang sa mga **host** run.
