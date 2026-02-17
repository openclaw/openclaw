---
summary: "Endurecimiento de lista de permitidos de Telegram: normalización de prefijos + espacios en blanco"
read_when:
  - Revisando cambios históricos de lista de permitidos de Telegram
title: "Endurecimiento de Lista de Permitidos de Telegram"
---

# Endurecimiento de Lista de Permitidos de Telegram

**Fecha**: 2026-01-05  
**Estado**: Completo  
**PR**: #216

## Resumen

Las listas de permitidos de Telegram ahora aceptan los prefijos `telegram:` y `tg:` sin distinguir mayúsculas y minúsculas, y toleran espacios en blanco accidentales. Esto alinea las verificaciones de lista de permitidos entrantes con la normalización de envío saliente.

## Qué cambió

- Los prefijos `telegram:` y `tg:` se tratan igual (sin distinguir mayúsculas y minúsculas).
- Las entradas de la lista de permitidos se recortan; las entradas vacías se ignoran.

## Ejemplos

Todos estos se aceptan para el mismo ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Por qué importa

Copiar/pegar desde registros o IDs de chat a menudo incluye prefijos y espacios en blanco. La normalización evita falsos negativos al decidir si responder en Mensajes directos o grupos.

## Documentación relacionada

- [Chats grupales](/es-ES/channels/groups)
- [Proveedor de Telegram](/es-ES/channels/telegram)
