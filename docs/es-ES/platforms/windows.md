---
summary: "Soporte de Windows (WSL2) + estado de aplicación complementaria"
read_when:
  - Instalando OpenClaw en Windows
  - Buscando estado de aplicación complementaria de Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

OpenClaw en Windows se recomienda **vía WSL2** (Ubuntu recomendado). El
CLI + Gateway se ejecutan dentro de Linux, lo que mantiene el runtime consistente y hace
las herramientas mucho más compatibles (Node/Bun/pnpm, binarios de Linux, habilidades). Windows
nativo puede ser más complicado. WSL2 te da la experiencia completa de Linux — un comando
para instalar: `wsl --install`.

Las aplicaciones complementarias nativas de Windows están planificadas.

## Instalación (WSL2)

- [Primeros Pasos](/es-ES/start/getting-started) (usar dentro de WSL)
- [Instalación y actualizaciones](/es-ES/install/updating)
- Guía oficial de WSL2 (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Manual del Gateway](/es-ES/gateway)
- [Configuración](/es-ES/gateway/configuration)

## Instalación del servicio Gateway (CLI)

Dentro de WSL2:

```
openclaw onboard --install-daemon
```

O:

```
openclaw gateway install
```

O:

```
openclaw configure
```

Selecciona **Servicio Gateway** cuando se te solicite.

Reparar/migrar:

```
openclaw doctor
```

## Avanzado: exponer servicios WSL a través de LAN (portproxy)

WSL tiene su propia red virtual. Si otra máquina necesita alcanzar un servicio
ejecutándose **dentro de WSL** (SSH, un servidor TTS local, o el Gateway), debes
reenviar un puerto de Windows a la IP actual de WSL. La IP de WSL cambia después de reinicios,
por lo que puede que necesites actualizar la regla de reenvío.

Ejemplo (PowerShell **como Administrador**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "IP de WSL no encontrada." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Permite el puerto a través del Firewall de Windows (una sola vez):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Actualiza el portproxy después de que WSL se reinicie:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notas:

- SSH desde otra máquina apunta a la **IP del host de Windows** (ejemplo: `ssh user@windows-host -p 2222`).
- Los nodos remotos deben apuntar a una URL del Gateway **alcanzable** (no `127.0.0.1`); usa
  `openclaw status --all` para confirmar.
- Usa `listenaddress=0.0.0.0` para acceso LAN; `127.0.0.1` lo mantiene solo local.
- Si quieres esto automático, registra una Tarea Programada para ejecutar el paso de actualización
  al iniciar sesión.

## Instalación paso a paso de WSL2

### 1) Instalar WSL2 + Ubuntu

Abre PowerShell (Admin):

```powershell
wsl --install
# O elige una distro explícitamente:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reinicia si Windows lo solicita.

### 2) Habilitar systemd (requerido para instalación del gateway)

En tu terminal WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Luego desde PowerShell:

```powershell
wsl --shutdown
```

Re-abre Ubuntu, luego verifica:

```bash
systemctl --user status
```

### 3) Instalar OpenClaw (dentro de WSL)

Sigue el flujo de Primeros Pasos de Linux dentro de WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-instala dependencias de UI en la primera ejecución
pnpm build
openclaw onboard
```

Guía completa: [Primeros Pasos](/es-ES/start/getting-started)

## Aplicación complementaria de Windows

Aún no tenemos una aplicación complementaria de Windows. Las contribuciones son bienvenidas si deseas
contribuciones para que suceda.
