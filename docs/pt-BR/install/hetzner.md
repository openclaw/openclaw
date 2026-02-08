---
summary: "Execute o OpenClaw Gateway 24/7 em um VPS barato da Hetzner (Docker) com estado durável e binários incorporados"
read_when:
  - Você quer o OpenClaw rodando 24/7 em um VPS na nuvem (não no seu laptop)
  - Você quer um Gateway sempre ativo, de nível de produção, no seu próprio VPS
  - Você quer controle total sobre persistência, binários e comportamento de reinício
  - Você está executando o OpenClaw em Docker na Hetzner ou em um provedor similar
title: "Hetzner"
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:19Z
---

# OpenClaw na Hetzner (Docker, Guia de Produção em VPS)

## Objetivo

Executar um OpenClaw Gateway persistente em um VPS da Hetzner usando Docker, com estado durável, binários incorporados e comportamento seguro de reinício.

Se você quer “OpenClaw 24/7 por ~US$5”, esta é a configuração confiável mais simples.
Os preços da Hetzner mudam; escolha o menor VPS Debian/Ubuntu e aumente se encontrar OOMs.

## O que estamos fazendo (em termos simples)?

- Alugar um pequeno servidor Linux (VPS da Hetzner)
- Instalar Docker (runtime de aplicativo isolado)
- Iniciar o OpenClaw Gateway no Docker
- Persistir `~/.openclaw` + `~/.openclaw/workspace` no host (sobrevive a reinícios/reconstruções)
- Acessar a UI de Controle a partir do seu laptop via um túnel SSH

O Gateway pode ser acessado via:

- Encaminhamento de porta SSH a partir do seu laptop
- Exposição direta de porta se você gerenciar firewall e tokens por conta própria

Este guia assume Ubuntu ou Debian na Hetzner.  
Se você estiver em outro VPS Linux, mapeie os pacotes de acordo.
Para o fluxo genérico de Docker, veja [Docker](/install/docker).

---

## Caminho rápido (operadores experientes)

1. Provisionar VPS da Hetzner
2. Instalar Docker
3. Clonar o repositório OpenClaw
4. Criar diretórios persistentes no host
5. Configurar `.env` e `docker-compose.yml`
6. Incorporar os binários necessários na imagem
7. `docker compose up -d`
8. Verificar persistência e acesso ao Gateway

---

## O que você precisa

- VPS da Hetzner com acesso root
- Acesso SSH a partir do seu laptop
- Conforto básico com SSH + copiar/colar
- ~20 minutos
- Docker e Docker Compose
- Credenciais de autenticação do modelo
- Credenciais opcionais de provedores
  - QR do WhatsApp
  - Token de bot do Telegram
  - OAuth do Gmail

---

## 1) Provisionar o VPS

Crie um VPS Ubuntu ou Debian na Hetzner.

Conecte-se como root:

```bash
ssh root@YOUR_VPS_IP
```

Este guia assume que o VPS é stateful.
Não o trate como infraestrutura descartável.

---

## 2) Instalar Docker (no VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Verifique:

```bash
docker --version
docker compose version
```

---

## 3) Clonar o repositório OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Este guia assume que você irá criar uma imagem personalizada para garantir a persistência dos binários.

---

## 4) Criar diretórios persistentes no host

Contêineres Docker são efêmeros.
Todo estado de longa duração deve viver no host.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) Configurar variáveis de ambiente

Crie `.env` na raiz do repositório.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Gere segredos fortes:

```bash
openssl rand -hex 32
```

**Não faça commit deste arquivo.**

---

## 6) Configuração do Docker Compose

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
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
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

## 7) Incorporar os binários necessários na imagem (crítico)

Instalar binários dentro de um contêiner em execução é uma armadilha.
Qualquer coisa instalada em tempo de execução será perdida no reinício.

Todos os binários externos exigidos por Skills devem ser instalados no momento da construção da imagem.

Os exemplos abaixo mostram apenas três binários comuns:

- `gog` para acesso ao Gmail
- `goplaces` para Google Places
- `wacli` para WhatsApp

Estes são exemplos, não uma lista completa.
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

## 8) Construir e iniciar

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

## 9) Verificar o Gateway

```bash
docker compose logs -f openclaw-gateway
```

Sucesso:

```
[gateway] listening on ws://0.0.0.0:18789
```

A partir do seu laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Abra:

`http://127.0.0.1:18789/`

Cole o token do seu gateway.

---

## O que persiste onde (fonte da verdade)

O OpenClaw roda em Docker, mas o Docker não é a fonte da verdade.
Todo estado de longa duração deve sobreviver a reinícios, reconstruções e reboots.

| Componente                       | Localização                       | Mecanismo de persistência  | Notas                               |
| -------------------------------- | --------------------------------- | -------------------------- | ----------------------------------- |
| Configuração do Gateway          | `/home/node/.openclaw/`           | Montagem de volume do host | Inclui `openclaw.json`, tokens      |
| Perfis de autenticação do modelo | `/home/node/.openclaw/`           | Montagem de volume do host | Tokens OAuth, chaves de API         |
| Configurações de Skills          | `/home/node/.openclaw/skills/`    | Montagem de volume do host | Estado no nível da Skill            |
| Workspace do agente              | `/home/node/.openclaw/workspace/` | Montagem de volume do host | Código e artefatos do agente        |
| Sessão do WhatsApp               | `/home/node/.openclaw/`           | Montagem de volume do host | Preserva o login por QR             |
| Keyring do Gmail                 | `/home/node/.openclaw/`           | Volume do host + senha     | Requer `GOG_KEYRING_PASSWORD`       |
| Binários externos                | `/usr/local/bin/`                 | Imagem Docker              | Devem ser incorporados no build     |
| Runtime do Node                  | Sistema de arquivos do contêiner  | Imagem Docker              | Reconstruído a cada build da imagem |
| Pacotes do SO                    | Sistema de arquivos do contêiner  | Imagem Docker              | Não instale em tempo de execução    |
| Contêiner Docker                 | Efêmero                           | Reiniciável                | Seguro para destruir                |
