---
summary: "Verwenden Sie OpenCode Zen (kuratierte Modelle) mit OpenClaw"
read_when:
  - Sie möchten OpenCode Zen für den Modellzugriff
  - Sie möchten eine kuratierte Liste codingfreundlicher Modelle
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen ist eine **kuratierte Liste von Modellen**, die vom OpenCode-Team für Coding-Agents empfohlen werden.
Es ist ein optionaler, gehosteter Modellzugriffspfad, der einen API-Schlüssel und den Anbieter `opencode` verwendet.
Zen befindet sich derzeit in der Beta-Phase.

## CLI-Einrichtung

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Konfigurationsausschnitt

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Hinweise

- `OPENCODE_ZEN_API_KEY` wird ebenfalls unterstützt.
- Sie melden sich bei Zen an, fügen Abrechnungsdetails hinzu und kopieren Ihren API-Schlüssel.
- OpenCode Zen rechnet pro Anfrage ab; prüfen Sie das OpenCode-Dashboard für Details.
