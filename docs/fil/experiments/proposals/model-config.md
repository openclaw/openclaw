---
summary: "Eksplorasyon: model config, mga auth profile, at fallback na pag-uugali"
read_when:
  - Pag-eeksplora ng mga ideya sa pagpili ng modelo sa hinaharap + mga auth profile
title: "Eksplorasyon ng Model Config"
---

# Model Config (Eksplorasyon)

This document captures **ideas** for future model configuration. It is not a
shipping spec. standalone CLI vs deep OpenClaw integration

- [Models](/concepts/models)
- [Model failover](/concepts/model-failover)
- [OAuth + profiles](/concepts/oauth)

## Motibasyon

Gusto ng mga operator ang:

- Maramihang auth profile bawat provider (personal vs work).
- Simpleng pagpili ng `/model` na may predictable na mga fallback.
- Malinaw na paghihiwalay sa pagitan ng mga text model at mga model na may kakayahang mag-image.

## Posibleng direksyon (high level)

- Panatilihing simple ang pagpili ng modelo: `provider/model` na may opsyonal na mga alias.
- Payagan ang mga provider na magkaroon ng maraming auth profile, na may malinaw na pagkakasunod-sunod.
- Gumamit ng global na listahan ng fallback upang ang lahat ng session ay mag-fail over nang pare-pareho.
- I-override lamang ang image routing kapag hayagang naka-configure.

## Mga bukas na tanong

- Dapat bang ang profile rotation ay per-provider o per-model?
- Paano dapat ipakita ng UI ang pagpili ng profile para sa isang session?
- Ano ang pinakaligtas na migration path mula sa mga legacy na config key?
