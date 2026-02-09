---
summary: "OAuth no OpenClaw: troca de tokens, armazenamento e padrões de múltiplas contas"
read_when:
  - Você quer entender o OAuth no OpenClaw de ponta a ponta
  - Você encontrou problemas de invalidação de token / logout
  - Você quer fluxos de setup-token ou autenticação OAuth
  - Você quer múltiplas contas ou roteamento por perfil
title: "OAuth"
---

# OAuth

O OpenClaw oferece suporte a **“subscription auth”** via OAuth para provedores que o oferecem (notavelmente **OpenAI Codex (ChatGPT OAuth)**). Para assinaturas da Anthropic, use o fluxo **setup-token**. Esta página explica:

- como funciona a **troca de tokens** OAuth (PKCE)
- onde os tokens são **armazenados** (e por quê)
- como lidar com **múltiplas contas** (perfis + substituições por sessão)

O OpenClaw também oferece suporte a **plugins de provedor** que incluem seus próprios fluxos de OAuth ou de chave de API. Execute-os via:

```bash
openclaw models auth login --provider <id>
```

## O sumidouro de tokens (por que ele existe)

Provedores OAuth comumente geram um **novo refresh token** durante fluxos de login/atualização. Alguns provedores (ou clientes OAuth) podem invalidar refresh tokens antigos quando um novo é emitido para o mesmo usuário/app.

Sintoma prático:

- você faz login via OpenClaw _e_ via Claude Code / Codex CLI → um deles acaba sendo “desconectado” aleatoriamente depois

Para reduzir isso, o OpenClaw trata `auth-profiles.json` como um **sumidouro de tokens**:

- o runtime lê credenciais de **um único lugar**
- podemos manter múltiplos perfis e roteá-los de forma determinística

## Armazenamento (onde os tokens ficam)

Segredos são armazenados **por agente**:

- Perfis de autenticação (OAuth + chaves de API): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Cache de runtime (gerenciado automaticamente; não edite): `~/.openclaw/agents/<agentId>/agent/auth.json`

Arquivo legado apenas para importação (ainda suportado, mas não é o armazenamento principal):

- `~/.openclaw/credentials/oauth.json` (importado para `auth-profiles.json` no primeiro uso)

Tudo acima também respeita `$OPENCLAW_STATE_DIR` (substituição do diretório de estado). Referência completa: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## setup-token da Anthropic (subscription auth)

Execute `claude setup-token` em qualquer máquina e depois cole no OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Se você gerou o token em outro lugar, cole manualmente:

```bash
openclaw models auth paste-token --provider anthropic
```

Verifique:

```bash
openclaw models status
```

## Troca OAuth (como o login funciona)

Os fluxos interativos de login do OpenClaw são implementados em `@mariozechner/pi-ai` e integrados aos assistentes/comandos.

### Anthropic (Claude Pro/Max) setup-token

Formato do fluxo:

1. execute `claude setup-token`
2. cole o token no OpenClaw
3. armazene como um perfil de autenticação por token (sem refresh)

O caminho no assistente é `openclaw onboard` → escolha de autenticação `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Formato do fluxo (PKCE):

1. gerar verificador/desafio PKCE + `state` aleatório
2. abrir `https://auth.openai.com/oauth/authorize?...`
3. tentar capturar o callback em `http://127.0.0.1:1455/auth/callback`
4. se o callback não conseguir vincular (ou você estiver remoto/headless), colar a URL/código de redirecionamento
5. trocar em `https://auth.openai.com/oauth/token`
6. extrair `accountId` do token de acesso e armazenar `{ access, refresh, expires, accountId }`

O caminho no assistente é `openclaw onboard` → escolha de autenticação `openai-codex`.

## Atualização + expiração

Os perfis armazenam um carimbo de data/hora `expires`.

Em runtime:

- se `expires` estiver no futuro → usar o token de acesso armazenado
- se estiver expirado → atualizar (sob um bloqueio de arquivo) e sobrescrever as credenciais armazenadas

O fluxo de atualização é automático; geralmente você não precisa gerenciar tokens manualmente.

## Múltiplas contas (perfis) + roteamento

Dois padrões:

### 1. Preferido: agentes separados

Se você quer que “pessoal” e “trabalho” nunca interajam, use agentes isolados (sessões + credenciais + workspace separados):

```bash
openclaw agents add work
openclaw agents add personal
```

Depois, configure a autenticação por agente (assistente) e direcione os chats para o agente correto.

### 2. Avançado: múltiplos perfis em um agente

`auth-profiles.json` oferece suporte a múltiplos IDs de perfil para o mesmo provedor.

Escolha qual perfil é usado:

- globalmente via ordenação de configuração (`auth.order`)
- por sessão via `/model ...@<profileId>`

Exemplo (substituição por sessão):

- `/model Opus@anthropic:work`

Como ver quais IDs de perfil existem:

- `openclaw channels list --json` (mostra `auth[]`)

Documentos relacionados:

- [/concepts/model-failover](/concepts/model-failover) (regras de rotação + cooldown)
- [/tools/slash-commands](/tools/slash-commands) (superfície de comandos)
