---
summary: "Cuándo OpenClaw muestra indicadores de escritura y cómo ajustarlos"
read_when:
  - Cambiar el comportamiento o valores predeterminados del indicador de escritura
title: "Indicadores de Escritura"
---

# Indicadores de escritura

Los indicadores de escritura se envían al canal de chat mientras una ejecución está activa. Usa
`agents.defaults.typingMode` para controlar **cuándo** comienza la escritura y `typingIntervalSeconds`
para controlar **con qué frecuencia** se actualiza.

## Valores predeterminados

Cuando `agents.defaults.typingMode` **no está configurado**, OpenClaw mantiene el comportamiento heredado:

- **Chats directos**: la escritura comienza inmediatamente una vez que el bucle del modelo inicia.
- **Chats grupales con una mención**: la escritura comienza inmediatamente.
- **Chats grupales sin una mención**: la escritura comienza solo cuando el texto del mensaje comienza a transmitirse.
- **Ejecuciones de heartbeat**: la escritura está deshabilitada.

## Modos

Configura `agents.defaults.typingMode` a uno de:

- `never` — sin indicador de escritura, nunca.
- `instant` — comienza a escribir **tan pronto como el bucle del modelo inicia**, incluso si la ejecución
  luego devuelve solo el token de respuesta silenciosa.
- `thinking` — comienza a escribir en el **primer delta de razonamiento** (requiere
  `reasoningLevel: "stream"` para la ejecución).
- `message` — comienza a escribir en el **primer delta de texto no silencioso** (ignora
  el token silencioso `NO_REPLY`).

Orden de "qué tan temprano se activa":
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

Puedes sobrescribir el modo o la cadencia por sesión:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notas

- El modo `message` no mostrará escritura para respuestas solo silenciosas (ej. el token `NO_REPLY`
  usado para suprimir la salida).
- `thinking` solo se activa si la ejecución transmite razonamiento (`reasoningLevel: "stream"`).
  Si el modelo no emite deltas de razonamiento, la escritura no comenzará.
- Los heartbeats nunca muestran escritura, independientemente del modo.
- `typingIntervalSeconds` controla la **cadencia de actualización**, no el tiempo de inicio.
  El valor predeterminado es 6 segundos.
