---
summary: "”Schema och exempel för Skills-konfig”"
read_when:
  - Lägga till eller ändra Skills-konfig
  - Justera medföljande tillåtelselista eller installationsbeteende
title: "”Skills-konfig”"
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

- `allowBundled`: valfri tillåten lista för **bundna** färdigheter endast. När angiven, är endast
  medföljande färdigheter i listan berättigade (hanterade / arbetsytor opåverkade).
- `load.extraDirs`: ytterligare Skills-kataloger att skanna (lägsta prioritet).
- `load.watch`: bevaka Skills-mappar och uppdatera Skills-ögonblicksbilden (standard: true).
- `load.watchDebounceMs`: debounce för händelser från Skills-bevakaren i millisekunder (standard: 250).
- `install.preferBrew`: föredra brew-installatörer när de finns tillgängliga (standard: true).
- `install.nodeManager`: Node installer preferens (`npm` <unk> `pnpm` <unk> `yarn` <unk> `bun`, default: npm).
  Detta påverkar endast **färdighetsinstallationer**; Gateway runtime bör fortfarande vara Node
  (Bun rekommenderas inte för WhatsApp/Telegram).
- `entries.<skillKey>`: åsidosättningar per skicklighet.

Per-Skill-fält:

- `enabled`: sätt `false` för att inaktivera en Skill även om den är medföljande/installerad.
- `env`: miljövariabler som injiceras för agentkörningen (endast om de inte redan är satta).
- `apiKey`: valfri bekvämlighet för Skills som deklarerar en primär miljövariabel.

## Noteringar

- Nycklar under `entries` kartan till skicklighetsnamnet som standard. Om en färdighet definierar
  `metadata.openclaw.skillKey`, använd den nyckeln istället.
- Ändringar i Skills plockas upp vid nästa agenttur när bevakaren är aktiverad.

### Sandboxed Skills + miljövariabler

När en session är **sandlåda**, färdighet processer körs inuti Docker. Sandlådan
ärver **inte** värden `process.env`.

Använd något av följande:

- `agents.defaults.sandbox.docker.env` (eller per-agent `agents.list[].sandbox.docker.env`)
- baka in miljövariablerna i din anpassade sandbox-image

Global `env` och `skills.entries.<skill>.env/apiKey` gäller endast **värd** körningar.
