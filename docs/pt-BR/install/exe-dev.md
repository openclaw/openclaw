---
summary: "Execute o OpenClaw Gateway no exe.dev (VM + proxy HTTPS) para acesso remoto"
read_when:
  - Você quer um host Linux barato e sempre ativo para o Gateway
  - Você quer acesso remoto à UI de Controle sem executar seu próprio VPS
title: "exe.dev"
---

# exe.dev

Objetivo: OpenClaw Gateway em execução em uma VM do exe.dev, acessível a partir do seu laptop via: `https://<vm-name>.exe.xyz`

Esta página assume a imagem **exeuntu** padrão do exe.dev. Se você escolheu uma distro diferente, mapeie os pacotes de acordo.

## Caminho rápido para iniciantes

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Preencha sua chave/token de autenticação conforme necessário
3. Clique em "Agent" ao lado da sua VM e aguarde...
4. ???
5. Lucro

## O que você precisa

- conta no exe.dev
- acesso `ssh exe.dev` a máquinas virtuais do [exe.dev](https://exe.dev) (opcional)

## Instalação automatizada com Shelley

Shelley, o agente do [exe.dev](https://exe.dev), pode instalar o OpenClaw instantaneamente com nosso
prompt. O prompt usado é o seguinte:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Instalação manual

## 1. Criar a VM

A partir do seu dispositivo:

```bash
ssh exe.dev new
```

Em seguida, conecte-se:

```bash
ssh <vm-name>.exe.xyz
```

Dica: mantenha esta VM **stateful**. O OpenClaw armazena estado em `~/.openclaw/` e `~/.openclaw/workspace/`.

## 2. Instalar pré-requisitos (na VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. Instalar o OpenClaw

Execute o script de instalação do OpenClaw:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. Configurar o nginx para fazer proxy do OpenClaw para a porta 8000

Edite `/etc/nginx/sites-enabled/default` com

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5. Acessar o OpenClaw e conceder privilégios

Acesse `https://<vm-name>.exe.xyz/` (veja a saída da UI de Controle durante a integração inicial). Se solicitar autenticação, cole o
token de `gateway.auth.token` na VM (recupere com `openclaw config get gateway.auth.token` ou gere um
com `openclaw doctor --generate-gateway-token`). Aprove dispositivos com `openclaw devices list` e
`openclaw devices approve <requestId>`. Em caso de dúvida, use o Shelley pelo seu navegador!

## Acesso remoto

O acesso remoto é tratado pela autenticação do [exe.dev](https://exe.dev). Por
padrão, o tráfego HTTP da porta 8000 é encaminhado para `https://<vm-name>.exe.xyz`
com autenticação por e-mail.

## Atualização

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Guia: [Atualizando](/install/updating)
