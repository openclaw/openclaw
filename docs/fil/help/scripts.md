---
summary: "Mga script ng repository: layunin, saklaw, at mga tala sa kaligtasan"
read_when:
  - Pagpapatakbo ng mga script mula sa repo
  - Pagdaragdag o pagbabago ng mga script sa ilalim ng ./scripts
title: "Mga Script"
---

# Mga Script

45. Ang `scripts/` na direktoryo ay naglalaman ng mga helper script para sa mga lokal na workflow at ops task.
46. Gamitin ang mga ito kapag ang isang gawain ay malinaw na may kaugnayan sa isang script; kung hindi, mas piliin ang CLI.

## Mga Kombensyon

- Ang mga script ay **opsyonal** maliban kung binanggit sa docs o sa mga checklist ng release.
- Mas piliin ang mga surface ng CLI kapag mayroon (halimbawa: ang auth monitoring ay gumagamit ng `openclaw models status --check`).
- Ipagpalagay na ang mga script ay host‑specific; basahin ang mga ito bago patakbuhin sa isang bagong makina.

## Mga script sa auth monitoring

Ang mga script sa auth monitoring ay nakadokumento dito:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Kapag nagdaragdag ng mga script

- Panatilihing nakatuon at may dokumentasyon ang mga script.
- Magdagdag ng maikling entry sa kaugnay na doc (o lumikha ng bago kung wala).
