---
summary: "Ventana de contexto + compactación: cómo OpenClaw mantiene las sesiones dentro de los límites del modelo"
read_when:
  - Quiere entender la compactación automática y /compact
  - Está depurando sesiones largas que alcanzan los límites de contexto
title: "Compactación"
---

# Ventana de contexto y compactación

Cada modelo tiene una **ventana de contexto** (máximo de tokens que puede ver). Los chats de larga duración acumulan mensajes y resultados de herramientas; cuando la ventana se estrecha, OpenClaw **compacta** el historial más antiguo para mantenerse dentro de los límites.

## Qué es la compactación

La compactación **resume conversaciones más antiguas** en una entrada de resumen compacta y mantiene intactos los mensajes recientes. El resumen se almacena en el historial de la sesión, por lo que las solicitudes futuras usan:

- El resumen de la compactación
- Mensajes recientes posteriores al punto de compactación

La compactación **persiste** en el historial JSONL de la sesión.

## Configuración

Consulte [Configuración y modos de compactación](/concepts/compaction) para los ajustes `agents.defaults.compaction`.

## Compactación automática (activada por defecto)

Cuando una sesión se acerca o supera la ventana de contexto del modelo, OpenClaw activa la compactación automática y puede reintentar la solicitud original usando el contexto compactado.

Verá:

- `🧹 Auto-compaction complete` en modo detallado
- `/status` mostrando `🧹 Compactions: <count>`

Antes de la compactación, OpenClaw puede ejecutar un turno **silencioso de vaciado de memoria** para almacenar notas duraderas en disco. Consulte [Memoria](/concepts/memory) para obtener detalles y configuración.

## Compactación manual

Use `/compact` (opcionalmente con instrucciones) para forzar un paso de compactación:

```
/compact Focus on decisions and open questions
```

## Fuente de la ventana de contexto

La ventana de contexto es específica del modelo. OpenClaw utiliza la definición del modelo del catálogo del proveedor configurado para determinar los límites.

## Compactación vs poda

- **Compactación**: resume y **persiste** en JSONL.
- **Poda de sesión**: recorta solo **resultados de herramientas**, **en memoria**, por solicitud.

Consulte [/concepts/session-pruning](/concepts/session-pruning) para obtener detalles sobre la poda.

## Consejos

- Use `/compact` cuando las sesiones se sientan obsoletas o el contexto esté inflado.
- Las salidas grandes de herramientas ya se truncan; la poda puede reducir aún más la acumulación de resultados de herramientas.
- Si necesita empezar desde cero, `/new` o `/reset` inicia un nuevo id de sesión.
