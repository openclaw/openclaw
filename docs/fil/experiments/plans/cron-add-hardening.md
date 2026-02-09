---
summary: "Patibayin ang paghawak ng input ng cron.add, i-align ang mga schema, at pahusayin ang cron UI/agent tooling"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Pagpapatibay ng Cron Add"
---

# Pagpapatibay ng Cron Add at Pag-align ng Schema

## Konteksto

Ipinahihiwatig nito na may hindi bababa sa isang client (malamang ang agent tool call path) na nagpapadala ng nakabalot o bahagyang tinukoy na mga job payload. This indicates that at least one client (likely the agent tool call path) is sending wrapped or partially specified job payloads. Ang mga Telegram allowlist ay tumatanggap na ngayon ng `telegram:` at `tg:` prefixes nang hindi sensitibo sa case, at tinatanggap ang
aksidenteng whitespace.

## Mga Layunin

- Itigil ang spam ng `cron.add` INVALID_REQUEST sa pamamagitan ng pag-normalize ng mga karaniwang wrapper payload at pag-infer ng nawawalang mga field ng `kind`.
- I-align ang mga listahan ng cron provider sa gateway schema, mga uri ng cron, docs ng CLI, at mga UI form.
- Gawing malinaw ang schema ng agent cron tool upang makagawa ang LLM ng tamang mga job payload.
- Ayusin ang pagpapakita ng bilang ng cron status job sa Control UI.
- Magdagdag ng mga test para saklawin ang normalization at gawi ng tool.

## Mga Hindi Layunin

- Baguhin ang semantika ng pag-iskedyul ng cron o ang gawi ng pagpapatupad ng job.
- Magdagdag ng mga bagong uri ng schedule o pag-parse ng cron expression.
- I-overhaul ang UI/UX para sa cron lampas sa mga kinakailangang pag-aayos ng field.

## Mga Natuklasan (kasalukuyang mga puwang)

- Ang `CronPayloadSchema` sa gateway ay hindi kasama ang `signal` + `imessage`, habang kasama ang mga ito sa TS types.
- Inaasahan ng Control UI CronStatus ang `jobCount`, ngunit ang gateway ay nagbabalik ng `jobs`.
- Pinapayagan ng schema ng agent cron tool ang arbitraryong mga object ng `job`, na nagbubukas ng daan sa mga maling input.
- Mahigpit na bina-validate ng gateway ang `cron.add` nang walang normalization, kaya bumabagsak ang mga nakabalot na payload.

## Ano ang Nagbago

- Ang `cron.add` at `cron.update` ay ngayon nagno-normalize ng mga karaniwang hugis ng wrapper at nag-iinfer ng nawawalang mga field ng `kind`.
- Ang schema ng agent cron tool ay tumutugma na sa gateway schema, na nagpapababa ng mga hindi valid na payload.
- Ang mga provider enum ay naka-align na sa gateway, CLI, UI, at macOS picker.
- Ginagamit ng Control UI ang field ng bilang ng `jobs` ng gateway para sa status.

## Kasalukuyang Gawi

- **Normalization:** ang mga nakabalot na payload ng `data`/`job` ay inaalis ang balot; ang `schedule.kind` at `payload.kind` ay ini-infer kapag ligtas.
- **Mga default:** inilalapat ang mga ligtas na default para sa `wakeMode` at `sessionTarget` kapag nawawala.
- **Mga provider:** ang Discord/Slack/Signal/iMessage ay ngayon pare-parehong ipinapakita sa CLI/UI.

Tingnan ang [Cron jobs](/automation/cron-jobs) para sa normalized na hugis at mga halimbawa.

## Beripikasyon

- Bantayan ang mga gateway log para sa pagbawas ng mga error na `cron.add` INVALID_REQUEST.
- Kumpirmahin na ipinapakita ng Control UI cron status ang bilang ng job pagkatapos mag-refresh.

## Opsyonal na Mga Follow-up

- Manu-manong Control UI smoke: magdagdag ng isang cron job bawat provider + beripikahin ang bilang ng job sa status.

## Mga Bukas na Tanong

- Dapat bang tanggapin ng `cron.add` ang tahasang `state` mula sa mga client (kasalukuyang hindi pinapayagan ng schema)?
- Dapat ba nating payagan ang `webchat` bilang isang tahasang delivery provider (kasalukuyang sinasala sa delivery resolution)?
