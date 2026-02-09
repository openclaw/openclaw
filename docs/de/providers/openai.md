---
summary: "„Verwenden Sie OpenAI über API-Schlüssel oder ein Codex-Abonnement in OpenClaw“"
read_when:
  - Sie möchten OpenAI-Modelle in OpenClaw verwenden
  - Sie möchten die Authentifizierung über ein Codex-Abonnement statt über API-Schlüssel
title: "OpenAI"
---

# OpenAI

OpenAI stellt Entwickler-APIs für GPT-Modelle bereit. Codex unterstützt die **Anmeldung mit ChatGPT** für den Zugriff über ein Abonnement oder die **Anmeldung mit API-Schlüssel** für nutzungsbasierte Abrechnung. Die Codex-Cloud erfordert die Anmeldung mit ChatGPT.

## Option A: OpenAI API-Schlüssel (OpenAI Platform)

**Am besten geeignet für:** direkten API-Zugriff und nutzungsbasierte Abrechnung.
Beziehen Sie Ihren API-Schlüssel über das OpenAI-Dashboard.

### CLI-Setup

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Konfigurationsausschnitt

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Option B: OpenAI Code (Codex)-Abonnement

**Am besten geeignet für:** die Nutzung des ChatGPT/Codex-Abonnementzugriffs anstelle eines API-Schlüssels.
Die Codex-Cloud erfordert die Anmeldung mit ChatGPT, während die Codex-CLI die Anmeldung mit ChatGPT oder API-Schlüssel unterstützt.

### CLI-Setup (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Konfigurationsausschnitt (Codex-Abonnement)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Hinweise

- Modell-Referenzen verwenden immer `provider/model` (siehe [/concepts/models](/concepts/models)).
- Authentifizierungsdetails und Wiederverwendungsregeln finden Sie unter [/concepts/oauth](/concepts/oauth).
