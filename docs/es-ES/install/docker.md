---
summary: "Configuración e incorporación opcional basada en Docker para OpenClaw"
read_when:
  - Quieres un gateway en contenedor en lugar de instalaciones locales
  - Estás validando el flujo de Docker
title: "Docker"
---

# Docker (opcional)

Docker es **opcional**. Úsalo solo si quieres un gateway en contenedor o para validar el flujo de Docker.

## ¿Es Docker adecuado para mí?

- **Sí**: quieres un entorno de gateway aislado y desechable o ejecutar OpenClaw en un host sin instalaciones locales.
- **No**: estás ejecutando en tu propia máquina y solo quieres el ciclo de desarrollo más rápido. Usa el flujo de instalación normal en su lugar.
- **Nota sobre Sandbox**: el sandboxing de agentes también usa Docker, pero **no** requiere que el gateway completo se ejecute en Docker. Ver [Sandboxing](/es-ES/gateway/sandboxing).

Esta guía cubre:

- Gateway en contenedor (OpenClaw completo en Docker)
- Sandbox de Agente por sesión (gateway en host + herramientas de agente aisladas en Docker)

Detalles de sandboxing: [Sandboxing](/es-ES/gateway/sandboxing)

## Requisitos

- Docker Desktop (o Docker Engine) + Docker Compose v2
- Espacio en disco suficiente para imágenes + registros

## Gateway en contenedor (Docker Compose)

### Inicio rápido (recomendado)

Desde la raíz del repositorio:

```bash
./docker-setup.sh
```

Este script:

- construye la imagen del gateway
- ejecuta el asistente de incorporación
- imprime sugerencias de configuración de proveedor opcionales
- inicia el gateway mediante Docker Compose
- genera un token de gateway y lo escribe en `.env`

Variables de entorno opcionales:

- `OPENCLAW_DOCKER_APT_PACKAGES` — instalar paquetes apt adicionales durante la construcción
- `OPENCLAW_EXTRA_MOUNTS` — agregar montajes de enlace de host adicionales
- `OPENCLAW_HOME_VOLUME` — persistir `/home/node` en un volumen nombrado

Después de que finalice:

- Abre `http://127.0.0.1:18789/` en tu navegador.
- Pega el token en la Interfaz de Control (Settings → token).
- ¿Necesitas la URL nuevamente? Ejecuta `docker compose run --rm openclaw-cli dashboard --no-open`.

Escribe config/workspace en el host:

- `~/.openclaw/`
- `~/.openclaw/workspace`

¿Ejecutando en un VPS? Ver [Hetzner (Docker VPS)](/es-ES/install/hetzner).

### Ayudantes de Shell (opcional)

Para una gestión diaria de Docker más fácil, instala `ClawDock`:

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

**Agregar a tu configuración de shell (zsh):**

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

Luego usa `clawdock-start`, `clawdock-stop`, `clawdock-dashboard`, etc. Ejecuta `clawdock-help` para todos los comandos.

Ver [README de Ayudantes `ClawDock`](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md) para más detalles.

### Flujo manual (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Nota: ejecuta `docker compose ...` desde la raíz del repositorio. Si habilitaste
`OPENCLAW_EXTRA_MOUNTS` o `OPENCLAW_HOME_VOLUME`, el script de configuración escribe
`docker-compose.extra.yml`; inclúyelo al ejecutar Compose en otro lugar:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Token de Interfaz de Control + emparejamiento (Docker)

Si ves "unauthorized" o "disconnected (1008): pairing required", obtén un
enlace de panel de control nuevo y aprueba el dispositivo del navegador:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Más detalles: [Dashboard](/es-ES/web/dashboard), [Devices](/es-ES/cli/devices).

### Montajes adicionales (opcional)

Si quieres montar directorios de host adicionales en los contenedores, establece
`OPENCLAW_EXTRA_MOUNTS` antes de ejecutar `docker-setup.sh`. Esto acepta una
lista separada por comas de montajes de enlace de Docker y los aplica tanto a
`openclaw-gateway` como `openclaw-cli` generando `docker-compose.extra.yml`.

Ejemplo:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notas:

- Las rutas deben estar compartidas con Docker Desktop en macOS/Windows.
- Si editas `OPENCLAW_EXTRA_MOUNTS`, vuelve a ejecutar `docker-setup.sh` para regenerar el
  archivo compose adicional.
- `docker-compose.extra.yml` es generado. No lo edites manualmente.

### Persistir el directorio home completo del contenedor (opcional)

Si quieres que `/home/node` persista a través de recreaciones de contenedores, establece un
volumen nombrado mediante `OPENCLAW_HOME_VOLUME`. Esto crea un volumen de Docker y lo monta en
`/home/node`, manteniendo los montajes de enlace estándar de config/workspace. Usa un
volumen nombrado aquí (no una ruta de enlace); para montajes de enlace, usa
`OPENCLAW_EXTRA_MOUNTS`.

Ejemplo:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Puedes combinar esto con montajes adicionales:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notas:

- Si cambias `OPENCLAW_HOME_VOLUME`, vuelve a ejecutar `docker-setup.sh` para regenerar el
  archivo compose adicional.
- El volumen nombrado persiste hasta que se elimine con `docker volume rm <name>`.

### Instalar paquetes apt adicionales (opcional)

Si necesitas paquetes del sistema dentro de la imagen (por ejemplo, herramientas de construcción o
bibliotecas multimedia), establece `OPENCLAW_DOCKER_APT_PACKAGES` antes de ejecutar `docker-setup.sh`.
Esto instala los paquetes durante la construcción de la imagen, por lo que persisten incluso si el
contenedor se elimina.

Ejemplo:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Notas:

- Esto acepta una lista separada por espacios de nombres de paquetes apt.
- Si cambias `OPENCLAW_DOCKER_APT_PACKAGES`, vuelve a ejecutar `docker-setup.sh` para reconstruir
  la imagen.

### Contenedor avanzado / con todas las funciones (opt-in)

La imagen de Docker predeterminada es **seguridad primero** y se ejecuta como el usuario no root `node`.
Esto mantiene la superficie de ataque pequeña, pero significa:

- sin instalaciones de paquetes del sistema en tiempo de ejecución
- sin Homebrew por defecto
- sin navegadores Chromium/Playwright incluidos

Si quieres un contenedor con más funciones, usa estas opciones opt-in:

1. **Persistir `/home/node`** para que las descargas del navegador y cachés de herramientas sobrevivan:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Incluir dependencias del sistema en la imagen** (repetible + persistente):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Instalar navegadores de Playwright sin `npx`** (evita conflictos de override de npm):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Si necesitas que Playwright instale dependencias del sistema, reconstruye la imagen con
`OPENCLAW_DOCKER_APT_PACKAGES` en lugar de usar `--with-deps` en tiempo de ejecución.

4. **Persistir descargas de navegadores de Playwright**:

- Establece `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` en
  `docker-compose.yml`.
- Asegúrate de que `/home/node` persista mediante `OPENCLAW_HOME_VOLUME`, o monta
  `/home/node/.cache/ms-playwright` mediante `OPENCLAW_EXTRA_MOUNTS`.

### Permisos + EACCES

La imagen se ejecuta como `node` (uid 1000). Si ves errores de permisos en
`/home/node/.openclaw`, asegúrate de que tus montajes de enlace de host sean propiedad de uid 1000.

Ejemplo (host Linux):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Si eliges ejecutar como root por conveniencia, aceptas el compromiso de seguridad.

### Reconstrucciones más rápidas (recomendado)

Para acelerar las reconstrucciones, ordena tu Dockerfile para que las capas de dependencias se cacheen.
Esto evita volver a ejecutar `pnpm install` a menos que cambien los archivos de bloqueo:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Configuración de canales (opcional)

Usa el contenedor CLI para configurar canales, luego reinicia el gateway si es necesario.

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (bot token):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (bot token):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Docs: [WhatsApp](/es-ES/channels/whatsapp), [Telegram](/es-ES/channels/telegram), [Discord](/es-ES/channels/discord)

### OAuth de OpenAI Codex (Docker sin cabeza)

Si eliges OAuth de OpenAI Codex en el asistente, abre una URL del navegador e intenta
capturar un callback en `http://127.0.0.1:1455/auth/callback`. En Docker o
configuraciones sin cabeza, ese callback puede mostrar un error del navegador. Copia la URL de redireccionamiento completa
a la que llegas y pégala de vuelta en el asistente para finalizar la autenticación.

### Verificación de salud

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### Prueba de humo E2E (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### Prueba de humo de importación QR (Docker)

```bash
pnpm test:docker:qr
```

### Notas

- El enlace del Gateway predeterminado es `lan` para uso en contenedor.
- El CMD del Dockerfile usa `--allow-unconfigured`; la configuración montada con `gateway.mode` no `local` aún se iniciará. Sobrescribe CMD para aplicar el guardián.
- El contenedor del gateway es la fuente de verdad para las sesiones (`~/.openclaw/agents/<agentId>/sessions/`).

## Sandbox de Agente (gateway en host + herramientas Docker)

Inmersión profunda: [Sandboxing](/es-ES/gateway/sandboxing)

### Qué hace

Cuando `agents.defaults.sandbox` está habilitado, las **sesiones no principales** ejecutan herramientas dentro de un
contenedor Docker. El gateway permanece en tu host, pero la ejecución de herramientas está aislada:

- scope: `"agent"` por defecto (un contenedor + espacio de trabajo por agente)
- scope: `"session"` para aislamiento por sesión
- carpeta de espacio de trabajo por scope montada en `/workspace`
- acceso opcional al espacio de trabajo del agente (`agents.defaults.sandbox.workspaceAccess`)
- política de herramientas allow/deny (deny gana)
- los medios entrantes se copian al espacio de trabajo del sandbox activo (`media/inbound/*`) para que las herramientas puedan leerlo (con `workspaceAccess: "rw"`, esto llega al espacio de trabajo del agente)

Advertencia: `scope: "shared"` deshabilita el aislamiento entre sesiones. Todas las sesiones comparten
un contenedor y un espacio de trabajo.

### Perfiles de sandbox por agente (multi-agente)

Si usas enrutamiento multi-agente, cada agente puede sobrescribir la configuración de sandbox + herramientas:
`agents.list[].sandbox` y `agents.list[].tools` (más `agents.list[].tools.sandbox.tools`). Esto te permite ejecutar
niveles de acceso mixtos en un gateway:

- Acceso completo (agente personal)
- Herramientas de solo lectura + espacio de trabajo de solo lectura (agente familiar/trabajo)
- Sin herramientas de sistema de archivos/shell (agente público)

Ver [Multi-Agent Sandbox & Tools](/es-ES/tools/multi-agent-sandbox-tools) para ejemplos,
precedencia y solución de problemas.

### Comportamiento predeterminado

- Imagen: `openclaw-sandbox:bookworm-slim`
- Un contenedor por agente
- Acceso al espacio de trabajo del agente: `workspaceAccess: "none"` (predeterminado) usa `~/.openclaw/sandboxes`
  - `"ro"` mantiene el espacio de trabajo del sandbox en `/workspace` y monta el espacio de trabajo del agente de solo lectura en `/agent` (deshabilita `write`/`edit`/`apply_patch`)
  - `"rw"` monta el espacio de trabajo del agente lectura/escritura en `/workspace`
- Auto-limpieza: inactivo > 24h O edad > 7d
- Red: `none` por defecto (explícitamente opt-in si necesitas egreso)
- Allow predeterminado: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Deny predeterminado: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Habilitar sandboxing

Si planeas instalar paquetes en `setupCommand`, ten en cuenta:

- `docker.network` predeterminado es `"none"` (sin egreso).
- `readOnlyRoot: true` bloquea instalaciones de paquetes.
- `user` debe ser root para `apt-get` (omite `user` o establece `user: "0:0"`).
  OpenClaw recrea automáticamente contenedores cuando `setupCommand` (o configuración de docker) cambia
  a menos que el contenedor haya sido **usado recientemente** (dentro de ~5 minutos). Los contenedores activos
  registran una advertencia con el comando exacto `openclaw sandbox recreate ...`.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent es predeterminado)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 deshabilita limpieza por inactividad
          maxAgeDays: 7, // 0 deshabilita limpieza por edad máxima
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Las opciones de endurecimiento viven en `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Multi-agente: sobrescribe `agents.defaults.sandbox.{docker,browser,prune}.*` por agente mediante `agents.list[].sandbox.{docker,browser,prune}.*`
(ignorado cuando `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` es `"shared"`).

### Construir la imagen de sandbox predeterminada

```bash
scripts/sandbox-setup.sh
```

Esto construye `openclaw-sandbox:bookworm-slim` usando `Dockerfile.sandbox`.

### Imagen común de sandbox (opcional)

Si quieres una imagen de sandbox con herramientas de construcción comunes (Node, Go, Rust, etc.), construye la imagen común:

```bash
scripts/sandbox-common-setup.sh
```

Esto construye `openclaw-sandbox-common:bookworm-slim`. Para usarla:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Imagen de navegador de sandbox

Para ejecutar la herramienta de navegador dentro del sandbox, construye la imagen de navegador:

```bash
scripts/sandbox-browser-setup.sh
```

Esto construye `openclaw-sandbox-browser:bookworm-slim` usando
`Dockerfile.sandbox-browser`. El contenedor ejecuta Chromium con CDP habilitado y
un observador noVNC opcional (headful mediante Xvfb).

Notas:

- Headful (Xvfb) reduce el bloqueo de bots vs headless.
- Headless aún se puede usar estableciendo `agents.defaults.sandbox.browser.headless=true`.
- No se necesita un entorno de escritorio completo (GNOME); Xvfb proporciona la pantalla.

Usa config:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

Imagen de navegador personalizada:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Cuando está habilitado, el agente recibe:

- una URL de control del navegador sandbox (para la herramienta `browser`)
- una URL noVNC (si está habilitado y headless=false)

Recuerda: si usas una lista de permitidos para herramientas, agrega `browser` (y elimínalo de
deny) o la herramienta permanecerá bloqueada.
Las reglas de limpieza (`agents.defaults.sandbox.prune`) también se aplican a los contenedores de navegador.

### Imagen de sandbox personalizada

Construye tu propia imagen y apunta la configuración a ella:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### Política de herramientas (allow/deny)

- `deny` gana sobre `allow`.
- Si `allow` está vacío: todas las herramientas (excepto deny) están disponibles.
- Si `allow` no está vacío: solo las herramientas en `allow` están disponibles (menos deny).

### Estrategia de limpieza

Dos opciones:

- `prune.idleHours`: eliminar contenedores no usados en X horas (0 = deshabilitar)
- `prune.maxAgeDays`: eliminar contenedores mayores de X días (0 = deshabilitar)

Ejemplo:

- Mantener sesiones ocupadas pero limitar la vida útil:
  `idleHours: 24`, `maxAgeDays: 7`
- Nunca limpiar:
  `idleHours: 0`, `maxAgeDays: 0`

### Notas de seguridad

- El muro duro solo se aplica a **herramientas** (exec/read/write/edit/apply_patch).
- Las herramientas solo de host como browser/camera/canvas están bloqueadas por defecto.
- Permitir `browser` en sandbox **rompe el aislamiento** (el navegador se ejecuta en el host).

## Solución de problemas

- Imagen faltante: construye con [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) o establece `agents.defaults.sandbox.docker.image`.
- Contenedor no ejecutándose: se auto-creará por sesión bajo demanda.
- Errores de permisos en sandbox: establece `docker.user` a un UID:GID que coincida con la
  propiedad de tu espacio de trabajo montado (o chown la carpeta del espacio de trabajo).
- Herramientas personalizadas no encontradas: OpenClaw ejecuta comandos con `sh -lc` (shell de inicio de sesión), que
  carga `/etc/profile` y puede restablecer PATH. Establece `docker.env.PATH` para anteponer tus
  rutas de herramientas personalizadas (ej., `/custom/bin:/usr/local/share/npm-global/bin`), o agrega
  un script en `/etc/profile.d/` en tu Dockerfile.
