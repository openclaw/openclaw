---
summary: "Referencia de la CLI para `openclaw browser` (perfiles, pestañas, acciones, relay de la extensión)"
read_when:
  - Usted usa `openclaw browser` y quiere ejemplos para tareas comunes
  - Usted quiere controlar un navegador que se ejecuta en otra máquina mediante un host de nodo
  - Usted quiere usar el relay de la extensión de Chrome (adjuntar/desadjuntar mediante el botón de la barra de herramientas)
title: "navegador"
---

# `openclaw browser`

Administre el servidor de control del navegador de OpenClaw y ejecute acciones del navegador (pestañas, instantáneas, capturas de pantalla, navegación, clics, escritura).

Relacionado:

- Herramienta y API del navegador: [Browser tool](/tools/browser)
- Relay de la extensión de Chrome: [Chrome extension](/tools/chrome-extension)

## Indicadores comunes

- `--url <gatewayWsUrl>`: URL de WebSocket del Gateway (predeterminado desde la configuración).
- `--token <token>`: token del Gateway (si es necesario).
- `--timeout <ms>`: tiempo de espera de la solicitud (ms).
- `--browser-profile <name>`: elija un perfil de navegador (predeterminado desde la configuración).
- `--json`: salida legible por máquina (donde sea compatible).

## Inicio rápido (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Perfiles

Los perfiles son configuraciones con nombre para el enrutamiento del navegador. En la práctica:

- `openclaw`: inicia/se adjunta a una instancia de Chrome dedicada y administrada por OpenClaw (directorio de datos de usuario aislado).
- `chrome`: controla sus pestañas existentes de Chrome mediante el relay de la extensión de Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Use un perfil específico:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Instantánea / captura de pantalla / acciones

Snapshot:

```bash
openclaw browser snapshot
```

Captura de pantalla:

```bash
openclaw browser screenshot
```

Navegar/hacer clic/escribir (automatización de la IU basada en referencias):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Relay de la extensión de Chrome (adjuntar mediante el botón de la barra de herramientas)

Este modo permite que el agente controle una pestaña existente de Chrome que usted adjunta manualmente (no se adjunta automáticamente).

Instale la extensión desempaquetada en una ruta estable:

```bash
openclaw browser extension install
openclaw browser extension path
```

Luego Chrome → `chrome://extensions` → habilite “Developer mode” → “Load unpacked” → seleccione la carpeta impresa.

Guía completa: [Chrome extension](/tools/chrome-extension)

## Control remoto del navegador (proxy del host de nodo)

Si el Gateway se ejecuta en una máquina diferente a la del navegador, ejecute un **host de nodo** en la máquina que tiene Chrome/Brave/Edge/Chromium. El Gateway hará de proxy de las acciones del navegador hacia ese nodo (no se requiere un servidor de control del navegador separado).

Use `gateway.nodes.browser.mode` para controlar el enrutamiento automático y `gateway.nodes.browser.node` para fijar un nodo específico si hay varios conectados.

Seguridad + configuración remota: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
