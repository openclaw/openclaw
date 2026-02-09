---
summary: "Cómo funciona el sandboxing de OpenClaw: modos, alcances, acceso al workspace e imágenes"
title: Sandboxing
read_when: "Quiere una explicación dedicada del sandboxing o necesita ajustar agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw puede ejecutar **herramientas dentro de contenedores Docker** para reducir el radio de impacto.
Esto es **opcional** y está controlado por la configuración (`agents.defaults.sandbox` o
`agents.list[].sandbox`). Si el sandboxing está desactivado, las herramientas se ejecutan en el host.
El Gateway permanece en el host; la ejecución de herramientas se realiza en un sandbox aislado
cuando está habilitado.

Esto no es un límite de seguridad perfecto, pero limita de forma material el acceso al sistema de archivos
y a los procesos cuando el modelo hace algo indebido.

## Qué se sandboxea

- Ejecución de herramientas (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.).
- Navegador opcional en sandbox (`agents.defaults.sandbox.browser`).
  - De forma predeterminada, el navegador del sandbox se inicia automáticamente (asegura que CDP sea accesible) cuando la herramienta de navegador lo necesita.
    Configure mediante `agents.defaults.sandbox.browser.autoStart` y `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` permite que las sesiones en sandbox apunten explícitamente al navegador del host.
  - Las allowlists opcionales controlan `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

No se sandboxea:

- El propio proceso del Gateway.
- Cualquier herramienta permitida explícitamente para ejecutarse en el host (por ejemplo, `tools.elevated`).
  - **La ejecución elevada se ejecuta en el host y omite el sandboxing.**
  - Si el sandboxing está desactivado, `tools.elevated` no cambia la ejecución (ya está en el host). Consulte [Elevated Mode](/tools/elevated).

## Modos

`agents.defaults.sandbox.mode` controla **cuándo** se utiliza el sandboxing:

- `"off"`: sin sandboxing.
- `"non-main"`: sandbox solo para sesiones **no principales** (valor predeterminado si quiere chats normales en el host).
- `"all"`: cada sesión se ejecuta en un sandbox.
  Nota: `"non-main"` se basa en `session.mainKey` (valor predeterminado `"main"`), no en el id del agente.
  Las sesiones de grupo/canal usan sus propias claves, por lo que cuentan como no principales y se sandboxean.

## Alcance

`agents.defaults.sandbox.scope` controla **cuántos contenedores** se crean:

- `"session"` (predeterminado): un contenedor por sesión.
- `"agent"`: un contenedor por agente.
- `"shared"`: un contenedor compartido por todas las sesiones en sandbox.

## Acceso al workspace

`agents.defaults.sandbox.workspaceAccess` controla **qué puede ver el sandbox**:

- `"none"` (predeterminado): las herramientas ven un workspace del sandbox bajo `~/.openclaw/sandboxes`.
- `"ro"`: monta el workspace del agente en solo lectura en `/agent` (deshabilita `write`/`edit`/`apply_patch`).
- `"rw"`: monta el workspace del agente en lectura/escritura en `/workspace`.

Los medios entrantes se copian en el workspace activo del sandbox (`media/inbound/*`).
Nota de Skills: la herramienta `read` está enraizada en el sandbox. Con `workspaceAccess: "none"`,
OpenClaw refleja las skills elegibles en el workspace del sandbox (`.../skills`) para
que puedan leerse. Con `"rw"`, las skills del workspace son legibles desde
`/workspace/skills`.

## Montajes bind personalizados

`agents.defaults.sandbox.docker.binds` monta directorios adicionales del host dentro del contenedor.
Formato: `host:container:mode` (por ejemplo, `"/home/user/source:/source:rw"`).

Los binds globales y por agente se **fusionan** (no se reemplazan). Bajo `scope: "shared"`, los binds por agente se ignoran.

Ejemplo (origen de solo lectura + socket de Docker):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Notas de seguridad:

- Los binds omiten el sistema de archivos del sandbox: exponen rutas del host con el modo que usted establezca (`:ro` o `:rw`).
- Los montajes sensibles (por ejemplo, `docker.sock`, secretos, claves SSH) deben ser `:ro` salvo que sea absolutamente necesario.
- Combine con `workspaceAccess: "ro"` si solo necesita acceso de lectura al workspace; los modos de bind permanecen independientes.
- Consulte [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) para saber cómo interactúan los binds con la política de herramientas y la ejecución elevada.

## Imágenes + configuración

Imagen predeterminada: `openclaw-sandbox:bookworm-slim`

Constrúyala una vez:

```bash
scripts/sandbox-setup.sh
```

Nota: la imagen predeterminada **no** incluye Node. Si una skill necesita Node (u
otros runtimes), hornee una imagen personalizada o instale mediante
`sandbox.docker.setupCommand` (requiere egreso de red + raíz escribible +
usuario root).

Imagen del navegador en sandbox:

```bash
scripts/sandbox-browser-setup.sh
```

De forma predeterminada, los contenedores del sandbox se ejecutan **sin red**.
Anule esto con `agents.defaults.sandbox.docker.network`.

Las instalaciones de Docker y el Gateway en contenedores viven aquí:
[Docker](/install/docker)

## setupCommand (configuración única del contenedor)

`setupCommand` se ejecuta **una vez** después de que se crea el contenedor del sandbox (no en cada ejecución).
Se ejecuta dentro del contenedor mediante `sh -lc`.

Rutas:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Por agente: `agents.list[].sandbox.docker.setupCommand`

Problemas comunes:

- El valor predeterminado de `docker.network` es `"none"` (sin egreso), por lo que las instalaciones de paquetes fallarán.
- `readOnlyRoot: true` impide escrituras; establezca `readOnlyRoot: false` o hornee una imagen personalizada.
- `user` debe ser root para instalaciones de paquetes (omita `user` o establezca `user: "0:0"`).
- La ejecución en sandbox **no** hereda las `process.env` del host. Use
  `agents.defaults.sandbox.docker.env` (o una imagen personalizada) para las claves de API de skills.

## Política de herramientas + vías de escape

Las políticas de permitir/denegar herramientas siguen aplicándose antes de las reglas del sandbox. Si una herramienta está denegada
globalmente o por agente, el sandboxing no la restablece.

`tools.elevated` es una vía de escape explícita que ejecuta `exec` en el host.
Las directivas `/exec` solo se aplican a remitentes autorizados y persisten por sesión; para deshabilitar de forma estricta
`exec`, use la denegación en la política de herramientas (consulte [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Depuración:

- Use `openclaw sandbox explain` para inspeccionar el modo efectivo del sandbox, la política de herramientas y las claves de configuración de corrección.
- Consulte [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) para el modelo mental de “¿por qué esto está bloqueado?”.
  Manténgalo bloqueado.

## Anulaciones multi‑agente

Cada agente puede anular sandbox + herramientas:
`agents.list[].sandbox` y `agents.list[].tools` (además de `agents.list[].tools.sandbox.tools` para la política de herramientas del sandbox).
Consulte [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para la precedencia.

## Ejemplo mínimo de habilitación

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Documentos relacionados

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
