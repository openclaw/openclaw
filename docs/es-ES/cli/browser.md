---
summary: "Referencia CLI para `openclaw browser` (perfiles, pestañas, acciones, relé de extensión)"
read_when:
  - Usas `openclaw browser` y quieres ejemplos para tareas comunes
  - Quieres controlar un navegador ejecutándose en otra máquina a través de un host de nodo
  - Quieres usar el relé de extensión de Chrome (adjuntar/separar a través del botón de barra de herramientas)
title: "browser"
---

# `openclaw browser`

Gestionar el servidor de control de navegador de OpenClaw y ejecutar acciones de navegador (pestañas, instantáneas, capturas de pantalla, navegación, clics, escritura).

Relacionado:

- Herramienta de navegador + API: [Herramienta de navegador](/es-ES/tools/browser)
- Extensión de Chrome relé: [Extensión de Chrome](/es-ES/tools/chrome-extension)

## Banderas comunes

- `--url <gatewayWsUrl>`: URL WebSocket del Gateway (por defecto desde configuración).
- `--token <token>`: token del Gateway (si es requerido).
- `--timeout <ms>`: tiempo de espera de solicitud (ms).
- `--browser-profile <name>`: elegir un perfil de navegador (predeterminado desde configuración).
- `--json`: salida legible por máquina (donde esté soportado).

## Inicio rápido (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Perfiles

Los perfiles son configuraciones de enrutamiento de navegador nombradas. En la práctica:

- `openclaw`: lanza/adjunta a una instancia de Chrome dedicada gestionada por OpenClaw (directorio de datos de usuario aislado).
- `chrome`: controla tus pestañas existentes de Chrome a través del relé de extensión de Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Usar un perfil específico:

```bash
openclaw browser --browser-profile work tabs
```

## Pestañas

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Instantánea / captura de pantalla / acciones

Instantánea:

```bash
openclaw browser snapshot
```

Captura de pantalla:

```bash
openclaw browser screenshot
```

Navegar/clic/escribir (automatización de UI basada en ref):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hola"
```

## Relé de extensión de Chrome (adjuntar a través del botón de barra de herramientas)

Este modo permite que el agente controle una pestaña existente de Chrome que adjuntas manualmente (no se adjunta automáticamente).

Instalar la extensión sin empaquetar en una ruta estable:

```bash
openclaw browser extension install
openclaw browser extension path
```

Luego Chrome → `chrome://extensions` → habilitar "Modo de desarrollador" → "Cargar extensión sin empaquetar" → seleccionar la carpeta impresa.

Guía completa: [Extensión de Chrome](/es-ES/tools/chrome-extension)

## Control remoto de navegador (proxy de host de nodo)

Si el Gateway se ejecuta en una máquina diferente al navegador, ejecuta un **host de nodo** en la máquina que tiene Chrome/Brave/Edge/Chromium. El Gateway hará proxy de las acciones del navegador a ese nodo (no se requiere servidor de control de navegador separado).

Usa `gateway.nodes.browser.mode` para controlar el enrutamiento automático y `gateway.nodes.browser.node` para fijar un nodo específico si hay múltiples conectados.

Seguridad + configuración remota: [Herramienta de navegador](/es-ES/tools/browser), [Acceso remoto](/es-ES/gateway/remote), [Tailscale](/es-ES/gateway/tailscale), [Seguridad](/es-ES/gateway/security)
