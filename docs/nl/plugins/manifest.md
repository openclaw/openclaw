---
summary: "Pluginmanifest + JSON-schemavereisten (strikte configvalidatie)"
read_when:
  - Je bouwt een OpenClaw-plugin
  - Je moet een plugin-configschema leveren of pluginvalidatiefouten debuggen
title: "Pluginmanifest"
---

# Pluginmanifest (openclaw.plugin.json)

Elke plugin **moet** een `openclaw.plugin.json`-bestand meeleveren in de **plugin-root**.
OpenClaw gebruikt dit manifest om configuratie te valideren **zonder plugincode
uit te voeren**. Ontbrekende of ongeldige manifests worden behandeld als
pluginfouten en blokkeren configvalidatie.

Zie de volledige gids voor het pluginsysteem: [Plugins](/tools/plugin).

## Vereiste velden

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Vereiste sleutels:

- `id` (string): canonieke plugin-id.
- `configSchema` (object): JSON Schema voor pluginconfiguratie (inline).

Optionele sleutels:

- `kind` (string): plugintype (voorbeeld: `"memory"`).
- `channels` (array): kanaal-id’s die door deze plugin worden geregistreerd (voorbeeld: `["matrix"]`).
- `providers` (array): provider-id’s die door deze plugin worden geregistreerd.
- `skills` (array): skillmappen om te laden (relatief ten opzichte van de plugin-root).
- `name` (string): weergavenaam voor de plugin.
- `description` (string): korte pluginsamenvatting.
- `uiHints` (object): labels/plaats-houders/gevoeligheidsvlaggen voor configvelden voor UI-rendering.
- `version` (string): pluginversie (informatief).

## JSON-schemavereisten

- **Elke plugin moet een JSON Schema meeleveren**, zelfs als deze geen configuratie accepteert.
- Een leeg schema is acceptabel (bijvoorbeeld `{ "type": "object", "additionalProperties": false }`).
- Schema’s worden gevalideerd bij het lezen/schrijven van config, niet tijdens runtime.

## Validatiegedrag

- Onbekende `channels.*`-sleutels zijn **fouten**, tenzij de kanaal-id door
  een pluginmanifest is gedeclareerd.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` en `plugins.slots.*`
  moeten verwijzen naar **ontdekbare** plugin-id’s. Onbekende id’s zijn **fouten**.
- Als een plugin is geïnstalleerd maar een defect of ontbrekend manifest of schema heeft,
  faalt de validatie en rapporteert Doctor de pluginfout.
- Als pluginconfiguratie bestaat maar de plugin **uitgeschakeld** is, blijft de config behouden en
  wordt een **waarschuwing** weergegeven in Doctor + logs.

## Notities

- Het manifest is **vereist voor alle plugins**, inclusief lokale filesystem-loads.
- De runtime laadt de pluginmodule nog steeds afzonderlijk; het manifest is alleen voor
  discovery + validatie.
- Als je plugin afhankelijk is van native modules, documenteer de buildstappen en eventuele
  vereisten voor een package-manager-allowlist (bijvoorbeeld pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
