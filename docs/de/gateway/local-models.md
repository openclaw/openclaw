---
summary: "„OpenClaw mit lokalen LLMs ausführen (LM Studio, vLLM, LiteLLM, benutzerdefinierte OpenAI-Endpunkte)“"
read_when:
  - Sie möchten Modelle von Ihrer eigenen GPU-Box bereitstellen
  - Sie binden LM Studio oder einen OpenAI-kompatiblen Proxy an
  - Sie benötigen die sicherste Anleitung für lokale Modelle
title: "Lokale Modelle"
---

# Lokale Modelle

Lokal ist machbar, aber OpenClaw erwartet großen Kontext und starke Abwehrmechanismen gegen Prompt Injection. Kleine Karten kürzen den Kontext und leaken Sicherheitsmechanismen. Zielen Sie hoch: **≥2 voll ausgestattete Mac Studios oder ein vergleichbares GPU-Rig (~30.000 $+)**. Eine einzelne **24‑GB**‑GPU funktioniert nur für leichtere Prompts mit höherer Latenz. Verwenden Sie die **größte/Vollversion des Modells, die Sie betreiben können**; stark quantisierte oder „kleine“ Checkpoints erhöhen das Risiko von Prompt Injection (siehe [Security](/gateway/security)).

## Empfohlen: LM Studio + MiniMax M2.1 (Responses API, Vollversion)

Der aktuell beste lokale Stack. Laden Sie MiniMax M2.1 in LM Studio, aktivieren Sie den lokalen Server (Standard: `http://127.0.0.1:1234`) und verwenden Sie die Responses API, um das Reasoning vom finalen Text zu trennen.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**Setup-Checkliste**

- Installieren Sie LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- Laden Sie in LM Studio den **größten verfügbaren MiniMax‑M2.1‑Build** (vermeiden Sie „small“/stark quantisierte Varianten), starten Sie den Server und bestätigen Sie, dass `http://127.0.0.1:1234/v1/models` ihn auflistet.
- Halten Sie das Modell geladen; ein Kaltstart erhöht die Startlatenz.
- Passen Sie `contextWindow`/`maxTokens` an, falls sich Ihr LM‑Studio‑Build unterscheidet.
- Für WhatsApp bleiben Sie bei der Responses API, damit nur der finale Text gesendet wird.

Halten Sie gehostete Modelle auch beim lokalen Betrieb konfiguriert; verwenden Sie `models.mode: "merge"`, damit Fallbacks verfügbar bleiben.

### Hybrid‑Konfiguration: gehostet primär, lokal als Fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Lokal zuerst mit gehostetem Sicherheitsnetz

Tauschen Sie die Reihenfolge von Primär und Fallback; behalten Sie denselben Provider‑Block und `models.mode: "merge"`, damit Sie auf Sonnet oder Opus zurückfallen können, wenn die lokale Box ausfällt.

### Regionale Bereitstellung / Datenrouting

- Gehostete MiniMax/Kimi/GLM‑Varianten sind auch auf OpenRouter mit regionsgebundenen Endpunkten (z. B. US‑gehostet) verfügbar. Wählen Sie dort die regionale Variante, um den Datenverkehr in Ihrer gewünschten Jurisdiktion zu halten, und nutzen Sie weiterhin `models.mode: "merge"` für Anthropic/OpenAI‑Fallbacks.
- Rein lokal bleibt der stärkste Datenschutzpfad; gehostetes, regionales Routing ist der Mittelweg, wenn Sie Provider‑Features benötigen, aber die Datenflüsse kontrollieren möchten.

## Weitere OpenAI‑kompatible lokale Proxys

vLLM, LiteLLM, OAI‑Proxy oder benutzerdefinierte Gateways funktionieren, wenn sie einen OpenAI‑ähnlichen `/v1`‑Endpunkt bereitstellen. Ersetzen Sie den obigen Provider‑Block durch Ihren Endpunkt und Ihre Modell‑ID:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Behalten Sie `models.mode: "merge"` bei, damit gehostete Modelle als Fallbacks verfügbar bleiben.

## Fehlerbehebung

- Kann das Gateway den Proxy erreichen? `curl http://127.0.0.1:1234/v1/models`.
- LM‑Studio‑Modell entladen? Neu laden; Kaltstarts sind eine häufige Ursache für „Hängenbleiben“.
- Kontextfehler? Senken Sie `contextWindow` oder erhöhen Sie das Server‑Limit.
- Sicherheit: Lokale Modelle umgehen providerseitige Filter; halten Sie Agents eng gefasst und lassen Sie die Kompaktierung aktiviert, um die Auswirkungsreichweite von Prompt Injection zu begrenzen.
