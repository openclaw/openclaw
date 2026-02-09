---
summary: "Configuração avançada e fluxos de trabalho de desenvolvimento para o OpenClaw"
read_when:
  - Configurando uma nova máquina
  - Você quer o “último e melhor” sem quebrar sua configuração pessoal
title: "Configuração"
---

# Configuração

<Note>
Se você estiver configurando pela primeira vez, comece com [Primeiros passos](/start/getting-started).
Para detalhes do assistente, veja [Assistente de Onboarding](/start/wizard).
</Note>

Última atualização: 2026-01-01

## TL;DR

- **A personalização fica fora do repo:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).
- **Fluxo estável:** instale o app do macOS; deixe-o executar o Gateway empacotado.
- **Fluxo bleeding edge:** execute o Gateway você mesmo via `pnpm gateway:watch`, depois deixe o app do macOS anexar em modo Local.

## Pré-requisitos (a partir do código-fonte)

- Node `>=22`
- `pnpm`
- Docker (opcional; apenas para configuração em contêiner/e2e — veja [Docker](/install/docker))

## Estratégia de personalização (para que atualizações não prejudiquem)

Se você quer “100% personalizado para mim” _e_ atualizações fáceis, mantenha sua customização em:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memórias; torne um repo git privado)

Faça o bootstrap uma vez:

```bash
openclaw setup
```

De dentro deste repo, use a entrada local da CLI:

```bash
openclaw setup
```

Se você ainda não tem uma instalação global, execute via `pnpm openclaw setup`.

## Execute o Gateway a partir deste repo

Após `pnpm build`, você pode executar a CLI empacotada diretamente:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Fluxo estável (app do macOS primeiro)

1. Instale + inicie **OpenClaw.app** (barra de menus).
2. Conclua a checklist de onboarding/permissões (prompts de TCC).
3. Garanta que o Gateway esteja **Local** e em execução (o app o gerencia).
4. Vincule superfícies (exemplo: WhatsApp):

```bash
openclaw channels login
```

5. Verificação rápida:

```bash
openclaw health
```

Se o onboarding não estiver disponível na sua build:

- Execute `openclaw setup`, depois `openclaw channels login`, e então inicie o Gateway manualmente (`openclaw gateway`).

## Fluxo bleeding edge (Gateway em um terminal)

Objetivo: trabalhar no Gateway em TypeScript, obter hot reload e manter a UI do app do macOS anexada.

### 0. (Opcional) Execute também o app do macOS a partir do código-fonte

Se você também quiser o app do macOS no bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1. Inicie o Gateway de desenvolvimento

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` executa o gateway em modo watch e recarrega em alterações de TypeScript.

### 2. Aponte o app do macOS para o seu Gateway em execução

No **OpenClaw.app**:

- Modo de conexão: **Local**
  O app vai se anexar ao gateway em execução na porta configurada.

### 3. Verifique

- O status do Gateway no app deve mostrar **“Using existing gateway …”**
- Ou via CLI:

```bash
openclaw health
```

### Armadilhas comuns

- **Porta errada:** o WS do Gateway usa por padrão `ws://127.0.0.1:18789`; mantenha app + CLI na mesma porta.
- **Onde o estado fica:**
  - Credenciais: `~/.openclaw/credentials/`
  - Sessões: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Mapa de armazenamento de credenciais

Use isto ao depurar autenticação ou decidir o que fazer backup:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Token do bot do Telegram**: config/env ou `channels.telegram.tokenFile`
- **Token do bot do Discord**: config/env (arquivo de token ainda não suportado)
- **Tokens do Slack**: config/env (`channels.slack.*`)
- **Listas de permissões de pareamento**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Perfis de autenticação do modelo**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Importação de OAuth legado**: `~/.openclaw/credentials/oauth.json`
  Mais detalhes: [Security](/gateway/security#credential-storage-map).

## Atualizando (sem detonar sua configuração)

- Mantenha `~/.openclaw/workspace` e `~/.openclaw/` como “suas coisas”; não coloque prompts/config pessoais no repo `openclaw`.
- Atualizando o código-fonte: `git pull` + `pnpm install` (quando o lockfile mudar) + continue usando `pnpm gateway:watch`.

## Linux (serviço de usuário do systemd)

Instalações no Linux usam um serviço de **usuário** do systemd. Por padrão, o systemd para serviços de usuário ao fazer logout/idle, o que encerra o Gateway. O onboarding tenta habilitar lingering para você (pode pedir sudo). Se ainda estiver desativado, execute:

```bash
sudo loginctl enable-linger $USER
```

Para servidores sempre ativos ou multiusuário, considere um serviço de **sistema** em vez de um serviço de usuário (não requer lingering). Veja [Gateway runbook](/gateway) para as notas de systemd.

## Documentos relacionados

- [Gateway runbook](/gateway) (flags, supervisão, portas)
- [Configuração do Gateway](/gateway/configuration) (esquema de configuração + exemplos)
- [Discord](/channels/discord) e [Telegram](/channels/telegram) (tags de resposta + configurações de replyToMode)
- [Configuração do assistente OpenClaw](/start/openclaw)
- [App do macOS](/platforms/macos) (ciclo de vida do gateway)
