---
summary: "Palabras de activación por voz globales (propiedad del Gateway) y cómo se sincronizan entre nodos"
read_when:
  - Al cambiar el comportamiento o los valores predeterminados de las palabras de activación por voz
  - Al agregar nuevas plataformas de nodos que necesitan sincronización de palabras de activación
title: "Activación por voz"
---

# Activación por voz (Palabras de activación globales)

OpenClaw trata las **palabras de activación como una única lista global** propiedad del **Gateway**.

- **No hay palabras de activación personalizadas por nodo**.
- **Cualquier UI de nodo/app puede editar** la lista; los cambios se persisten en el Gateway y se difunden a todos.
- Cada dispositivo mantiene su propio interruptor de **Activación por voz habilitada/deshabilitada** (la UX local y los permisos difieren).

## Almacenamiento (host del Gateway)

Las palabras de activación se almacenan en la máquina del Gateway en:

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

- Los disparadores se normalizan (se recortan, se descartan los vacíos). Las listas vacías vuelven a los valores predeterminados.
- Se aplican límites por seguridad (topes de cantidad/longitud).

### Eventos

- `voicewake.changed` carga útil `{ triggers: string[] }`

Quién lo recibe:

- Todos los clientes WebSocket (app de macOS, WebChat, etc.).
- Todos los nodos conectados (iOS/Android), y también al conectar un nodo como un envío inicial del “estado actual”.

## Comportamiento del cliente

### app de macOS

- Usa la lista global para filtrar disparadores de `VoiceWakeRuntime`.
- Editar “Palabras de activación” en los ajustes de Activación por voz llama a `voicewake.set` y luego se apoya en la difusión para mantener sincronizados a los demás clientes.

### nodo iOS

- Usa la lista global para la detección de disparadores de `VoiceWakeManager`.
- Editar Palabras de activación en Ajustes llama a `voicewake.set` (sobre el WS del Gateway) y también mantiene receptiva la detección local de palabras de activación.

### nodo Android

- Expone un editor de Palabras de activación en Ajustes.
- Llama a `voicewake.set` sobre el WS del Gateway para que las ediciones se sincronicen en todas partes.
