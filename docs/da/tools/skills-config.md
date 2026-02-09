---
summary: "Skema og eksempler for Skills-konfiguration"
read_when:
  - Tilføjelse eller ændring af Skills-konfiguration
  - Justering af bundtet tilladelsesliste eller installationsadfærd
title: "Skills-konfiguration"
---

# Skills-konfiguration

Al Skills-relateret konfiguration ligger under `skills` i `~/.openclaw/openclaw.json`.

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

## Felter

- `allowBundled`: valgfri tilladt liste for \*\*bundtede \*\* færdigheder. Når de er angivet, er kun
  bundtede færdigheder på listen kvalificerede (administrerede/arbejdsområde færdigheder upåvirket).
- `load.extraDirs`: ekstra Skill-mapper, der skal scannes (laveste præcedens).
- `load.watch`: overvåg Skill-mapper og opdater Skills-snapshot (standard: true).
- `load.watchDebounceMs`: debounce for hændelser fra Skill-watcher i millisekunder (standard: 250).
- `install.preferBrew`: foretræk brew-installatører, når de er tilgængelige (standard: true).
- `install.nodeManager`: node installatør præference (`npm` ● `pnpm` ● `yarn` ● `bun`, default: npm).
  Dette påvirker kun **færdighed installerer**; Gateway runtime skal stadig være node
  (Bun anbefales ikke for WhatsApp/Telegram).
- `poster.<skillKey>`: per-færdighed tilsidesættelser.

Per-færdigheds felter:

- `enabled`: sæt `false` for at deaktivere en Skill, selv hvis den er bundtet/installeret.
- `env`: miljøvariabler, der injiceres til agent-kørslen (kun hvis de ikke allerede er sat).
- `apiKey`: valgfri bekvemmelighed for Skills, der deklarerer en primær miljøvariabel.

## Noter

- Nøgler under 'entries' kort til færdighedsnavnet som standard. Hvis en færdighed definerer
  `metadata.openclaw.skillKey`, brug denne nøgle i stedet.
- Ændringer i Skills opfanges ved næste agent-tur, når watcher er aktiveret.

### Sandboxed Skills + miljøvariabler

Når en session er **sandboxed**, færdighedsprocesser køre inde Docker. Sandkassen
arver **ikke** værten `process.env`.

Brug en af følgende:

- `agents.defaults.sandbox.docker.env` (eller pr.-agent `agents.list[].sandbox.docker.env`)
- bag miljøvariablerne ind i dit brugerdefinerede sandbox-image

Global `env` og `skills.entries.<skill>.env/apiKey` gælder kun for **vært** kører.
