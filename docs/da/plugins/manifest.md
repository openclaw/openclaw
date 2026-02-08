---
summary: "Plugin-manifest + JSON Schema-krav (streng konfigurationsvalidering)"
read_when:
  - Du bygger et OpenClaw-plugin
  - Du skal levere et plugin-konfigurationsskema eller fejlfinde plugin-valideringsfejl
title: "Plugin-manifest"
x-i18n:
  source_path: plugins/manifest.md
  source_hash: 234c7c0e77f22f5c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:29Z
---

# Plugin-manifest (openclaw.plugin.json)

Hvert plugin **skal** levere en `openclaw.plugin.json`-fil i **plugin-roden**.
OpenClaw bruger dette manifest til at validere konfiguration **uden at køre plugin-kode**.
Manglende eller ugyldige manifester behandles som plugin-fejl og blokerer
konfigurationsvalidering.

Se den fulde guide til pluginsystemet: [Plugins](/tools/plugin).

## Påkrævede felter

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

Påkrævede nøgler:

- `id` (string): kanonisk plugin-id.
- `configSchema` (object): JSON Schema for plugin-konfiguration (indlejret).

Valgfrie nøgler:

- `kind` (string): plugin-type (eksempel: `"memory"`).
- `channels` (array): kanal-id’er registreret af dette plugin (eksempel: `["matrix"]`).
- `providers` (array): udbyder-id’er registreret af dette plugin.
- `skills` (array): skill-mapper der skal indlæses (relativt til plugin-roden).
- `name` (string): visningsnavn for plugin’et.
- `description` (string): kort plugin-opsummering.
- `uiHints` (object): labels/placeholders/sensitive-flags for konfigurationsfelter til UI-rendering.
- `version` (string): plugin-version (informationsmæssig).

## Krav til JSON Schema

- **Hvert plugin skal levere et JSON Schema**, også selvom det ikke accepterer konfiguration.
- Et tomt skema er acceptabelt (for eksempel `{ "type": "object", "additionalProperties": false }`).
- Skemaer valideres ved læsning/skrivning af konfiguration, ikke ved runtime.

## Valideringsadfærd

- Ukendte `channels.*`-nøgler er **fejl**, medmindre kanal-id’et er deklareret af
  et plugin-manifest.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` og `plugins.slots.*`
  skal referere til **opdagelige** plugin-id’er. Ukendte id’er er **fejl**.
- Hvis et plugin er installeret, men har et defekt eller manglende manifest eller skema,
  fejler valideringen, og Doctor rapporterer plugin-fejlen.
- Hvis plugin-konfiguration findes, men plugin’et er **deaktiveret**, bevares konfigurationen,
  og der vises en **advarsel** i Doctor + logs.

## Noter

- Manifestet er **påkrævet for alle plugins**, inklusive lokale indlæsninger fra filsystemet.
- Runtime indlæser stadig plugin-modulet separat; manifestet er kun til
  discovery + validering.
- Hvis dit plugin afhænger af native moduler, skal du dokumentere build-trin og eventuelle
  krav til allowlist i pakkehåndteringen (for eksempel pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
