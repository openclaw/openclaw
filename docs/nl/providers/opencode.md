---
summary: "Gebruik OpenCode Zen (gecurateerde modellen) met OpenClaw"
read_when:
  - Je wilt OpenCode Zen voor modeltoegang
  - Je wilt een gecureerde lijst met codeervriendelijke modellen
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen is een **gecurateerde lijst met modellen** die door het OpenCode-team worden aanbevolen voor coderingsagents.
Het is een optionele, gehoste modeltoegang die een API-sleutel gebruikt en de `opencode` provider.
Zen bevindt zich momenteel in beta.

## CLI setup

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Notes

- `OPENCODE_ZEN_API_KEY` wordt ook ondersteund.
- Je meldt je aan bij Zen, voegt factureringsgegevens toe en kopieert je API-sleutel.
- OpenCode Zen rekent per aanvraag; raadpleeg het OpenCode-dashboard voor details.
