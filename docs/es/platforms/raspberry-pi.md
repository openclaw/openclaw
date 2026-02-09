---
summary: "OpenClaw en Raspberry Pi (configuración autoalojada económica)"
read_when:
  - Configurar OpenClaw en una Raspberry Pi
  - Ejecutar OpenClaw en dispositivos ARM
  - Construir una IA personal barata y siempre activa
title: "Raspberry Pi"
---

# OpenClaw en Raspberry Pi

## Objetivo

Ejecutar un Gateway de OpenClaw persistente y siempre activo en una Raspberry Pi por un costo único de **~$35-80** (sin tarifas mensuales).

Perfecto para:

- Asistente de IA personal 24/7
- Hub de automatización del hogar
- Bot de Telegram/WhatsApp de bajo consumo y siempre disponible

## Requisitos de hardware

| Modelo de Pi    | RAM     | ¿Funciona? | Notas                                     |
| --------------- | ------- | ---------- | ----------------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Mejor    | El más rápido, recomendado                |
| **Pi 4**        | 4GB     | ✅ Bueno    | Dulce espacio para la mayoría de usuarios |
| **Pi 4**        | 2GB     | ✅ OK       | Funciona, agregar swap                    |
| **Pi 4**        | 1GB     | ⚠️ Tight   | Posible con swap, config mínima           |
| **Pi 3B+**      | 1GB     | ⚠️ Lento   | Funciona pero es lento                    |
| **Pi Zero 2 W** | 512MB   | ❌          | No recomendado                            |

**Especificaciones mínimas:** 1GB de RAM, 1 núcleo, 500MB de disco  
**Recomendado:** 2GB+ de RAM, SO de 64 bits, tarjeta SD de 16GB+ (o SSD USB)

## Lo que necesitará

- Raspberry Pi 4 o 5 (2GB+ recomendado)
- Tarjeta MicroSD (16GB+) o SSD USB (mejor rendimiento)
- Fuente de alimentación (se recomienda la oficial de Pi)
- Conexión de red (Ethernet o WiFi)
- ~30 minutos

## 1. Grabar el SO

Use **Raspberry Pi OS Lite (64-bit)** — no se necesita escritorio para un servidor headless.

1. Descargue [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Elija SO: **Raspberry Pi OS Lite (64-bit)**
3. Haga clic en el icono de engranaje (⚙️) para preconfigurar:
   - Establecer hostname: `gateway-host`
   - Habilitar SSH
   - Establecer usuario/contraseña
   - Configurar WiFi (si no usa Ethernet)
4. Grabe en su tarjeta SD / unidad USB
5. Inserte y arranque la Pi

## 2) Conectarse por SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. Configuración del sistema

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Instalar Node.js 22 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. Agregar swap (importante para 2GB o menos)

El swap evita fallos por falta de memoria:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. Instalar OpenClaw

### Opción A: Instalación estándar (recomendada)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Opción B: Instalación hackeable (para experimentar)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

La instalación hackeable le da acceso directo a los logs y al código — útil para depurar problemas específicos de ARM.

## 7. Ejecutar el onboarding

```bash
openclaw onboard --install-daemon
```

Siga el asistente:

1. **Modo del Gateway:** Local
2. **Autenticación:** Se recomiendan claves de API (OAuth puede ser delicado en una Pi headless)
3. **Canales:** Telegram es el más fácil para empezar
4. **Daemon:** Sí (systemd)

## 8) Verificar la instalación

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. Acceder al dashboard

Como la Pi es headless, use un túnel SSH:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

O use Tailscale para acceso siempre activo:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Optimizaciones de rendimiento

### Use un SSD USB (gran mejora)

Las tarjetas SD son lentas y se desgastan. Un SSD USB mejora drásticamente el rendimiento:

```bash
# Check if booting from USB
lsblk
```

Vea la [guía de arranque USB de Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) para la configuración.

### Reducir el uso de memoria

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Monitorear recursos

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## Notas específicas de ARM

### Compatibilidad de binarios

La mayoría de las funciones de OpenClaw funcionan en ARM64, pero algunos binarios externos pueden necesitar compilaciones ARM:

| Herramienta                             | Estado ARM64 | Notas                               |
| --------------------------------------- | ------------ | ----------------------------------- |
| Node.js                 | ✅            | Funciona muy bien                   |
| WhatsApp (Baileys)   | ✅            | JS puro, sin problemas              |
| Telegram                                | ✅            | JS puro, sin problemas              |
| gog (Gmail CLI)      | ⚠️           | Verifique si hay versión ARM        |
| Chromium (navegador) | ✅            | `sudo apt install chromium-browser` |

Si una skill falla, verifique si su binario tiene compilación ARM. Muchas herramientas en Go/Rust la tienen; algunas no.

### 32-bit vs 64-bit

**Use siempre un SO de 64 bits.** Node.js y muchas herramientas modernas lo requieren. Verifique con:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Configuración recomendada de modelos

Como la Pi es solo el Gateway (los modelos se ejecutan en la nube), use modelos basados en API:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**No intente ejecutar LLMs locales en una Pi** — incluso los modelos pequeños son demasiado lentos. Deje que Claude/GPT hagan el trabajo pesado.

---

## Inicio automático al arrancar

El asistente de onboarding lo configura, pero para verificar:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## Solución de problemas

### Falta de memoria (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Rendimiento lento

- Use SSD USB en lugar de tarjeta SD
- Deshabilite servicios no usados: `sudo systemctl disable cups bluetooth avahi-daemon`
- Verifique la limitación térmica de la CPU: `vcgencmd get_throttled` (debería devolver `0x0`)

### El servicio no inicia

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### Problemas de binarios ARM

Si una skill falla con "exec format error":

1. Verifique si el binario tiene compilación ARM64
2. Intente compilar desde el código fuente
3. O use un contenedor Docker con soporte ARM

### Caídas de WiFi

Para Pis headless con WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Comparación de costos

| Configuración                     | Costo único          | Costo mensual             | Notas                                                  |
| --------------------------------- | -------------------- | ------------------------- | ------------------------------------------------------ |
| **Pi 4 (2GB)** | ~$45 | $0                        | + energía (~$5/año) |
| **Pi 4 (4GB)** | ~$55 | $0                        | Recomendado                                            |
| **Pi 5 (4GB)** | ~$60 | $0                        | Mejor rendimiento                                      |
| **Pi 5 (8GB)** | ~$80 | $0                        | Excesivo pero a prueba de futuro                       |
| DigitalOcean                      | $0                   | $6/mes                    | $72/año                                                |
| Hetzner                           | $0                   | €3.79/mes | ~$50/año                               |

**Punto de equilibrio:** Una Pi se paga sola en ~6-12 meses frente a un VPS en la nube.

---

## Ver también

- [Guía de Linux](/platforms/linux) — configuración general en Linux
- [Guía de DigitalOcean](/platforms/digitalocean) — alternativa en la nube
- [Guía de Hetzner](/install/hetzner) — configuración con Docker
- [Tailscale](/gateway/tailscale) — acceso remoto
- [Nodes](/nodes) — empareje su laptop/teléfono con el Gateway de la Pi
