---
summary: "Instalación automatizada y reforzada de OpenClaw con Ansible, VPN Tailscale y aislamiento por firewall"
read_when:
  - Desea un despliegue automatizado del servidor con refuerzo de seguridad
  - Necesita una configuración aislada por firewall con acceso mediante VPN
  - Está desplegando en servidores Debian/Ubuntu remotos
title: "Ansible"
---

# Instalación con Ansible

La forma recomendada de desplegar OpenClaw en servidores de producción es mediante **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — un instalador automatizado con una arquitectura orientada a la seguridad.

## Inicio rápido

Instalación con un solo comando:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Guía completa: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> El repositorio openclaw-ansible es la fuente de verdad para el despliegue con Ansible. Esta página es una vista general rápida.

## Qué obtiene

- 🔒 **Seguridad centrada en firewall**: UFW + aislamiento de Docker (solo SSH + Tailscale accesibles)
- 🔐 **VPN Tailscale**: Acceso remoto seguro sin exponer servicios públicamente
- 🐳 **Docker**: Contenedores sandbox aislados, enlaces solo a localhost
- 🛡️ **Defensa en profundidad**: Arquitectura de seguridad en 4 capas
- 🚀 **Configuración con un solo comando**: Despliegue completo en minutos
- 🔧 **Integración con systemd**: Inicio automático al arrancar con refuerzo de seguridad

## Requisitos

- **SO**: Debian 11+ o Ubuntu 20.04+
- **Acceso**: Privilegios de root o sudo
- **Red**: Conexión a Internet para la instalación de paquetes
- **Ansible**: 2.14+ (instalado automáticamente por el script de inicio rápido)

## Qué se instala

El playbook de Ansible instala y configura:

1. **Tailscale** (VPN mesh para acceso remoto seguro)
2. **Firewall UFW** (solo puertos SSH + Tailscale)
3. **Docker CE + Compose V2** (para sandboxes de agentes)
4. **Node.js 22.x + pnpm** (dependencias de tiempo de ejecución)
5. **OpenClaw** (basado en host, no en contenedores)
6. **Servicio systemd** (inicio automático con refuerzo de seguridad)

Nota: El Gateway se ejecuta **directamente en el host** (no en Docker), pero los sandboxes de agentes usan Docker para aislamiento. Consulte [Sandboxing](/gateway/sandboxing) para más detalles.

## Configuración posterior a la instalación

Una vez que finalice la instalación, cambie al usuario openclaw:

```bash
sudo -i -u openclaw
```

El script posterior a la instalación le guiará a través de:

1. **Asistente de incorporación**: Configurar los ajustes de OpenClaw
2. **Inicio de sesión del proveedor**: Conectar WhatsApp/Telegram/Discord/Signal
3. **Pruebas del Gateway**: Verificar la instalación
4. **Configuración de Tailscale**: Conectarse a su malla VPN

### Comandos rápidos

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## Arquitectura de seguridad

### Defensa en 4 capas

1. **Firewall (UFW)**: Solo SSH (22) + Tailscale (41641/udp) expuestos públicamente
2. **VPN (Tailscale)**: El Gateway es accesible únicamente a través de la malla VPN
3. **Aislamiento de Docker**: La cadena iptables DOCKER-USER evita la exposición de puertos externos
4. **Refuerzo de systemd**: NoNewPrivileges, PrivateTmp, usuario sin privilegios

### Verificación

Pruebe la superficie de ataque externa:

```bash
nmap -p- YOUR_SERVER_IP
```

Debería mostrar **solo el puerto 22** (SSH) abierto. Todos los demás servicios (Gateway, Docker) están bloqueados.

### Disponibilidad de Docker

Docker se instala para **sandboxes de agentes** (ejecución aislada de herramientas), no para ejecutar el Gateway en sí. El Gateway se vincula solo a localhost y es accesible mediante la VPN Tailscale.

Consulte [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para la configuración del sandbox.

## Instalación manual

Si prefiere control manual sobre la automatización:

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## Actualización de OpenClaw

El instalador de Ansible configura OpenClaw para actualizaciones manuales. Consulte [Actualización](/install/updating) para el flujo estándar de actualización.

Para volver a ejecutar el playbook de Ansible (por ejemplo, para cambios de configuración):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Nota: Esto es idempotente y seguro para ejecutarse varias veces.

## Solución de problemas

### El firewall bloquea mi conexión

Si quedó bloqueado:

- Asegúrese de poder acceder primero mediante la VPN Tailscale
- El acceso SSH (puerto 22) siempre está permitido
- El Gateway es accesible **solo** mediante Tailscale por diseño

### El servicio no inicia

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Problemas con el sandbox de Docker

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Falla el inicio de sesión del proveedor

Asegúrese de estar ejecutando como el usuario `openclaw`:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Configuración avanzada

Para arquitectura de seguridad detallada y solución de problemas:

- [Arquitectura de seguridad](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Detalles técnicos](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Guía de solución de problemas](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Relacionado

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — guía completa de despliegue
- [Docker](/install/docker) — configuración del Gateway en contenedores
- [Sandboxing](/gateway/sandboxing) — configuración del sandbox de agentes
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — aislamiento por agente
