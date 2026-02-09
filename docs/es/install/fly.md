---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Implementación en Fly.io

**Objetivo:** OpenClaw Gateway ejecutándose en una máquina de [Fly.io](https://fly.io) con almacenamiento persistente, HTTPS automático y acceso a Discord/canales.

## Lo que necesita

- [CLI flyctl](https://fly.io/docs/hands-on/install-flyctl/) instalado
- Cuenta de Fly.io (el nivel gratuito funciona)
- Autenticación del modelo: clave de API de Anthropic (u otras claves de proveedor)
- Credenciales de canales: token de bot de Discord, token de Telegram, etc.

## Ruta rápida para principiantes

1. Clonar el repositorio → personalizar `fly.toml`
2. Crear la app + volumen → configurar secretos
3. Implementar con `fly deploy`
4. Acceder por SSH para crear la configuración o usar la UI de Control

## 1) Crear la app en Fly

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Consejo:** Elija una región cercana a usted. Opciones comunes: `lhr` (Londres), `iad` (Virginia), `sjc` (San José).

## 2. Configurar fly.toml

Edite `fly.toml` para que coincida con el nombre de su app y sus requisitos.

**Nota de seguridad:** La configuración predeterminada expone una URL pública. Para una implementación reforzada sin IP pública, consulte [Implementación privada](#private-deployment-hardened) o use `fly.private.toml`.

```toml
app = "my-openclaw"  # Your app name
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**Configuraciones clave:**

| Configuración                  | Por qué                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Se vincula a `0.0.0.0` para que el proxy de Fly pueda alcanzar el gateway                                     |
| `--allow-unconfigured`         | Inicia sin un archivo de configuración (lo creará después)                                 |
| `internal_port = 3000`         | Debe coincidir con `--port 3000` (o `OPENCLAW_GATEWAY_PORT`) para los health checks de Fly |
| `memory = "2048mb"`            | 512MB es demasiado poco; se recomiendan 2GB                                                                   |
| `OPENCLAW_STATE_DIR = "/data"` | Persiste el estado en el volumen                                                                              |

## 3. Configurar secretos

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**Notas:**

- Enlaces no loopback (`--bind lan`) requieren `OPENCLAW_GATEWAY_TOKEN` por seguridad.
- Trate estos tokens como contraseñas.
- **Prefiera variables de entorno sobre el archivo de configuración** para todas las claves de API y tokens. Esto mantiene los secretos fuera de `openclaw.json`, donde podrían exponerse o registrarse accidentalmente.

## 4. Implementar

```bash
fly deploy
```

La primera implementación construye la imagen Docker (~2–3 minutos). Las implementaciones posteriores son más rápidas.

Después de la implementación, verifique:

```bash
fly status
fly logs
```

Debería ver:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Crear el archivo de configuración

Acceda por SSH a la máquina para crear una configuración adecuada:

```bash
fly ssh console
```

Cree el directorio y el archivo de configuración:

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**Nota:** Con `OPENCLAW_STATE_DIR=/data`, la ruta de configuración es `/data/openclaw.json`.

**Nota:** El token de Discord puede provenir de cualquiera de estos:

- Variable de entorno: `DISCORD_BOT_TOKEN` (recomendado para secretos)
- Archivo de configuración: `channels.discord.token`

Si usa la variable de entorno, no es necesario agregar el token a la configuración. El gateway lee `DISCORD_BOT_TOKEN` automáticamente.

Reinicie para aplicar:

```bash
exit
fly machine restart <machine-id>
```

## 6. Acceder al Gateway

### UI de Control

Abra en el navegador:

```bash
fly open
```

O visite `https://my-openclaw.fly.dev/`

Pegue su token del gateway (el de `OPENCLAW_GATEWAY_TOKEN`) para autenticarse.

### Registros

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### Consola SSH

```bash
fly ssh console
```

## Solución de problemas

### "App is not listening on expected address"

El gateway se está vinculando a `127.0.0.1` en lugar de `0.0.0.0`.

**Solución:** Agregue `--bind lan` al comando del proceso en `fly.toml`.

### Fallan los health checks / conexión rechazada

Fly no puede alcanzar el gateway en el puerto configurado.

**Solución:** Asegúrese de que `internal_port` coincida con el puerto del gateway (establezca `--port 3000` o `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / Problemas de memoria

El contenedor se reinicia constantemente o es terminado. Señales: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration` o reinicios silenciosos.

**Solución:** Aumente la memoria en `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

O actualice una máquina existente:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Nota:** 512MB es demasiado poco. 1GB puede funcionar, pero puede provocar OOM bajo carga o con registros verbosos. **Se recomiendan 2GB.**

### Problemas de bloqueo del Gateway

El Gateway se niega a iniciar con errores de "already running".

Esto ocurre cuando el contenedor se reinicia pero el archivo de bloqueo PID persiste en el volumen.

**Solución:** Elimine el archivo de bloqueo:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

El archivo de bloqueo está en `/data/gateway.*.lock` (no en un subdirectorio).

### La configuración no se está leyendo

Si usa `--allow-unconfigured`, el gateway crea una configuración mínima. Su configuración personalizada en `/data/openclaw.json` debería leerse al reiniciar.

Verifique que la configuración exista:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Escribir la configuración vía SSH

El comando `fly ssh console -C` no admite redirección del shell. Para escribir un archivo de configuración:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Nota:** `fly sftp` puede fallar si el archivo ya existe. Elimínelo primero:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### El estado no persiste

Si pierde credenciales o sesiones después de un reinicio, el directorio de estado está escribiendo en el sistema de archivos del contenedor.

**Solución:** Asegúrese de que `OPENCLAW_STATE_DIR=/data` esté configurado en `fly.toml` y vuelva a implementar.

## Actualizaciones

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Actualizar el comando de la máquina

Si necesita cambiar el comando de inicio sin una reimplementación completa:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Nota:** Después de `fly deploy`, el comando de la máquina puede restablecerse a lo que esté en `fly.toml`. Si realizó cambios manuales, vuelva a aplicarlos después de implementar.

## Implementación privada (reforzada)

De forma predeterminada, Fly asigna IP públicas, lo que hace que su gateway sea accesible en `https://your-app.fly.dev`. Esto es conveniente, pero significa que su implementación es detectable por escáneres de internet (Shodan, Censys, etc.).

Para una implementación reforzada **sin exposición pública**, use la plantilla privada.

### Cuándo usar implementación privada

- Solo realiza llamadas/mensajes **salientes** (sin webhooks entrantes)
- Usa túneles **ngrok o Tailscale** para cualquier callback de webhook
- Accede al gateway mediante **SSH, proxy o WireGuard** en lugar del navegador
- Quiere la implementación **oculta a los escáneres de internet**

### Configuración

Use `fly.private.toml` en lugar de la configuración estándar:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

O convierta una implementación existente:

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

Después de esto, `fly ips list` debería mostrar solo una IP de tipo `private`:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Acceso a una implementación privada

Como no hay URL pública, use uno de estos métodos:

**Opción 1: Proxy local (la más simple)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Opción 2: VPN WireGuard**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Opción 3: Solo SSH**

```bash
fly ssh console -a my-openclaw
```

### Webhooks con implementación privada

Si necesita callbacks de webhook (Twilio, Telnyx, etc.) sin exposición pública:

1. **Túnel ngrok**: ejecute ngrok dentro del contenedor o como sidecar
2. **Tailscale Funnel**: exponga rutas específicas mediante Tailscale
3. **Solo saliente**: algunos proveedores (Twilio) funcionan bien para llamadas salientes sin webhooks

Ejemplo de configuración de llamada de voz con ngrok:

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

El túnel ngrok se ejecuta dentro del contenedor y proporciona una URL pública de webhook sin exponer la app de Fly en sí. Configure `webhookSecurity.allowedHosts` con el nombre de host público del túnel para que se acepten los encabezados de host reenviados.

### Beneficios de seguridad

| Aspecto                   | Público    | Privado    |
| ------------------------- | ---------- | ---------- |
| Escáneres de internet     | Detectable | Oculto     |
| Ataques directos          | Posibles   | Bloqueados |
| Acceso a la UI de Control | Navegador  | Proxy/VPN  |
| Entrega de webhooks       | Directa    | Vía túnel  |

## Notas

- Fly.io usa **arquitectura x86** (no ARM)
- El Dockerfile es compatible con ambas arquitecturas
- Para la incorporación de WhatsApp/Telegram, use `fly ssh console`
- Los datos persistentes viven en el volumen en `/data`
- Signal requiere Java + signal-cli; use una imagen personalizada y mantenga la memoria en 2GB+.

## Costos

Con la configuración recomendada (`shared-cpu-2x`, 2GB de RAM):

- ~$10–15/mes según el uso
- El nivel gratuito incluye cierta asignación

Consulte [precios de Fly.io](https://fly.io/docs/about/pricing/) para obtener más detalles.
