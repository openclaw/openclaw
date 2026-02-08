---
summary: "Configuración de un túnel SSH para OpenClaw.app al conectarse a un Gateway remoto"
read_when: "Conectar la app de macOS a un Gateway remoto mediante SSH"
title: "Configuración del Gateway remoto"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:33Z
---

# Ejecutar OpenClaw.app con un Gateway remoto

OpenClaw.app utiliza túneles SSH para conectarse a un Gateway remoto. Esta guía le muestra cómo configurarlo.

## Descripción general

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Machine                          │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Configuración rápida

### Paso 1: Agregar configuración de SSH

Edite `~/.ssh/config` y agregue:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

Reemplace `<REMOTE_IP>` y `<REMOTE_USER>` con sus valores.

### Paso 2: Copiar la clave SSH

Copie su clave pública a la máquina remota (ingrese la contraseña una sola vez):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### Paso 3: Establecer el token del Gateway

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### Paso 4: Iniciar el túnel SSH

```bash
ssh -N remote-gateway &
```

### Paso 5: Reiniciar OpenClaw.app

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

La app ahora se conectará al Gateway remoto a través del túnel SSH.

---

## Inicio automático del túnel al iniciar sesión

Para que el túnel SSH se inicie automáticamente cuando usted inicie sesión, cree un Launch Agent.

### Crear el archivo PLIST

Guarde esto como `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Cargar el Launch Agent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

El túnel ahora:

- Se iniciará automáticamente cuando usted inicie sesión
- Se reiniciará si falla
- Se mantendrá en ejecución en segundo plano

Nota heredada: elimine cualquier LaunchAgent `com.openclaw.ssh-tunnel` restante si existe.

---

## Solución de problemas

**Verificar si el túnel está en ejecución:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**Reiniciar el túnel:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**Detener el túnel:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## Cómo funciona

| Componente                           | Qué hace                                                    |
| ------------------------------------ | ----------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | Reenvía el puerto local 18789 al puerto remoto 18789        |
| `ssh -N`                             | SSH sin ejecutar comandos remotos (solo reenvío de puertos) |
| `KeepAlive`                          | Reinicia automáticamente el túnel si falla                  |
| `RunAtLoad`                          | Inicia el túnel cuando se carga el agente                   |

OpenClaw.app se conecta a `ws://127.0.0.1:18789` en su máquina cliente. El túnel SSH reenvía esa conexión al puerto 18789 en la máquina remota donde se está ejecutando el Gateway.
