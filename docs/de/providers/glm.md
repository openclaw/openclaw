---
summary: "„Überblick über die GLM-Modellfamilie + Nutzung in OpenClaw“"
read_when:
  - Sie möchten GLM-Modelle in OpenClaw verwenden
  - Sie benötigen die Modellbenennungskonvention und das Setup
title: "„GLM-Modelle“"
---

# GLM-Modelle

GLM ist eine **Modellfamilie** (kein Unternehmen), die über die Z.AI-Plattform verfügbar ist. In OpenClaw werden GLM-
Modelle über den Anbieter `zai` und Modell-IDs wie `zai/glm-4.7` angesprochen.

## CLI-Setup

```bash
openclaw onboard --auth-choice zai-api-key
```

## Konfigurationsausschnitt

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Hinweise

- GLM-Versionen und -Verfügbarkeit können sich ändern; prüfen Sie die Z.AI-Dokumentation auf den neuesten Stand.
- Beispielhafte Modell-IDs sind `glm-4.7` und `glm-4.6`.
- Details zum Anbieter finden Sie unter [/providers/zai](/providers/zai).
