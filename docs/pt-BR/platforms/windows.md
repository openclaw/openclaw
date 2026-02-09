---
summary: "Suporte ao Windows (WSL2) + status do aplicativo complementar"
read_when:
  - Instalando o OpenClaw no Windows
  - Procurando o status do aplicativo complementar para Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

O OpenClaw no Windows é recomendado **via WSL2** (Ubuntu recomendado). A
CLI + o Gateway rodam dentro do Linux, o que mantém o runtime consistente e torna
as ferramentas muito mais compatíveis (Node/Bun/pnpm, binários Linux, Skills). O Windows nativo pode ser mais complicado. O WSL2 oferece a experiência completa
do Linux — um comando para instalar: `wsl --install`.

Aplicativos complementares nativos para Windows estão planejados.

## Instalação (WSL2)

- [Primeiros passos](/start/getting-started) (use dentro do WSL)
- [Instalação e atualizações](/install/updating)
- Guia oficial do WSL2 (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Runbook do Gateway](/gateway)
- [Configuração](/gateway/configuration)

## Instalação do serviço do Gateway (CLI)

Dentro do WSL2:

```
openclaw onboard --install-daemon
```

Ou:

```
openclaw gateway install
```

Ou:

```
openclaw configure
```

Selecione **Gateway service** quando solicitado.

Reparar/migrar:

```
openclaw doctor
```

## Avançado: expor serviços do WSL na LAN (portproxy)

O WSL tem sua própria rede virtual. Se outra máquina precisar acessar um serviço
em execução **dentro do WSL** (SSH, um servidor TTS local ou o Gateway), você deve
encaminhar uma porta do Windows para o IP atual do WSL. O IP do WSL muda após
reinicializações, então pode ser necessário atualizar a regra de encaminhamento.

Exemplo (PowerShell **como Administrador**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Permita a porta no Firewall do Windows (uma vez):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Atualize o portproxy após reinicializações do WSL:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notas:

- SSH a partir de outra máquina aponta para o **IP do host Windows** (exemplo: `ssh user@windows-host -p 2222`).
- Nós remotos devem apontar para uma URL do Gateway **alcançável** (não `127.0.0.1`); use
  `openclaw status --all` para confirmar.
- Use `listenaddress=0.0.0.0` para acesso via LAN; `127.0.0.1` mantém apenas local.
- Se quiser isso automático, registre uma Tarefa Agendada para executar a etapa
  de atualização no login.

## Instalação passo a passo do WSL2

### 1. Instalar WSL2 + Ubuntu

Abra o PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reinicie se o Windows solicitar.

### 2. Ativar systemd (necessário para a instalação do gateway)

No terminal do WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Em seguida, no PowerShell:

```powershell
wsl --shutdown
```

Reabra o Ubuntu e verifique:

```bash
systemctl --user status
```

### 3. Instalar o OpenClaw (dentro do WSL)

Siga o fluxo de Primeiros passos do Linux dentro do WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Guia completo: [Primeiros passos](/start/getting-started)

## Aplicativo complementar para Windows

Ainda não temos um aplicativo complementar para Windows. Contribuições são bem-vindas se você quiser
ajudar a tornar isso realidade.
