---
summary: "Captura de cámara (nodo iOS + app macOS) para uso del agente: fotos (jpg) y clips de video cortos (mp4)"
read_when:
  - Al agregar o modificar la captura de cámara en nodos iOS o macOS
  - Al ampliar flujos de trabajo de archivos temporales MEDIA accesibles por el agente
title: "Captura de cámara"
---

# Captura de cámara (agente)

OpenClaw admite **captura de cámara** para flujos de trabajo del agente:

- **Nodo iOS** (emparejado vía Gateway): capturar una **foto** (`jpg`) o un **clip de video corto** (`mp4`, con audio opcional) mediante `node.invoke`.
- **Nodo Android** (emparejado vía Gateway): capturar una **foto** (`jpg`) o un **clip de video corto** (`mp4`, con audio opcional) mediante `node.invoke`.
- **App macOS** (nodo vía Gateway): capturar una **foto** (`jpg`) o un **clip de video corto** (`mp4`, con audio opcional) mediante `node.invoke`.

Todo el acceso a la cámara está protegido por **configuraciones controladas por el usuario**.

## Nodo iOS

### Configuración del usuario (activada por defecto)

- Pestaña de Ajustes de iOS → **Cámara** → **Permitir cámara** (`camera.enabled`)
  - Valor predeterminado: **activado** (una clave ausente se trata como habilitada).
  - Cuando está desactivado: los comandos `camera.*` devuelven `CAMERA_DISABLED`.

### Comandos (vía Gateway `node.invoke`)

- `camera.list`
  - Carga útil de la respuesta:
    - `devices`: arreglo de `{ id, name, position, deviceType }`

- `camera.snap`
  - Parámetros:
    - `facing`: `front|back` (predeterminado: `front`)
    - `maxWidth`: número (opcional; predeterminado `1600` en el nodo iOS)
    - `quality`: `0..1` (opcional; predeterminado `0.9`)
    - `format`: actualmente `jpg`
    - `delayMs`: número (opcional; predeterminado `0`)
    - `deviceId`: cadena (opcional; de `camera.list`)
  - Carga útil de la respuesta:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Protección de carga útil: las fotos se recomprimen para mantener la carga base64 por debajo de 5 MB.

- `camera.clip`
  - Parámetros:
    - `facing`: `front|back` (predeterminado: `front`)
    - `durationMs`: número (predeterminado `3000`, limitado a un máximo de `60000`)
    - `includeAudio`: booleano (predeterminado `true`)
    - `format`: actualmente `mp4`
    - `deviceId`: cadena (opcional; de `camera.list`)
  - Carga útil de la respuesta:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Requisito de primer plano

Al igual que `canvas.*`, el nodo iOS solo permite comandos `camera.*` en **primer plano**. Las invocaciones en segundo plano devuelven `NODE_BACKGROUND_UNAVAILABLE`.

### Ayudante de la CLI (archivos temporales + MEDIA)

La forma más sencilla de obtener adjuntos es mediante el ayudante de la CLI, que escribe los medios decodificados en un archivo temporal e imprime `MEDIA:<path>`.

Ejemplos:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Notas:

- `nodes camera snap` se establece de forma predeterminada en **ambas** orientaciones para dar al agente ambas vistas.
- Los archivos de salida son temporales (en el directorio temporal del sistema operativo) a menos que construya su propio envoltorio.

## Nodo Android

### Configuración del usuario en Android (activada por defecto)

- Hoja de Ajustes de Android → **Cámara** → **Permitir cámara** (`camera.enabled`)
  - Valor predeterminado: **activado** (una clave ausente se trata como habilitada).
  - Cuando está desactivado: los comandos `camera.*` devuelven `CAMERA_DISABLED`.

### Permisos

- Android requiere permisos en tiempo de ejecución:
  - `CAMERA` tanto para `camera.snap` como para `camera.clip`.
  - `RECORD_AUDIO` para `camera.clip` cuando `includeAudio=true`.

Si faltan permisos, la app solicitará cuando sea posible; si se deniegan, las solicitudes `camera.*` fallan con un
error `*_PERMISSION_REQUIRED`.

### Requisito de primer plano en Android

Al igual que `canvas.*`, el nodo Android solo permite comandos `camera.*` en **primer plano**. Las invocaciones en segundo plano devuelven `NODE_BACKGROUND_UNAVAILABLE`.

### Protección de carga útil

Las fotos se recomprimen para mantener la carga base64 por debajo de 5 MB.

## App macOS

### Configuración del usuario (desactivada por defecto)

La app complementaria de macOS expone una casilla:

- **Ajustes → General → Permitir cámara** (`openclaw.cameraEnabled`)
  - Valor predeterminado: **desactivado**
  - Cuando está desactivado: las solicitudes de cámara devuelven “Cámara deshabilitada por el usuario”.

### Ayudante de la CLI (invocación del nodo)

Use la CLI principal `openclaw` para invocar comandos de cámara en el nodo macOS.

Ejemplos:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

Notas:

- `openclaw nodes camera snap` se establece de forma predeterminada en `maxWidth=1600` salvo que se anule.
- En macOS, `camera.snap` espera `delayMs` (predeterminado 2000 ms) después de la preparación/estabilización de la exposición antes de capturar.
- Las cargas de fotos se recomprimen para mantener base64 por debajo de 5 MB.

## Seguridad + límites prácticos

- El acceso a la cámara y al micrófono activa los avisos habituales de permisos del SO (y requiere cadenas de uso en Info.plist).
- Los clips de video están limitados (actualmente `<= 60s`) para evitar cargas de nodo sobredimensionadas (sobrecarga base64 + límites de mensajes).

## Video de pantalla en macOS (nivel del SO)

Para video de _pantalla_ (no de cámara), use el complemento de macOS:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Notas:

- Requiere el permiso de macOS **Grabación de pantalla** (TCC).
