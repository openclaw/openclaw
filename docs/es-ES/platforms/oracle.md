---
summary: "OpenClaw en Oracle Cloud (Always Free ARM)"
read_when:
  - Configurando OpenClaw en Oracle Cloud
  - Buscando hosting VPS de bajo costo para OpenClaw
  - Quieres OpenClaw 24/7 en un servidor pequeño
title: "Oracle Cloud"
---

# OpenClaw en Oracle Cloud (OCI)

## Objetivo

Ejecutar un Gateway OpenClaw persistente en el nivel ARM **Always Free** de Oracle Cloud.

El nivel gratuito de Oracle puede ser una excelente opción para OpenClaw (especialmente si ya tienes una cuenta OCI), pero viene con compensaciones:

- Arquitectura ARM (la mayoría de las cosas funcionan, pero algunos binarios pueden ser solo x86)
- La capacidad y el registro pueden ser caprichosos

## Comparación de Costos (2026)

| Proveedor    | Plan            | Especificaciones       | Precio/mes | Notas                         |
| ------------ | --------------- | ---------------------- | ---------- | ----------------------------- |
| Oracle Cloud | Always Free ARM | hasta 4 OCPU, 24GB RAM | $0         | ARM, capacidad limitada       |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | ~ $4       | Opción paga más barata        |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6         | UI fácil, buena documentación |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6         | Muchas ubicaciones            |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5         | Ahora parte de Akamai         |

---

## Requisitos previos

- Cuenta de Oracle Cloud ([registro](https://www.oracle.com/cloud/free/)) — ver [guía de registro de comunidad](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) si encuentras problemas
- Cuenta de Tailscale (gratis en [tailscale.com](https://tailscale.com))
- ~30 minutos

## 1) Crear una Instancia OCI

1. Inicia sesión en [Oracle Cloud Console](https://cloud.oracle.com/)
2. Navega a **Compute → Instances → Create Instance**
3. Configura:
   - **Nombre:** `openclaw`
   - **Imagen:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (o hasta 4)
   - **Memoria:** 12 GB (o hasta 24 GB)
   - **Volumen de arranque:** 50 GB (hasta 200 GB gratis)
   - **Clave SSH:** Agrega tu clave pública
4. Haz clic en **Create**
5. Anota la dirección IP pública

**Consejo:** Si la creación de instancia falla con "Out of capacity", intenta un dominio de disponibilidad diferente o reintenta más tarde. La capacidad del nivel gratuito es limitada.

## 2) Conectar y Actualizar

```bash
# Conectar vía IP pública
ssh ubuntu@TU_IP_PUBLICA

# Actualizar sistema
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Nota:** `build-essential` es requerido para compilación ARM de algunas dependencias.

## 3) Configurar Usuario y Hostname

```bash
# Establecer hostname
sudo hostnamectl set-hostname openclaw

# Establecer contraseña para usuario ubuntu
sudo passwd ubuntu

# Habilitar lingering (mantiene servicios de usuario ejecutándose después del logout)
sudo loginctl enable-linger ubuntu
```

## 4) Instalar Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Esto habilita Tailscale SSH, para que puedas conectarte vía `ssh openclaw` desde cualquier dispositivo en tu tailnet — no se necesita IP pública.

Verificar:

```bash
tailscale status
```

**De ahora en adelante, conecta vía Tailscale:** `ssh ubuntu@openclaw` (o usa la IP de Tailscale).

## 5) Instalar OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Cuando se te pregunte "¿Cómo quieres incubar tu bot?", selecciona **"Hacer esto más tarde"**.

> Nota: Si encuentras problemas de compilación nativa ARM, comienza con paquetes del sistema (ej. `sudo apt install -y build-essential`) antes de recurrir a Homebrew.

## 6) Configurar Gateway (loopback + autenticación por token) y habilitar Tailscale Serve

Usa autenticación por token como predeterminada. Es predecible y evita necesitar banderas de "autenticación insegura" en la Interfaz de Control.

```bash
# Mantener el Gateway privado en la VM
openclaw config set gateway.bind loopback

# Requerir autenticación para Gateway + Interfaz de Control
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Exponer sobre Tailscale Serve (HTTPS + acceso tailnet)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7) Verificar

```bash
# Verificar versión
openclaw --version

# Verificar estado del daemon
systemctl --user status openclaw-gateway

# Verificar Tailscale Serve
tailscale serve status

# Probar respuesta local
curl http://localhost:18789
```

## 8) Asegurar Seguridad VCN

Ahora que todo funciona, asegura la VCN para bloquear todo el tráfico excepto Tailscale. La Red en la Nube Virtual de OCI actúa como un firewall en el borde de la red — el tráfico es bloqueado antes de alcanzar tu instancia.

1. Ve a **Networking → Virtual Cloud Networks** en la Consola OCI
2. Haz clic en tu VCN → **Security Lists** → Default Security List
3. **Elimina** todas las reglas de ingreso excepto:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Mantén las reglas de egreso predeterminadas (permitir todo saliente)

Esto bloquea SSH en puerto 22, HTTP, HTTPS, y todo lo demás en el borde de la red. De ahora en adelante, solo puedes conectarte vía Tailscale.

---

## Acceder a la Interfaz de Control

Desde cualquier dispositivo en tu red Tailscale:

```
https://openclaw.<nombre-tailnet>.ts.net/
```

Reemplaza `<nombre-tailnet>` con tu nombre de tailnet (visible en `tailscale status`).

No se necesita túnel SSH. Tailscale proporciona:

- Cifrado HTTPS (certificados automáticos)
- Autenticación vía identidad Tailscale
- Acceso desde cualquier dispositivo en tu tailnet (laptop, teléfono, etc.)

---

## Seguridad: VCN + Tailscale (línea base recomendada)

Con la VCN asegurada (solo UDP 41641 abierto) y el Gateway vinculado a loopback, obtienes una fuerte defensa en profundidad: el tráfico público es bloqueado en el borde de la red, y el acceso administrativo ocurre sobre tu tailnet.

Esta configuración a menudo elimina la _necesidad_ de reglas de firewall adicionales basadas en host puramente para detener fuerza bruta SSH a nivel de Internet — pero aún deberías mantener el SO actualizado, ejecutar `openclaw security audit`, y verificar que no estés escuchando accidentalmente en interfaces públicas.

### Lo que Ya Está Protegido

| Paso Tradicional           | ¿Necesario?   | Por qué                                                                     |
| -------------------------- | ------------- | --------------------------------------------------------------------------- |
| Firewall UFW               | No            | VCN bloquea antes de que el tráfico alcance la instancia                    |
| fail2ban                   | No            | Sin fuerza bruta si el puerto 22 está bloqueado en VCN                      |
| Endurecimiento sshd        | No            | Tailscale SSH no usa sshd                                                   |
| Deshabilitar login root    | No            | Tailscale usa identidad Tailscale, no usuarios del sistema                  |
| Autenticación solo SSH key | No            | Tailscale autentica vía tu tailnet                                          |
| Endurecimiento IPv6        | Usualmente no | Depende de tu configuración VCN/subnet; verifica qué está asignado/expuesto |

### Aún Recomendado

- **Permisos de credenciales:** `chmod 700 ~/.openclaw`
- **Auditoría de seguridad:** `openclaw security audit`
- **Actualizaciones del sistema:** `sudo apt update && sudo apt upgrade` regularmente
- **Monitorear Tailscale:** Revisar dispositivos en [consola admin de Tailscale](https://login.tailscale.com/admin)

### Verificar Postura de Seguridad

```bash
# Confirmar que no hay puertos públicos escuchando
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verificar que Tailscale SSH está activo
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH activo"

# Opcional: deshabilitar sshd por completo
sudo systemctl disable --now ssh
```

---

## Respaldo: Túnel SSH

Si Tailscale Serve no funciona, usa un túnel SSH:

```bash
# Desde tu máquina local (vía Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Luego abre `http://localhost:18789`.

---

## Solución de Problemas

### Creación de instancia falla ("Out of capacity")

Las instancias ARM del nivel gratuito son populares. Intenta:

- Dominio de disponibilidad diferente
- Reintentar durante horas de menor uso (madrugada)
- Usar el filtro "Always Free" al seleccionar shape

### Tailscale no conecta

```bash
# Verificar estado
sudo tailscale status

# Re-autenticar
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway no inicia

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### No puedo alcanzar la Interfaz de Control

```bash
# Verificar que Tailscale Serve está ejecutándose
tailscale serve status

# Verificar que el gateway está escuchando
curl http://localhost:18789

# Reiniciar si es necesario
systemctl --user restart openclaw-gateway
```

### Problemas con binarios ARM

Algunas herramientas pueden no tener compilaciones ARM. Verifica:

```bash
uname -m  # Debería mostrar aarch64
```

La mayoría de los paquetes npm funcionan bien. Para binarios, busca lanzamientos `linux-arm64` o `aarch64`.

---

## Persistencia

Todo el estado vive en:

- `~/.openclaw/` — config, credenciales, datos de sesión
- `~/.openclaw/workspace/` — espacio de trabajo (SOUL.md, memoria, artefactos)

Respalda periódicamente:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Ver También

- [Acceso remoto al Gateway](/es-ES/gateway/remote) — otros patrones de acceso remoto
- [Integración con Tailscale](/es-ES/gateway/tailscale) — documentación completa de Tailscale
- [Configuración del Gateway](/es-ES/gateway/configuration) — todas las opciones de config
- [Guía de DigitalOcean](/es-ES/platforms/digitalocean) — si quieres pago + registro más fácil
- [Guía de Hetzner](/es-ES/install/hetzner) — alternativa basada en Docker
