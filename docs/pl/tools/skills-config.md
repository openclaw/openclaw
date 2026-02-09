---
summary: "Schemat konfiguracji Skills oraz przykłady"
read_when:
  - Dodawanie lub modyfikowanie konfiguracji Skills
  - Dostosowywanie dołączonej listy dozwolonych lub zachowania instalacji
title: "Konfiguracja Skills"
---

# Konfiguracja Skills

Cała konfiguracja związana ze Skills znajduje się pod `skills` w `~/.openclaw/openclaw.json`.

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

## Pola

- `allowBundled`: opcjonalna lista dozwolonych wyłącznie dla **dołączonych** Skills. Gdy jest ustawiona, kwalifikują się tylko
  dołączone Skills z listy (Skills zarządzane/obszaru roboczego pozostają bez wpływu).
- `load.extraDirs`: dodatkowe katalogi Skills do skanowania (najniższy priorytet).
- `load.watch`: obserwowanie folderów Skills i odświeżanie migawki Skills (domyślnie: true).
- `load.watchDebounceMs`: opóźnienie (debounce) zdarzeń obserwatora Skills w milisekundach (domyślnie: 250).
- `install.preferBrew`: preferuj instalatory brew, gdy są dostępne (domyślnie: true).
- `install.nodeManager`: preferencja instalatora node (`npm` | `pnpm` | `yarn` | `bun`, domyślnie: npm).
  Dotyczy to wyłącznie **instalacji Skills**; środowisko uruchomieniowe Gateway nadal powinno być Node
  (Bun niezalecany dla WhatsApp/Telegram).
- `entries.<skillKey>`: nadpisania per-skill.

Pola per-skill:

- `enabled`: ustaw `false`, aby wyłączyć skill, nawet jeśli jest dołączony/zainstalowany.
- `env`: zmienne środowiskowe wstrzykiwane do uruchomienia agenta (tylko jeśli nie są już ustawione).
- `apiKey`: opcjonalne ułatwienie dla Skills, które deklarują główną zmienną środowiskową.

## Uwagi

- Klucze pod `entries` domyślnie mapują się na nazwę skill. Jeśli skill definiuje
  `metadata.openclaw.skillKey`, użyj zamiast tego tego klucza.
- Zmiany w Skills są wykrywane przy następnym kroku agenta, gdy obserwator jest włączony.

### Sandboxed Skills + zmienne środowiskowe

Gdy sesja jest **sandboxed**, procesy Skills działają wewnątrz Dockera. Sandbox
**nie** dziedziczy `process.env` hosta.

Użyj jednego z poniższych:

- `agents.defaults.sandbox.docker.env` (lub per-agent `agents.list[].sandbox.docker.env`)
- wbuduj zmienne środowiskowe w niestandardowy obraz sandbox

Globalne `env` oraz `skills.entries.<skill>.env/apiKey` mają zastosowanie wyłącznie do uruchomień na **hoście**.
