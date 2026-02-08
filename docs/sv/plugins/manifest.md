---
summary: "Pluginmanifest + JSON Schema-krav (strikt validering av konfig)"
read_when:
  - Du bygger ett OpenClaw-plugin
  - Du behöver leverera ett konfigschema för ett plugin eller felsöka valideringsfel för plugin
title: "Pluginmanifest"
x-i18n:
  source_path: plugins/manifest.md
  source_hash: 234c7c0e77f22f5c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:08Z
---

# Pluginmanifest (openclaw.plugin.json)

Varje plugin **måste** leverera en `openclaw.plugin.json`-fil i **pluginets rot**.
OpenClaw använder detta manifest för att validera konfiguration **utan att exekvera plugin-
kod**. Saknade eller ogiltiga manifest behandlas som pluginfel och blockerar
konfigvalidering.

Se den fullständiga guiden för pluginsystemet: [Plugins](/tools/plugin).

## Obligatoriska fält

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

Obligatoriska nycklar:

- `id` (string): kanoniskt plugin-id.
- `configSchema` (object): JSON Schema för pluginets konfig (inline).

Valfria nycklar:

- `kind` (string): plugintyp (exempel: `"memory"`).
- `channels` (array): kanal-id:n som registreras av detta plugin (exempel: `["matrix"]`).
- `providers` (array): leverantörs-id:n som registreras av detta plugin.
- `skills` (array): Skill-kataloger som ska laddas (relativt pluginets rot).
- `name` (string): visningsnamn för pluginet.
- `description` (string): kort sammanfattning av pluginet.
- `uiHints` (object): etiketter/platshållare/känslighetsflaggor för konfigfält för UI-rendering.
- `version` (string): pluginversion (informationsmässig).

## Krav för JSON Schema

- **Varje plugin måste leverera ett JSON Schema**, även om det inte accepterar någon konfig.
- Ett tomt schema är acceptabelt (till exempel `{ "type": "object", "additionalProperties": false }`).
- Scheman valideras vid läsning/skrivning av konfig, inte vid körning.

## Valideringsbeteende

- Okända `channels.*`-nycklar är **fel**, om inte kanal-id:t deklareras av
  ett pluginmanifest.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` och `plugins.slots.*`
  måste referera till **upptäckbara** plugin-id:n. Okända id:n är **fel**.
- Om ett plugin är installerat men har ett trasigt eller saknat manifest eller schema,
  misslyckas valideringen och Doctor rapporterar pluginfelet.
- Om plugin-konfig finns men pluginet är **inaktiverat**, behålls konfigen och
  en **varning** visas i Doctor + loggar.

## Noteringar

- Manifestet är **obligatoriskt för alla plugins**, inklusive lokala filsystems-laddningar.
- Runtime laddar fortfarande pluginmodulen separat; manifestet är endast för
  discovery + validering.
- Om ditt plugin är beroende av native-moduler, dokumentera byggstegen och eventuella
  krav på tillåtelselista för pakethanterare (till exempel pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
