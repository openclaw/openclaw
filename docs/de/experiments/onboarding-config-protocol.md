---
summary: "RPC-Protokollhinweise für Onboarding-Assistent und Konfigurationsschema"
read_when: "Ändern der Schritte des Onboarding-Assistenten oder der Endpunkte des Konfigurationsschemas"
title: "Onboarding- und Konfigurationsprotokoll"
---

# Onboarding- und Konfigurationsprotokoll

Zweck: Gemeinsame Onboarding- und Konfigurationsoberflächen für CLI, macOS-App und Web-UI.

## Komponenten

- Assistenten-Engine (gemeinsame Sitzung + Eingabeaufforderungen + Onboarding-Status).
- CLI-Onboarding verwendet denselben Assistentenablauf wie die UI-Clients.
- Gateway-RPC stellt Endpunkte für Assistent und Konfigurationsschema bereit.
- macOS-Onboarding verwendet das Modell der Assistentenschritte.
- Die Web-UI rendert Konfigurationsformulare aus JSON Schema + UI-Hinweisen.

## Gateway RPC

- `wizard.start` Parameter: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` Parameter: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` Parameter: `{ sessionId }`
- `wizard.status` Parameter: `{ sessionId }`
- `config.schema` Parameter: `{}`

Antworten (Struktur)

- Assistent: `{ sessionId, done, step?, status?, error? }`
- Konfigurationsschema: `{ schema, uiHints, version, generatedAt }`

## UI-Hinweise

- `uiHints` nach Pfad indexiert; optionale Metadaten (label/help/group/order/advanced/sensitive/placeholder).
- Sensible Felder werden als Passwort-Eingaben gerendert; keine Redaktionsschicht.
- Nicht unterstützte Schema-Knoten fallen auf den rohen JSON-Editor zurück.

## Hinweise

- Dieses Dokument ist der zentrale Ort zur Nachverfolgung von Protokoll-Refactorings für Onboarding/Konfiguration.
