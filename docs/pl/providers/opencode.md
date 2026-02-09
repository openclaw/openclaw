---
summary: "„Używaj OpenCode Zen (kuratorowane modele) z OpenClaw”"
read_when:
  - Chcesz korzystać z OpenCode Zen w celu uzyskania dostępu do modeli
  - Chcesz mieć kuratorowaną listę modeli przyjaznych do kodowania
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen to **kuratorowana lista modeli** rekomendowanych przez zespół OpenCode do agentów kodujących.
Jest to opcjonalna, hostowana ścieżka dostępu do modeli, która korzysta z klucza API oraz dostawcy `opencode`.
Zen jest obecnie w fazie beta.

## Konfiguracja CLI

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Fragment konfiguracji

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Uwagi

- `OPENCODE_ZEN_API_KEY` jest również obsługiwany.
- Logujesz się do Zen, dodajesz dane rozliczeniowe i kopiujesz swój klucz API.
- OpenCode Zen rozlicza się za każde żądanie; szczegóły sprawdź w panelu OpenCode.
