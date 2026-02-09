---
summary: "Endurecimiento de la lista de permitidos de Telegram: prefijo + normalización de espacios en blanco"
read_when:
  - Revisión de cambios históricos de la lista de permitidos de Telegram
title: "Endurecimiento de la lista de permitidos de Telegram"
---

# Endurecimiento de la lista de permitidos de Telegram

**Fecha**: 2026-01-05  
**Estado**: Completo  
**PR**: #216

## Resumen

Las listas de permitidos de Telegram ahora aceptan los prefijos `telegram:` y `tg:` sin distinguir mayúsculas y minúsculas, y toleran
espacios en blanco accidentales. Esto alinea las comprobaciones de la lista de permitidos entrante con la normalización de envío saliente.

## Qué cambió

- Los prefijos `telegram:` y `tg:` se tratan de la misma manera (sin distinguir mayúsculas y minúsculas).
- Las entradas de la lista de permitidos se recortan; las entradas vacías se ignoran.

## Ejemplos

Todos estos se aceptan para el mismo ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Por qué importa

Copiar y pegar desde registros o IDs de chat a menudo incluye prefijos y espacios en blanco. La normalización evita
falsos negativos al decidir si responder en mensajes directos o grupos.

## Documentación relacionada

- [Chats de grupo](/channels/groups)
- [Proveedor de Telegram](/channels/telegram)
