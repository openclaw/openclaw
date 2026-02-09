---
summary: "Desinstalar OpenClaw por completo (CLI, servicio, estado, espacio de trabajo)"
read_when:
  - Desea eliminar OpenClaw de una máquina
  - El servicio del Gateway sigue ejecutándose después de la desinstalación
title: "Desinstalar"
---

# Desinstalar

Dos rutas:

- **Ruta fácil** si `openclaw` todavía está instalado.
- **Eliminación manual del servicio** si la CLI ya no está, pero el servicio sigue ejecutándose.

## Ruta fácil (CLI todavía instalada)

Recomendado: use el desinstalador integrado:

```bash
openclaw uninstall
```

No interactivo (automatización / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Pasos manuales (mismo resultado):

1. Detenga el servicio del Gateway:

```bash
openclaw gateway stop
```

2. Desinstale el servicio del Gateway (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Elimine el estado + la configuración:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Si configuró `OPENCLAW_CONFIG_PATH` en una ubicación personalizada fuera del directorio de estado, elimine también ese archivo.

4. Elimine su espacio de trabajo (opcional, elimina archivos del agente):

```bash
rm -rf ~/.openclaw/workspace
```

5. Elimine la instalación de la CLI (elija la que haya usado):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Si instaló la aplicación de macOS:

```bash
rm -rf /Applications/OpenClaw.app
```

Notas:

- Si usó perfiles (`--profile` / `OPENCLAW_PROFILE`), repita el paso 3 para cada directorio de estado (los valores predeterminados son `~/.openclaw-<profile>`).
- En modo remoto, el directorio de estado vive en el **host del Gateway**, por lo que ejecute también allí los pasos 1-4.

## Eliminación manual del servicio (CLI no instalada)

Use esto si el servicio del Gateway sigue ejecutándose pero falta `openclaw`.

### macOS (launchd)

La etiqueta predeterminada es `bot.molt.gateway` (o `bot.molt.<profile>`; el legado `com.openclaw.*` puede seguir existiendo):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Si usó un perfil, reemplace la etiqueta y el nombre del plist por `bot.molt.<profile>`. Elimine cualquier plist heredado `com.openclaw.*` si existe.

### Linux (unidad de usuario systemd)

El nombre de la unidad predeterminada es `openclaw-gateway.service` (o `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Tarea programada)

El nombre de la tarea predeterminado es `OpenClaw Gateway` (o `OpenClaw Gateway (<profile>)`).
El script de la tarea se encuentra dentro de su directorio de estado.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Si usó un perfil, elimine el nombre de la tarea correspondiente y `~\.openclaw-<profile>\gateway.cmd`.

## Instalación normal vs. checkout del código fuente

### Instalación normal (install.sh / npm / pnpm / bun)

Si usó `https://openclaw.ai/install.sh` o `install.ps1`, la CLI se instaló con `npm install -g openclaw@latest`.
Elimínela con `npm rm -g openclaw` (o `pnpm remove -g` / `bun remove -g` si la instaló de esa manera).

### Checkout del código fuente (git clone)

Si ejecuta desde un checkout del repositorio (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Desinstale el servicio del Gateway **antes** de eliminar el repositorio (use la ruta fácil anterior o la eliminación manual del servicio).
2. Elimine el directorio del repositorio.
3. Elimine el estado + el espacio de trabajo como se muestra arriba.
