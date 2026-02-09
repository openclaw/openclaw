---
summary: "OpenClaw no DigitalOcean (opção simples de VPS paga)"
read_when:
  - Configurando o OpenClaw no DigitalOcean
  - Procurando hospedagem VPS barata para o OpenClaw
title: "DigitalOcean"
---

# OpenClaw no DigitalOcean

## Objetivo

Executar um Gateway OpenClaw persistente no DigitalOcean por **US$ 6/mês** (ou US$ 4/mês com preço reservado).

Se você quer uma opção de US$ 0/mês e não se importa com ARM + configuração específica do provedor, veja o [guia do Oracle Cloud](/platforms/oracle).

## Comparação de custos (2026)

| Provedor     | Plano           | Especificações       | Preço/mês                                         | Notas                                                 |
| ------------ | --------------- | -------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Oracle Cloud | Always Free ARM | até 4 OCPU, 24GB RAM | US$ 0                                             | ARM, capacidade limitada / peculiaridades de cadastro |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM      | €3,79 (~US$ 4) | Opção paga mais barata                                |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM      | US$ 6                                             | UI fácil, boa documentação                            |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM      | US$ 6                                             | Muitas localizações                                   |
| Linode       | Nanode          | 1 vCPU, 1GB RAM      | US$ 5                                             | Agora parte da Akamai                                 |

**Escolhendo um provedor:**

- DigitalOcean: UX mais simples + configuração previsível (este guia)
- Hetzner: bom custo/desempenho (veja o [guia da Hetzner](/install/hetzner))
- Oracle Cloud: pode custar US$ 0/mês, mas é mais exigente e apenas ARM (veja o [guia do Oracle](/platforms/oracle))

---

## Pré-requisitos

- Conta no DigitalOcean ([cadastre-se com US$ 200 de crédito grátis](https://m.do.co/c/signup))
- Par de chaves SSH (ou disposição para usar autenticação por senha)
- ~20 minutos

## 1. Criar um Droplet

1. Faça login no [DigitalOcean](https://cloud.digitalocean.com/)
2. Clique em **Create → Droplets**
3. Escolha:
   - **Region:** Mais próxima de você (ou dos seus usuários)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **US$ 6/mês** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** Chave SSH (recomendado) ou senha
4. Clique em **Create Droplet**
5. Anote o endereço IP

## 2) Conectar via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Instalar o OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Executar a integração inicial

```bash
openclaw onboard --install-daemon
```

O assistente vai orientar você em:

- Autenticação do modelo (chaves de API ou OAuth)
- Configuração de canais (Telegram, WhatsApp, Discord, etc.)
- Token do Gateway (gerado automaticamente)
- Instalação do daemon (systemd)

## 5. Verificar o Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Acessar o Dashboard

O gateway se vincula ao local loopback por padrão. Para acessar a UI de controle:

**Opção A: Túnel SSH (recomendado)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Opção B: Tailscale Serve (HTTPS, apenas loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Abra: `https://<magicdns>/`

Notas:

- O Serve mantém o Gateway apenas em loopback e autentica via cabeçalhos de identidade do Tailscale.
- Para exigir token/senha, defina `gateway.auth.allowTailscale: false` ou use `gateway.auth.mode: "password"`.

**Opção C: Bind na tailnet (sem Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Abra: `http://<tailscale-ip>:18789` (token obrigatório).

## 7. Conecte seus canais

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

Veja [Canais](/channels) para outros provedores.

---

## Otimizações para 1GB de RAM

O droplet de US$ 6 tem apenas 1GB de RAM. Para manter tudo funcionando sem problemas:

### Adicionar swap (recomendado)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Usar um modelo mais leve

Se você estiver enfrentando OOMs, considere:

- Usar modelos baseados em API (Claude, GPT) em vez de modelos locais
- Definir `agents.defaults.model.primary` para um modelo menor

### Monitorar memória

```bash
free -h
htop
```

---

## Persistência

Todo o estado fica em:

- `~/.openclaw/` — configuração, credenciais, dados de sessão
- `~/.openclaw/workspace/` — workspace (SOUL.md, memória, etc.)

Eles sobrevivem a reinicializações. Faça backup periodicamente:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Alternativa gratuita do Oracle Cloud

O Oracle Cloud oferece instâncias ARM **Always Free** que são significativamente mais poderosas do que qualquer opção paga aqui — por US$ 0/mês.

| O que você recebe          | Especificações                     |
| -------------------------- | ---------------------------------- |
| **4 OCPUs**                | ARM Ampere A1                      |
| **24GB RAM**               | Mais do que suficiente             |
| **200GB de armazenamento** | Volume de bloco                    |
| **Grátis para sempre**     | Sem cobranças no cartão de crédito |

**Ressalvas:**

- O cadastro pode ser exigente (tente novamente se falhar)
- Arquitetura ARM — a maioria das coisas funciona, mas alguns binários precisam de builds ARM

Para o guia completo de configuração, veja [Oracle Cloud](/platforms/oracle). Para dicas de cadastro e solução de problemas do processo de inscrição, veja este [guia da comunidade](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Solução de problemas

### O Gateway não inicia

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Porta já em uso

```bash
lsof -i :18789
kill <PID>
```

### Falta de memória

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Veja também

- [Guia da Hetzner](/install/hetzner) — mais barato, mais poderoso
- [Instalação com Docker](/install/docker) — configuração em contêiner
- [Tailscale](/gateway/tailscale) — acesso remoto seguro
- [Configuração](/gateway/configuration) — referência completa de configuração
