---
summary: "OpenClaw en Oracle Cloud (ARM Always Free)"
read_when:
  - Configurar OpenClaw en Oracle Cloud
  - Buscar hosting VPS de bajo costo para OpenClaw
  - Querer OpenClaw 24/7 en un servidor pequeño
title: "Oracle Cloud"
---

# OpenClaw en Oracle Cloud (OCI)

## Objetivo

Ejecutar un Gateway de OpenClaw persistente en el nivel **Always Free** ARM de Oracle Cloud.

El nivel gratuito de Oracle puede ser una excelente opción para OpenClaw (especialmente si ya tiene una cuenta de OCI), pero tiene compromisos:

- Arquitectura ARM (la mayoría de las cosas funcionan, pero algunos binarios pueden ser solo x86)
- La capacidad y el registro pueden ser inestables

## Comparación de costos (2026)

| Proveedor    | Plan            | Especificaciones       | Precio/mes           | Notas                   |
| ------------ | --------------- | ---------------------- | -------------------- | ----------------------- |
| Oracle Cloud | Always Free ARM | hasta 4 OCPU, 24GB RAM | $0                   | ARM, capacidad limitada |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | ~ $4 | Opción paga más barata  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6                   | UI sencilla, buena doc  |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6                   | Muchas ubicaciones      |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5                   | Ahora parte de Akamai   |

---

## Requisitos previos

- Cuenta de Oracle Cloud ([registro](https://www.oracle.com/cloud/free/)) — vea la [guía comunitaria de registro](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) si encuentra problemas
- Cuenta de Tailscale (gratis en [tailscale.com](https://tailscale.com))
- ~30 minutos

## 1. Crear una instancia de OCI

1. Inicie sesión en [Oracle Cloud Console](https://cloud.oracle.com/)
2. Navegue a **Compute → Instances → Create Instance**
3. Configure:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (o hasta 4)
   - **Memory:** 12 GB (o hasta 24 GB)
   - **Boot volume:** 50 GB (hasta 200 GB gratis)
   - **SSH key:** Agregue su clave pública
4. Haga clic en **Create**
5. Anote la dirección IP pública

**Consejo:** Si la creación de la instancia falla con "Out of capacity", pruebe un dominio de disponibilidad diferente o intente más tarde. La capacidad del nivel gratuito es limitada.

## 2. Conectar y actualizar

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Nota:** `build-essential` es requerido para la compilación ARM de algunas dependencias.

## 3. Configurar usuario y nombre de host

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Instalar Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Esto habilita SSH de Tailscale, para que pueda conectarse vía `ssh openclaw` desde cualquier dispositivo en su tailnet — no se necesita IP pública.

Verificar:

```bash
tailscale status
```

**De ahora en adelante, conéctese vía Tailscale:** `ssh ubuntu@openclaw` (o use la IP de Tailscale).

## 5. Instalar OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Cuando se le pregunte "How do you want to hatch your bot?", seleccione **"Do this later"**.

> Nota: Si encuentra problemas de compilación nativa en ARM, comience con paquetes del sistema (p. ej., `sudo apt install -y build-essential`) antes de recurrir a Homebrew.

## 6. Configurar el Gateway (loopback + autenticación por token) y habilitar Tailscale Serve

Use la autenticación por token como predeterminada. Es predecible y evita necesitar banderas de Control UI de “insecure auth”.

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. Verificar

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. Asegurar la VCN

Ahora que todo funciona, asegure la VCN para bloquear todo el tráfico excepto Tailscale. La Virtual Cloud Network de OCI actúa como un firewall en el borde de la red — el tráfico se bloquea antes de llegar a su instancia.

1. Vaya a **Networking → Virtual Cloud Networks** en la consola de OCI
2. Haga clic en su VCN → **Security Lists** → Default Security List
3. **Elimine** todas las reglas de ingreso excepto:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Mantenga las reglas de salida predeterminadas (permitir todo el tráfico saliente)

Esto bloquea SSH en el puerto 22, HTTP, HTTPS y todo lo demás en el borde de la red. A partir de ahora, solo puede conectarse vía Tailscale.

---

## Acceder a la Control UI

Desde cualquier dispositivo en su red de Tailscale:

```
https://openclaw.<tailnet-name>.ts.net/
```

Reemplace `<tailnet-name>` con el nombre de su tailnet (visible en `tailscale status`).

No se necesita túnel SSH. Tailscale proporciona:

- Cifrado HTTPS (certificados automáticos)
- Autenticación mediante identidad de Tailscale
- Acceso desde cualquier dispositivo en su tailnet (laptop, teléfono, etc.)

---

## Seguridad: VCN + Tailscale (línea base recomendada)

Con la VCN asegurada (solo UDP 41641 abierto) y el Gateway enlazado a local loopback, obtiene una sólida defensa en profundidad: el tráfico público se bloquea en el borde de la red y el acceso administrativo ocurre a través de su tailnet.

Esta configuración a menudo elimina la _necesidad_ de reglas adicionales de firewall en el host únicamente para detener fuerza bruta de SSH a escala de Internet — pero aun así debe mantener el SO actualizado, ejecutar `openclaw security audit`, y verificar que no esté escuchando accidentalmente en interfaces públicas.

### Qué ya está protegido

| Paso tradicional                 | ¿Necesario?   | Por qué                                                                            |
| -------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| Firewall UFW                     | No            | La VCN bloquea antes de que el tráfico llegue a la instancia                       |
| fail2ban                         | No            | No hay fuerza bruta si el puerto 22 está bloqueado en la VCN                       |
| Endurecimiento sshd              | No            | SSH de Tailscale no usa sshd                                                       |
| Deshabilitar root                | No            | Tailscale usa identidad de Tailscale, no usuarios del sistema                      |
| Autenticación solo con clave SSH | No            | Tailscale autentica vía su tailnet                                                 |
| Endurecimiento IPv6              | Usualmente no | Depende de la configuración de su VCN/subred; verifique qué está asignado/expuesto |

### Aún recomendado

- **Permisos de credenciales:** `chmod 700 ~/.openclaw`
- **Auditoría de seguridad:** `openclaw security audit`
- **Actualizaciones del sistema:** `sudo apt update && sudo apt upgrade` regularmente
- **Monitorear Tailscale:** Revise dispositivos en la [consola de administración de Tailscale](https://login.tailscale.com/admin)

### Verificar la postura de seguridad

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Alternativa: túnel SSH

Si Tailscale Serve no funciona, use un túnel SSH:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Luego abra `http://localhost:18789`.

---

## Solución de problemas

### Falla la creación de la instancia ("Out of capacity")

Las instancias ARM del nivel gratuito son populares. Intente:

- Un dominio de disponibilidad diferente
- Reintentar en horas de baja demanda (temprano por la mañana)
- Usar el filtro "Always Free" al seleccionar la forma

### Tailscale no conecta

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### El Gateway no inicia

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### No se puede acceder a la Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### Problemas con binarios ARM

Algunas herramientas pueden no tener compilaciones ARM. Revise:

```bash
uname -m  # Should show aarch64
```

La mayoría de los paquetes npm funcionan bien. Para binarios, busque versiones `linux-arm64` o `aarch64`.

---

## Persistencia

Todo el estado vive en:

- `~/.openclaw/` — configuración, credenciales, datos de sesión
- `~/.openclaw/workspace/` — espacio de trabajo (SOUL.md, memoria, artefactos)

Realice copias de seguridad periódicamente:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Ver también

- [Acceso remoto del Gateway](/gateway/remote) — otros patrones de acceso remoto
- [Integración con Tailscale](/gateway/tailscale) — documentación completa de Tailscale
- [Configuración del Gateway](/gateway/configuration) — todas las opciones de configuración
- [Guía de DigitalOcean](/platforms/digitalocean) — si desea pago + registro más sencillo
- [Guía de Hetzner](/install/hetzner) — alternativa basada en Docker
