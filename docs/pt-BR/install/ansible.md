---
summary: "Instalação automatizada e reforçada do OpenClaw com Ansible, VPN Tailscale e isolamento por firewall"
read_when:
  - Você quer implantação automatizada de servidores com reforço de segurança
  - Você precisa de uma configuração isolada por firewall com acesso via VPN
  - Você está implantando em servidores remotos Debian/Ubuntu
title: "Ansible"
---

# Instalação com Ansible

A forma recomendada de implantar o OpenClaw em servidores de produção é por meio do **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — um instalador automatizado com arquitetura focada em segurança.

## Início Rápido

Instalação com um único comando:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Guia completo: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> O repositório openclaw-ansible é a fonte de verdade para implantação com Ansible. Esta página é apenas uma visão geral rápida.

## O que você recebe

- 🔒 **Segurança com foco em firewall**: UFW + isolamento do Docker (apenas SSH + Tailscale acessíveis)
- 🔐 **VPN Tailscale**: Acesso remoto seguro sem expor serviços publicamente
- 🐳 **Docker**: Containers de sandbox isolados, com bindings apenas para localhost
- 🛡️ **Defesa em profundidade**: Arquitetura de segurança em 4 camadas
- 🚀 **Configuração com um comando**: Implantação completa em minutos
- 🔧 **Integração com systemd**: Inicialização automática no boot com hardening

## Requisitos

- **SO**: Debian 11+ ou Ubuntu 20.04+
- **Acesso**: Privilégios de root ou sudo
- **Rede**: Conexão com a internet para instalação de pacotes
- **Ansible**: 2.14+ (instalado automaticamente pelo script de início rápido)

## O que é instalado

O playbook do Ansible instala e configura:

1. **Tailscale** (VPN mesh para acesso remoto seguro)
2. **Firewall UFW** (apenas portas de SSH + Tailscale)
3. **Docker CE + Compose V2** (para sandboxes de agentes)
4. **Node.js 22.x + pnpm** (dependências de runtime)
5. **OpenClaw** (baseado no host, não containerizado)
6. **Serviço systemd** (inicialização automática com hardening de segurança)

Nota: O gateway roda **diretamente no host** (não em Docker), mas os sandboxes de agentes usam Docker para isolamento. Veja [Sandboxing](/gateway/sandboxing) para detalhes.

## Configuração pós-instalação

Após a conclusão da instalação, mude para o usuário openclaw:

```bash
sudo -i -u openclaw
```

O script pós-instalação irá guiá-lo por:

1. **Assistente de onboarding**: Configurar as definições do OpenClaw
2. **Login de provedor**: Conectar WhatsApp/Telegram/Discord/Signal
3. **Teste do Gateway**: Verificar a instalação
4. **Configuração do Tailscale**: Conectar à sua malha VPN

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

## Arquitetura de segurança

### Defesa em 4 camadas

1. **Firewall (UFW)**: Apenas SSH (22) + Tailscale (41641/udp) expostos publicamente
2. **VPN (Tailscale)**: Gateway acessível apenas pela malha VPN
3. **Isolamento do Docker**: A chain DOCKER-USER do iptables impede a exposição externa de portas
4. **Hardening do systemd**: NoNewPrivileges, PrivateTmp, usuário sem privilégios

### Verificação

Teste a superfície de ataque externa:

```bash
nmap -p- YOUR_SERVER_IP
```

Deve mostrar **apenas a porta 22** (SSH) aberta. Todos os outros serviços (gateway, Docker) ficam bloqueados.

### Disponibilidade do Docker

O Docker é instalado para **sandboxes de agentes** (execução isolada de ferramentas), não para rodar o gateway em si. O gateway faz bind apenas em localhost e é acessível via VPN Tailscale.

Veja [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para configuração de sandbox.

## Instalação manual

Se você preferir controle manual em vez da automação:

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

## Atualizando o OpenClaw

O instalador Ansible configura o OpenClaw para atualizações manuais. Veja [Updating](/install/updating) para o fluxo padrão de atualização.

Para reexecutar o playbook do Ansible (por exemplo, para mudanças de configuração):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Nota: Isso é idempotente e seguro para executar várias vezes.

## Solução de problemas

### O firewall bloqueia minha conexão

Se você ficou sem acesso:

- Certifique-se de conseguir acessar primeiro via VPN Tailscale
- O acesso SSH (porta 22) é sempre permitido
- O gateway é acessível **apenas** via Tailscale por design

### O serviço não inicia

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

### Problemas com sandbox do Docker

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Falha no login do provedor

Certifique-se de que você está executando como o usuário `openclaw`:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Configuração avançada

Para arquitetura de segurança detalhada e solução de problemas:

- [Arquitetura de segurança](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Detalhes técnicos](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Guia de solução de problemas](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Relacionado

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — guia completo de implantação
- [Docker](/install/docker) — configuração de gateway containerizado
- [Sandboxing](/gateway/sandboxing) — configuração de sandbox de agentes
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — isolamento por agente
