---
summary: "Superfície de ferramentas do agente para o OpenClaw (browser, canvas, nodes, message, cron) substituindo as Skills legadas `openclaw-*`"
read_when:
  - Adicionar ou modificar ferramentas do agente
  - Aposentar ou alterar Skills `openclaw-*`
title: "Tools"
---

# Tools (OpenClaw)

O OpenClaw expõe **ferramentas de agente de primeira classe** para browser, canvas, nodes e cron.
Elas substituem as antigas Skills `openclaw-*`: as ferramentas são tipadas, sem shelling,
e o agente deve confiar nelas diretamente.

## Desabilitando ferramentas

Você pode permitir/negar ferramentas globalmente via `tools.allow` / `tools.deny` em `openclaw.json`
(negação prevalece). Isso impede que ferramentas não permitidas sejam enviadas aos provedores de modelo.

```json5
{
  tools: { deny: ["browser"] },
}
```

Notas:

- Correspondência é insensível a maiúsculas e minúsculas.
- Curingas `*` são suportados (`"*"` significa todas as ferramentas).
- Se `tools.allow` referenciar apenas nomes de ferramentas de plugin desconhecidos ou não carregados, o OpenClaw registra um aviso e ignora a allowlist para que as ferramentas principais continuem disponíveis.

## Perfis de ferramentas (allowlist base)

`tools.profile` define uma **allowlist base de ferramentas** antes de `tools.allow`/`tools.deny`.
Substituição por agente: `agents.list[].tools.profile`.

Perfis:

- `minimal`: apenas `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: sem restrição (igual a não definido)

Exemplo (apenas mensagens por padrão, permitir também ferramentas do Slack + Discord):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Exemplo (perfil de código, mas negar exec/process em todos os lugares):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Exemplo (perfil global de código, agente de suporte apenas para mensagens):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Política de ferramentas específica por provedor

Use `tools.byProvider` para **restringir ainda mais** as ferramentas para provedores específicos
(ou um único `provider/model`) sem alterar seus padrões globais.
Substituição por agente: `agents.list[].tools.byProvider`.

Isso é aplicado **após** o perfil base de ferramentas e **antes** das listas de permitir/negar,
portanto só pode reduzir o conjunto de ferramentas.
As chaves de provedor aceitam `provider` (por exemplo, `google-antigravity`) ou
`provider/model` (por exemplo, `openai/gpt-5.2`).

Exemplo (manter o perfil global de código, mas ferramentas mínimas para o Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Exemplo (allowlist específica por provedor/modelo para um endpoint instável):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Exemplo (substituição específica por agente para um único provedor):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Grupos de ferramentas (atalhos)

Políticas de ferramentas (global, agente, sandbox) suportam entradas `group:*` que se expandem para várias ferramentas.
Use-as em `tools.allow` / `tools.deny`.

Grupos disponíveis:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: todas as ferramentas integradas do OpenClaw (exclui plugins de provedores)

Exemplo (permitir apenas ferramentas de arquivo + browser):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + ferramentas

Plugins podem registrar **ferramentas adicionais** (e comandos de CLI) além do conjunto principal.
Veja [Plugins](/tools/plugin) para instalação + configuração e [Skills](/tools/skills) para saber como
a orientação de uso de ferramentas é injetada nos prompts. Alguns plugins vêm com suas próprias Skills
junto com ferramentas (por exemplo, o plugin de chamadas de voz).

Ferramentas opcionais de plugin:

- [Lobster](/tools/lobster): runtime de workflow tipado com aprovações retomáveis (requer a CLI do Lobster no host do Gateway).
- [LLM Task](/tools/llm-task): etapa de LLM somente em JSON para saída estruturada de workflow (validação de esquema opcional).

## Inventário de ferramentas

### `apply_patch`

Aplicar patches estruturados em um ou mais arquivos. Use para edições com vários hunks.
Experimental: habilite via `tools.exec.applyPatch.enabled` (apenas modelos OpenAI).

### `exec`

Executar comandos de shell no workspace.

Parâmetros principais:

- `command` (obrigatório)
- `yieldMs` (vai para background automaticamente após timeout, padrão 10000)
- `background` (background imediato)
- `timeout` (segundos; encerra o processo se excedido, padrão 1800)
- `elevated` (bool; executa no host se o modo elevado estiver habilitado/permitido; só altera o comportamento quando o agente está em sandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (id/nome do node para `host=node`)
- Precisa de um TTY real? Defina `pty: true`.

Notas:

- Retorna `status: "running"` com um `sessionId` quando em background.
- Use `process` para consultar/logar/escrever/encerrar/limpar sessões em background.
- Se `process` não for permitido, `exec` executa de forma síncrona e ignora `yieldMs`/`background`.
- `elevated` é controlado por `tools.elevated` mais qualquer substituição `agents.list[].tools.elevated` (ambos devem permitir) e é um alias para `host=gateway` + `security=full`.
- `elevated` só altera o comportamento quando o agente está em sandbox (caso contrário, não tem efeito).
- `host=node` pode direcionar para um aplicativo complementar do macOS ou um host de node headless (`openclaw node run`).
- aprovações e allowlists de gateway/node: [Exec approvals](/tools/exec-approvals).

### `process`

Gerenciar sessões de exec em background.

Ações principais:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Notas:

- `poll` retorna nova saída e status de saída quando concluído.
- `log` suporta `offset`/`limit` baseados em linhas (omita `offset` para pegar as últimas N linhas).
- `process` é por agente; sessões de outros agentes não são visíveis.

### `web_search`

Pesquisar na web usando a API do Brave Search.

Parâmetros principais:

- `query` (obrigatório)
- `count` (1–10; padrão de `tools.web.search.maxResults`)

Notas:

- Requer uma chave de API do Brave (recomendado: `openclaw configure --section web`, ou defina `BRAVE_API_KEY`).
- Habilite via `tools.web.search.enabled`.
- As respostas são armazenadas em cache (padrão 15 min).
- Veja [Web tools](/tools/web) para configuração.

### `web_fetch`

Buscar e extrair conteúdo legível de uma URL (HTML → markdown/texto).

Parâmetros principais:

- `url` (obrigatório)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncar páginas longas)

Notas:

- Habilite via `tools.web.fetch.enabled`.
- `maxChars` é limitado por `tools.web.fetch.maxCharsCap` (padrão 50000).
- As respostas são armazenadas em cache (padrão 15 min).
- Para sites com muito JS, prefira a ferramenta de browser.
- Veja [Web tools](/tools/web) para configuração.
- Veja [Firecrawl](/tools/firecrawl) para o fallback anti-bot opcional.

### `browser`

Controlar o browser dedicado gerenciado pelo OpenClaw.

Ações principais:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (retorna bloco de imagem + `MEDIA:<path>`)
- `act` (ações de UI: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Gerenciamento de perfis:

- `profiles` — listar todos os perfis de browser com status
- `create-profile` — criar novo perfil com porta alocada automaticamente (ou `cdpUrl`)
- `delete-profile` — parar o browser, excluir dados do usuário, remover da configuração (apenas local)
- `reset-profile` — encerrar processo órfão na porta do perfil (apenas local)

Parâmetros comuns:

- `profile` (opcional; padrão `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opcional; seleciona um id/nome de node específico)
  Notas:
- Requer `browser.enabled=true` (padrão é `true`; defina `false` para desabilitar).
- Todas as ações aceitam o parâmetro opcional `profile` para suporte a múltiplas instâncias.
- Quando `profile` é omitido, usa `browser.defaultProfile` (padrão "chrome").
- Nomes de perfil: apenas alfanuméricos em minúsculas + hífens (máx. 64 caracteres).
- Faixa de portas: 18800–18899 (~100 perfis no máximo).
- Perfis remotos são apenas para anexar (sem start/stop/reset).
- Se um node com capacidade de browser estiver conectado, a ferramenta pode rotear automaticamente para ele (a menos que você fixe `target`).
- `snapshot` usa por padrão `ai` quando o Playwright está instalado; use `aria` para a árvore de acessibilidade.
- `snapshot` também suporta opções de snapshot por função (`interactive`, `compact`, `depth`, `selector`) que retornam refs como `e12`.
- `act` requer `ref` de `snapshot` (numérico `12` de snapshots de IA, ou `e12` de snapshots por função); use `evaluate` para casos raros que exigem seletor CSS.
- Evite `act` → `wait` por padrão; use apenas em casos excepcionais (sem estado confiável de UI para aguardar).
- `upload` pode opcionalmente passar um `ref` para auto-clique após armar.
- `upload` também suporta `inputRef` (ref aria) ou `element` (seletor CSS) para definir `<input type="file">` diretamente.

### `canvas`

Controlar o Canvas do node (present, eval, snapshot, A2UI).

Ações principais:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (retorna bloco de imagem + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Notas:

- Usa `node.invoke` do gateway por baixo dos panos.
- Se nenhum `node` for fornecido, a ferramenta escolhe um padrão (um único node conectado ou node local do mac).
- A2UI é apenas v0.8 (sem `createSurface`); a CLI rejeita JSONL v0.9 com erros de linha.
- Teste rápido: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Descobrir e direcionar nodes pareados; enviar notificações; capturar câmera/tela.

Ações principais:

- `status`, `describe`
- `pending`, `approve`, `reject` (pareamento)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Notas:

- Comandos de câmera/tela exigem que o app do node esteja em primeiro plano.
- Imagens retornam blocos de imagem + `MEDIA:<path>`.
- Vídeos retornam `FILE:<path>` (mp4).
- Localização retorna um payload JSON (lat/lon/precisão/timestamp).
- Parâmetros de `run`: array argv `command`; opcionais `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Exemplo (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Analisar uma imagem com o modelo de imagem configurado.

Parâmetros principais:

- `image` (caminho ou URL obrigatório)
- `prompt` (opcional; padrão "Describe the image.")
- `model` (substituição opcional)
- `maxBytesMb` (limite opcional de tamanho)

Notas:

- Disponível apenas quando `agents.defaults.imageModel` está configurado (primário ou fallbacks), ou quando um modelo de imagem implícito pode ser inferido a partir do seu modelo padrão + autenticação configurada (emparelhamento best-effort).
- Usa o modelo de imagem diretamente (independente do modelo principal de chat).

### `message`

Enviar mensagens e ações de canal em Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Ações principais:

- `send` (texto + mídia opcional; MS Teams também suporta `card` para Adaptive Cards)
- `poll` (enquetes do WhatsApp/Discord/MS Teams)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Notas:

- `send` roteia o WhatsApp via o Gateway; outros canais vão direto.
- `poll` usa o Gateway para WhatsApp e MS Teams; enquetes do Discord vão direto.
- Quando uma chamada de ferramenta de mensagem está vinculada a uma sessão de chat ativa, os envios ficam restritos ao alvo dessa sessão para evitar vazamentos entre contextos.

### `cron`

Gerenciar jobs de cron e wakeups do Gateway.

Ações principais:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (enfileirar evento do sistema + heartbeat imediato opcional)

Notas:

- `add` espera um objeto completo de job de cron (mesmo esquema do RPC `cron.add`).
- `update` usa `{ jobId, patch }` (`id` aceito por compatibilidade).

### `gateway`

Reiniciar ou aplicar atualizações ao processo do Gateway em execução (in-place).

Ações principais:

- `restart` (autoriza + envia `SIGUSR1` para reinício em processo; reinício in-place `openclaw gateway`)
- `config.get` / `config.schema`
- `config.apply` (validar + gravar configuração + reiniciar + acordar)
- `config.patch` (mesclar atualização parcial + reiniciar + acordar)
- `update.run` (executar atualização + reiniciar + acordar)

Notas:

- Use `delayMs` (padrão 2000) para evitar interromper uma resposta em andamento.
- `restart` é desabilitado por padrão; habilite com `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Listar sessões, inspecionar histórico de transcrições ou enviar para outra sessão.

Parâmetros principais:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = nenhum)
- `sessions_history`: `sessionKey` (ou `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (ou `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (padrão atual; aceita `sessionId`), `model?` (`default` limpa a substituição)

Notas:

- `main` é a chave canônica de chat direto; global/desconhecido ficam ocultos.
- `messageLimit > 0` busca as últimas N mensagens por sessão (mensagens de ferramenta filtradas).
- `sessions_send` aguarda a conclusão final quando `timeoutSeconds > 0`.
- A entrega/anúncio ocorre após a conclusão e é best-effort; `status: "ok"` confirma que a execução do agente terminou, não que o anúncio foi entregue.
- `sessions_spawn` inicia uma execução de subagente e publica uma resposta de anúncio de volta ao chat solicitante.
- `sessions_spawn` não bloqueia e retorna `status: "accepted"` imediatamente.
- `sessions_send` executa um ping‑pong de resposta (responda `REPLY_SKIP` para parar; máximo de turnos via `session.agentToAgent.maxPingPongTurns`, 0–5).
- Após o ping‑pong, o agente alvo executa uma **etapa de anúncio**; responda `ANNOUNCE_SKIP` para suprimir o anúncio.

### `agents_list`

Listar ids de agentes que a sessão atual pode direcionar com `sessions_spawn`.

Notas:

- O resultado é restrito às allowlists por agente (`agents.list[].subagents.allowAgents`).
- Quando `["*"]` está configurado, a ferramenta inclui todos os agentes configurados e marca `allowAny: true`.

## Parâmetros (comum)

Ferramentas apoiadas pelo Gateway (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (padrão `ws://127.0.0.1:18789`)
- `gatewayToken` (se a autenticação estiver habilitada)
- `timeoutMs`

Nota: quando `gatewayUrl` está definido, inclua `gatewayToken` explicitamente. As ferramentas não herdam configuração
ou credenciais de ambiente para substituições, e a ausência de credenciais explícitas é um erro.

Ferramenta de browser:

- `profile` (opcional; padrão `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opcional; fixar um id/nome de node específico)

## Fluxos recomendados do agente

Automação de browser:

1. `browser` → `status` / `start`
2. `snapshot` (ai ou aria)
3. `act` (click/type/press)
4. `screenshot` se precisar de confirmação visual

Renderização de Canvas:

1. `canvas` → `present`
2. `a2ui_push` (opcional)
3. `snapshot`

Direcionamento de node:

1. `nodes` → `status`
2. `describe` no node escolhido
3. `notify` / `run` / `camera_snap` / `screen_record`

## Segurança

- Evite `system.run` direto; use `nodes` → `run` apenas com consentimento explícito do usuário.
- Respeite o consentimento do usuário para captura de câmera/tela.
- Use `status/describe` para garantir permissões antes de invocar comandos de mídia.

## Como as ferramentas são apresentadas ao agente

As ferramentas são expostas em dois canais paralelos:

1. **Texto do prompt do sistema**: uma lista legível por humanos + orientação.
2. **Esquema da ferramenta**: as definições estruturadas de função enviadas à API do modelo.

Isso significa que o agente vê tanto “quais ferramentas existem” quanto “como chamá-las”. Se uma ferramenta
não aparecer no prompt do sistema nem no esquema, o modelo não pode chamá-la.
