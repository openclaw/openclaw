---
summary: "Instalación de OpenClaw automatizada y endurecida con Ansible, Tailscale VPN y aislamiento de firewall"
read_when:
  - Quieres despliegue de servidor automatizado con endurecimiento de seguridad
  - Necesitas configuración aislada con firewall con acceso VPN
  - Estás desplegando a servidores Debian/Ubuntu remotos
title: "Ansible"
---

# Instalación con Ansible

La forma recomendada de desplegar OpenClaw a servidores de producción es mediante **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — un instalador automatizado con arquitectura de seguridad primero.

## Inicio Rápido

Instalación con un comando:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Guía completa: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> El repositorio openclaw-ansible es la fuente de verdad para el despliegue con Ansible. Esta página es una descripción rápida.

## Lo Que Obtienes

- 🔒 **Seguridad con firewall primero**: Aislamiento UFW + Docker (solo SSH + Tailscale accesibles)
- 🔐 **VPN Tailscale**: Acceso remoto seguro sin exponer servicios públicamente
- 🐳 **Docker**: Contenedores sandbox aislados, enlaces solo localhost
- 🛡️ **Defensa en profundidad**: Arquitectura de seguridad de 4 capas
- 🚀 **Configuración con un comando**: Despliegue completo en minutos
- 🔧 **Integración Systemd**: Auto-inicio al arrancar con endurecimiento

## Requisitos

- **SO**: Debian 11+ o Ubuntu 20.04+
- **Acceso**: Privilegios root o sudo
- **Red**: Conexión a Internet para instalación de paquetes
- **Ansible**: 2.14+ (instalado automáticamente por script de inicio rápido)

## Qué Se Instala

El playbook de Ansible instala y configura:

1. **Tailscale** (VPN mesh para acceso remoto seguro)
2. **Firewall UFW** (solo puertos SSH + Tailscale)
3. **Docker CE + Compose V2** (para sandboxes de agente)
4. **Node.js 22.x + pnpm** (dependencias de runtime)
5. **OpenClaw** (basado en host, no contenedorizado)
6. **Servicio Systemd** (auto-inicio con endurecimiento de seguridad)

Nota: El gateway se ejecuta **directamente en el host** (no en Docker), pero los sandboxes de agente usan Docker para aislamiento. Ver [Sandboxing](/es-ES/gateway/sandboxing) para detalles.

## Configuración Post-Instalación

Después de que la instalación se complete, cambia al usuario openclaw:

```bash
sudo -i -u openclaw
```

El script post-instalación te guiará a través de:

1. **Asistente de incorporación**: Configurar ajustes de OpenClaw
2. **Inicio de sesión de proveedor**: Conectar WhatsApp/Telegram/Discord/Signal
3. **Prueba de gateway**: Verificar la instalación
4. **Configuración de Tailscale**: Conectar a tu mesh VPN

### Comandos rápidos

```bash
# Verificar estado del servicio
sudo systemctl status openclaw

# Ver registros en vivo
sudo journalctl -u openclaw -f

# Reiniciar gateway
sudo systemctl restart openclaw

# Inicio de sesión de proveedor (ejecutar como usuario openclaw)
sudo -i -u openclaw
openclaw channels login
```

## Arquitectura de Seguridad

### Defensa de 4 Capas

1. **Firewall (UFW)**: Solo SSH (22) + Tailscale (41641/udp) expuestos públicamente
2. **VPN (Tailscale)**: Gateway accesible solo mediante mesh VPN
3. **Aislamiento Docker**: Cadena iptables DOCKER-USER previene exposición de puertos externos
4. **Endurecimiento Systemd**: NoNewPrivileges, PrivateTmp, usuario sin privilegios

### Verificación

Probar superficie de ataque externo:

```bash
nmap -p- YOUR_SERVER_IP
```

Debería mostrar **solo puerto 22** (SSH) abierto. Todos los demás servicios (gateway, Docker) están bloqueados.

### Disponibilidad de Docker

Docker está instalado para **sandboxes de agente** (ejecución de herramientas aisladas), no para ejecutar el gateway mismo. El gateway se enlaza solo a localhost y es accesible mediante VPN Tailscale.

Ver [Multi-Agent Sandbox & Tools](/es-ES/tools/multi-agent-sandbox-tools) para configuración de sandbox.

## Instalación Manual

Si prefieres control manual sobre la automatización:

```bash
# 1. Instalar prerequisitos
sudo apt update && sudo apt install -y ansible git

# 2. Clonar repositorio
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Instalar colecciones de Ansible
ansible-galaxy collection install -r requirements.yml

# 4. Ejecutar playbook
./run-playbook.sh

# O ejecutar directamente (luego ejecutar manualmente /tmp/openclaw-setup.sh después)
# ansible-playbook playbook.yml --ask-become-pass
```

## Actualizar OpenClaw

El instalador de Ansible configura OpenClaw para actualizaciones manuales. Ver [Updating](/es-ES/install/updating) para el flujo de actualización estándar.

Para volver a ejecutar el playbook de Ansible (ej., para cambios de configuración):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Nota: Esto es idempotente y seguro de ejecutar múltiples veces.

## Solución de problemas

### El firewall bloquea mi conexión

Si estás bloqueado:

- Asegúrate de poder acceder mediante VPN Tailscale primero
- El acceso SSH (puerto 22) siempre está permitido
- El gateway es **solo** accesible mediante Tailscale por diseño

### El servicio no inicia

```bash
# Verificar registros
sudo journalctl -u openclaw -n 100

# Verificar permisos
sudo ls -la /opt/openclaw

# Probar inicio manual
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Problemas de sandbox Docker

```bash
# Verificar que Docker esté ejecutándose
sudo systemctl status docker

# Verificar imagen de sandbox
sudo docker images | grep openclaw-sandbox

# Construir imagen de sandbox si falta
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### El inicio de sesión de proveedor falla

Asegúrate de estar ejecutando como usuario `openclaw`:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Configuración Avanzada

Para arquitectura de seguridad detallada y solución de problemas:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Relacionado

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — guía de despliegue completa
- [Docker](/es-ES/install/docker) — configuración de gateway en contenedor
- [Sandboxing](/es-ES/gateway/sandboxing) — configuración de sandbox de agente
- [Multi-Agent Sandbox & Tools](/es-ES/tools/multi-agent-sandbox-tools) — aislamiento por agente
