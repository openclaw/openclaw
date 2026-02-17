---
summary: "Referencia CLI para `openclaw onboard` (asistente de incorporación interactivo)"
read_when:
  - Quieres configuración guiada para gateway, workspace, autenticación, canales y habilidades
title: "onboard"
---

# `openclaw onboard`

Asistente de incorporación interactivo (configuración de Gateway local o remoto).

## Guías relacionadas

- Hub de incorporación CLI: [Asistente de Incorporación (CLI)](/es-ES/start/wizard)
- Resumen de incorporación: [Resumen de Incorporación](/es-ES/start/onboarding-overview)
- Referencia de incorporación CLI: [Referencia de Incorporación CLI](/es-ES/start/wizard-cli-reference)
- Automatización CLI: [Automatización CLI](/es-ES/start/wizard-cli-automation)
- Incorporación macOS: [Incorporación (App de macOS)](/es-ES/start/onboarding)

## Ejemplos

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Proveedor personalizado no interactivo:

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --custom-compatibility openai
```

`--custom-api-key` es opcional en modo no interactivo. Si se omite, la incorporación verifica `CUSTOM_API_KEY`.

Opciones de endpoint Z.AI no interactivas:

Nota: `--auth-choice zai-api-key` ahora detecta automáticamente el mejor endpoint Z.AI para tu clave (prefiere la API general con `zai/glm-5`).
Si específicamente quieres los endpoints del Plan de Codificación GLM, elige `zai-coding-global` o `zai-coding-cn`.

```bash
# Selección de endpoint sin prompts
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# Otras opciones de endpoint Z.AI:
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

Notas de flujo:

- `quickstart`: prompts mínimos, autogenera un token de gateway.
- `manual`: prompts completos para puerto/bind/autenticación (alias de `advanced`).
- Primera conversación más rápida: `openclaw dashboard` (Interfaz de Control, sin configuración de canal).
- Proveedor Personalizado: conecta cualquier endpoint compatible con OpenAI o Anthropic,
  incluyendo proveedores alojados no listados. Usa Unknown para autodetección.

## Comandos de seguimiento comunes

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` no implica modo no interactivo. Usa `--non-interactive` para scripts.
</Note>
