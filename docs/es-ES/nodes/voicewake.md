---
summary: "Palabras de activación de voz globales (propiedad del Gateway) y cómo se sincronizan entre nodos"
read_when:
  - Cambiar comportamiento de palabras de activación de voz o predeterminados
  - Agregar nuevas plataformas de nodo que necesiten sincronización de palabras de activación
title: "Activación por Voz"
---

# Activación por Voz (Palabras de activación globales)

OpenClaw trata las **palabras de activación como una única lista global** propiedad del **Gateway**.

- **No hay palabras de activación personalizadas por nodo**.
- **Cualquier interfaz de nodo/aplicación puede editar** la lista; los cambios son persistidos por el Gateway y transmitidos a todos.
- Cada dispositivo aún mantiene su propio **interruptor de habilitado/deshabilitado de Activación por Voz** (la UX local + permisos difieren).

## Almacenamiento (host del Gateway)

Las palabras de activación se almacenan en la máquina del gateway en:

- `~/.openclaw/settings/voicewake.json`

Forma:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protocolo

### Métodos

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` con parámetros `{ triggers: string[] }` → `{ triggers: string[] }`

Notas:

- Los disparadores se normalizan (recortados, vacíos eliminados). Las listas vacías recurren a los predeterminados.
- Se aplican límites por seguridad (límites de conteo/longitud).

### Eventos

- `voicewake.changed` carga útil `{ triggers: string[] }`

Quién lo recibe:

- Todos los clientes WebSocket (aplicación macOS, WebChat, etc.)
- Todos los nodos conectados (iOS/Android), y también en la conexión del nodo como un envío inicial de "estado actual".

## Comportamiento del cliente

### Aplicación macOS

- Usa la lista global para controlar los disparadores de `VoiceWakeRuntime`.
- Editar "Palabras de activación" en la configuración de Activación por Voz llama a `voicewake.set` y luego confía en la transmisión para mantener sincronizados otros clientes.

### Nodo iOS

- Usa la lista global para la detección de disparadores de `VoiceWakeManager`.
- Editar Palabras de activación en Configuración llama a `voicewake.set` (sobre el WS del Gateway) y también mantiene la detección de palabras de activación local receptiva.

### Nodo Android

- Expone un editor de Palabras de activación en Configuración.
- Llama a `voicewake.set` sobre el WS del Gateway para que las ediciones se sincronicen en todas partes.
