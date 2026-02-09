---
summary: "Manifest ng plugin + mga kinakailangan sa JSON schema (mahigpit na pag-validate ng config)"
read_when:
  - Gumagawa ka ng OpenClaw plugin
  - Kailangan mong mag-ship ng plugin config schema o mag-debug ng mga error sa pag-validate ng plugin
title: "Manifest ng Plugin"
---

# Plugin manifest (openclaw.plugin.json)

Bawat plugin **ay dapat** maglaman ng isang `openclaw.plugin.json` file sa **plugin root**.
OpenClaw uses this manifest to validate configuration **without executing plugin
code**. Ang nawawala o hindi valid na mga manifest ay itinuturing na mga error ng plugin at hinaharangan ang config validation.

Tingnan ang kumpletong gabay sa plugin system: [Plugins](/tools/plugin).

## Mga kinakailangang field

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

Mga kinakailangang key:

- `id` (string): canonical na plugin id.
- `configSchema` (object): JSON Schema para sa plugin config (inline).

Mga opsyonal na key:

- `kind` (string): uri ng plugin (halimbawa: `"memory"`).
- `channels` (array): mga channel id na nirehistro ng plugin na ito (halimbawa: `["matrix"]`).
- `providers` (array): mga provider id na nirehistro ng plugin na ito.
- `skills` (array): mga directory ng skill na ilo-load (relative sa plugin root).
- `name` (string): display name para sa plugin.
- `description` (string): maikling buod ng plugin.
- `uiHints` (object): mga label/placeholder/sensitive flag ng config field para sa UI rendering.
- `version` (string): bersyon ng plugin (impormasyonal).

## Mga kinakailangan sa JSON Schema

- **Bawat plugin ay dapat mag-ship ng JSON Schema**, kahit wala itong tinatanggap na config.
- Katanggap-tanggap ang isang empty schema (halimbawa, `{ "type": "object", "additionalProperties": false }`).
- Ang mga schema ay vini-validate sa oras ng pagbasa/pagsulat ng config, hindi sa runtime.

## Gawi ng pag-validate

- Ang mga hindi kilalang `channels.*` key ay **mga error**, maliban kung ang channel id ay idineklara ng
  isang plugin manifest.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, at `plugins.slots.*` ay dapat tumukoy sa **nadidiskubreng** mga plugin id. Ang mga hindi kilalang id ay **mga error**.
- Kung naka-install ang isang plugin ngunit may sira o nawawalang manifest o schema,
  babagsak ang validation at ire-report ng Doctor ang error ng plugin.
- Kung may umiiral na plugin config ngunit ang plugin ay **disabled**, pananatilihin ang config at
  maglalabas ng **babala** sa Doctor + logs.

## Mga tala

- Ang manifest ay **kinakailangan para sa lahat ng plugin**, kabilang ang mga local filesystem load.
- Hiwa-hiwalay pa ring nilo-load ng runtime ang plugin module; ang manifest ay para lamang sa
  discovery + validation.
- Kung ang plugin mo ay umaasa sa mga native module, idokumento ang mga hakbang sa build at anumang
  allowlist na kinakailangan ng package-manager (halimbawa, pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
