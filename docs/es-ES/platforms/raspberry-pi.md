---
summary: "OpenClaw en Raspberry Pi (configuración auto-hospedada económica)"
read_when:
  - Configurando OpenClaw en una Raspberry Pi
  - Ejecutando OpenClaw en dispositivos ARM
  - Construyendo una IA personal económica siempre activa
title: "Raspberry Pi"
---

# OpenClaw en Raspberry Pi

## Objetivo

Ejecutar un Gateway OpenClaw persistente, siempre activo en una Raspberry Pi por **~$35-80** costo único (sin tarifas mensuales).

Perfecto para:

- Asistente de IA personal 24/7
- Hub de automatización del hogar
- Bot de Telegram/WhatsApp de bajo consumo, siempre disponible

## Requisitos de Hardware

| Modelo Pi       | RAM     | ¿Funciona? | Notas                                     |
| --------------- | ------- | ---------- | ----------------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Mejor   | Más rápida, recomendada                   |
| **Pi 4**        | 4GB     | ✅ Buena   | Punto óptimo para la mayoría de usuarios |
| **Pi 4**        | 2GB     | ✅ OK      | Funciona, agregar swap                    |
| **Pi 4**        | 1GB     | ⚠️ Justo   | Posible con swap, config mínima           |
| **Pi 3B+**      | 1GB     | ⚠️ Lenta   | Funciona pero lenta                       |
| **Pi Zero 2 W** | 512MB   | ❌         | No recomendada                            |

**Especificaciones mínimas:** 1GB RAM, 1 núcleo, 500MB disco  
**Recomendado:** 2GB+ RAM, SO 64-bit, tarjeta SD de 16GB+ (o SSD USB)

## Lo que Necesitarás

- Raspberry Pi 4 o 5 (2GB+ recomendado)
- Tarjeta MicroSD (16GB+) o SSD USB (mejor rendimiento)
- Fuente de alimentación (PSU oficial de Pi recomendada)
- Conexión de red (Ethernet o WiFi)
- ~30 minutos

## 1) Flashear el SO

Usa **Raspberry Pi OS Lite (64-bit)** — no se necesita escritorio para un servidor sin interfaz.

1. Descarga [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Elige SO: **Raspberry Pi OS Lite (64-bit)**
3. Haz clic en el ícono de engranaje (⚙️) para pre-configurar:
   - Establecer hostname: `gateway-host`
   - Habilitar SSH
   - Establecer usuario/contraseña
   - Configurar WiFi (si no usas Ethernet)
4. Flashea a tu tarjeta SD / unidad USB
5. Inserta e inicia la Pi

## 2) Conectar vía SSH

```bash
ssh user@gateway-host
# o usa la dirección IP
ssh user@192.168.x.x
```

## 3) Configuración del Sistema

```bash
# Actualizar sistema
sudo apt update && sudo apt upgrade -y

# Instalar paquetes esenciales
sudo apt install -y git curl build-essential

# Establecer zona horaria (importante para cron/recordatorios)
sudo timedatectl set-timezone America/Chicago  # Cambia a tu zona horaria
```

## 4) Instalar Node.js 22 (ARM64)

```bash
# Instalar Node.js vía NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verificar
node --version  # Debería mostrar v22.x.x
npm --version
```

## 5) Agregar Swap (Importante para 2GB o menos)

El swap previene caídas por falta de memoria:

```bash
# Crear archivo de swap de 2GB
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Hacer permanente
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimizar para poca RAM (reducir swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) Instalar OpenClaw

### Opción A: Instalación Estándar (Recomendada)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Opción B: Instalación Hackeable (Para experimentar)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

La instalación hackeable te da acceso directo a registros y código — útil para depurar problemas específicos de ARM.

## 7) Ejecutar Incorporación

```bash
openclaw onboard --install-daemon
```

Sigue el asistente:

1. **Modo Gateway:** Local
2. **Autenticación:** Claves de API recomendadas (OAuth puede ser complicado en Pi sin interfaz)
3. **Canales:** Telegram es el más fácil para empezar
4. **Daemon:** Sí (systemd)

## 8) Verificar Instalación

```bash
# Verificar estado
openclaw status

# Verificar servicio
sudo systemctl status openclaw

# Ver registros
journalctl -u openclaw -f
```

## 9) Acceder al Panel de Control

Como la Pi no tiene interfaz, usa un túnel SSH:

```bash
# Desde tu laptop/escritorio
ssh -L 18789:localhost:18789 user@gateway-host

# Luego abre en navegador
open http://localhost:18789
```

O usa Tailscale para acceso siempre activo:

```bash
# En la Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Actualizar config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## Optimizaciones de Rendimiento

### Usar un SSD USB (Mejora Enorme)

Las tarjetas SD son lentas y se desgastan. Un SSD USB mejora dramáticamente el rendimiento:

```bash
# Verificar si arranca desde USB
lsblk
```

Ver [guía de arranque USB de Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) para configuración.

### Reducir Uso de Memoria

```bash
# Deshabilitar asignación de memoria GPU (sin interfaz)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Deshabilitar Bluetooth si no se necesita
sudo systemctl disable bluetooth
```

### Monitorear Recursos

```bash
# Verificar memoria
free -h

# Verificar temperatura CPU
vcgencmd measure_temp

# Monitoreo en vivo
htop
```

---

## Notas Específicas de ARM

### Compatibilidad de Binarios

La mayoría de las características de OpenClaw funcionan en ARM64, pero algunos binarios externos pueden necesitar compilaciones ARM:

| Herramienta        | Estado ARM64 | Notas                                          |
| ------------------ | ------------ | ---------------------------------------------- |
| Node.js            | ✅           | Funciona excelente                             |
| WhatsApp (Baileys) | ✅           | JS puro, sin problemas                         |
| Telegram           | ✅           | JS puro, sin problemas                         |
| gog (Gmail CLI)    | ⚠️           | Verificar lanzamiento ARM                      |
| Chromium (browser) | ✅           | `sudo apt install chromium-browser`            |

Si una habilidad falla, verifica si su binario tiene una compilación ARM. Muchas herramientas Go/Rust la tienen; algunas no.

### 32-bit vs 64-bit

**Siempre usa SO 64-bit.** Node.js y muchas herramientas modernas lo requieren. Verifica con:

```bash
uname -m
# Debería mostrar: aarch64 (64-bit) no armv7l (32-bit)
```

---

## Configuración de Modelo Recomendada

Como la Pi es solo el Gateway (los modelos se ejecutan en la nube), usa modelos basados en API:

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

**No intentes ejecutar LLMs locales en una Pi** — incluso los modelos pequeños son demasiado lentos. Deja que Claude/GPT hagan el trabajo pesado.

---

## Inicio Automático al Arrancar

El asistente de incorporación configura esto, pero para verificar:

```bash
# Verificar que el servicio esté habilitado
sudo systemctl is-enabled openclaw

# Habilitar si no lo está
sudo systemctl enable openclaw

# Iniciar al arrancar
sudo systemctl start openclaw
```

---

## Solución de Problemas

### Falta de Memoria (OOM)

```bash
# Verificar memoria
free -h

# Agregar más swap (ver Paso 5)
# O reducir servicios ejecutándose en la Pi
```

### Rendimiento Lento

- Usar SSD USB en lugar de tarjeta SD
- Deshabilitar servicios no usados: `sudo systemctl disable cups bluetooth avahi-daemon`
- Verificar throttling de CPU: `vcgencmd get_throttled` (debería retornar `0x0`)

### El Servicio No Inicia

```bash
# Verificar registros
journalctl -u openclaw --no-pager -n 100

# Solución común: reconstruir
cd ~/openclaw  # si usas instalación hackeable
npm run build
sudo systemctl restart openclaw
```

### Problemas con Binarios ARM

Si una habilidad falla con "exec format error":

1. Verifica si el binario tiene una compilación ARM64
2. Intenta compilar desde código fuente
3. O usa un contenedor Docker con soporte ARM

### Caídas de WiFi

Para Pis sin interfaz en WiFi:

```bash
# Deshabilitar gestión de energía WiFi
sudo iwconfig wlan0 power off

# Hacer permanente
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Comparación de Costos

| Configuración  | Costo Único | Costo Mensual | Notas                          |
| -------------- | ----------- | ------------- | ------------------------------ |
| **Pi 4 (2GB)** | ~$45        | $0            | + energía (~$5/año)            |
| **Pi 4 (4GB)** | ~$55        | $0            | Recomendado                    |
| **Pi 5 (4GB)** | ~$60        | $0            | Mejor rendimiento              |
| **Pi 5 (8GB)** | ~$80        | $0            | Excesivo pero a prueba de futuro |
| DigitalOcean   | $0          | $6/mes        | $72/año                        |
| Hetzner        | $0          | €3.79/mes     | ~$50/año                       |

**Punto de equilibrio:** Una Pi se paga a sí misma en ~6-12 meses vs VPS en la nube.

---

## Ver También

- [Guía de Linux](/es-ES/platforms/linux) — configuración general de Linux
- [Guía de DigitalOcean](/es-ES/platforms/digitalocean) — alternativa en la nube
- [Guía de Hetzner](/es-ES/install/hetzner) — configuración con Docker
- [Tailscale](/es-ES/gateway/tailscale) — acceso remoto
- [Nodos](/es-ES/nodes) — empareja tu laptop/teléfono con el gateway Pi
