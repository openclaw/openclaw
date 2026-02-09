---
summary: "Use OpenAI mediante claves de API o suscripción a Codex en OpenClaw"
read_when:
  - Quiere usar modelos de OpenAI en OpenClaw
  - Quiere autenticación con suscripción a Codex en lugar de claves de API
title: "OpenAI"
---

# OpenAI

OpenAI proporciona APIs para desarrolladores de modelos GPT. Codex admite **inicio de sesión con ChatGPT** para acceso por suscripción o **inicio de sesión con clave de API** para acceso basado en uso. Codex cloud requiere inicio de sesión con ChatGPT.

## Opción A: Clave de API de OpenAI (OpenAI Platform)

**Ideal para:** acceso directo a la API y facturación basada en uso.
Obtenga su clave de API desde el panel de OpenAI.

### Configuración de la CLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Fragmento de configuración

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Opción B: Suscripción a OpenAI Code (Codex)

**Ideal para:** usar acceso por suscripción a ChatGPT/Codex en lugar de una clave de API.
Codex cloud requiere inicio de sesión con ChatGPT, mientras que la CLI de Codex admite inicio de sesión con ChatGPT o con clave de API.

### Configuración de la CLI (OAuth de Codex)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Fragmento de configuración (suscripción a Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Notas

- Las referencias de modelos siempre usan `provider/model` (consulte [/concepts/models](/concepts/models)).
- Los detalles de autenticación y las reglas de reutilización están en [/concepts/oauth](/concepts/oauth).
