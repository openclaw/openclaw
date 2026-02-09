---
summary: "Comportamento e configuração para o tratamento de mensagens de grupo do WhatsApp (mentionPatterns são compartilhados entre superfícies)"
read_when:
  - Alterar regras de mensagens de grupo ou menções
title: "Mensagens de grupo"
---

# Mensagens de grupo (canal web do WhatsApp)

Objetivo: permitir que o Clawd fique em grupos do WhatsApp, acorde apenas quando for acionado e mantenha essa conversa separada da sessão de DM pessoal.

Nota: `agents.list[].groupChat.mentionPatterns` agora também é usado por Telegram/Discord/Slack/iMessage; este documento foca no comportamento específico do WhatsApp. Para configurações com múltiplos agentes, defina `agents.list[].groupChat.mentionPatterns` por agente (ou use `messages.groupChat.mentionPatterns` como fallback global).

## O que está implementado (2025-12-03)

- Modos de ativação: `mention` (padrão) ou `always`. `mention` exige um ping (menções reais do WhatsApp com @ via `mentionedJids`, padrões regex ou o E.164 do bot em qualquer lugar do texto). `always` acorda o agente a cada mensagem, mas ele deve responder apenas quando puder agregar valor significativo; caso contrário, retorna o token silencioso `NO_REPLY`. Os padrões podem ser definidos na configuração (`channels.whatsapp.groups`) e sobrescritos por grupo via `/activation`. Quando `channels.whatsapp.groups` está definido, ele também atua como uma lista de permissões de grupos (inclua `"*"` para permitir todos).
- Política de grupo: `channels.whatsapp.groupPolicy` controla se mensagens de grupo são aceitas (`open|disabled|allowlist`). `allowlist` usa `channels.whatsapp.groupAllowFrom` (fallback: `channels.whatsapp.allowFrom` explícito). O padrão é `allowlist` (bloqueado até você adicionar remetentes).
- Sessões por grupo: chaves de sessão têm o formato `agent:<agentId>:whatsapp:group:<jid>`, então comandos como `/verbose on` ou `/think high` (enviados como mensagens isoladas) ficam restritos a esse grupo; o estado de DM pessoal permanece intocado. Heartbeats são ignorados para threads de grupo.
- Injeção de contexto: mensagens de grupo **apenas pendentes** (padrão 50) que _não_ dispararam uma execução são prefixadas sob `[Chat messages since your last reply - for context]`, com a linha que disparou sob `[Current message - respond to this]`. Mensagens já na sessão não são reinjetadas.
- Identificação do remetente: cada lote de grupo agora termina com `[from: Sender Name (+E164)]` para que o Pi saiba quem está falando.
- Efêmeras/visualizar uma vez: nós as desembrulhamos antes de extrair texto/menções, então pings dentro delas ainda disparam.
- Prompt de sistema do grupo: no primeiro turno de uma sessão de grupo (e sempre que `/activation` muda o modo), injetamos um pequeno texto no prompt de sistema como `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Se os metadados não estiverem disponíveis, ainda informamos ao agente que é um chat em grupo.

## Exemplo de configuração (WhatsApp)

Adicione um bloco `groupChat` a `~/.openclaw/openclaw.json` para que pings por nome de exibição funcionem mesmo quando o WhatsApp remove o `@` visual no corpo do texto:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Notas:

- As regexes não diferenciam maiúsculas/minúsculas; elas cobrem um ping por nome de exibição como `@openclaw` e o número bruto com ou sem `+`/espaços.
- O WhatsApp ainda envia menções canônicas via `mentionedJids` quando alguém toca no contato, então o fallback por número raramente é necessário, mas é uma rede de segurança útil.

### Comando de ativação (somente proprietário)

Use o comando de chat do grupo:

- `/activation mention`
- `/activation always`

Apenas o número do proprietário (de `channels.whatsapp.allowFrom`, ou o próprio E.164 do bot quando não definido) pode alterar isso. Envie `/status` como uma mensagem isolada no grupo para ver o modo de ativação atual.

## Como usar

1. Adicione sua conta do WhatsApp (a que executa o OpenClaw) ao grupo.
2. Diga `@openclaw …` (ou inclua o número). Apenas remetentes na lista de permissões podem acioná-lo, a menos que você defina `groupPolicy: "open"`.
3. O prompt do agente incluirá o contexto recente do grupo mais o marcador final `[from: …]` para que ele possa se dirigir à pessoa certa.
4. Diretivas no nível da sessão (`/verbose on`, `/think high`, `/new` ou `/reset`, `/compact`) aplicam-se apenas à sessão desse grupo; envie-as como mensagens isoladas para que sejam registradas. Sua sessão de DM pessoal permanece independente.

## Testes / verificação

- Smoke manual:
  - Envie um ping `@openclaw` no grupo e confirme uma resposta que faça referência ao nome do remetente.
  - Envie um segundo ping e verifique se o bloco de histórico é incluído e depois limpo no próximo turno.
- Verifique os logs do gateway (execute com `--verbose`) para ver entradas `inbound web message` mostrando `from: <groupJid>` e o sufixo `[from: …]`.

## Considerações conhecidas

- Heartbeats são intencionalmente ignorados para grupos para evitar transmissões ruidosas.
- A supressão de eco usa a string combinada do lote; se você enviar o mesmo texto duas vezes sem menções, apenas a primeira receberá resposta.
- Entradas no armazenamento de sessões aparecerão como `agent:<agentId>:whatsapp:group:<jid>` no armazenamento de sessões (`~/.openclaw/agents/<agentId>/sessions/sessions.json` por padrão); uma entrada ausente apenas significa que o grupo ainda não disparou uma execução.
- Indicadores de digitação em grupos seguem `agents.defaults.typingMode` (padrão: `message` quando não mencionado).
