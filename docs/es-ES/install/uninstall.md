---
summary: "Desinstalar OpenClaw completamente (CLI, servicio, estado, espacio de trabajo)"
read_when:
  - Quieres eliminar OpenClaw de una máquina
  - El servicio del gateway todavía se está ejecutando después de desinstalar
title: "Desinstalación"
---

# Desinstalación

Dos rutas:

- **Ruta fácil** si `openclaw` todavía está instalado.
- **Eliminación manual del servicio** si el CLI se ha ido pero el servicio todavía se está ejecutando.

## Ruta fácil (CLI todavía instalado)

Recomendado: usa el desinstalador integrado:

```bash
openclaw uninstall
```

No interactivo (automatización / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Pasos manuales (mismo resultado):

1. Detener el servicio del gateway:

```bash
openclaw gateway stop
```

2. Desinstalar el servicio del gateway (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Eliminar estado + config:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Si estableciste `OPENCLAW_CONFIG_PATH` en una ubicación personalizada fuera del directorio de estado, elimina ese archivo también.

4. Eliminar tu espacio de trabajo (opcional, elimina archivos del agente):

```bash
rm -rf ~/.openclaw/workspace
```

5. Eliminar la instalación CLI (elige el que usaste):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Si instalaste la aplicación macOS:

```bash
rm -rf /Applications/OpenClaw.app
```

Notas:

- Si usaste perfiles (`--profile` / `OPENCLAW_PROFILE`), repite el paso 3 para cada directorio de estado (los predeterminados son `~/.openclaw-<profile>`).
- En modo remoto, el directorio de estado vive en el **host del gateway**, así que ejecuta los pasos 1-4 allí también.

## Eliminación manual del servicio (CLI no instalado)

Usa esto si el servicio del gateway sigue ejecutándose pero falta `openclaw`.

### macOS (launchd)

La etiqueta predeterminada es `bot.molt.gateway` (o `bot.molt.<profile>`; heredado `com.openclaw.*` puede existir todavía):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Si usaste un perfil, reemplaza la etiqueta y el nombre del plist con `bot.molt.<profile>`. Elimina cualquier plist heredado `com.openclaw.*` si está presente.

### Linux (unidad de usuario systemd)

El nombre de unidad predeterminado es `openclaw-gateway.service` (o `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Tarea Programada)

El nombre de tarea predeterminado es `OpenClaw Gateway` (o `OpenClaw Gateway (<profile>)`).
El script de la tarea vive bajo tu directorio de estado.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Si usaste un perfil, elimina el nombre de tarea coincidente y `~\.openclaw-<profile>\gateway.cmd`.

## Instalación normal vs checkout de fuente

### Instalación normal (install.sh / npm / pnpm / bun)

Si usaste `https://openclaw.ai/install.sh` o `install.ps1`, el CLI se instaló con `npm install -g openclaw@latest`.
Elimínalo con `npm rm -g openclaw` (o `pnpm remove -g` / `bun remove -g` si instalaste de esa manera).

### Checkout de fuente (git clone)

Si ejecutas desde un checkout del repositorio (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Desinstalar el servicio del gateway **antes** de eliminar el repositorio (usa la ruta fácil anterior o eliminación manual del servicio).
2. Eliminar el directorio del repositorio.
3. Eliminar estado + espacio de trabajo como se muestra arriba.
