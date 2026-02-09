---
summary: "OpenClaw no Oracle Cloud (ARM Always Free)"
read_when:
  - Configurando o OpenClaw no Oracle Cloud
  - Procurando hospedagem VPS de baixo custo para o OpenClaw
  - Quer o OpenClaw 24/7 em um servidor pequeno
title: "Oracle Cloud"
---

# OpenClaw no Oracle Cloud (OCI)

## Objetivo

Executar um Gateway do OpenClaw persistente no nível **Always Free** ARM do Oracle Cloud.

O nível gratuito da Oracle pode ser uma ótima opção para o OpenClaw (especialmente se você já tiver uma conta OCI), mas ele vem com algumas concessões:

- Arquitetura ARM (a maioria das coisas funciona, mas alguns binários podem ser apenas x86)
- Capacidade e cadastro podem ser instáveis

## Comparação de custos (2026)

| Provedor     | Plano           | Especificações       | Preço/mês            | Notas                      |
| ------------ | --------------- | -------------------- | -------------------- | -------------------------- |
| Oracle Cloud | ARM Always Free | até 4 OCPU, 24GB RAM | $0                   | ARM, capacidade limitada   |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM      | ~ $4 | Opção paga mais barata     |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM      | $6                   | UI fácil, boa documentação |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM      | $6                   | Muitas localizações        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM      | $5                   | Agora parte da Akamai      |

---

## Pré-requisitos

- Conta no Oracle Cloud ([cadastro](https://www.oracle.com/cloud/free/)) — veja o [guia de cadastro da comunidade](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) se encontrar problemas
- Conta no Tailscale (gratuita em [tailscale.com](https://tailscale.com))
- ~30 minutos

## 1. Criar uma instância OCI

1. Faça login no [Oracle Cloud Console](https://cloud.oracle.com/)
2. Navegue até **Compute → Instances → Create Instance**
3. Configure:
   - **Nome:** `openclaw`
   - **Imagem:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (ou até 4)
   - **Memória:** 12 GB (ou até 24 GB)
   - **Volume de boot:** 50 GB (até 200 GB grátis)
   - **Chave SSH:** Adicione sua chave pública
4. Clique em **Create**
5. Anote o endereço IP público

**Dica:** Se a criação da instância falhar com "Out of capacity", tente um domínio de disponibilidade diferente ou tente novamente mais tarde. A capacidade do nível gratuito é limitada.

## 2. Conectar e atualizar

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Nota:** `build-essential` é necessário para a compilação ARM de algumas dependências.

## 3. Configurar usuário e hostname

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Instalar o Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Isso habilita o SSH do Tailscale, para que você possa se conectar via `ssh openclaw` a partir de qualquer dispositivo no seu tailnet — sem necessidade de IP público.

Verifique:

```bash
tailscale status
```

**A partir de agora, conecte-se via Tailscale:** `ssh ubuntu@openclaw` (ou use o IP do Tailscale).

## 5. Instalar o OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Quando solicitado "How do you want to hatch your bot?", selecione **"Do this later"**.

> Nota: Se você encontrar problemas de build nativo em ARM, comece com pacotes do sistema (por exemplo, `sudo apt install -y build-essential`) antes de recorrer ao Homebrew.

## 6. Configurar o Gateway (loopback + autenticação por token) e habilitar o Tailscale Serve

Use autenticação por token como padrão. Ela é previsível e evita a necessidade de flags de Control UI de “autenticação insegura”.

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

## 8. Bloquear a segurança da VCN

Agora que tudo está funcionando, restrinja a VCN para bloquear todo o tráfego, exceto o Tailscale. A Virtual Cloud Network da OCI atua como um firewall na borda da rede — o tráfego é bloqueado antes de chegar à sua instância.

1. Vá para **Networking → Virtual Cloud Networks** no Console da OCI
2. Clique na sua VCN → **Security Lists** → Default Security List
3. **Remova** todas as regras de ingresso, exceto:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Mantenha as regras padrão de saída (permitir todo o tráfego de saída)

Isso bloqueia SSH na porta 22, HTTP, HTTPS e todo o resto na borda da rede. A partir de agora, você só poderá se conectar via Tailscale.

---

## Acessar a Control UI

De qualquer dispositivo na sua rede Tailscale:

```
https://openclaw.<tailnet-name>.ts.net/
```

Substitua `<tailnet-name>` pelo nome do seu tailnet (visível em `tailscale status`).

Nenhum túnel SSH é necessário. O Tailscale fornece:

- Criptografia HTTPS (certificados automáticos)
- Autenticação via identidade do Tailscale
- Acesso de qualquer dispositivo no seu tailnet (laptop, telefone, etc.)

---

## Segurança: VCN + Tailscale (linha de base recomendada)

Com a VCN bloqueada (apenas UDP 41641 aberto) e o Gateway vinculado ao loopback, você obtém uma forte defesa em profundidade: o tráfego público é bloqueado na borda da rede, e o acesso administrativo acontece pelo seu tailnet.

Essa configuração geralmente elimina a _necessidade_ de regras adicionais de firewall no host apenas para impedir força bruta de SSH na Internet — mas você ainda deve manter o SO atualizado, executar `openclaw security audit` e verificar se não está escutando acidentalmente em interfaces públicas.

### O que já está protegido

| Etapa tradicional             | Necessário?    | Por quê                                                                               |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| Firewall UFW                  | Não            | A VCN bloqueia antes que o tráfego chegue à instância                                 |
| fail2ban                      | Não            | Não há força bruta se a porta 22 estiver bloqueada na VCN                             |
| Hardening do sshd             | Não            | O SSH do Tailscale não usa o sshd                                                     |
| Desabilitar login root        | Não            | O Tailscale usa identidade do Tailscale, não usuários do sistema                      |
| Autenticação SSH só por chave | Não            | O Tailscale autentica via seu tailnet                                                 |
| Hardening de IPv6             | Geralmente não | Depende das configurações da sua VCN/sub-rede; verifique o que está atribuído/exposto |

### Ainda recomendado

- **Permissões de credenciais:** `chmod 700 ~/.openclaw`
- **Auditoria de segurança:** `openclaw security audit`
- **Atualizações do sistema:** execute `sudo apt update && sudo apt upgrade` regularmente
- **Monitorar o Tailscale:** revise dispositivos no [console de administração do Tailscale](https://login.tailscale.com/admin)

### Verificar postura de segurança

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Alternativa: Túnel SSH

Se o Tailscale Serve não estiver funcionando, use um túnel SSH:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Em seguida, abra `http://localhost:18789`.

---

## Solução de problemas

### Criação da instância falha ("Out of capacity")

Instâncias ARM do nível gratuito são populares. Tente:

- Um domínio de disponibilidade diferente
- Tentar novamente em horários de menor uso (início da manhã)
- Usar o filtro "Always Free" ao selecionar o shape

### O Tailscale não conecta

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### O Gateway não inicia

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Não é possível acessar a Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### Problemas com binários ARM

Algumas ferramentas podem não ter builds para ARM. Verifique:

```bash
uname -m  # Should show aarch64
```

A maioria dos pacotes npm funciona bem. Para binários, procure por releases `linux-arm64` ou `aarch64`.

---

## Persistência

Todo o estado fica em:

- `~/.openclaw/` — configuração, credenciais, dados de sessão
- `~/.openclaw/workspace/` — workspace (SOUL.md, memória, artefatos)

Faça backup periodicamente:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Veja também

- [Acesso remoto ao Gateway](/gateway/remote) — outros padrões de acesso remoto
- [Integração com Tailscale](/gateway/tailscale) — documentação completa do Tailscale
- [Configuração do Gateway](/gateway/configuration) — todas as opções de configuração
- [Guia do DigitalOcean](/platforms/digitalocean) — se você quiser pago + cadastro mais fácil
- [Guia do Hetzner](/install/hetzner) — alternativa baseada em Docker
