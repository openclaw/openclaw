---
summary: "Cómo funciona el sandboxing de OpenClaw: modos, alcances, acceso al workspace e imágenes"
title: Sandboxing
read_when: "Quieres una explicación dedicada del sandboxing o necesitas ajustar agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw puede ejecutar **herramientas dentro de contenedores Docker** para reducir el radio de explosión.
Esto es **opcional** y se controla mediante configuración (`agents.defaults.sandbox` o
`agents.list[].sandbox`). Si el sandboxing está desactivado, las herramientas se ejecutan en el host.
El Gateway permanece en el host; la ejecución de herramientas se ejecuta en un sandbox aislado
cuando está habilitado.

Esto no es un límite de seguridad perfecto, pero limita materialmente el acceso al sistema de archivos
y los procesos cuando el modelo hace algo tonto.

## Qué se pone en sandbox

- Ejecución de herramientas (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.).
- Navegador opcional en sandbox (`agents.defaults.sandbox.browser`).
  - Por defecto, el navegador del sandbox se inicia automáticamente (asegura que CDP sea alcanzable) cuando la herramienta del navegador lo necesita.
    Configura a través de `agents.defaults.sandbox.browser.autoStart` y `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` permite que las sesiones en sandbox apunten al navegador del host explícitamente.
  - Las listas de permitidos opcionales controlan `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

No se pone en sandbox:

- El proceso Gateway en sí.
- Cualquier herramienta explícitamente permitida para ejecutarse en el host (ej. `tools.elevated`).
  - **El exec elevado se ejecuta en el host y evita el sandboxing.**
  - Si el sandboxing está desactivado, `tools.elevated` no cambia la ejecución (ya en el host). Ver [Modo Elevated](/es-ES/tools/elevated).

## Modos

`agents.defaults.sandbox.mode` controla **cuándo** se usa el sandboxing:

- `"off"`: sin sandboxing.
- `"non-main"`: sandbox solo sesiones **no-main** (predeterminado si quieres chats normales en el host).
- `"all"`: cada sesión se ejecuta en un sandbox.
  Nota: `"non-main"` se basa en `session.mainKey` (predeterminado `"main"`), no en el id del agente.
  Las sesiones de grupo/canal usan sus propias claves, por lo que cuentan como no-main y estarán en sandbox.

## Alcance

`agents.defaults.sandbox.scope` controla **cuántos contenedores** se crean:

- `"session"` (predeterminado): un contenedor por sesión.
- `"agent"`: un contenedor por agente.
- `"shared"`: un contenedor compartido por todas las sesiones en sandbox.

## Acceso al workspace

`agents.defaults.sandbox.workspaceAccess` controla **qué puede ver el sandbox**:

- `"none"` (predeterminado): las herramientas ven un workspace de sandbox bajo `~/.openclaw/sandboxes`.
- `"ro"`: monta el workspace del agente de solo lectura en `/agent` (deshabilita `write`/`edit`/`apply_patch`).
- `"rw"`: monta el workspace del agente lectura/escritura en `/workspace`.

Los medios entrantes se copian en el workspace del sandbox activo (`media/inbound/*`).
Nota de habilidades: la herramienta `read` está enraizada en el sandbox. Con `workspaceAccess: "none"`,
OpenClaw refleja las habilidades elegibles en el workspace del sandbox (`.../skills`) para
que puedan ser leídas. Con `"rw"`, las habilidades del workspace son legibles desde
`/workspace/skills`.

## Montajes bind personalizados

`agents.defaults.sandbox.docker.binds` monta directorios de host adicionales en el contenedor.
Formato: `host:container:mode` (ej., `"/home/user/source:/source:rw"`).

Los binds globales y por agente se **fusionan** (no se reemplazan). Bajo `scope: "shared"`, los binds por agente se ignoran.

`agents.defaults.sandbox.browser.binds` monta directorios de host adicionales en el contenedor del **navegador del sandbox** solamente.

- Cuando se establece (incluyendo `[]`), reemplaza `agents.defaults.sandbox.docker.binds` para el contenedor del navegador.
- Cuando se omite, el contenedor del navegador recurre a `agents.defaults.sandbox.docker.binds` (compatible hacia atrás).

Ejemplo (fuente de solo lectura + un directorio de datos extra):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/data/myapp:/data:ro"],
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

- Los binds evitan el sistema de archivos del sandbox: exponen rutas del host con el modo que establezcas (`:ro` o `:rw`).
- OpenClaw bloquea fuentes de bind peligrosas (por ejemplo: `docker.sock`, `/etc`, `/proc`, `/sys`, `/dev`, y montajes padre que los expondrían).
- Los montajes sensibles (secretos, claves SSH, credenciales de servicio) deben ser `:ro` a menos que sea absolutamente necesario.
- Combina con `workspaceAccess: "ro"` si solo necesitas acceso de lectura al workspace; los modos de bind permanecen independientes.
- Ver [Sandbox vs Política de Herramientas vs Elevated](/es-ES/gateway/sandbox-vs-tool-policy-vs-elevated) para cómo los binds interactúan con la política de herramientas y el exec elevado.

## Imágenes + configuración

Imagen predeterminada: `openclaw-sandbox:bookworm-slim`

Compílala una vez:

```bash
scripts/sandbox-setup.sh
```

Nota: la imagen predeterminada **no** incluye Node. Si una habilidad necesita Node (u
otros runtimes), hornea una imagen personalizada o instala a través de
`sandbox.docker.setupCommand` (requiere salida de red + root escribible +
usuario root).

Imagen del navegador en sandbox:

```bash
scripts/sandbox-browser-setup.sh
```

Por defecto, los contenedores sandbox se ejecutan **sin red**.
Anula con `agents.defaults.sandbox.docker.network`.

Las instalaciones de Docker y el gateway contenedorizado viven aquí:
[Docker](/es-ES/install/docker)

## setupCommand (configuración única del contenedor)

`setupCommand` se ejecuta **una vez** después de que se crea el contenedor sandbox (no en cada ejecución).
Se ejecuta dentro del contenedor a través de `sh -lc`.

Rutas:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Por agente: `agents.list[].sandbox.docker.setupCommand`

Errores comunes:

- El `docker.network` predeterminado es `"none"` (sin salida), por lo que las instalaciones de paquetes fallarán.
- `readOnlyRoot: true` previene escrituras; establece `readOnlyRoot: false` o hornea una imagen personalizada.
- `user` debe ser root para instalaciones de paquetes (omite `user` o establece `user: "0:0"`).
- El exec del sandbox **no** hereda `process.env` del host. Usa
  `agents.defaults.sandbox.docker.env` (o una imagen personalizada) para claves API de habilidades.

## Política de herramientas + escotillas de escape

Las políticas de permitir/denegar herramientas aún se aplican antes de las reglas del sandbox. Si una herramienta está denegada
globalmente o por agente, el sandboxing no la trae de vuelta.

`tools.elevated` es una escotilla de escape explícita que ejecuta `exec` en el host.
Las directivas `/exec` solo se aplican para remitentes autorizados y persisten por sesión; para deshabilitar permanentemente
`exec`, usa la denegación de política de herramientas (ver [Sandbox vs Política de Herramientas vs Elevated](/es-ES/gateway/sandbox-vs-tool-policy-vs-elevated)).

Depuración:

- Usa `openclaw sandbox explain` para inspeccionar el modo de sandbox efectivo, política de herramientas y claves de config de corrección.
- Ver [Sandbox vs Política de Herramientas vs Elevated](/es-ES/gateway/sandbox-vs-tool-policy-vs-elevated) para el modelo mental de "¿por qué está bloqueado esto?".
  Manténlo bloqueado.

## Anulaciones multi-agente

Cada agente puede anular sandbox + herramientas:
`agents.list[].sandbox` y `agents.list[].tools` (más `agents.list[].tools.sandbox.tools` para política de herramientas de sandbox).
Ver [Sandbox y Herramientas Multi-Agente](/es-ES/tools/multi-agent-sandbox-tools) para precedencia.

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

## Docs relacionados

- [Configuración de Sandbox](/es-ES/gateway/configuration#agentsdefaults-sandbox)
- [Sandbox y Herramientas Multi-Agente](/es-ES/tools/multi-agent-sandbox-tools)
- [Seguridad](/es-ES/gateway/security)
