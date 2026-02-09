---
summary: "Execute o OpenClaw Gateway 24/7 em uma VM do GCP Compute Engine (Docker) com estado durável"
read_when:
  - Você quer o OpenClaw rodando 24/7 no GCP
  - Você quer um Gateway sempre ativo, de nível de produção, na sua própria VM
  - Você quer controle total sobre persistência, binários e comportamento de reinicialização
title: "GCP"
---

# OpenClaw no GCP Compute Engine (Docker, Guia de VPS em Produção)

## Objetivo

Executar um OpenClaw Gateway persistente em uma VM do GCP Compute Engine usando Docker, com estado durável, binários incorporados na imagem e comportamento seguro de reinicialização.

Se você quer “OpenClaw 24/7 por ~$5–12/mês”, esta é uma configuração confiável no Google Cloud.
O preço varia conforme o tipo de máquina e a região; escolha a menor VM que atenda à sua carga de trabalho e aumente se encontrar OOMs.

## O que estamos fazendo (em termos simples)?

- Criar um projeto no GCP e habilitar o faturamento
- Criar uma VM do Compute Engine
- Instalar o Docker (runtime de aplicativo isolado)
- Iniciar o OpenClaw Gateway no Docker
- Persistir `~/.openclaw` + `~/.openclaw/workspace` no host (sobrevive a reinicializações/rebuilds)
- Acessar a UI de Controle a partir do seu laptop via túnel SSH

O Gateway pode ser acessado via:

- Redirecionamento de porta SSH a partir do seu laptop
- Exposição direta de porta, se você gerenciar firewall e tokens por conta própria

Este guia usa Debian no GCP Compute Engine.
Ubuntu também funciona; ajuste os pacotes conforme necessário.
Para o fluxo genérico com Docker, veja [Docker](/install/docker).

---

## Caminho rápido (operadores experientes)

1. Criar projeto no GCP + habilitar a API do Compute Engine
2. Criar VM do Compute Engine (e2-small, Debian 12, 20GB)
3. Acessar a VM via SSH
4. Instalar Docker
5. Clonar o repositório do OpenClaw
6. Criar diretórios persistentes no host
7. Configurar `.env` e `docker-compose.yml`
8. Incorporar os binários necessários, construir e iniciar

---

## O que você precisa

- Conta no GCP (free tier elegível para e2-micro)
- gcloud CLI instalada (ou usar o Cloud Console)
- Acesso SSH a partir do seu laptop
- Conforto básico com SSH + copiar/colar
- ~20–30 minutos
- Docker e Docker Compose
- Credenciais de autenticação do modelo
- Credenciais opcionais de provedores
  - QR do WhatsApp
  - Token de bot do Telegram
  - OAuth do Gmail

---

## 1. Instalar a gcloud CLI (ou usar o Console)

**Opção A: gcloud CLI** (recomendado para automação)

Instale a partir de [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Inicialize e autentique:

```bash
gcloud init
gcloud auth login
```

**Opção B: Cloud Console**

Todos os passos podem ser feitos pela interface web em [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Criar um projeto no GCP

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Habilite o faturamento em [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (obrigatório para o Compute Engine).

Habilite a API do Compute Engine:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Vá para IAM e Admin > Criar projeto
2. Dê um nome e crie
3. Habilite o faturamento para o projeto
4. Navegue até APIs e Serviços > Ativar APIs > procure por “Compute Engine API” > Ativar

---

## 3. Criar a VM

**Tipos de máquina:**

| Tipo     | Especificações                                     | Custo                    | Observações            |
| -------- | -------------------------------------------------- | ------------------------ | ---------------------- |
| e2-small | 2 vCPU, 2GB RAM                                    | ~$12/mês | Recomendado            |
| e2-micro | 2 vCPU (compartilhado), 1GB RAM | Elegível ao free tier    | Pode dar OOM sob carga |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Vá para Compute Engine > Instâncias de VM > Criar instância
2. Nome: `openclaw-gateway`
3. Região: `us-central1`, Zona: `us-central1-a`
4. Tipo de máquina: `e2-small`
5. Disco de boot: Debian 12, 20GB
6. Criar

---

## 4. Acessar a VM via SSH

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Clique no botão “SSH” ao lado da sua VM no painel do Compute Engine.

Nota: a propagação da chave SSH pode levar 1–2 minutos após a criação da VM. Se a conexão for recusada, aguarde e tente novamente.

---

## 5. Instalar Docker (na VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Faça logout e login novamente para que a mudança de grupo tenha efeito:

```bash
exit
```

Depois, conecte-se novamente via SSH:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Verifique:

```bash
docker --version
docker compose version
```

---

## 6. Clonar o repositório do OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Este guia assume que você irá construir uma imagem personalizada para garantir a persistência dos binários.

---

## 7. Criar diretórios persistentes no host

Contêineres Docker são efêmeros.
Todo estado de longa duração deve viver no host.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Configurar variáveis de ambiente

Crie `.env` na raiz do repositório.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Gere segredos fortes:

```bash
openssl rand -hex 32
```

**Não faça commit deste arquivo.**

---

## 9. Configuração do Docker Compose

Crie ou atualize `docker-compose.yml`.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 10. Incorporar os binários necessários na imagem (crítico)

Instalar binários dentro de um contêiner em execução é uma armadilha.
Tudo o que for instalado em tempo de execução será perdido na reinicialização.

Todos os binários externos exigidos pelas Skills devem ser instalados no momento da construção da imagem.

Os exemplos abaixo mostram apenas três binários comuns:

- `gog` para acesso ao Gmail
- `goplaces` para Google Places
- `wacli` para WhatsApp

São exemplos, não uma lista completa.
Você pode instalar quantos binários forem necessários usando o mesmo padrão.

Se você adicionar novas Skills posteriormente que dependam de binários adicionais, você deve:

1. Atualizar o Dockerfile
2. Reconstruir a imagem
3. Reiniciar os contêineres

**Exemplo de Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 11. Construir e iniciar

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Verifique os binários:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Saída esperada:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12. Verificar o Gateway

```bash
docker compose logs -f openclaw-gateway
```

Sucesso:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Acessar a partir do seu laptop

Crie um túnel SSH para encaminhar a porta do Gateway:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Abra no seu navegador:

`http://127.0.0.1:18789/`

Cole o token do gateway.

---

## O que persiste onde (fonte da verdade)

O OpenClaw roda em Docker, mas o Docker não é a fonte da verdade.
Todo estado de longa duração deve sobreviver a reinicializações, rebuilds e reboots.

| Componente               | Localização                       | Mecanismo de persistência  | Observações                            |
| ------------------------ | --------------------------------- | -------------------------- | -------------------------------------- |
| Configuração do Gateway  | `/home/node/.openclaw/`           | Montagem de volume no host | Inclui `openclaw.json`, tokens         |
| Perfis de auth do modelo | `/home/node/.openclaw/`           | Montagem de volume no host | Tokens OAuth, chaves de API            |
| Configs de Skills        | `/home/node/.openclaw/skills/`    | Montagem de volume no host | Estado no nível da Skill               |
| Workspace do agente      | `/home/node/.openclaw/workspace/` | Montagem de volume no host | Código e artefatos do agente           |
| Sessão do WhatsApp       | `/home/node/.openclaw/`           | Montagem de volume no host | Preserva o login por QR                |
| Keyring do Gmail         | `/home/node/.openclaw/`           | Volume no host + senha     | Requer `GOG_KEYRING_PASSWORD`          |
| Binários externos        | `/usr/local/bin/`                 | Imagem Docker              | Deve ser assado no tempo de construção |
| Runtime Node             | Sistema de arquivos do contêiner  | Imagem Docker              | Recriado a cada build da imagem        |
| Pacotes do SO            | Sistema de arquivos do contêiner  | Imagem Docker              | Não instalar em runtime                |
| Contêiner Docker         | Efêmero                           | Reiniciável                | Seguro de destruir                     |

---

## Atualizações

Para atualizar o OpenClaw na VM:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Solução de problemas

**Conexão SSH recusada**

A propagação da chave SSH pode levar 1–2 minutos após a criação da VM. Aguarde e tente novamente.

**Problemas com OS Login**

Verifique seu perfil de OS Login:

```bash
gcloud compute os-login describe-profile
```

Garanta que sua conta tenha as permissões IAM necessárias (Compute OS Login ou Compute OS Admin Login).

**Falta de memória (OOM)**

Se estiver usando e2-micro e encontrar OOM, faça upgrade para e2-small ou e2-medium:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Contas de serviço (boa prática de segurança)

Para uso pessoal, sua conta de usuário padrão funciona bem.

Para automação ou pipelines de CI/CD, crie uma conta de serviço dedicada com permissões mínimas:

1. Crie uma conta de serviço:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Conceda a função Compute Instance Admin (ou uma função personalizada mais restrita):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Evite usar a função Owner para automação. Use o princípio do menor privilégio.

Veja [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) para detalhes sobre funções do IAM.

---

## Próximos passos

- Configurar canais de mensagens: [Channels](/channels)
- Parear dispositivos locais como nós: [Nodes](/nodes)
- Configurar o Gateway: [Gateway configuration](/gateway/configuration)
