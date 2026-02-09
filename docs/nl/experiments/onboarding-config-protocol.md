---
summary: "RPC-protocolnotities voor onboardingwizard en config-schema"
read_when: "Wijzigen van stappen in de onboardingwizard of config-schema-eindpunten"
title: "Onboarding- en Config-protocol"
---

# Onboarding + Config-protocol

Doel: gedeelde onboarding- en config-oppervlakken voor CLI, macOS-app en Web UI.

## Componenten

- Wizard-engine (gedeelde sessie + prompts + onboardingstatus).
- CLI-onboarding gebruikt dezelfde wizardflow als de UI-clients.
- Gateway RPC biedt wizard- en config-schema-eindpunten.
- macOS-onboarding gebruikt het wizard-stappenmodel.
- Web UI rendert config-formulieren op basis van JSON Schema + UI-hints.

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Antwoorden (structuur)

- Wizard: `{ sessionId, done, step?, status?, error? }`
- Config-schema: `{ schema, uiHints, version, generatedAt }`

## UI-hints

- `uiHints` gesleuteld op pad; optionele metadata (label/help/group/order/advanced/sensitive/placeholder).
- Gevoelige velden worden weergegeven als wachtwoordinvoer; geen redactionele laag.
- Niet-ondersteunde schema-nodes vallen terug op de ruwe JSON-editor.

## Notities

- Dit document is de enige plek om protocolrefactors voor onboarding/config bij te houden.
