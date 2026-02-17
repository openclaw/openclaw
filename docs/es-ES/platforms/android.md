---
summary: "Aplicación Android (nodo): manual de conexión + Canvas/Chat/Cámara"
read_when:
  - Emparejando o reconectando el nodo Android
  - Depurando descubrimiento de gateway o autenticación Android
  - Verificando paridad de historial de chat entre clientes
title: "Aplicación Android"
---

# Aplicación Android (Nodo)

## Instantánea de soporte

- Rol: aplicación de nodo complementaria (Android no aloja el Gateway).
- Gateway requerido: sí (ejecútalo en macOS, Linux, o Windows vía WSL2).
- Instalación: [Primeros Pasos](/es-ES/start/getting-started) + [Emparejamiento](/es-ES/gateway/pairing).
- Gateway: [Manual](/es-ES/gateway) + [Configuración](/es-ES/gateway/configuration).
  - Protocolos: [Protocolo del Gateway](/es-ES/gateway/protocol) (nodos + plano de control).

## Control del sistema

El control del sistema (launchd/systemd) vive en el host del Gateway. Ver [Gateway](/es-ES/gateway).

## Manual de Conexión

Aplicación de nodo Android ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android se conecta directamente al WebSocket del Gateway (predeterminado `ws://<host>:18789`) y usa el emparejamiento propiedad del Gateway.

### Requisitos previos

- Puedes ejecutar el Gateway en la máquina "maestra".
- El dispositivo/emulador Android puede alcanzar el WebSocket del gateway:
  - Misma LAN con mDNS/NSD, **o**
  - Misma tailnet de Tailscale usando Bonjour de Área Amplia / DNS-SD unicast (ver abajo), **o**
  - Host/puerto del gateway manual (respaldo)
- Puedes ejecutar el CLI (`openclaw`) en la máquina gateway (o vía SSH).

### 1) Inicia el Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Confirma en los registros que ves algo como:

- `listening on ws://0.0.0.0:18789`

Para configuraciones solo de tailnet (recomendado para Vienna ⇄ Londres), vincula el gateway a la IP de tailnet:

- Establece `gateway.bind: "tailnet"` en `~/.openclaw/openclaw.json` en el host del gateway.
- Reinicia el Gateway / aplicación de barra de menús de macOS.

### 2) Verifica el descubrimiento (opcional)

Desde la máquina gateway:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Más notas de depuración: [Bonjour](/es-ES/gateway/bonjour).

#### Descubrimiento en Tailnet (Vienna ⇄ Londres) vía DNS-SD unicast

El descubrimiento NSD/mDNS de Android no cruzará redes. Si tu nodo Android y el gateway están en diferentes redes pero conectados vía Tailscale, usa Bonjour de Área Amplia / DNS-SD unicast en su lugar:

1. Configura una zona DNS-SD (ejemplo `openclaw.internal.`) en el host del gateway y publica registros `_openclaw-gw._tcp`.
2. Configura DNS dividido de Tailscale para tu dominio elegido apuntando a ese servidor DNS.

Detalles y ejemplo de configuración CoreDNS: [Bonjour](/es-ES/gateway/bonjour).

### 3) Conectar desde Android

En la aplicación Android:

- La aplicación mantiene su conexión al gateway viva vía un **servicio en primer plano** (notificación persistente).
- Abre **Configuración**.
- En **Gateways Descubiertos**, selecciona tu gateway y pulsa **Conectar**.
- Si mDNS está bloqueado, usa **Avanzado → Gateway Manual** (host + puerto) y **Conectar (Manual)**.

Después del primer emparejamiento exitoso, Android se reconecta automáticamente al lanzar:

- Endpoint manual (si está habilitado), de lo contrario
- El último gateway descubierto (mejor esfuerzo).

### 4) Aprobar emparejamiento (CLI)

En la máquina gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Detalles de emparejamiento: [Emparejamiento del Gateway](/es-ES/gateway/pairing).

### 5) Verifica que el nodo esté conectado

- Vía estado de nodos:

  ```bash
  openclaw nodes status
  ```

- Vía Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) Chat + historial

La hoja de Chat del nodo Android usa la **clave de sesión primaria** del gateway (`main`), por lo que el historial y las respuestas se comparten con WebChat y otros clientes:

- Historial: `chat.history`
- Enviar: `chat.send`
- Actualizaciones push (mejor esfuerzo): `chat.subscribe` → `event:"chat"`

### 7) Lienzo + cámara

#### Host de Lienzo del Gateway (recomendado para contenido web)

Si quieres que el nodo muestre HTML/CSS/JS real que el agente pueda editar en disco, apunta el nodo al host de lienzo del Gateway.

Nota: los nodos cargan el lienzo desde el servidor HTTP del Gateway (mismo puerto que `gateway.port`, predeterminado `18789`).

1. Crea `~/.openclaw/workspace/canvas/index.html` en el host del gateway.

2. Navega el nodo a él (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet (opcional): si ambos dispositivos están en Tailscale, usa un nombre MagicDNS o IP de tailnet en lugar de `.local`, ej. `http://<gateway-magicdns>:18789/__openclaw__/canvas/`.

Este servidor inyecta un cliente de recarga en vivo en HTML y recarga con cambios de archivos.
El host A2UI vive en `http://<gateway-host>:18789/__openclaw__/a2ui/`.

Comandos de lienzo (solo en primer plano):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (usa `{"url":""}` o `{"url":"/"}` para regresar al andamio predeterminado). `canvas.snapshot` retorna `{ format, base64 }` (predeterminado `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (alias legado `canvas.a2ui.pushJSONL`)

Comandos de cámara (solo en primer plano; protegido por permisos):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Ver [Nodo de cámara](/es-ES/nodes/camera) para parámetros y ayudantes CLI.
