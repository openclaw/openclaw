---
summary: "Extensión de Chrome: permita que OpenClaw controle su pestaña de Chrome existente"
read_when:
  - Desea que el agente controle una pestaña de Chrome existente (botón de la barra de herramientas)
  - Necesita un Gateway remoto + automatización del navegador local vía Tailscale
  - Desea comprender las implicaciones de seguridad de la toma de control del navegador
title: "Extensión de Chrome"
---

# Extensión de Chrome (retransmisión del navegador)

La extensión de Chrome de OpenClaw permite que el agente controle sus **pestañas de Chrome existentes** (su ventana normal de Chrome) en lugar de iniciar un perfil de Chrome separado administrado por OpenClaw.

La conexión y desconexión se realizan mediante un **único botón en la barra de herramientas de Chrome**.

## Qué es (concepto)

Hay tres partes:

- **Servicio de control del navegador** (Gateway o nodo): la API que llama el agente/herramienta (a través del Gateway)
- **Servidor de retransmisión local** (CDP en loopback): puente entre el servidor de control y la extensión (`http://127.0.0.1:18792` por defecto)
- **Extensión de Chrome MV3**: se adjunta a la pestaña activa usando `chrome.debugger` y canaliza mensajes CDP a la retransmisión

Luego, OpenClaw controla la pestaña adjunta a través de la superficie normal de la herramienta `browser` (seleccionando el perfil correcto).

## Instalar / cargar (sin empaquetar)

1. Instale la extensión en una ruta local estable:

```bash
openclaw browser extension install
```

2. Imprima la ruta del directorio de la extensión instalada:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Habilite “Developer mode”
- “Load unpacked” → seleccione el directorio impreso arriba

4. Fije la extensión.

## Actualizaciones (sin paso de compilación)

La extensión se envía dentro de la versión de OpenClaw (paquete npm) como archivos estáticos. No hay un paso de “compilación” separado.

Después de actualizar OpenClaw:

- Vuelva a ejecutar `openclaw browser extension install` para actualizar los archivos instalados bajo su directorio de estado de OpenClaw.
- Chrome → `chrome://extensions` → haga clic en “Reload” en la extensión.

## Uso (sin configuración adicional)

OpenClaw incluye un perfil de navegador integrado llamado `chrome` que apunta a la retransmisión de la extensión en el puerto predeterminado.

Utilícelo:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Herramienta del agente: `browser` con `profile="chrome"`

Si desea un nombre diferente o un puerto de retransmisión distinto, cree su propio perfil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Adjuntar / separar (botón de la barra de herramientas)

- Abra la pestaña que desea que OpenClaw controle.
- Haga clic en el ícono de la extensión.
  - La insignia muestra `ON` cuando está adjunta.
- Haga clic de nuevo para separar.

## ¿Qué pestaña controla?

- **No** controla automáticamente “la pestaña que esté viendo”.
- Controla **solo la(s) pestaña(s) que usted adjunte explícitamente** haciendo clic en el botón de la barra de herramientas.
- Para cambiar: abra la otra pestaña y haga clic allí en el ícono de la extensión.

## Insignia + errores comunes

- `ON`: adjunta; OpenClaw puede controlar esa pestaña.
- `…`: conectándose a la retransmisión local.
- `!`: retransmisión no accesible (lo más común: el servidor de retransmisión del navegador no se está ejecutando en esta máquina).

Si ve `!`:

- Asegúrese de que el Gateway se esté ejecutando localmente (configuración predeterminada), o ejecute un host de nodo en esta máquina si el Gateway se ejecuta en otro lugar.
- Abra la página de Opciones de la extensión; muestra si la retransmisión es accesible.

## Gateway remoto (use un host de nodo)

### Gateway local (misma máquina que Chrome) — normalmente **sin pasos adicionales**

Si el Gateway se ejecuta en la misma máquina que Chrome, inicia el servicio de control del navegador en loopback
y arranca automáticamente el servidor de retransmisión. La extensión habla con la retransmisión local; las llamadas de la CLI/herramienta van al Gateway.

### Gateway remoto (el Gateway se ejecuta en otro lugar) — **ejecute un host de nodo**

Si su Gateway se ejecuta en otra máquina, inicie un host de nodo en la máquina que ejecuta Chrome.
El Gateway enviará por proxy las acciones del navegador a ese nodo; la extensión + la retransmisión permanecen locales a la máquina del navegador.

Si hay varios nodos conectados, fije uno con `gateway.nodes.browser.node` o configure `gateway.nodes.browser.mode`.

## Sandboxing (contenedores de herramientas)

Si su sesión de agente está en sandbox (`agents.defaults.sandbox.mode != "off"`), la herramienta `browser` puede estar restringida:

- De forma predeterminada, las sesiones en sandbox a menudo apuntan al **navegador del sandbox** (`target="sandbox"`), no a su Chrome del host.
- La toma de control mediante la retransmisión de la extensión de Chrome requiere controlar el servidor de control del navegador del **host**.

Opciones:

- Lo más sencillo: use la extensión desde una sesión/agente **no en sandbox**.
- O permita el control del navegador del host para sesiones en sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Luego asegúrese de que la herramienta no esté denegada por la política de herramientas y, si es necesario, llame a `browser` con `target="host"`.

Depuración: `openclaw sandbox explain`

## Consejos de acceso remoto

- Mantenga el Gateway y el host de nodo en la misma tailnet; evite exponer puertos de retransmisión a la LAN o a Internet público.
- Empareje nodos de forma intencional; deshabilite el enrutamiento de proxy del navegador si no desea control remoto (`gateway.nodes.browser.mode="off"`).

## Cómo funciona la “ruta de la extensión”

`openclaw browser extension path` imprime el directorio **instalado** en disco que contiene los archivos de la extensión.

La CLI intencionalmente **no** imprime una ruta `node_modules`. Ejecute siempre `openclaw browser extension install` primero para copiar la extensión a una ubicación estable bajo su directorio de estado de OpenClaw.

Si mueve o elimina ese directorio de instalación, Chrome marcará la extensión como dañada hasta que la recargue desde una ruta válida.

## Implicaciones de seguridad (léalo)

Esto es potente y riesgoso. Trátelo como dar al modelo “manos en su navegador”.

- La extensión usa la API de depuración de Chrome (`chrome.debugger`). Cuando está adjunta, el modelo puede:
  - hacer clic/escribir/navegar en esa pestaña
  - leer el contenido de la página
  - acceder a todo lo que la sesión iniciada de la pestaña pueda acceder
- **Esto no está aislado** como el perfil dedicado administrado por OpenClaw.
  - Si se adjunta a su perfil/pestaña de uso diario, está otorgando acceso a ese estado de cuenta.

Recomendaciones:

- Prefiera un perfil de Chrome dedicado (separado de su navegación personal) para el uso de la retransmisión por extensión.
- Mantenga el Gateway y cualquier host de nodo solo en la tailnet; confíe en la autenticación del Gateway + el emparejamiento de nodos.
- Evite exponer puertos de retransmisión en la LAN (`0.0.0.0`) y evite Funnel (público).
- La retransmisión bloquea orígenes que no sean la extensión y requiere un token de autenticación interno para clientes CDP.

Relacionado:

- Descripción general de la herramienta de navegador: [Browser](/tools/browser)
- Auditoría de seguridad: [Security](/gateway/security)
- Configuración de Tailscale: [Tailscale](/gateway/tailscale)
