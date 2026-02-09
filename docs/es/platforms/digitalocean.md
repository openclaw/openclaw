---
summary: "OpenClaw en DigitalOcean (opción simple de VPS de pago)"
read_when:
  - Configuración de OpenClaw en DigitalOcean
  - Buscando alojamiento VPS económico para OpenClaw
title: "DigitalOcean"
---

# OpenClaw en DigitalOcean

## Objetivo

Ejecutar un Gateway persistente de OpenClaw en DigitalOcean por **$6/mes** (o $4/mes con precios reservados).

Si desea una opción de $0/mes y no le importa ARM + una configuración específica del proveedor, consulte la [guía de Oracle Cloud](/platforms/oracle).

## Comparación de costos (2026)

| Proveedor    | Plan            | Especificaciones       | Precio/mes                                                     | Notas                                                |
| ------------ | --------------- | ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| Oracle Cloud | Always Free ARM | hasta 4 OCPU, 24GB RAM | $0                                                             | ARM, capacidad limitada / peculiaridades de registro |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | €3.79 (~$4) | Opción de pago más barata                            |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6                                                             | UI sencilla, buena documentación                     |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6                                                             | Muchas ubicaciones                                   |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5                                                             | Ahora parte de Akamai                                |

**Elección de proveedor:**

- DigitalOcean: UX más simple + configuración predecible (esta guía)
- Hetzner: buena relación precio/rendimiento (ver [guía de Hetzner](/install/hetzner))
- Oracle Cloud: puede ser $0/mes, pero es más delicado y solo ARM (ver [guía de Oracle](/platforms/oracle))

---

## Requisitos previos

- Cuenta de DigitalOcean ([registro con $200 de crédito gratis](https://m.do.co/c/signup))
- Par de claves SSH (o disposición para usar autenticación por contraseña)
- ~20 minutos

## 1. Crear un Droplet

1. Inicie sesión en [DigitalOcean](https://cloud.digitalocean.com/)
2. Haga clic en **Create → Droplets**
3. Elija:
   - **Región:** La más cercana a usted (o a sus usuarios)
   - **Imagen:** Ubuntu 24.04 LTS
   - **Tamaño:** Basic → Regular → **$6/mes** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Autenticación:** Clave SSH (recomendado) o contraseña
4. Haga clic en **Create Droplet**
5. Anote la dirección IP

## 2) Conectarse vía SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Instalar OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Ejecutar el onboarding

```bash
openclaw onboard --install-daemon
```

El asistente lo guiará a través de:

- Autenticación del modelo (claves de API u OAuth)
- Configuración de canales (Telegram, WhatsApp, Discord, etc.)
- Token del Gateway (generado automáticamente)
- Instalación del daemon (systemd)

## 5. Verificar el Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Acceder al panel

El Gateway se enlaza a loopback de forma predeterminada. Para acceder a la UI de control:

**Opción A: Túnel SSH (recomendado)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Opción B: Tailscale Serve (HTTPS, solo loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Abrir: `https://<magicdns>/`

Notas:

- Serve mantiene el Gateway solo en loopback y autentica mediante encabezados de identidad de Tailscale.
- Para requerir token/contraseña en su lugar, configure `gateway.auth.allowTailscale: false` o use `gateway.auth.mode: "password"`.

**Opción C: Enlace a tailnet (sin Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Abrir: `http://<tailscale-ip>:18789` (se requiere token).

## 7. Conecte sus canales

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

Consulte [Canales](/channels) para otros proveedores.

---

## Optimizaciones para 1GB de RAM

El droplet de $6 solo tiene 1GB de RAM. Para que todo funcione sin problemas:

### Agregar swap (recomendado)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Usar un modelo más ligero

Si está encontrando OOM, considere:

- Usar modelos basados en API (Claude, GPT) en lugar de modelos locales
- Configurar `agents.defaults.model.primary` a un modelo más pequeño

### Monitorear memoria

```bash
free -h
htop
```

---

## Persistencia

Todo el estado vive en:

- `~/.openclaw/` — configuración, credenciales, datos de sesión
- `~/.openclaw/workspace/` — espacio de trabajo (SOUL.md, memoria, etc.)

Estos sobreviven a reinicios. Respáldelos periódicamente:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Alternativa gratuita de Oracle Cloud

Oracle Cloud ofrece instancias ARM **Always Free** que son significativamente más potentes que cualquier opción de pago aquí — por $0/mes.

| Qué obtiene                 | Especificaciones                 |
| --------------------------- | -------------------------------- |
| **4 OCPUs**                 | ARM Ampere A1                    |
| **24GB RAM**                | Más que suficiente               |
| **200GB de almacenamiento** | Volumen de bloques               |
| **Gratis para siempre**     | Sin cargos de tarjeta de crédito |

**Advertencias:**

- El registro puede ser delicado (reintente si falla)
- Arquitectura ARM — la mayoría de las cosas funcionan, pero algunos binarios requieren compilaciones ARM

Para la guía completa de configuración, consulte [Oracle Cloud](/platforms/oracle). Para consejos de registro y solución de problemas del proceso de inscripción, vea esta [guía de la comunidad](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Solución de problemas

### El Gateway no inicia

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### El puerto ya está en uso

```bash
lsof -i :18789
kill <PID>
```

### Sin memoria

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Ver también

- [Guía de Hetzner](/install/hetzner) — más barata, más potente
- [Instalación con Docker](/install/docker) — configuración en contenedores
- [Tailscale](/gateway/tailscale) — acceso remoto seguro
- [Configuración](/gateway/configuration) — referencia completa de configuración
