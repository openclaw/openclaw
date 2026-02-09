---
summary: "Análise de localização de canais de entrada (Telegram + WhatsApp) e campos de contexto"
read_when:
  - Ao adicionar ou modificar a análise de localização de canais
  - Ao usar campos de contexto de localização em prompts ou ferramentas do agente
title: "Análise de localização de canais"
---

# Análise de localização de canais

O OpenClaw normaliza locais compartilhados de canais de chat em:

- texto legível por humanos anexado ao corpo de entrada, e
- campos estruturados no payload de contexto da resposta automática.

Atualmente suportado:

- **Telegram** (pins de localização + locais nomeados + localizações ao vivo)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` com `geo_uri`)

## Formatação de texto

As localizações são renderizadas como linhas amigáveis sem colchetes:

- Pin:
  - `📍 48.858844, 2.294351 ±12m`
- Local nomeado:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Compartilhamento ao vivo:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

Se o canal incluir uma legenda/comentário, ele é anexado na próxima linha:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Campos de contexto

Quando uma localização está presente, estes campos são adicionados a `ctx`:

- `LocationLat` (number)
- `LocationLon` (number)
- `LocationAccuracy` (number, metros; opcional)
- `LocationName` (string; opcional)
- `LocationAddress` (string; opcional)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolean)

## Notas por canal

- **Telegram**: locais nomeados mapeiam para `LocationName/LocationAddress`; localizações ao vivo usam `live_period`.
- **WhatsApp**: `locationMessage.comment` e `liveLocationMessage.caption` são anexados como a linha de legenda.
- **Matrix**: `geo_uri` é analisado como um pin de localização; a altitude é ignorada e `LocationIsLive` é sempre false.
