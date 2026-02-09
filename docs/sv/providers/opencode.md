---
summary: "Använd OpenCode Zen (kurerade modeller) med OpenClaw"
read_when:
  - Du vill använda OpenCode Zen för modellåtkomst
  - Du vill ha en kurerad lista med kodningsvänliga modeller
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen är en **kurerad lista över modeller** som rekommenderas av OpenCode-teamet för kodningsagenter.
Det är en frivillig, hostad modellens åtkomstväg som använder en API-nyckel och leverantören `opencode`.
Zen är för närvarande i beta.

## CLI-konfigurering

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Konfigutdrag

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Noteringar

- `OPENCODE_ZEN_API_KEY` stöds också.
- Du loggar in på Zen, lägger till faktureringsuppgifter och kopierar din API-nyckel.
- OpenCode Zen debiterar per begäran; kontrollera OpenCode-instrumentpanelen för detaljer.
