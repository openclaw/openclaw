---
summary: "Skema og eksempler for Skills-konfiguration"
read_when:
  - Tilføjelse eller ændring af Skills-konfiguration
  - Justering af bundtet tilladelsesliste eller installationsadfærd
title: "Skills-konfiguration"
x-i18n:
  source_path: tools/skills-config.md
  source_hash: e265c93da7856887
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:44Z
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

- `allowBundled`: valgfri tilladelsesliste for **bundtede** Skills kun. Når den er sat, er kun
  bundtede Skills på listen berettigede (administrerede/workspace Skills er upåvirkede).
- `load.extraDirs`: ekstra Skill-mapper, der skal scannes (laveste præcedens).
- `load.watch`: overvåg Skill-mapper og opdater Skills-snapshot (standard: true).
- `load.watchDebounceMs`: debounce for hændelser fra Skill-watcher i millisekunder (standard: 250).
- `install.preferBrew`: foretræk brew-installatører, når de er tilgængelige (standard: true).
- `install.nodeManager`: præference for node-installatør (`npm` | `pnpm` | `yarn` | `bun`, standard: npm).
  Dette påvirker kun **Skill-installationer**; Gateway-runtime bør stadig være Node
  (Bun anbefales ikke til WhatsApp/Telegram).
- `entries.<skillKey>`: overrides pr. Skill.

Felter pr. Skill:

- `enabled`: sæt `false` for at deaktivere en Skill, selv hvis den er bundtet/installeret.
- `env`: miljøvariabler, der injiceres til agent-kørslen (kun hvis de ikke allerede er sat).
- `apiKey`: valgfri bekvemmelighed for Skills, der deklarerer en primær miljøvariabel.

## Noter

- Nøgler under `entries` kortlægges som standard til Skill-navnet. Hvis en Skill definerer
  `metadata.openclaw.skillKey`, bruges den nøgle i stedet.
- Ændringer i Skills opfanges ved næste agent-tur, når watcher er aktiveret.

### Sandboxed Skills + miljøvariabler

Når en session er **sandboxed**, kører Skill-processer inde i Docker. Sandboxen
arver **ikke** værts-`process.env`.

Brug en af følgende:

- `agents.defaults.sandbox.docker.env` (eller pr.-agent `agents.list[].sandbox.docker.env`)
- bag miljøvariablerne ind i dit brugerdefinerede sandbox-image

Globale `env` og `skills.entries.<skill>.env/apiKey` gælder kun for **værts**-kørsler.
