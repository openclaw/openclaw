---
summary: "Etapas de verificação de saúde para conectividade de canais"
read_when:
  - Diagnosticando a saúde do canal WhatsApp
title: "Verificações de Saúde"
---

# Verificações de Saúde (CLI)

Guia curto para verificar a conectividade do canal sem adivinhações.

## Verificações rápidas

- `openclaw status` — resumo local: alcançabilidade/modo do gateway, dica de atualização, idade da autenticação do canal vinculado, sessões + atividade recente.
- `openclaw status --all` — diagnóstico local completo (somente leitura, com cores, seguro para colar para depuração).
- `openclaw status --deep` — também sonda o Gateway em execução (sondagens por canal quando suportado).
- `openclaw health --json` — solicita ao Gateway em execução um snapshot completo de saúde (apenas WS; sem socket Baileys direto).
- Envie `/status` como uma mensagem independente no WhatsApp/WebChat para obter uma resposta de status sem invocar o agente.
- Logs: tail `/tmp/openclaw/openclaw-*.log` e filtre por `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Diagnósticos aprofundados

- Credenciais em disco: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (o mtime deve ser recente).
- Armazenamento de sessão: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (o caminho pode ser sobrescrito na configuração). A contagem e os destinatários recentes são exibidos via `status`.
- Fluxo de religação: `openclaw channels logout && openclaw channels login --verbose` quando códigos de status 409–515 ou `loggedOut` aparecem nos logs. (Nota: o fluxo de login por QR reinicia automaticamente uma vez para o status 515 após o pareamento.)

## Quando algo falha

- `logged out` ou status 409–515 → religue com `openclaw channels logout` e depois `openclaw channels login`.
- Gateway inacessível → inicie-o: `openclaw gateway --port 18789` (use `--force` se a porta estiver ocupada).
- Sem mensagens de entrada → confirme que o telefone vinculado está online e que o remetente é permitido (`channels.whatsapp.allowFrom`); para chats em grupo, garanta que a lista de permissões + as regras de menção correspondam (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Comando dedicado "health"

`openclaw health --json` solicita ao Gateway em execução seu snapshot de saúde (sem sockets diretos de canal a partir da CLI). Ele relata credenciais vinculadas/idade da autenticação quando disponível, resumos de sondagem por canal, resumo do armazenamento de sessões e a duração da sondagem. Ele encerra com código diferente de zero se o Gateway estiver inacessível ou se a sondagem falhar/expirar. Use `--timeout <ms>` para sobrescrever o padrão de 10s.
