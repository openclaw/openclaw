---
summary: "Actualizar OpenClaw de forma segura (instalación global o desde fuente), más estrategia de reversión"
read_when:
  - Actualizando OpenClaw
  - Algo se rompe después de una actualización
title: "Actualizando"
---

# Actualizando

OpenClaw se está moviendo rápido (pre "1.0"). Trata las actualizaciones como infraestructura de envío: actualizar → ejecutar comprobaciones → reiniciar (o usa `openclaw update`, que reinicia) → verificar.

## Recomendado: volver a ejecutar el instalador del sitio web (actualización en el lugar)

La ruta de actualización **preferida** es volver a ejecutar el instalador desde el sitio web. Este
detecta instalaciones existentes, actualiza en el lugar y ejecuta `openclaw doctor` cuando
sea necesario.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Notas:

- Agrega `--no-onboard` si no quieres que el asistente de incorporación se ejecute de nuevo.
- Para **instalaciones desde fuente**, usa:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  El instalador ejecutará `git pull --rebase` **solo** si el repositorio está limpio.

- Para **instalaciones globales**, el script usa `npm install -g openclaw@latest` internamente.
- Nota heredada: `clawdbot` permanece disponible como un shim de compatibilidad.

## Antes de actualizar

- Conoce cómo instalaste: **global** (npm/pnpm) vs **desde fuente** (git clone).
- Conoce cómo se está ejecutando tu Gateway: **terminal en primer plano** vs **servicio supervisado** (launchd/systemd).
- Haz una instantánea de tu personalización:
  - Config: `~/.openclaw/openclaw.json`
  - Credenciales: `~/.openclaw/credentials/`
  - Espacio de trabajo: `~/.openclaw/workspace`

## Actualizar (instalación global)

Instalación global (elige uno):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

**No** recomendamos Bun para el runtime del Gateway (errores de WhatsApp/Telegram).

Para cambiar canales de actualización (instalaciones git + npm):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Usa `--tag <dist-tag|version>` para una instalación única de etiqueta/versión.

Ver [Development channels](/es-ES/install/development-channels) para semántica de canales y notas de lanzamiento.

Nota: en instalaciones npm, el gateway registra una sugerencia de actualización al iniciar (verifica la etiqueta del canal actual). Deshabilitar mediante `update.checkOnStart: false`.

Luego:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Notas:

- Si tu Gateway se ejecuta como un servicio, `openclaw gateway restart` es preferido sobre matar PIDs.
- Si estás anclado a una versión específica, ver "Reversión / anclaje" abajo.

## Actualizar (`openclaw update`)

Para **instalaciones desde fuente** (git checkout), prefiere:

```bash
openclaw update
```

Ejecuta un flujo de actualización seguro:

- Requiere un árbol de trabajo limpio.
- Cambia al canal seleccionado (etiqueta o rama).
- Obtiene + rebasea contra el upstream configurado (canal dev).
- Instala dependencias, construye, construye la Interfaz de Control y ejecuta `openclaw doctor`.
- Reinicia el gateway por defecto (usa `--no-restart` para omitir).

Si instalaste mediante **npm/pnpm** (sin metadatos de git), `openclaw update` intentará actualizar mediante tu gestor de paquetes. Si no puede detectar la instalación, usa "Actualizar (instalación global)" en su lugar.

## Actualizar (Interfaz de Control / RPC)

La Interfaz de Control tiene **Update & Restart** (RPC: `update.run`). Este:

1. Ejecuta el mismo flujo de actualización desde fuente que `openclaw update` (solo git checkout).
2. Escribe un centinela de reinicio con un informe estructurado (tail stdout/stderr).
3. Reinicia el gateway y hace ping a la última sesión activa con el informe.

Si el rebase falla, el gateway aborta y reinicia sin aplicar la actualización.

## Actualizar (desde fuente)

Desde el checkout del repositorio:

Preferido:

```bash
openclaw update
```

Manual (equivalente):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-instala dependencias UI en la primera ejecución
openclaw doctor
openclaw health
```

Notas:

- `pnpm build` importa cuando ejecutas el binario empaquetado `openclaw` ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) o usas Node para ejecutar `dist/`.
- Si ejecutas desde un checkout del repositorio sin una instalación global, usa `pnpm openclaw ...` para comandos CLI.
- Si ejecutas directamente desde TypeScript (`pnpm openclaw ...`), una reconstrucción generalmente es innecesaria, pero **las migraciones de config aún se aplican** → ejecuta doctor.
- Cambiar entre instalaciones globales y git es fácil: instala el otro sabor, luego ejecuta `openclaw doctor` para que el punto de entrada del servicio de gateway se reescriba a la instalación actual.

## Siempre ejecutar: `openclaw doctor`

Doctor es el comando de "actualización segura". Es intencionalmente aburrido: reparar + migrar + advertir.

Nota: si estás en una **instalación desde fuente** (git checkout), `openclaw doctor` ofrecerá ejecutar `openclaw update` primero.

Cosas típicas que hace:

- Migrar claves de config obsoletas / ubicaciones de archivo de config heredadas.
- Auditar políticas DM y advertir sobre configuraciones "abiertas" arriesgadas.
- Verificar salud del Gateway y puede ofrecer reiniciar.
- Detectar y migrar servicios de gateway más antiguos (launchd/systemd; schtasks heredados) a servicios OpenClaw actuales.
- En Linux, asegurar lingering de usuario systemd (para que el Gateway sobreviva al cierre de sesión).

Detalles: [Doctor](/es-ES/gateway/doctor)

## Iniciar / detener / reiniciar el Gateway

CLI (funciona independientemente del SO):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Si estás supervisado:

- macOS launchd (LaunchAgent incluido en la app): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (usa `bot.molt.<profile>`; heredado `com.openclaw.*` aún funciona)
- Servicio de usuario systemd Linux: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` solo funcionan si el servicio está instalado; de lo contrario ejecuta `openclaw gateway install`.

Libro de ejecución + etiquetas exactas de servicio: [Gateway runbook](/es-ES/gateway)

## Reversión / anclaje (cuando algo se rompe)

### Anclar (instalación global)

Instala una versión que funciona conocida (reemplaza `<version>` con la última que funcionó):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Consejo: para ver la versión publicada actual, ejecuta `npm view openclaw version`.

Luego reinicia + vuelve a ejecutar doctor:

```bash
openclaw doctor
openclaw gateway restart
```

### Anclar (fuente) por fecha

Elige un commit desde una fecha (ejemplo: "estado de main al 2026-01-01"):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Luego reinstala dependencias + reinicia:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Si quieres volver a la última versión más tarde:

```bash
git checkout main
git pull
```

## Si estás atascado

- Ejecuta `openclaw doctor` de nuevo y lee la salida cuidadosamente (a menudo te dice la solución).
- Verifica: [Troubleshooting](/es-ES/gateway/troubleshooting)
- Pregunta en Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
