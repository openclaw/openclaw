---
summary: ”Schema och exempel för Skills-konfig”
read_when:
  - Lägga till eller ändra Skills-konfig
  - Justera medföljande tillåtelselista eller installationsbeteende
title: ”Skills-konfig”
x-i18n:
  source_path: tools/skills-config.md
  source_hash: e265c93da7856887
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:43Z
---

# Skills-konfig

All konfiguration som rör Skills finns under `skills` i `~/.openclaw/openclaw.json`.

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

## Fält

- `allowBundled`: valfri tillåtelselista endast för **medföljande** Skills. När den är satt är endast
  medföljande Skills i listan berättigade (hanterade-/workspace-Skills påverkas inte).
- `load.extraDirs`: ytterligare Skills-kataloger att skanna (lägsta prioritet).
- `load.watch`: bevaka Skills-mappar och uppdatera Skills-ögonblicksbilden (standard: true).
- `load.watchDebounceMs`: debounce för händelser från Skills-bevakaren i millisekunder (standard: 250).
- `install.preferBrew`: föredra brew-installatörer när de finns tillgängliga (standard: true).
- `install.nodeManager`: preferens för Node-installatör (`npm` | `pnpm` | `yarn` | `bun`, standard: npm).
  Detta påverkar endast **Skills-installationer**; Gateway-körtiden bör fortfarande vara Node
  (Bun rekommenderas inte för WhatsApp/Telegram).
- `entries.<skillKey>`: per-Skill-åsidosättningar.

Per-Skill-fält:

- `enabled`: sätt `false` för att inaktivera en Skill även om den är medföljande/installerad.
- `env`: miljövariabler som injiceras för agentkörningen (endast om de inte redan är satta).
- `apiKey`: valfri bekvämlighet för Skills som deklarerar en primär miljövariabel.

## Noteringar

- Nycklar under `entries` mappas som standard till Skill-namnet. Om en Skill definierar
  `metadata.openclaw.skillKey`, använd den nyckeln i stället.
- Ändringar i Skills plockas upp vid nästa agenttur när bevakaren är aktiverad.

### Sandboxed Skills + miljövariabler

När en session är **sandboxed** körs Skill-processer inuti Docker. Sandboxing
ärver **inte** värdens `process.env`.

Använd något av följande:

- `agents.defaults.sandbox.docker.env` (eller per-agent `agents.list[].sandbox.docker.env`)
- baka in miljövariablerna i din anpassade sandbox-image

Globala `env` och `skills.entries.<skill>.env/apiKey` gäller endast för **värd**-körningar.
