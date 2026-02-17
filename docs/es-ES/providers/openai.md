---
summary: "Usa OpenAI mediante claves de API o suscripción de Codex en OpenClaw"
read_when:
  - Quieres usar modelos de OpenAI en OpenClaw
  - Quieres autenticación por suscripción de Codex en lugar de claves de API
title: "OpenAI"
---

# OpenAI

OpenAI proporciona APIs para desarrolladores para modelos GPT. Codex admite **inicio de sesión con ChatGPT** para acceso por suscripción o **inicio de sesión con clave de API** para acceso basado en uso. Codex cloud requiere inicio de sesión con ChatGPT.

## Opción A: Clave de API de OpenAI (Plataforma OpenAI)

**Mejor para:** acceso directo a la API y facturación basada en uso.
Obtén tu clave de API desde el panel de OpenAI.

### Configuración mediante CLI

```bash
openclaw onboard --auth-choice openai-api-key
# o no interactivo
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Fragmento de configuración

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Opción B: Suscripción de OpenAI Code (Codex)

**Mejor para:** usar acceso por suscripción de ChatGPT/Codex en lugar de una clave de API.
Codex cloud requiere inicio de sesión con ChatGPT, mientras que el CLI de Codex admite inicio de sesión con ChatGPT o clave de API.

### Configuración mediante CLI (OAuth de Codex)

```bash
# Ejecuta OAuth de Codex en el asistente
openclaw onboard --auth-choice openai-codex

# O ejecuta OAuth directamente
openclaw models auth login --provider openai-codex
```

### Fragmento de configuración (suscripción de Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Notas

- Las referencias de modelo siempre usan `provider/model` (ver [/es-ES/concepts/models](/es-ES/concepts/models)).
- Los detalles de autenticación y las reglas de reutilización están en [/es-ES/concepts/oauth](/es-ES/concepts/oauth).
