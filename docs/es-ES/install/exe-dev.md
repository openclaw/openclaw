---
summary: "Ejecutar OpenClaw Gateway en exe.dev (VM + proxy HTTPS) para acceso remoto"
read_when:
  - Quieres un host Linux económico siempre activo para el Gateway
  - Quieres acceso remoto a la UI de Control sin ejecutar tu propio VPS
title: "exe.dev"
---

# exe.dev

Objetivo: OpenClaw Gateway ejecutándose en una VM exe.dev, accesible desde tu laptop vía: `https://<vm-name>.exe.xyz`

Esta página asume la imagen predeterminada de exe.dev **exeuntu**. Si elegiste una distro diferente, mapea los paquetes correspondientes.

## Ruta rápida para principiantes

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Completa tu clave/token de autenticación según sea necesario
3. Haz clic en "Agent" junto a tu VM, y espera...
4. ???
5. Profit

## Lo que necesitas

- Cuenta exe.dev
- Acceso `ssh exe.dev` a máquinas virtuales de [exe.dev](https://exe.dev) (opcional)

## Instalación Automatizada con Shelley

Shelley, el agente de [exe.dev](https://exe.dev), puede instalar OpenClaw instantáneamente con nuestro
prompt. El prompt utilizado es el siguiente:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Instalación manual

## 1) Crear la VM

Desde tu dispositivo:

```bash
ssh exe.dev new
```

Luego conéctate:

```bash
ssh <vm-name>.exe.xyz
```

Consejo: mantén esta VM **con estado**. OpenClaw almacena estado en `~/.openclaw/` y `~/.openclaw/workspace/`.

## 2) Instalar prerequisitos (en la VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) Instalar OpenClaw

Ejecuta el script de instalación de OpenClaw:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) Configurar nginx para hacer proxy de OpenClaw al puerto 8000

Edita `/etc/nginx/sites-enabled/default` con

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) Acceder a OpenClaw y otorgar privilegios

Accede a `https://<vm-name>.exe.xyz/` (ver la salida de la UI de Control desde onboarding). Si solicita autenticación, pega el
token de `gateway.auth.token` en la VM (obtén con `openclaw config get gateway.auth.token`, o genera uno
con `openclaw doctor --generate-gateway-token`). Aprueba dispositivos con `openclaw devices list` y
`openclaw devices approve <requestId>`. Cuando tengas dudas, ¡usa Shelley desde tu navegador!

## Acceso Remoto

El acceso remoto es manejado por la autenticación de [exe.dev](https://exe.dev). Por
defecto, el tráfico HTTP del puerto 8000 se reenvía a `https://<vm-name>.exe.xyz`
con autenticación por email.

## Actualización

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Guía: [Actualizando](/es-ES/install/updating)
