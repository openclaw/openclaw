---
summary: "Cuándo OpenClaw muestra indicadores de escritura y cómo ajustarlos"
read_when:
  - Cambiar el comportamiento o los valores predeterminados de los indicadores de escritura
title: "Indicadores de escritura"
---

# Indicadores de escritura

Los indicadores de escritura se envían al canal de chat mientras una ejecución está activa. Use
`agents.defaults.typingMode` para controlar **cuándo** comienza la escritura y `typingIntervalSeconds`
para controlar **con qué frecuencia** se actualiza.

## Valores predeterminados

Cuando `agents.defaults.typingMode` está **sin configurar**, OpenClaw mantiene el comportamiento heredado:

- **Chats directos**: la escritura comienza inmediatamente cuando inicia el bucle del modelo.
- **Chats grupales con una mención**: la escritura comienza inmediatamente.
- **Chats grupales sin una mención**: la escritura comienza solo cuando el texto del mensaje empieza a transmitirse.
- **Ejecuciones de heartbeat**: la escritura está deshabilitada.

## Modos

Configure `agents.defaults.typingMode` en uno de los siguientes:

- `never` — sin indicador de escritura, nunca.
- `instant` — comenzar a escribir **tan pronto como inicia el bucle del modelo**, incluso si la ejecución
  luego devuelve solo el token de respuesta silenciosa.
- `thinking` — comenzar a escribir en el **primer delta de razonamiento** (requiere
  `reasoningLevel: "stream"` para la ejecución).
- `message` — comenzar a escribir en el **primer delta de texto no silencioso** (ignora
  el token silencioso `NO_REPLY`).

Orden de “qué tan temprano se activa”:
`never` → `message` → `thinking` → `instant`

## Configuración

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Puede sobrescribir el modo o la cadencia por sesión:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notas

- El modo `message` no mostrará escritura para respuestas solo silenciosas (por ejemplo, el token `NO_REPLY`
  usado para suprimir la salida).
- `thinking` solo se activa si la ejecución transmite razonamiento (`reasoningLevel: "stream"`).
  Si el modelo no emite deltas de razonamiento, la escritura no comenzará.
- Los heartbeats nunca muestran escritura, independientemente del modo.
- `typingIntervalSeconds` controla la **cadencia de actualización**, no el momento de inicio.
  El valor predeterminado es 6 segundos.
