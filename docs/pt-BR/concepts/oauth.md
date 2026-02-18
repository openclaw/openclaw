---
summary: "OAuth em OpenClaw: troca de token, armazenamento e padrões multi-conta"
read_when:
  - Você quer entender OAuth do OpenClaw ponta a ponta
  - Você bate em problemas de invalidação/logout de token
  - Você quer setup-token ou fluxos de autenticação OAuth
  - Você quer múltiplas contas ou roteamento de perfil
title: "OAuth"
---

# OAuth

OpenClaw suporta "autenticação de assinatura" via OAuth para provedores que o oferecem (notavelmente **OpenAI Codex (ChatGPT OAuth)**). Para assinaturas Anthropic, use o fluxo **setup-token**. Esta página explica:

- como o **troca de token** OAuth funciona (PKCE)
- onde tokens são **armazenados** (e por que)
- como manipular **múltiplas contas** (perfis + substituições por sessão)

OpenClaw também suporta **plugins de provedor** que enviam seus próprios OAuth ou fluxos de chave de API. Execute-os via:

```bash
openclaw models auth login --provider <id>
```

## O token sink (por que existe)

Provedores OAuth comumente cunham um **novo token de refresh** durante fluxos de login/refresh. Alguns provedores (ou clientes OAuth) podem invalidar tokens de refresh mais antigos quando um novo é emitido para o mesmo usuário/app.

Sintoma prático:

- você faz login via OpenClaw _e_ via Claude Code / Codex CLI → um deles aleatoriamente fica "logged out" depois

Para reduzir isso, OpenClaw trata `auth-profiles.json` como um **token sink**:

- o runtime lê credenciais de **um lugar**
- podemos manter múltiplos perfis e rotacioná-los deterministicamente

## Armazenamento (onde tokens vivem)

Segredos são armazenados **por agente**:

- Perfis de autenticação (OAuth + chaves de API): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Cache de runtime (gerenciado automaticamente; não edite): `~/.openclaw/agents/<agentId>/agent/auth.json`

Arquivo legado apenas para importação (ainda suportado, mas não a principal store):

- `~/.openclaw/credentials/oauth.json` (importado para `auth-profiles.json` no primeiro uso)

Tudo lo acima também respeita `$OPENCLAW_STATE_DIR` (substituição de diretório de estado). Referência completa: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (autenticação de assinatura)

Execute `claude setup-token` em qualquer máquina, depois cole em OpenClaw:

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

## Troca OAuth (como login funciona)

Os fluxos de login interativos do OpenClaw são implementados em `@mariozechner/pi-ai` e fiados nos assistentes/comandos.

### Anthropic (Claude Pro/Max) setup-token

Forma de fluxo:

1. execute `claude setup-token`
