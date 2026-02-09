---
summary: "Schema en voorbeelden voor Skills-configuratie"
read_when:
  - Skills-configuratie toevoegen of wijzigen
  - Gebundelde toegestane lijst of installatiegedrag aanpassen
title: "Skills-configuratie"
---

# Skills-configuratie

Alle skills-gerelateerde configuratie bevindt zich onder `skills` in `~/.openclaw/openclaw.json`.

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

## Velden

- `allowBundled`: optionele toegestane lijst alleen voor **gebundelde** skills. Indien ingesteld,
  komen alleen gebundelde skills in de lijst in aanmerking (beheerde/werkruimte-skills blijven onaangetast).
- `load.extraDirs`: aanvullende skill-mappen om te scannen (laagste prioriteit).
- `load.watch`: bewaak skill-mappen en vernieuw de skills-snapshot (standaard: true).
- `load.watchDebounceMs`: debounce voor skill-watcher-gebeurtenissen in milliseconden (standaard: 250).
- `install.preferBrew`: geef de voorkeur aan brew-installers wanneer beschikbaar (standaard: true).
- `install.nodeManager`: voorkeur voor node-installer (`npm` | `pnpm` | `yarn` | `bun`, standaard: npm).
  Dit beïnvloedt alleen **skill-installaties**; de Gateway-runtime moet nog steeds Node zijn
  (Bun niet aanbevolen voor WhatsApp/Telegram).
- `entries.<skillKey>`: overrides per skill.

Velden per skill:

- `enabled`: stel `false` in om een skill uit te schakelen, zelfs als deze gebundeld/geïnstalleerd is.
- `env`: omgevingsvariabelen die worden geïnjecteerd voor de agent-run (alleen als ze nog niet zijn ingesteld).
- `apiKey`: optioneel gemak voor skills die een primaire env-var declareren.

## Notities

- Sleutels onder `entries` worden standaard gekoppeld aan de skillnaam. Als een skill
  `metadata.openclaw.skillKey` definieert, gebruik die sleutel in plaats daarvan.
- Wijzigingen aan skills worden opgepikt bij de volgende agent-beurt wanneer de watcher is ingeschakeld.

### Gesandboxde skills + env-vars

Wanneer een sessie **gesandboxed** is, draaien skill-processen binnen Docker. De sandbox
erft **niet** de host `process.env`.

Gebruik een van de volgende opties:

- `agents.defaults.sandbox.docker.env` (of per agent `agents.list[].sandbox.docker.env`)
- bak de env in je aangepaste sandbox-image

Globale `env` en `skills.entries.<skill>.env/apiKey` zijn alleen van toepassing op **host**-runs.
