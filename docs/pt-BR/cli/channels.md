---
summary: "Referência da CLI para `openclaw channels` (contas, status, login/logout, logs)"
read_when:
  - Você quer adicionar/remover contas de canal (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Você quer verificar o status do canal ou acompanhar logs do canal
title: "canais"
---

# `openclaw channels`

Gerencie contas de canais de chat e seu status de execução no Gateway.

Documentos relacionados:

- Guias de canais: [Channels](/channels/index)
- Configuração do Gateway: [Configuration](/gateway/configuration)

## Comandos comuns

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Adicionar / remover contas

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Dica: `openclaw channels add --help` mostra flags por canal (token, token do app, caminhos do signal-cli, etc).

## Login / logout (interativo)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Solução de problemas

- Execute `openclaw status --deep` para uma verificação ampla.
- Use `openclaw doctor` para correções guiadas.
- `openclaw channels list` imprime `Claude: HTTP 403 ... user:profile` → o snapshot de uso precisa do escopo `user:profile`. Use `--no-usage`, ou forneça uma chave de sessão do claude.ai (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), ou reautentique via Claude Code CLI.

## Verificação de capacidades

Busca dicas de capacidades do provedor (intents/escopos quando disponíveis) além de suporte estático a recursos:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notas:

- `--channel` é opcional; omita para listar todos os canais (incluindo extensões).
- `--target` aceita `channel:<id>` ou um id numérico bruto do canal e se aplica apenas ao Discord.
- As verificações são específicas do provedor: intents do Discord + permissões opcionais de canal; escopos de bot + usuário do Slack; flags de bot + webhook do Telegram; versão do daemon do Signal; token do app do MS Teams + funções/escopos do Graph (anotados quando conhecidos). Canais sem verificação reportam `Probe: unavailable`.

## Resolver nomes para IDs

Resolva nomes de canais/usuários para IDs usando o diretório do provedor:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notas:

- Use `--kind user|group|auto` para forçar o tipo de destino.
- A resolução prioriza correspondências ativas quando várias entradas compartilham o mesmo nome.
