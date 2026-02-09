---
summary: "Referencia de la CLI para `openclaw onboard` (asistente interactivo de incorporación)"
read_when:
  - Desea una configuración guiada para el Gateway, el espacio de trabajo, la autenticación, los canales y las Skills
title: "onboard"
---

# `openclaw onboard`

Asistente interactivo de incorporación (configuración del Gateway local o remoto).

## Guías relacionadas

- Centro de incorporación de la CLI: [Onboarding Wizard (CLI)](/start/wizard)
- Referencia de incorporación de la CLI: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Automatización de la CLI: [CLI Automation](/start/wizard-cli-automation)
- Incorporación en macOS: [Onboarding (macOS App)](/start/onboarding)

## Ejemplos

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Notas del flujo:

- `quickstart`: indicaciones mínimas, genera automáticamente un token del Gateway.
- `manual`: indicaciones completas para puerto/enlace/autenticación (alias de `advanced`).
- Primer chat más rápido: `openclaw dashboard` (UI de control, sin configuración de canal).

## Comandos comunes posteriores

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` no implica modo no interactivo. Use `--non-interactive` para scripts.
</Note>
