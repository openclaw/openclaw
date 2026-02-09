---
summary: "Soporte de Windows (WSL2) + estado de la aplicación complementaria"
read_when:
  - Instalación de OpenClaw en Windows
  - Búsqueda del estado de la aplicación complementaria de Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

Se recomienda usar OpenClaw en Windows **mediante WSL2** (se recomienda Ubuntu). La
CLI + el Gateway se ejecutan dentro de Linux, lo que mantiene el entorno de ejecución consistente y hace que las
herramientas sean mucho más compatibles (Node/Bun/pnpm, binarios de Linux, Skills). Windows nativo puede ser más complicado. WSL2 le ofrece la experiencia completa de Linux — un comando
para instalar: `wsl --install`.

Las aplicaciones complementarias nativas para Windows están planificadas.

## Instalación (WSL2)

- [Primeros pasos](/start/getting-started) (úselo dentro de WSL)
- [Instalación y actualizaciones](/install/updating)
- Guía oficial de WSL2 (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Runbook del Gateway](/gateway)
- [Configuración](/gateway/configuration)

## Instalación del servicio del Gateway (CLI)

Dentro de WSL2:

```
openclaw onboard --install-daemon
```

O bien:

```
openclaw gateway install
```

O bien:

```
openclaw configure
```

Seleccione **Gateway service** cuando se le solicite.

Reparar/migrar:

```
openclaw doctor
```

## Avanzado: exponer servicios de WSL en la LAN (portproxy)

WSL tiene su propia red virtual. Si otra máquina necesita acceder a un servicio
que se ejecuta **dentro de WSL** (SSH, un servidor TTS local o el Gateway), debe
reenviar un puerto de Windows a la IP actual de WSL. La IP de WSL cambia después de los reinicios,
por lo que puede que deba actualizar la regla de reenvío.

Ejemplo (PowerShell **como Administrador**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Permita el puerto a través del Firewall de Windows (una sola vez):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Actualice el portproxy después de que WSL se reinicie:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notas:

- El acceso SSH desde otra máquina apunta a la **IP del host de Windows** (ejemplo: `ssh user@windows-host -p 2222`).
- Los nodos remotos deben apuntar a una URL del Gateway **accesible** (no `127.0.0.1`); use
  `openclaw status --all` para confirmar.
- Use `listenaddress=0.0.0.0` para acceso en la LAN; `127.0.0.1` lo mantiene solo local.
- Si desea que esto sea automático, registre una Tarea programada para ejecutar el paso de
  actualización al iniciar sesión.

## Instalación paso a paso de WSL2

### 1. Instalar WSL2 + Ubuntu

Abra PowerShell (Administrador):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reinicie si Windows lo solicita.

### 2. Habilitar systemd (requerido para la instalación del Gateway)

En su terminal de WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Luego, desde PowerShell:

```powershell
wsl --shutdown
```

Vuelva a abrir Ubuntu y luego verifique:

```bash
systemctl --user status
```

### 3. Instalar OpenClaw (dentro de WSL)

Siga el flujo de Primeros pasos de Linux dentro de WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Guía completa: [Primeros pasos](/start/getting-started)

## Aplicación complementaria de Windows

Aún no tenemos una aplicación complementaria para Windows. Las contribuciones son bienvenidas si desea
ayudar a que esto suceda.
