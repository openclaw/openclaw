---
summary: "Mahigpit na beripikasyon ng config + mga migration na para sa doctor lang"
read_when:
  - Nagdidisenyo o nagpapatupad ng behavior ng beripikasyon ng config
  - Gumagawa sa mga migration ng config o mga workflow ng doctor
  - Humahawak ng mga schema ng config ng plugin o gating ng pag-load ng plugin
title: "Mahigpit na Beripikasyon ng Config"
---

# Mahigpit na beripikasyon ng config (mga migration na para sa doctor lang)

## Mga layunin

- **Tanggihan ang mga hindi kilalang key ng config kahit saan** (root + nested).
- **Tanggihan ang config ng plugin na walang schema**; huwag i-load ang plugin na iyon.
- **Alisin ang legacy auto-migration sa pag-load**; ang mga migration ay tatakbo sa pamamagitan ng doctor lamang.
- **Awtomatikong patakbuhin ang doctor (dry-run) sa startup**; kung hindi wasto, harangin ang mga non-diagnostic na command.

## Hindi saklaw

- Backward compatibility sa pag-load (ang mga legacy key ay hindi awtomatikong mina-migrate).
- Tahimik na pag-drop ng mga hindi nakikilalang key.

## Mga tuntunin ng mahigpit na beripikasyon

- Dapat eksaktong tumugma ang config sa schema sa bawat antas.
- Ang mga hindi kilalang key ay mga error sa beripikasyon (walang passthrough sa root o nested).
- 47. `plugins.entries.<id>48. .config` ay dapat ma-validate ng schema ng plugin.
  - Kung walang schema ang isang plugin, **tanggihan ang pag-load ng plugin** at maglabas ng malinaw na error.
- 49. Ang mga hindi kilalang `channels.<id>50. ` key ay mga error maliban kung ang isang plugin manifest ay nagdedeklara ng channel id.
- Kinakailangan ang mga manifest ng plugin (`openclaw.plugin.json`) para sa lahat ng plugin.

## Pagpapatupad ng schema ng plugin

- Bawat plugin ay nagbibigay ng mahigpit na JSON Schema para sa config nito (inline sa manifest).
- Daloy ng pag-load ng plugin:
  1. I-resolve ang manifest ng plugin + schema (`openclaw.plugin.json`).
  2. I-validate ang config laban sa schema.
  3. Kung nawawala ang schema o hindi wasto ang config: harangin ang pag-load ng plugin, i-record ang error.
- Kasama sa mensahe ng error ang:
  - Plugin id
  - Dahilan (walang schema / hindi wastong config)
  - (Mga) path na bumagsak sa beripikasyon
- Ang mga disabled na plugin ay pinananatili ang kanilang config, ngunit ang Doctor + mga log ay maglalantad ng babala.

## Daloy ng Doctor

- Tumatakbo ang Doctor **sa bawat pagkakataon** na nilo-load ang config (dry-run bilang default).
- Kung hindi wasto ang config:
  - Mag-print ng buod + mga actionable na error.
  - Magbigay ng tagubilin: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Nag-a-apply ng mga migration.
  - Tinatanggal ang mga hindi kilalang key.
  - Isinusulat ang na-update na config.

## Gating ng command (kapag hindi wasto ang config)

Pinapayagan (diagnostic-only):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Everything else must hard-fail with: “Config invalid. Run `openclaw doctor --fix`.”

## Format ng Error UX

- Isang header ng buod.
- Mga seksyong naka-grupo:
  - Mga hindi kilalang key (buong mga path)
  - Mga legacy key / kinakailangang mga migration
  - Mga pagkabigo sa pag-load ng plugin (plugin id + dahilan + path)

## Mga touchpoint sa implementasyon

- `src/config/zod-schema.ts`: alisin ang root passthrough; mahigpit na mga object kahit saan.
- `src/config/zod-schema.providers.ts`: tiyakin ang mahigpit na mga channel schema.
- `src/config/validation.ts`: mag-fail sa mga hindi kilalang key; huwag mag-apply ng mga legacy migration.
- `src/config/io.ts`: alisin ang legacy auto-migrations; laging patakbuhin ang doctor dry-run.
- `src/config/legacy*.ts`: ilipat ang paggamit sa doctor lamang.
- `src/plugins/*`: magdagdag ng schema registry + gating.
- CLI command gating sa `src/cli`.

## Mga test

- Pagtanggi sa hindi kilalang key (root + nested).
- Nawawalang schema ng plugin → na-block ang pag-load ng plugin na may malinaw na error.
- Hindi wastong config → na-block ang startup ng Gateway maliban sa mga diagnostic na command.
- Doctor dry-run auto; isinusulat ng `doctor --fix` ang naitama na config.
