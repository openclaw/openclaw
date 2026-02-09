---
summary: "Configuração e integração inicial opcionais baseadas em Docker para o OpenClaw"
read_when:
  - Você quer um gateway em contêiner em vez de instalações locais
  - Você está validando o fluxo do Docker
title: "Docker"
---

# Docker (opcional)

Docker é **opcional**. Use apenas se você quiser um gateway em contêiner ou validar o fluxo do Docker.

## O Docker é ideal para mim?

- **Sim**: você quer um ambiente de gateway isolado e descartável ou executar o OpenClaw em um host sem instalações locais.
- **Não**: você está executando na sua própria máquina e só quer o loop de desenvolvimento mais rápido. Use o fluxo de instalação normal.
- **Nota sobre sandboxing**: o sandboxing do agente também usa Docker, mas **não** exige que o gateway completo rode em Docker. Veja [Sandboxing](/gateway/sandboxing).

Este guia cobre:

- Gateway em contêiner (OpenClaw completo em Docker)
- Sandbox de Agente por sessão (gateway no host + ferramentas do agente isoladas em Docker)

Detalhes de sandboxing: [Sandboxing](/gateway/sandboxing)

## Requisitos

- Docker Desktop (ou Docker Engine) + Docker Compose v2
- Espaço em disco suficiente para imagens + logs

## Gateway em contêiner (Docker Compose)

### Início rápido (recomendado)

A partir da raiz do repositório:

```bash
./docker-setup.sh
```

Este script:

- constrói a imagem do gateway
- executa o assistente de integração
- imprime dicas opcionais de configuração de provedores
- inicia o gateway via Docker Compose
- gera um token do gateway e o grava em `.env`

Variáveis env opcionais:

- `OPENCLAW_DOCKER_APT_PACKAGES` — instala pacotes apt extras durante o build
- `OPENCLAW_EXTRA_MOUNTS` — adiciona bind mounts extras do host
- `OPENCLAW_HOME_VOLUME` — persiste `/home/node` em um volume nomeado

Após finalizar:

- Abra `http://127.0.0.1:18789/` no seu navegador.
- Cole o token na UI de Controle (Configurações → token).
- Precisa da URL novamente? Execute `docker compose run --rm openclaw-cli dashboard --no-open`.

Ele grava config/workspace no host:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Executando em um VPS? Veja [Hetzner (Docker VPS)](/install/hetzner).

### Fluxo manual (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Nota: execute `docker compose ...` a partir da raiz do repositório. Se você ativou
`OPENCLAW_EXTRA_MOUNTS` ou `OPENCLAW_HOME_VOLUME`, o script de setup grava
`docker-compose.extra.yml`; inclua-o ao executar o Compose em outro local:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Token da UI de Controle + pareamento (Docker)

Se você vir “unauthorized” ou “disconnected (1008): pairing required”, obtenha um
novo link do painel e aprove o dispositivo do navegador:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Mais detalhes: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Montagens extras (opcional)

Se você quiser montar diretórios adicionais do host nos contêineres, defina
`OPENCLAW_EXTRA_MOUNTS` antes de executar `docker-setup.sh`. Isso aceita uma
lista separada por vírgulas de bind mounts do Docker e aplica a ambos
`openclaw-gateway` e `openclaw-cli` gerando `docker-compose.extra.yml`.

Exemplo:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notas:

- Os caminhos devem estar compartilhados com o Docker Desktop no macOS/Windows.
- Se você editar `OPENCLAW_EXTRA_MOUNTS`, execute novamente `docker-setup.sh` para regenerar o
  arquivo compose extra.
- `docker-compose.extra.yml` é gerado. Não edite manualmente.

### Persistir todo o home do contêiner (opcional)

Se você quiser que `/home/node` persista entre recriações do contêiner, defina um
volume nomeado via `OPENCLAW_HOME_VOLUME`. Isso cria um volume Docker e o monta em
`/home/node`, mantendo as montagens padrão de config/workspace. Use um
volume nomeado aqui (não um caminho de bind); para bind mounts, use
`OPENCLAW_EXTRA_MOUNTS`.

Exemplo:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Você pode combinar isso com montagens extras:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notas:

- Se você alterar `OPENCLAW_HOME_VOLUME`, execute novamente `docker-setup.sh` para regenerar o
  arquivo compose extra.
- O volume nomeado persiste até ser removido com `docker volume rm <name>`.

### Instalar pacotes apt extras (opcional)

Se você precisar de pacotes de sistema dentro da imagem (por exemplo, ferramentas
de build ou bibliotecas de mídia), defina `OPENCLAW_DOCKER_APT_PACKAGES` antes de executar
`docker-setup.sh`.
Isso instala os pacotes durante o build da imagem, então eles
persistem mesmo que o contêiner seja excluído.

Exemplo:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Notas:

- Aceita uma lista separada por espaços de nomes de pacotes apt.
- Se você alterar `OPENCLAW_DOCKER_APT_PACKAGES`, execute novamente `docker-setup.sh` para reconstruir
  a imagem.

### Contêiner para usuários avançados / com recursos completos (opt-in)

A imagem Docker padrão é **security-first** e roda como o usuário não-root
`node`. Isso mantém a superfície de ataque pequena, mas significa:

- sem instalações de pacotes de sistema em tempo de execução
- sem Homebrew por padrão
- sem navegadores Chromium/Playwright empacotados

Se você quiser um contêiner com mais recursos, use estes controles opt-in:

1. **Persistir `/home/node`** para que downloads de navegadores e caches de ferramentas sobrevivam:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Incorporar dependências de sistema na imagem** (repetível + persistente):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Instalar navegadores do Playwright sem `npx`** (evita conflitos de override do npm):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Se você precisar que o Playwright instale dependências de sistema, reconstrua a
imagem com `OPENCLAW_DOCKER_APT_PACKAGES` em vez de usar `--with-deps` em tempo de execução.

4. **Persistir downloads de navegadores do Playwright**:

- Defina `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` em
  `docker-compose.yml`.
- Garanta que `/home/node` persista via `OPENCLAW_HOME_VOLUME`, ou monte
  `/home/node/.cache/ms-playwright` via `OPENCLAW_EXTRA_MOUNTS`.

### Permissões + EACCES

A imagem roda como `node` (uid 1000). Se você vir erros de permissão em
`/home/node/.openclaw`, certifique-se de que seus bind mounts do host pertençam ao uid 1000.

Exemplo (host Linux):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Se você optar por rodar como root por conveniência, você aceita a troca de segurança.

### Rebuilds mais rápidos (recomendado)

Para acelerar rebuilds, organize seu Dockerfile para que as camadas de dependências
sejam cacheadas.
Isso evita reexecutar `pnpm install` a menos que os lockfiles mudem:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Configuração de canais (opcional)

Use o contêiner da CLI para configurar canais e, se necessário, reinicie o gateway.

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (token do bot):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (token do bot):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (Docker headless)

Se você escolher OpenAI Codex OAuth no assistente, ele abre uma URL no navegador e
tenta capturar um callback em `http://127.0.0.1:1455/auth/callback`. Em Docker ou
configurações headless, esse callback pode mostrar um erro no navegador. Copie a
URL completa de redirecionamento em que você cair e cole de volta no assistente
para finalizar a autenticação.

### Health check

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### Teste de fumaça E2E (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### Teste de fumaça de importação de QR (Docker)

```bash
pnpm test:docker:qr
```

### Notas

- O bind do Gateway usa por padrão `lan` para uso em contêiner.
- O CMD do Dockerfile usa `--allow-unconfigured`; config montada com `gateway.mode` e não `local` ainda iniciará. Substitua o CMD para impor a verificação.
- O contêiner do gateway é a fonte de verdade para sessões (`~/.openclaw/agents/<agentId>/sessions/`).

## Sandbox de Agente (gateway no host + ferramentas em Docker)

Aprofundamento: [Sandboxing](/gateway/sandboxing)

### O que faz

Quando `agents.defaults.sandbox` está habilitado, **sessões não-principais** executam
ferramentas dentro de um contêiner Docker. O gateway permanece no seu host, mas a
execução das ferramentas é isolada:

- escopo: `"agent"` por padrão (um contêiner + workspace por agente)
- escopo: `"session"` para isolamento por sessão
- pasta de workspace por escopo montada em `/workspace`
- acesso opcional ao workspace do agente (`agents.defaults.sandbox.workspaceAccess`)
- política de ferramentas allow/deny (deny vence)
- mídia de entrada é copiada para o workspace ativo do sandbox (`media/inbound/*`)
  para que as ferramentas possam lê-la (com `workspaceAccess: "rw"`, isso vai para o
  workspace do agente)

Aviso: `scope: "shared"` desativa o isolamento entre sessões. Todas as sessões
compartilham um contêiner e um workspace.

### Perfis de sandbox por agente (multi-agente)

Se você usa roteamento multi-agente, cada agente pode sobrescrever configurações
de sandbox + ferramentas: `agents.list[].sandbox` e `agents.list[].tools` (além de
`agents.list[].tools.sandbox.tools`). Isso permite executar níveis de acesso mistos em um único gateway:

- Acesso total (agente pessoal)
- Ferramentas somente leitura + workspace somente leitura (agente familiar/de trabalho)
- Sem ferramentas de filesystem/shell (agente público)

Veja [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para exemplos,
precedência e solução de problemas.

### Comportamento padrão

- Imagem: `openclaw-sandbox:bookworm-slim`
- Um contêiner por agente
- Acesso ao workspace do agente: `workspaceAccess: "none"` (padrão) usa `~/.openclaw/sandboxes`
  - `"ro"` mantém o workspace do sandbox em `/workspace` e monta o
    workspace do agente como somente leitura em `/agent` (desativa
    `write`/`edit`/`apply_patch`)
  - `"rw"` monta o workspace do agente com leitura/escrita em
    `/workspace`
- Auto-prune: inativo > 24h OU idade > 7d
- Rede: `none` por padrão (faça opt-in explícito se precisar de egress)
- Allow padrão: `exec`, `process`, `read`,
  `write`, `edit`, `sessions_list`, `sessions_history`,
  `sessions_send`, `sessions_spawn`, `session_status`
- Deny padrão: `browser`, `canvas`, `nodes`,
  `cron`, `discord`, `gateway`

### Habilitar sandboxing

Se você planeja instalar pacotes em `setupCommand`, observe:

- O `docker.network` padrão é `"none"` (sem egress).
- `readOnlyRoot: true` bloqueia instalações de pacotes.
- `user` deve ser root para `apt-get` (omita `user` ou
  defina `user: "0:0"`).
  O OpenClaw recria automaticamente os contêineres quando `setupCommand` (ou a
  configuração do Docker) muda, a menos que o contêiner tenha sido **usado
  recentemente** (dentro de ~5 minutos). Contêineres “quentes” registram um aviso
  com o comando exato `openclaw sandbox recreate ...`.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Controles de hardening ficam em `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`,
`memorySwap`, `cpus`, `ulimits`, `seccompProfile`,
`apparmorProfile`, `dns`, `extraHosts`.

Multi-agente: sobrescreva `agents.defaults.sandbox.{docker,browser,prune}.*` por agente via `agents.list[].sandbox.{docker,browser,prune}.*`
(ignorado quando `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` é `"shared"`).

### Construir a imagem padrão do sandbox

```bash
scripts/sandbox-setup.sh
```

Isso constrói `openclaw-sandbox:bookworm-slim` usando `Dockerfile.sandbox`.

### Imagem comum de sandbox (opcional)

Se você quiser uma imagem de sandbox com ferramentas comuns de build (Node, Go,
Rust, etc.), construa a imagem comum:

```bash
scripts/sandbox-common-setup.sh
```

Isso constrói `openclaw-sandbox-common:bookworm-slim`. Para usá-la:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Imagem de navegador do sandbox

Para executar a ferramenta de navegador dentro do sandbox, construa a imagem de
navegador:

```bash
scripts/sandbox-browser-setup.sh
```

Isso constrói `openclaw-sandbox-browser:bookworm-slim` usando
`Dockerfile.sandbox-browser`. O contêiner executa o Chromium com CDP habilitado e
um observador noVNC opcional (headful via Xvfb).

Notas:

- Headful (Xvfb) reduz bloqueios de bots vs headless.
- Headless ainda pode ser usado definindo `agents.defaults.sandbox.browser.headless=true`.
- Nenhum ambiente de desktop completo (GNOME) é necessário; o Xvfb fornece o display.

Use a configuração:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

Imagem de navegador personalizada:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Quando habilitado, o agente recebe:

- uma URL de controle do navegador do sandbox (para a ferramenta `browser`)
- uma URL noVNC (se habilitado e headless=false)

Lembre-se: se você usar uma lista de permissões (allowlist) para ferramentas,
adicione `browser` (e remova de deny) ou a ferramenta continuará bloqueada.
As regras de prune (`agents.defaults.sandbox.prune`) também se aplicam a contêineres de navegador.

### Imagem de sandbox personalizada

Construa sua própria imagem e aponte a configuração para ela:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### Política de ferramentas (allow/deny)

- `deny` vence sobre `allow`.
- Se `allow` estiver vazio: todas as ferramentas (exceto deny) estão disponíveis.
- Se `allow` não estiver vazio: apenas as ferramentas em `allow` estão disponíveis (menos deny).

### Estratégia de pruning

Dois controles:

- `prune.idleHours`: remover contêineres não usados em X horas (0 = desativar)
- `prune.maxAgeDays`: remover contêineres mais antigos que X dias (0 = desativar)

Exemplo:

- Manter sessões ativas, mas limitar a vida útil:
  `idleHours: 24`, `maxAgeDays: 7`
- Nunca fazer prune:
  `idleHours: 0`, `maxAgeDays: 0`

### Notas de segurança

- A barreira rígida se aplica apenas a **ferramentas** (exec/read/write/edit/apply_patch).
- Ferramentas somente do host como browser/camera/canvas são bloqueadas por padrão.
- Permitir `browser` no sandbox **quebra o isolamento** (o navegador roda no host).

## Solução de problemas

- Imagem ausente: construa com [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) ou defina `agents.defaults.sandbox.docker.image`.
- Contêiner não está em execução: ele será criado automaticamente por sessão sob demanda.
- Erros de permissão no sandbox: defina `docker.user` para um UID:GID que corresponda à
  propriedade do seu workspace montado (ou faça chown da pasta do workspace).
- Ferramentas personalizadas não encontradas: o OpenClaw executa comandos com
  `sh -lc` (login shell), que carrega `/etc/profile` e pode redefinir o PATH. Defina `docker.env.PATH` para prefixar os caminhos das suas ferramentas personalizadas
  (por exemplo, `/custom/bin:/usr/local/share/npm-global/bin`), ou adicione
  um script em `/etc/profile.d/` no seu Dockerfile.
