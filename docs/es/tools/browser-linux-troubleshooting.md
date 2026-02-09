---
summary: "Solucione problemas de inicio de CDP de Chrome/Brave/Edge/Chromium para el control del navegador de OpenClaw en Linux"
read_when: "El control del navegador falla en Linux, especialmente con Chromium instalado mediante snap"
title: "Solución de problemas del navegador"
---

# Solución de problemas del navegador (Linux)

## Problema: "Failed to start Chrome CDP on port 18800"

El servidor de control del navegador de OpenClaw no logra iniciar Chrome/Brave/Edge/Chromium con el error:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Causa raíz

En Ubuntu (y muchas distribuciones Linux), la instalación predeterminada de Chromium es un **paquete snap**. El confinamiento AppArmor de snap interfiere con la forma en que OpenClaw crea y supervisa el proceso del navegador.

El comando `apt install chromium` instala un paquete stub que redirige a snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Este NO es un navegador real; es solo un contenedor.

### Solución 1: Instalar Google Chrome (Recomendado)

Instale el paquete oficial `.deb` de Google Chrome, que no está en sandbox por snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Luego actualice su configuración de OpenClaw (`~/.openclaw/openclaw.json`):

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Solución 2: Usar Chromium snap con modo de solo adjuntar

Si debe usar Chromium instalado por snap, configure OpenClaw para adjuntarse a un navegador iniciado manualmente:

1. Actualice la configuración:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Inicie Chromium manualmente:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Opcionalmente, cree un servicio de usuario systemd para iniciar Chrome automáticamente:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Habilite con: `systemctl --user enable --now openclaw-browser.service`

### Verificar que el navegador funcione

Verifique el estado:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Prueba de navegación:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Referencia de configuración

| Opción                   | Descripción                                                                                            | Predeterminado                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `browser.enabled`        | Habilitar el control del navegador                                                                     | `true`                                                                                                      |
| `browser.executablePath` | Ruta a un binario de navegador basado en Chromium (Chrome/Brave/Edge/Chromium)      | detección automática (prefiere el navegador predeterminado cuando es basado en Chromium) |
| `browser.headless`       | Ejecutar sin GUI                                                                                       | `false`                                                                                                     |
| `browser.noSandbox`      | Agregar la bandera `--no-sandbox` (necesaria para algunas configuraciones de Linux) | `false`                                                                                                     |
| `browser.attachOnly`     | No iniciar el navegador, solo adjuntarse a uno existente                                               | `false`                                                                                                     |
| `browser.cdpPort`        | Puerto del Chrome DevTools Protocol                                                                    | `18800`                                                                                                     |

### Problema: "Chrome extension relay is running, but no tab is connected"

Está usando el perfil `chrome` (relay de extensión). Este espera que la extensión de navegador de OpenClaw esté adjunta a una pestaña activa.

Opciones de solución:

1. **Use el navegador administrado:** `openclaw browser start --browser-profile openclaw`
   (o establezca `browser.defaultProfile: "openclaw"`).
2. **Use el relay de extensión:** instale la extensión, abra una pestaña y haga clic en el ícono de la extensión de OpenClaw para adjuntarla.

Notas:

- El perfil `chrome` usa su **navegador Chromium predeterminado del sistema** cuando es posible.
- Los perfiles locales `openclaw` asignan automáticamente `cdpPort`/`cdpUrl`; solo configure esos para CDP remoto.
