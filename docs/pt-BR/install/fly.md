---
title: Fly.io
description: Implante o OpenClaw no Fly.io
---

# Implantação no Fly.io

**Objetivo:** Gateway do OpenClaw rodando em uma máquina do [Fly.io](https://fly.io) com armazenamento persistente, HTTPS automático e acesso a Discord/canais.

## O que você precisa

- [CLI flyctl](https://fly.io/docs/hands-on/install-flyctl/) instalada
- Conta no Fly.io (o plano gratuito funciona)
- Autenticação do modelo: chave de API da Anthropic (ou chaves de outros provedores)
- Credenciais de canal: token de bot do Discord, token do Telegram etc.

## Caminho rápido para iniciantes

1. Clonar o repositório → personalizar `fly.toml`
2. Criar app + volume → definir secrets
3. Implantar com `fly deploy`
4. Acessar via SSH para criar a configuração ou usar a UI de Controle

## 1) Criar o app no Fly

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Dica:** Escolha uma região próxima de você. Opções comuns: `lhr` (Londres), `iad` (Virgínia), `sjc` (San Jose).

## 2. Configurar o fly.toml

Edite `fly.toml` para corresponder ao nome do seu app e aos requisitos.

**Nota de segurança:** A configuração padrão expõe uma URL pública. Para uma implantação reforçada sem IP público, veja [Implantação Privada](#private-deployment-hardened) ou use `fly.private.toml`.

```toml
app = "my-openclaw"  # Your app name
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**Configurações principais:**

| Configuração                   | Por quê                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Vincula a `0.0.0.0` para que o proxy do Fly consiga alcançar o gateway                                         |
| `--allow-unconfigured`         | Inicia sem um arquivo de configuração (você criará um depois)                               |
| `internal_port = 3000`         | Deve corresponder a `--port 3000` (ou `OPENCLAW_GATEWAY_PORT`) para os health checks do Fly |
| `memory = "2048mb"`            | 512MB é muito pouco; 2GB recomendado                                                                           |
| `OPENCLAW_STATE_DIR = "/data"` | Persiste o estado no volume                                                                                    |

## 3. Definir secrets

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**Notas:**

- Bindings fora do loopback (`--bind lan`) exigem `OPENCLAW_GATEWAY_TOKEN` por segurança.
- Trate esses tokens como senhas.
- **Prefira variáveis de ambiente ao arquivo de configuração** para todas as chaves de API e tokens. Isso mantém os secrets fora de `openclaw.json`, onde poderiam ser expostos ou registrados acidentalmente.

## 4. Implantar

```bash
fly deploy
```

A primeira implantação constrói a imagem Docker (~2–3 minutos). Implantações seguintes são mais rápidas.

Após a implantação, verifique:

```bash
fly status
fly logs
```

Você deve ver:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Criar arquivo de configuração

Acesse a máquina via SSH para criar uma configuração adequada:

```bash
fly ssh console
```

Crie o diretório e o arquivo de configuração:

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**Nota:** Com `OPENCLAW_STATE_DIR=/data`, o caminho da configuração é `/data/openclaw.json`.

**Nota:** O token do Discord pode vir de:

- Variável de ambiente: `DISCORD_BOT_TOKEN` (recomendado para secrets)
- Arquivo de configuração: `channels.discord.token`

Se usar a variável de ambiente, não é necessário adicionar o token à configuração. O gateway lê `DISCORD_BOT_TOKEN` automaticamente.

Reinicie para aplicar:

```bash
exit
fly machine restart <machine-id>
```

## 6. Acessar o Gateway

### UI de Controle

Abra no navegador:

```bash
fly open
```

Ou visite `https://my-openclaw.fly.dev/`

Cole seu token do gateway (o mesmo de `OPENCLAW_GATEWAY_TOKEN`) para autenticar.

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### Console SSH

```bash
fly ssh console
```

## Solução de problemas

### "App is not listening on expected address"

O gateway está fazendo bind em `127.0.0.1` em vez de `0.0.0.0`.

**Correção:** Adicione `--bind lan` ao comando do processo em `fly.toml`.

### Health checks falhando / conexão recusada

O Fly não consegue alcançar o gateway na porta configurada.

**Correção:** Garanta que `internal_port` corresponda à porta do gateway (defina `--port 3000` ou `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / Problemas de memória

O contêiner continua reiniciando ou sendo encerrado. Sinais: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration` ou reinícios silenciosos.

**Correção:** Aumente a memória em `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Ou atualize uma máquina existente:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Nota:** 512MB é muito pouco. 1GB pode funcionar, mas pode causar OOM sob carga ou com logs verbosos. **2GB é recomendado.**

### Problemas de bloqueio do Gateway

O Gateway se recusa a iniciar com erros de "already running".

Isso acontece quando o contêiner reinicia, mas o arquivo de lock de PID persiste no volume.

**Correção:** Exclua o arquivo de lock:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

O arquivo de lock está em `/data/gateway.*.lock` (não em um subdiretório).

### Configuração não está sendo lida

Se estiver usando `--allow-unconfigured`, o gateway cria uma configuração mínima. Sua configuração personalizada em `/data/openclaw.json` deve ser lida após o reinício.

Verifique se a configuração existe:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Escrever configuração via SSH

O comando `fly ssh console -C` não suporta redirecionamento de shell. Para escrever um arquivo de configuração:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Nota:** `fly sftp` pode falhar se o arquivo já existir. Exclua primeiro:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Estado não persistindo

Se você perder credenciais ou sessões após um reinício, o diretório de estado está gravando no filesystem do contêiner.

**Correção:** Garanta que `OPENCLAW_STATE_DIR=/data` esteja definido em `fly.toml` e reimplante.

## Atualizações

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Atualizando o comando da máquina

Se você precisar alterar o comando de inicialização sem uma reimplantação completa:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Nota:** Após `fly deploy`, o comando da máquina pode voltar para o que está em `fly.toml`. Se você fez alterações manuais, reaplique-as após a implantação.

## Implantação Privada (Reforçada)

Por padrão, o Fly aloca IPs públicos, tornando seu gateway acessível em `https://your-app.fly.dev`. Isso é conveniente, mas significa que sua implantação é detectável por scanners da internet (Shodan, Censys etc.).

Para uma implantação reforçada **sem exposição pública**, use o template privado.

### Quando usar implantação privada

- Você faz apenas chamadas/mensagens **de saída** (sem webhooks de entrada)
- Você usa túneis **ngrok ou Tailscale** para quaisquer callbacks de webhook
- Você acessa o gateway via **SSH, proxy ou WireGuard** em vez do navegador
- Você quer a implantação **oculta de scanners da internet**

### Configuração

Use `fly.private.toml` em vez da configuração padrão:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Ou converta uma implantação existente:

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

Depois disso, `fly ips list` deve mostrar apenas um IP do tipo `private`:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Acessando uma implantação privada

Como não há URL pública, use um destes métodos:

**Opção 1: Proxy local (mais simples)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Opção 2: VPN WireGuard**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Opção 3: Apenas SSH**

```bash
fly ssh console -a my-openclaw
```

### Webhooks com implantação privada

Se você precisar de callbacks de webhook (Twilio, Telnyx etc.) sem exposição pública:

1. **Túnel ngrok** – Execute o ngrok dentro do contêiner ou como sidecar
2. **Tailscale Funnel** – Exponha caminhos específicos via Tailscale
3. **Somente saída** – Alguns provedores (Twilio) funcionam bem para chamadas de saída sem webhooks

Exemplo de configuração de chamada de voz com ngrok:

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

O túnel ngrok roda dentro do contêiner e fornece uma URL pública de webhook sem expor o app do Fly em si. Defina `webhookSecurity.allowedHosts` como o hostname público do túnel para que headers de host encaminhados sejam aceitos.

### Benefícios de segurança

| Aspecto                 | Público    | Privado    |
| ----------------------- | ---------- | ---------- |
| Scanners da internet    | Detectável | Oculto     |
| Ataques diretos         | Possíveis  | Bloqueados |
| Acesso à UI de Controle | Navegador  | Proxy/VPN  |
| Entrega de webhook      | Direta     | Via túnel  |

## Notas

- O Fly.io usa **arquitetura x86** (não ARM)
- O Dockerfile é compatível com ambas as arquiteturas
- Para onboarding do WhatsApp/Telegram, use `fly ssh console`
- Os dados persistentes ficam no volume em `/data`
- O Signal requer Java + signal-cli; use uma imagem personalizada e mantenha a memória em 2GB+.

## Custo

Com a configuração recomendada (`shared-cpu-2x`, 2GB de RAM):

- ~$10–15/mês dependendo do uso
- O plano gratuito inclui alguma franquia

Veja [preços do Fly.io](https://fly.io/docs/about/pricing/) para detalhes.
