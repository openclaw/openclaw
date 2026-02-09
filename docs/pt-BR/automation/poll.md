---
summary: "Envio de enquetes via gateway + CLI"
read_when:
  - Adicionando ou modificando suporte a enquetes
  - Depurando envios de enquetes pela CLI ou gateway
title: "Enquetes"
---

# Enquetes

## Canais suportados

- WhatsApp (canal web)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Opções:

- `--channel`: `whatsapp` (padrão), `discord`, ou `msteams`
- `--poll-multi`: permite selecionar múltiplas opções
- `--poll-duration-hours`: apenas Discord (padrão 24 quando omitido)

## Gateway RPC

Método: `poll`

Parâmetros:

- `to` (string, obrigatório)
- `question` (string, obrigatório)
- `options` (string[], obrigatório)
- `maxSelections` (number, opcional)
- `durationHours` (number, opcional)
- `channel` (string, opcional, padrão: `whatsapp`)
- `idempotencyKey` (string, obrigatório)

## Diferenças entre canais

- WhatsApp: 2–12 opções, `maxSelections` deve estar dentro da contagem de opções, ignora `durationHours`.
- Discord: 2–10 opções, `durationHours` limitado a 1–768 horas (padrão 24). `maxSelections > 1` habilita seleção múltipla; o Discord não oferece suporte a uma contagem estrita de seleção.
- MS Teams: enquetes via Adaptive Card (gerenciadas pelo OpenClaw). Não há API nativa de enquetes; `durationHours` é ignorado.

## Ferramenta do agente (Mensagem)

Use a ferramenta `message` com a ação `poll` (`to`, `pollQuestion`, `pollOption`, `pollMulti` opcional, `pollDurationHours`, `channel`).

Nota: o Discord não tem modo de “escolher exatamente N”; `pollMulti` mapeia para seleção múltipla.
As enquetes do Teams são renderizadas como Adaptive Cards e exigem que o gateway permaneça online
para registrar votos em `~/.openclaw/msteams-polls.json`.
