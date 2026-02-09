---
summary: "Actualización segura de OpenClaw (instalación global o desde código fuente), además de estrategia de reversión"
read_when:
  - Actualización de OpenClaw
  - Algo se rompe después de una actualización
title: "Actualización"
---

# Actualización

OpenClaw avanza rápido (pre “1.0”). Trate las actualizaciones como si fueran infraestructura de producción: actualizar → ejecutar comprobaciones → reiniciar (o usar `openclaw update`, que reinicia) → verificar.

## Recomendado: volver a ejecutar el instalador del sitio web (actualización en el lugar)

La ruta de actualización **preferida** es volver a ejecutar el instalador desde el sitio web. Detecta instalaciones existentes, actualiza en el lugar y ejecuta `openclaw doctor` cuando es necesario.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Notas:

- Agregue `--no-onboard` si no quiere que el asistente de incorporación se ejecute de nuevo.

- Para **instalaciones desde código fuente**, use:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  El instalador `git pull --rebase` **solo** si el repositorio está limpio.

- Para **instalaciones globales**, el script usa `npm install -g openclaw@latest` internamente.

- Nota heredada: `clawdbot` sigue disponible como shim de compatibilidad.

## Antes de actualizar

- Sepa cómo instaló: **global** (npm/pnpm) vs **desde código fuente** (git clone).
- Sepa cómo se está ejecutando su Gateway: **terminal en primer plano** vs **servicio supervisado** (launchd/systemd).
- Instala tu diseño a la medida:
  - Configuración: `~/.openclaw/openclaw.json`
  - Credenciales: `~/.openclaw/credentials/`
  - Espacio de trabajo: `~/.openclaw/workspace`

## Actualizar (instalación global)

Instalación global (elija una):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

**No** recomendamos Bun para el runtime del Gateway (errores de WhatsApp/Telegram).

Para cambiar de canal de actualización (instalaciones con git + npm):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Use `--tag <dist-tag|version>` para una etiqueta/versión de instalación puntual.

Consulte [Canales de desarrollo](/install/development-channels) para la semántica de canales y las notas de la versión.

Nota: en instalaciones con npm, el gateway registra una sugerencia de actualización al iniciar (verifica la etiqueta del canal actual). Desactive con `update.checkOnStart: false`.

Luego:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Notas:

- Si su Gateway se ejecuta como servicio, `openclaw gateway restart` es preferible a matar PIDs.
- Si está fijado a una versión específica, vea “Reversión / fijación” más abajo.

## Actualizar (`openclaw update`)

Para **instalaciones desde código fuente** (git checkout), prefiera:

```bash
openclaw update
```

Ejecuta un flujo de actualización relativamente seguro:

- Requiere un árbol de trabajo limpio.
- Cambia al canal seleccionado (etiqueta o rama).
- Obtiene y hace rebase contra el upstream configurado (canal dev).
- Instala dependencias, compila, construye la UI de Control y ejecuta `openclaw doctor`.
- Reinicia el gateway de forma predeterminada (use `--no-restart` para omitir).

Si instaló mediante **npm/pnpm** (sin metadatos de git), `openclaw update` intentará actualizar mediante su gestor de paquetes. Si no puede detectar la instalación, use “Actualizar (instalación global)” en su lugar.

## Actualizar (Control UI / RPC)

La UI de Control tiene **Update & Restart** (RPC: `update.run`). Hace lo siguiente:

1. Ejecuta el mismo flujo de actualización desde código fuente que `openclaw update` (solo git checkout).
2. Escribe un sentinel de reinicio con un informe estructurado (cola de stdout/stderr).
3. Reinicia el gateway y hace ping a la última sesión activa con el informe.

Si el rebase falla, el gateway aborta y se reinicia sin aplicar la actualización.

## Actualizar (desde código fuente)

Desde el checkout del repositorio:

Preferido:

```bash
openclaw update
```

Manual (más o menos equivalente):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Notas:

- `pnpm build` importa cuando ejecuta el binario empaquetado `openclaw` ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) o usa Node para ejecutar `dist/`.
- Si ejecuta desde un checkout del repositorio sin una instalación global, use `pnpm openclaw ...` para los comandos de la CLI.
- Si ejecuta directamente desde TypeScript (`pnpm openclaw ...`), normalmente no es necesario recompilar, pero **las migraciones de configuración siguen aplicando** → ejecute doctor.
- Cambiar entre instalaciones globales y con git es fácil: instale la otra variante y luego ejecute `openclaw doctor` para que el entrypoint del servicio del gateway se reescriba a la instalación actual.

## Ejecutar siempre: `openclaw doctor`

Doctor es el comando de “actualización segura”. Es intencionalmente aburrido: reparar + migrar + advertir.

Nota: si está en una **instalación desde código fuente** (git checkout), `openclaw doctor` ofrecerá ejecutar `openclaw update` primero.

Cosas típicas que hace:

- Migrar claves de configuración obsoletas / ubicaciones heredadas de archivos de configuración.
- Auditar políticas de mensajes directos y advertir sobre configuraciones “abiertas” riesgosas.
- Verificar la salud del Gateway y ofrecer reiniciar.
- Detectar y migrar servicios de gateway antiguos (launchd/systemd; schtasks heredados) a los servicios actuales de OpenClaw.
- En Linux, asegurar el lingering de usuario de systemd (para que el Gateway sobreviva al cierre de sesión).

Detalles: [Doctor](/gateway/doctor)

## Iniciar / detener / reiniciar el Gateway

CLI (funciona independientemente del SO):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Si está supervisado:

- macOS launchd (LaunchAgent incluido en la app): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (use `bot.molt.<profile>`; el heredado `com.openclaw.*` aún funciona)
- Linux systemd servicio de usuario: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` solo funcionan si el servicio está instalado; de lo contrario ejecute `openclaw gateway install`.

Runbook + etiquetas exactas de servicio: [Runbook del Gateway](/gateway)

## Reversión / fijación (cuando algo se rompe)

### Fijar (instalación global)

Instale una versión conocida y estable (reemplace `<version>` por la última que funcionó):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Consejo: para ver la versión publicada actual, ejecute `npm view openclaw version`.

Luego reinicie y vuelva a ejecutar doctor:

```bash
openclaw doctor
openclaw gateway restart
```

### Fijar (desde código fuente) por fecha

Elija un commit por fecha (ejemplo: “estado de main al 2026-01-01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Luego reinstale dependencias y reinicie:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Si quiere volver a lo más reciente más adelante:

```bash
git checkout main
git pull
```

## Si está atascado

- Ejecute `openclaw doctor` nuevamente y lea la salida con atención (a menudo indica la solución).
- Consulte: [Solución de problemas](/gateway/troubleshooting)
- Pregunte en Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
