---
summary: "OpenClaw en DigitalOcean (opción VPS paga simple)"
read_when:
  - Configurando OpenClaw en DigitalOcean
  - Buscando hosting VPS económico para OpenClaw
title: "DigitalOcean"
---

# OpenClaw en DigitalOcean

## Objetivo

Ejecutar un Gateway OpenClaw persistente en DigitalOcean por **$6/mes** (o $4/mes con precios reservados).

Si quieres una opción de $0/mes y no te importa ARM + configuración específica del proveedor, ver la [guía de Oracle Cloud](/es-ES/platforms/oracle).

## Comparación de Costos (2026)

| Proveedor    | Plan            | Especificaciones       | Precio/mes  | Notas                                                |
| ------------ | --------------- | ---------------------- | ----------- | ---------------------------------------------------- |
| Oracle Cloud | Always Free ARM | hasta 4 OCPU, 24GB RAM | $0          | ARM, capacidad limitada / peculiaridades de registro |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | €3.79 (~$4) | Opción paga más barata                               |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6          | UI fácil, buena documentación                        |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6          | Muchas ubicaciones                                   |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5          | Ahora parte de Akamai                                |

**Eligiendo un proveedor:**

- DigitalOcean: UX más simple + configuración predecible (esta guía)
- Hetzner: buen precio/rendimiento (ver [guía de Hetzner](/es-ES/install/hetzner))
- Oracle Cloud: puede ser $0/mes, pero es más caprichoso y solo ARM (ver [guía de Oracle](/es-ES/platforms/oracle))

---

## Requisitos previos

- Cuenta de DigitalOcean ([registro con $200 de crédito gratis](https://m.do.co/c/signup))
- Par de claves SSH (o disposición a usar autenticación por contraseña)
- ~20 minutos

## 1) Crear un Droplet

1. Inicia sesión en [DigitalOcean](https://cloud.digitalocean.com/)
2. Haz clic en **Crear → Droplets**
3. Elige:
   - **Región:** Más cercana a ti (o a tus usuarios)
   - **Imagen:** Ubuntu 24.04 LTS
   - **Tamaño:** Basic → Regular → **$6/mes** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Autenticación:** Clave SSH (recomendada) o contraseña
4. Haz clic en **Crear Droplet**
5. Anota la dirección IP

## 2) Conectar vía SSH

```bash
ssh root@TU_IP_DROPLET
```

## 3) Instalar OpenClaw

```bash
# Actualizar sistema
apt update && apt upgrade -y

# Instalar Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Instalar OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verificar
openclaw --version
```

## 4) Ejecutar Incorporación

```bash
openclaw onboard --install-daemon
```

El asistente te guiará a través de:

- Autenticación de modelo (claves de API u OAuth)
- Configuración de canal (Telegram, WhatsApp, Discord, etc.)
- Token del gateway (auto-generado)
- Instalación de daemon (systemd)

## 5) Verificar el Gateway

```bash
# Verificar estado
openclaw status

# Verificar servicio
systemctl --user status openclaw-gateway.service

# Ver registros
journalctl --user -u openclaw-gateway.service -f
```

## 6) Acceder al Panel de Control

El gateway se vincula a loopback por defecto. Para acceder a la Interfaz de Control:

**Opción A: Túnel SSH (recomendado)**

```bash
# Desde tu máquina local
ssh -L 18789:localhost:18789 root@TU_IP_DROPLET

# Luego abre: http://localhost:18789
```

**Opción B: Tailscale Serve (HTTPS, solo loopback)**

```bash
# En el droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configurar Gateway para usar Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Abre: `https://<magicdns>/`

Notas:

- Serve mantiene el Gateway solo en loopback y autentica vía encabezados de identidad de Tailscale.
- Para requerir token/contraseña en su lugar, establece `gateway.auth.allowTailscale: false` o usa `gateway.auth.mode: "password"`.

**Opción C: Vinculación tailnet (sin Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Abre: `http://<tailscale-ip>:18789` (token requerido).

## 7) Conectar tus Canales

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Escanea código QR
```

Ver [Canales](/es-ES/channels) para otros proveedores.

---

## Optimizaciones para 1GB RAM

El droplet de $6 solo tiene 1GB RAM. Para mantener las cosas funcionando sin problemas:

### Agregar swap (recomendado)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Usar un modelo más ligero

Si estás enfrentando OOMs, considera:

- Usar modelos basados en API (Claude, GPT) en lugar de modelos locales
- Establecer `agents.defaults.model.primary` a un modelo más pequeño

### Monitorear memoria

```bash
free -h
htop
```

---

## Persistencia

Todo el estado vive en:

- `~/.openclaw/` — config, credenciales, datos de sesión
- `~/.openclaw/workspace/` — espacio de trabajo (SOUL.md, memoria, etc.)

Estos sobreviven reinicios. Respaldalos periódicamente:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Alternativa Gratuita de Oracle Cloud

Oracle Cloud ofrece instancias ARM **Always Free** que son significativamente más potentes que cualquier opción paga aquí — por $0/mes.

| Lo que obtienes    | Especificaciones      |
| ------------------ | --------------------- |
| **4 OCPUs**        | ARM Ampere A1         |
| **24GB RAM**       | Más que suficiente    |
| **200GB storage**  | Volumen de bloque     |
| **Gratis forever** | Sin cargos de tarjeta |

**Advertencias:**

- El registro puede ser caprichoso (reintenta si falla)
- Arquitectura ARM — la mayoría de las cosas funcionan, pero algunos binarios necesitan compilaciones ARM

Para la guía completa de configuración, ver [Oracle Cloud](/es-ES/platforms/oracle). Para consejos de registro y solución de problemas del proceso de inscripción, ver esta [guía de comunidad](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Solución de Problemas

### El Gateway no inicia

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Puerto ya en uso

```bash
lsof -i :18789
kill <PID>
```

### Falta de memoria

```bash
# Verificar memoria
free -h

# Agregar más swap
# O actualizar al droplet de $12/mes (2GB RAM)
```

---

## Ver También

- [Guía de Hetzner](/es-ES/install/hetzner) — más barato, más potente
- [Instalación con Docker](/es-ES/install/docker) — configuración containerizada
- [Tailscale](/es-ES/gateway/tailscale) — acceso remoto seguro
- [Configuración](/es-ES/gateway/configuration) — referencia completa de config
