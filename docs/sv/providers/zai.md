---
summary: "Använd Z.AI (GLM-modeller) med OpenClaw"
read_when:
  - Du vill använda Z.AI / GLM-modeller i OpenClaw
  - Du behöver en enkel ZAI_API_KEY-konfigurering
title: "Z.AI"
---

# Z.AI

Z.AI är API-plattformen för **GLM**-modeller. Det ger REST API:er för GLM och använder API-nycklar
för autentisering. Skapa din API-nyckel i Z.AI-konsolen. OpenClaw använder `zai`-leverantören
med en Z.AI API-nyckel.

## CLI-konfigurering

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Konfigutdrag

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Noteringar

- GLM-modeller är tillgängliga som `zai/<model>` (exempel: `zai/glm-4.7`).
- Se [/providers/glm](/providers/glm) för en översikt över modellfamiljen.
- Z.AI använder Bearer-autentisering med din API-nyckel.
