---
summary: "„Nutzen Sie Qianfans einheitliche API, um auf viele Modelle in OpenClaw zuzugreifen“"
read_when:
  - Sie möchten einen einzigen API-Schlüssel für viele LLMs
  - Sie benötigen eine Einrichtungsanleitung für Baidu Qianfan
title: "„Qianfan“"
---

# Qianfan-Anbieterleitfaden

Qianfan ist Baidus MaaS-Plattform und bietet eine **einheitliche API**, die Anfragen über einen einzelnen
Endpunkt und einen einzigen API-Schlüssel an viele Modelle weiterleitet. Sie ist OpenAI-kompatibel, sodass die meisten OpenAI-SDKs durch das Umschalten der Basis-URL funktionieren.

## Voraussetzungen

1. Ein Baidu-Cloud-Konto mit Qianfan-API-Zugriff
2. Ein API-Schlüssel aus der Qianfan-Konsole
3. OpenClaw auf Ihrem System installiert

## Ihren API-Schlüssel erhalten

1. Besuchen Sie die [Qianfan-Konsole](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Erstellen Sie eine neue Anwendung oder wählen Sie eine bestehende aus
3. Generieren Sie einen API-Schlüssel (Format: `bce-v3/ALTAK-...`)
4. Kopieren Sie den API-Schlüssel zur Verwendung mit OpenClaw

## CLI-Einrichtung

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Zugehörige Dokumentation

- [OpenClaw-Konfiguration](/gateway/configuration)
- [Modellanbieter](/concepts/model-providers)
- [Agent-Einrichtung](/concepts/agent)
- [Qianfan-API-Dokumentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
