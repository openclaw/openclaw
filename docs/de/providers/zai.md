---
summary: "„Verwenden Sie Z.AI (GLM-Modelle) mit OpenClaw“"
read_when:
  - Sie möchten Z.AI-/GLM-Modelle in OpenClaw verwenden
  - Sie benötigen eine einfache Einrichtung mit ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

Z.AI ist die API-Plattform für **GLM**-Modelle. Sie stellt REST-APIs für GLM bereit und verwendet API-Schlüssel
zur Authentifizierung. Erstellen Sie Ihren API-Schlüssel in der Z.AI-Konsole. OpenClaw verwendet den Anbieter
`zai` mit einem Z.AI-API-Schlüssel.

## CLI-Einrichtung

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Konfigurationsausschnitt

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Hinweise

- GLM-Modelle sind als `zai/<model>` verfügbar (Beispiel: `zai/glm-4.7`).
- Siehe [/providers/glm](/providers/glm) für die Übersicht der Modellfamilie.
- Z.AI verwendet Bearer-Authentifizierung mit Ihrem API-Schlüssel.
