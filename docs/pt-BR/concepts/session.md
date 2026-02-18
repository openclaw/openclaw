---
summary: "Regras de gerenciamento de sessão, chaves e persistência para chats"
read_when:
  - Modificando o tratamento ou armazenamento de sessão
title: "Gerenciamento de Sessão"
---

# Gerenciamento de Sessão

OpenClaw trata **uma sessão de chat direto por agente** como primária. Chats diretos colapsam para `agent:<agentId>:<mainKey>` (padrão `main`), enquanto chats de grupo/canal recebem suas próprias chaves. `session.mainKey` é honrado.

Use `session.dmScope` para controlar como **mensagens diretas** são agrupadas:

- `main` (padrão): todas as DMs compartilham a sessão principal para continuidade.
- `per-peer`: isola por id de remetente entre canais.
- `per-channel-peer`: isola por canal + remetente (recomendado para caixas de entrada multi-usuário).
- `per-account-channel-peer`: isola por conta + canal + remetente (recomendado para caixas de entrada multi-conta).
  Use `session.identityLinks` para mapear ids de peer com prefixo de provedor para uma identidade canônica para que a mesma pessoa compartilhe uma sessão de DM entre canais ao usar `per-peer`, `per-channel-peer`, ou `per-account-channel-peer`.

## Modo DM seguro (recomendado para configurações multi-usuário)

> **Aviso de Segurança:** Se seu agente pode receber DMs de **múltiplas pessoas**, você deve fortemente considerar abilitar modo DM seguro. Sem isso, todos os usuários compartilham o mesmo contexto de conversa, o que pode vazar informações privadas entre usuários.

**Exemplo do problema com configurações padrão:**

- Alice (`<SENDER_A>`) mensagens seu agente sobre um tópico privado (por exemplo, uma consulta médica)
- Bob (`<SENDER_B>`) mensagens seu agente perguntando "Sobre o que estávamos falando?"
- Como ambas as DMs compartilham a mesma sessão, o modelo pode responder a Bob usando o contexto anterior de Alice.

**A solução:** Defina `dmScope` para isolar sessões por usuário:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Modo DM seguro: isola contexto de DM por canal + remetente.
    dmScope: "per-channel-peer",
  },
}
```

**Quando habilitar isso:**

- Você tem aprovações de emparelhamento para mais de um remetente
- Você usa uma lista de permissões de DM com múltiplas entradas
- Você define `dmPolicy: "open"`
- Múltiplos números de telefone ou contas podem mensagear seu agente

Notas:

- O padrão é `dmScope: "main"` para continuidade (todas as DMs compartilham a sessão principal). Isso é bom para configurações de usuário único.
- Para caixas de entrada multi-conta no mesmo canal, prefira `per-account-channel-peer`.
- Se a mesma pessoa o contatar em múltiplos canais, use `session.identityLinks` para colapsar suas sessões de DM em uma identidade canônica.
- Você pode verificar suas configurações de DM com `openclaw security audit` (veja [security](/cli/security)).

## Gateway é a fonte de verdade

Todo o estado da sessão é **propriedade do gateway** (o "mestre" OpenClaw). Clientes de interface (app macOS, WebChat, etc.) devem consultar o gateway para listas de sessão e contagens de token em vez de ler arquivos locais.

- Em **modo remoto**, o armazenamento de sessão que você se importa vive no host do gateway remoto, não no seu Mac.
- Contagens de token mostradas nas interfaces vêm dos campos de armazenamento do gateway (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Clientes não analisam transcrições JSONL para "corrigir" totais.

## Onde o estado vive

- No **host do gateway**:
  - Arquivo de armazenamento: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (por agente).
- Transcrições: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (sessões de tópico Telegram usam `.../<SessionId>-topic-<threadId>.jsonl`).
- O armazenamento é um mapa `sessionKey -> { sessionId, updatedAt, ... }`. Excluir entradas é seguro; elas são recriadas sob demanda.
- Entradas de grupo podem incluir `displayName`, `channel`, `subject`, `room`, e `space` para rotular sessões em interfaces.
- Entradas de sessão incluem metadados de `origin` (rótulo + dicas de roteamento) para que interfaces possam explicar de onde uma sessão veio.
- OpenClaw **não** lê pastas de sessão herdadas Pi/Tau.

## Limpeza de sessão

OpenClaw aparas **resultados de ferramentas antigas** do contexto na memória logo antes de chamadas de LLM por padrão.
Isso **não** reescreve histórico JSONL. Veja [/pt-BR/concepts/session-pruning](/pt-BR/concepts/session-pruning).

## Flush de memória pré-compactação

Quando uma sessão se aproxima de auto-compactação, OpenClaw pode executar uma volta de **flush de memória silencioso** que lembra o modelo a escrever notas duráveis em disco. Isso só executado quando o workspace é gravável. Veja [Memória](/pt-BR/concepts/memory) e [Compactação](/pt-BR/concepts/compaction).

## Mapeando transportes → chaves de sessão

- Chats diretos segue `session.dmScope` (padrão `main`).
  - `main`: `agent:<agentId>:<mainKey>` (continuidade entre dispositivos/canais).
    - Múltiplos números de telefone e canais podem mapear para a mesma chave principal do agente; agem como transportes em uma conversa.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId padrão é `default`).
  - Se `session.identityLinks` corresponde a um id de peer com prefixo de provedor (por exemplo `telegram:123`), a chave canônica substitui `<peerId>` para que a mesma pessoa compartilhe uma sessão entre canais.
- Chats de grupo isolam estado: `agent:<agentId>:<channel>:group:<id>` (salas/canais usam `agent:<agentId>:<channel>:channel:<id>`).
  - Tópicos de fórum Telegram anexam `:topic:<threadId>` ao id do grupo para isolamento.
  - Chaves legadas `group:<id>` ainda são reconhecidas para migração.
- Contextos de entrada ainda podem usar `group:<id>`; o canal é inferido de `Provider` e normalizado para a forma canônica `agent:<agentId>:<channel>:group:<id>`.
- Outras fontes:
  - Cron jobs: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (a menos que explicitamente definido pelo webhook)
  - Execuções de nó: `node-<nodeId>`

## Ciclo de vida

- Política de reset: sessões são reutilizadas até expirar, e expiração é avaliada na próxima mensagem de entrada.
- Reset diário: padrão de **4:00 AM horário local no host do gateway**. Uma sessão fica obsoleta uma vez que sua última atualização é anterior ao tempo de reset diário mais recente.
- Reset ocioso (opcional): `idleMinutes` adiciona uma janela de ociosidade deslizante. Quando resets diários e ociosos são configurados, **aquele que expira primeiro** força uma nova sessão.
- Legado somente ocioso: se você definir `session.idleMinutes` sem qualquer configuração `session.reset`/`resetByType`, OpenClaw fica em modo somente ocioso para compatibilidade retroativa.
- Substituições por tipo (opcional): `resetByType` permite substituir a política para sessões `direct`, `group`, e `thread` (thread = threads Slack/Discord, tópicos Telegram, threads Matrix quando fornecidos pelo conector).
- Substituições por canal (opcional): `resetByChannel` substitui a política de reset para um canal (aplica a todos os tipos de sessão para esse canal e tem precedência sobre `reset`/`resetByType`).
- Triggers de reset: exato `/new` ou `/reset` (mais qualquer coisa extra em `resetTriggers`) inicia um id de sessão fresco e passa o resto da mensagem através. `/new <model>` aceita um alias de modelo, `provider/model`, ou nome do provedor (correspondência difusa) para definir o novo modelo de sessão. Se `/new` ou `/reset` é enviado sozinho, OpenClaw executa uma volta de saudação curta "olá" para confirmar o reset.
- Reset manual: exclua chaves específicas do armazenamento ou remova a transcrição JSONL; a próxima mensagem as recria.
- Cron jobs isolados sempre cunham um `sessionId` fresco por execução (nenhuma reutilização de ociosidade).

## Política de envio (opcional)

Bloqueia entrega para tipos de sessão específicos sem listar ids individuais.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
        // Corresponde a chave de sessão bruta (incluindo o prefixo `agent:<id>:`).
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ],
      default: "allow",
    },
  },
}
```

Substituição de tempo de execução (somente proprietário):

- `/send on` → permitir para esta sessão
- `/send off` → negar para esta sessão
- `/send inherit` → limpar substituição e usar regras de configuração
  Envie essas como mensagens autônomas para que elas se registrem.

## Configuração (exemplo opcional de renomeação)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // mantém chaves de grupo separadas
    dmScope: "main", // continuidade de DM (defina per-channel-peer/per-account-channel-peer para caixas de entrada compartilhadas)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Padrões: mode=daily, atHour=4 (horário local do host do gateway).
      // Se você também definir idleMinutes, o que expira primeiro vence.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Inspecionando

- `openclaw status` — mostra caminho de armazenamento e sessões recentes.
- `openclaw sessions --json` — despeja cada entrada (filtro com `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — busca sessões do gateway em execução (use `--url`/`--token` para acesso remoto de gateway).
- Envie `/status` como uma mensagem autônoma no chat para ver se o agente está acessível, quanto do contexto da sessão é usado, toggles de pensamento/verboso atuais, e quando suas credenciais do WhatsApp web foram atualizadas pela última vez (ajuda a detectar necessidades de relink).
- Envie `/context list` ou `/context detail` para ver o que está no prompt do sistema e arquivos de workspace injetados (e os maiores contribuidores de contexto).
- Envie `/stop` como uma mensagem autônoma para abortar a execução atual, limpar followups enfileirados para essa sessão, e parar qualquer execução de sub-agente gerada a partir dela (a resposta inclui a contagem parada).
- Envie `/compact` (instruções opcionais) como uma mensagem autônoma para resumir contexto mais antigo e liberar espaço de janela. Veja [/pt-BR/concepts/compaction](/pt-BR/concepts/compaction).
- Transcrições JSONL podem ser abertas diretamente para revisar voltas completas.

## Dicas

- Mantenha a chave principal dedicada ao tráfego 1:1; deixe grupos manterem suas próprias chaves.
- Ao automatizar limpeza, delete chaves individuais em vez de todo o armazenamento para preservar contexto em outro lugar.

## Metadados de origem da sessão

Cada entrada de sessão registra de onde veio (melhor esforço) em `origin`:

- `label`: rótulo humano (resolvido de rótulo de conversa + assunto/canal de grupo)
- `provider`: id do canal normalizado (incluindo extensões)
- `from`/`to`: ids de roteamento brutos do envelope de entrada
- `accountId`: id da conta do provedor (quando multi-conta)
- `threadId`: id do thread/tópico quando o canal suporta
  Os campos de origem são preenchidos para mensagens diretas, canais e grupos. Se um conector apenas atualiza roteamento de entrega (por exemplo, para manter uma sessão principal de DM fresca), ainda deve fornecer contexto de entrada para que a sessão mantenha seus metadados de explicador. Extensões podem fazer isso enviando `ConversationLabel`, `GroupSubject`, `GroupChannel`, `GroupSpace`, e `SenderName` no contexto de entrada e chamando `recordSessionMetaFromInbound` (ou passando o mesmo contexto para `updateLastRoute`).
