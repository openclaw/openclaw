---
summary: "Referência da CLI para `openclaw onboard` (assistente interativo de integração inicial)"
read_when:
  - Você quer configuração guiada para gateway, workspace, autenticação, canais e Skills
title: "onboard"
---

# `openclaw onboard`

Assistente interativo de integração inicial (configuração local ou remota do Gateway).

## Guias relacionados

- Hub de integração inicial da CLI: [Onboarding Wizard (CLI)](/start/wizard)
- Referência de integração inicial da CLI: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Automação da CLI: [CLI Automation](/start/wizard-cli-automation)
- Integração inicial no macOS: [Onboarding (macOS App)](/start/onboarding)

## Exemplos

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Notas do fluxo:

- `quickstart`: prompts mínimos, gera automaticamente um token do gateway.
- `manual`: prompts completos para porta/bind/autenticação (alias de `advanced`).
- Primeiro chat mais rápido: `openclaw dashboard` (UI de Controle, sem configuração de canal).

## Comandos comuns de acompanhamento

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` não implica modo não interativo. Use `--non-interactive` para scripts.
</Note>
