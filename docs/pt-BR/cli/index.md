---
summary: "Referência da CLI do OpenClaw para comandos, subcomandos e opções do `openclaw`"
read_when:
  - Ao adicionar ou modificar comandos ou opções da CLI
  - Ao documentar novas superfícies de comando
title: "Referência da CLI"
---

# Referência da CLI

Esta página descreve o comportamento atual da CLI. Se os comandos mudarem, atualize este documento.

## Páginas de comandos

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`plugins`](/cli/plugins) (comandos de plugin)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (plugin; se instalado)

## Flags globais

- `--dev`: isola o estado em `~/.openclaw-dev` e desloca as portas padrão.
- `--profile <name>`: isola o estado em `~/.openclaw-<name>`.
- `--no-color`: desativa cores ANSI.
- `--update`: atalho para `openclaw update` (apenas instalações a partir do código-fonte).
- `-V`, `--version`, `-v`: imprime a versão e sai.

## Estilo de saída

- Cores ANSI e indicadores de progresso só são renderizados em sessões TTY.
- Hiperlinks OSC-8 são renderizados como links clicáveis em terminais compatíveis; caso contrário, usamos URLs simples.
- `--json` (e `--plain` quando suportado) desativa a estilização para uma saída limpa.
- `--no-color` desativa a estilização ANSI; `NO_COLOR=1` também é respeitado.
- Comandos de longa duração mostram um indicador de progresso (OSC 9;4 quando suportado).

## Paleta de cores

O OpenClaw usa uma paleta “lobster” para a saída da CLI.

- `accent` (#FF5A2D): títulos, rótulos, destaques primários.
- `accentBright` (#FF7A3D): nomes de comandos, ênfase.
- `accentDim` (#D14A22): texto de destaque secundário.
- `info` (#FF8A5B): valores informativos.
- `success` (#2FBF71): estados de sucesso.
- `warn` (#FFB020): avisos, alternativas, atenção.
- `error` (#E23D2D): erros, falhas.
- `muted` (#8B7F77): desênfase, metadados.

Fonte de verdade da paleta: `src/terminal/palette.ts` (também conhecido como “lobster seam”).

## Árvore de comandos

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  doctor
  security
    audit
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  docs
  dns
    setup
  tui
```

Nota: plugins podem adicionar comandos adicionais de nível superior (por exemplo, `openclaw voicecall`).

## Segurança

- `openclaw security audit` — audita a configuração + estado local em busca de armadilhas comuns de segurança.
- `openclaw security audit --deep` — sondagem ao vivo do Gateway com melhor esforço.
- `openclaw security audit --fix` — reforça padrões seguros e aplica chmod ao estado/configuração.

## Plugins

Gerencie extensões e suas configurações:

- `openclaw plugins list` — descobrir plugins (use `--json` para saída de máquina).
- `openclaw plugins info <id>` — mostrar detalhes de um plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — instalar um plugin (ou adicionar um caminho de plugin a `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — alternar `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — relatar erros de carregamento de plugins.

A maioria das mudanças em plugins exige uma reinicialização do gateway. Veja [/plugin](/tools/plugin).

## Memória

Busca vetorial em `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — mostrar estatísticas do índice.
- `openclaw memory index` — reindexar arquivos de memória.
- `openclaw memory search "<query>"` — busca semântica na memória.

## Comandos de barra do chat

Mensagens de chat suportam comandos `/...` (texto e nativos). Veja [/tools/slash-commands](/tools/slash-commands).

Destaques:

- `/status` para diagnósticos rápidos.
- `/config` para mudanças persistidas de configuração.
- `/debug` para substituições de configuração apenas em tempo de execução (memória, não disco; requer `commands.debug: true`).

## Configuração + integração inicial

### `setup`

Inicializa configuração + workspace.

Opções:

- `--workspace <dir>`: caminho do workspace do agente (padrão `~/.openclaw/workspace`).
- `--wizard`: executar o assistente de integração inicial.
- `--non-interactive`: executar o assistente sem prompts.
- `--mode <local|remote>`: modo do assistente.
- `--remote-url <url>`: URL remota do Gateway.
- `--remote-token <token>`: token remoto do Gateway.

O assistente é executado automaticamente quando qualquer flag do assistente está presente (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Assistente interativo para configurar gateway, workspace e skills.

Opções:

- `--workspace <dir>`
- `--reset` (redefine configuração + credenciais + sessões + workspace antes do assistente)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual é um alias para avançado)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (não interativo; usado com `--auth-choice token`)
- `--token <token>` (não interativo; usado com `--auth-choice token`)
- `--token-profile-id <id>` (não interativo; padrão: `<provider>:manual`)
- `--token-expires-in <duration>` (não interativo; ex.: `365d`, `12h`)
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (alias: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm recomendado; bun não é recomendado para o runtime do Gateway)
- `--json`

### `configure`

Assistente interativo de configuração (modelos, canais, skills, gateway).

### `config`

Auxiliares de configuração não interativos (get/set/unset). Executar `openclaw config` sem
subcomando inicia o assistente.

Subcomandos:

- `config get <path>`: imprimir um valor de configuração (caminho com ponto/colchetes).
- `config set <path> <value>`: definir um valor (JSON5 ou string bruta).
- `config unset <path>`: remover um valor.

### `doctor`

Verificações de saúde + correções rápidas (configuração + gateway + serviços legados).

Opções:

- `--no-workspace-suggestions`: desativar dicas de memória do workspace.
- `--yes`: aceitar padrões sem prompt (headless).
- `--non-interactive`: pular prompts; aplicar apenas migrações seguras.
- `--deep`: escanear serviços do sistema por instalações extras do gateway.

## Auxiliares de canais

### `channels`

Gerenciar contas de canais de chat (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams).

Subcomandos:

- `channels list`: mostrar canais configurados e perfis de autenticação.
- `channels status`: verificar alcançabilidade do gateway e saúde do canal (`--probe` executa verificações extras; use `openclaw health` ou `openclaw status --deep` para sondagens de saúde do gateway).
- Dica: `channels status` imprime avisos com correções sugeridas quando consegue detectar configurações incorretas comuns (e então aponta para `openclaw doctor`).
- `channels logs`: mostrar logs recentes de canais a partir do arquivo de log do gateway.
- `channels add`: configuração no estilo assistente quando nenhuma flag é passada; flags mudam para modo não interativo.
- `channels remove`: desativado por padrão; passe `--delete` para remover entradas de configuração sem prompts.
- `channels login`: login interativo do canal (apenas WhatsApp Web).
- `channels logout`: sair de uma sessão de canal (se suportado).

Opções comuns:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: id da conta do canal (padrão `default`)
- `--name <label>`: nome de exibição da conta

Opções de `channels login`:

- `--channel <channel>` (padrão `whatsapp`; suporta `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

Opções de `channels logout`:

- `--channel <channel>` (padrão `whatsapp`)
- `--account <id>`

Opções de `channels list`:

- `--no-usage`: pular snapshots de uso/cota do provedor de modelos (apenas OAuth/API).
- `--json`: saída em JSON (inclui uso, a menos que `--no-usage` esteja definido).

Opções de `channels logs`:

- `--channel <name|all>` (padrão `all`)
- `--lines <n>` (padrão `200`)
- `--json`

Mais detalhes: [/concepts/oauth](/concepts/oauth)

Exemplos:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Listar e inspecionar skills disponíveis, além de informações de prontidão.

Subcomandos:

- `skills list`: listar skills (padrão quando não há subcomando).
- `skills info <name>`: mostrar detalhes de uma skill.
- `skills check`: resumo de requisitos prontos vs ausentes.

Opções:

- `--eligible`: mostrar apenas skills prontas.
- `--json`: saída em JSON (sem estilização).
- `-v`, `--verbose`: incluir detalhes de requisitos ausentes.

Dica: use `npx clawhub` para pesquisar, instalar e sincronizar skills.

### `pairing`

Aprovar solicitações de pareamento por DM entre canais.

Subcomandos:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Configuração + executor de hook do Gmail Pub/Sub. Veja [/automation/gmail-pubsub](/automation/gmail-pubsub).

Subcomandos:

- `webhooks gmail setup` (requer `--account <email>`; suporta `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (substituições em tempo de execução para as mesmas flags)

### `dns setup`

Auxiliar de DNS para descoberta em grande área (CoreDNS + Tailscale). Veja [/gateway/discovery](/gateway/discovery).

Opções:

- `--apply`: instalar/atualizar configuração do CoreDNS (requer sudo; apenas macOS).

## Mensagens + agente

### `message`

Mensageria unificada de saída + ações de canal.

Veja: [/cli/message](/cli/message)

Subcomandos:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Exemplos:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Executar uma rodada de agente via o Gateway (ou `--local` incorporado).

Obrigatório:

- `--message <text>`

Opções:

- `--to <dest>` (para chave de sessão e entrega opcional)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (apenas modelos GPT-5.2 + Codex)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Gerenciar agentes isolados (workspaces + autenticação + roteamento).

#### `agents list`

Listar agentes configurados.

Opções:

- `--json`
- `--bindings`

#### `agents add [name]`

Adicionar um novo agente isolado. Executa o assistente guiado a menos que flags (ou `--non-interactive`) sejam passadas; `--workspace` é obrigatório no modo não interativo.

Opções:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (repetível)
- `--non-interactive`
- `--json`

As especificações de binding usam `channel[:accountId]`. Quando `accountId` é omitido para WhatsApp, o id de conta padrão é usado.

#### `agents delete <id>`

Excluir um agente e podar seu workspace + estado.

Opções:

- `--force`
- `--json`

### `acp`

Executar a ponte ACP que conecta IDEs ao Gateway.

Veja [`acp`](/cli/acp) para opções completas e exemplos.

### `status`

Mostrar a saúde da sessão vinculada e destinatários recentes.

Opções:

- `--json`
- `--all` (diagnóstico completo; somente leitura, colável)
- `--deep` (sondar canais)
- `--usage` (mostrar uso/cota do provedor de modelos)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias para `--verbose`)

Notas:

- A visão geral inclui o status do Gateway + serviço do host do nó quando disponível.

### Rastreamento de uso

O OpenClaw pode expor uso/cota do provedor quando credenciais OAuth/API estão disponíveis.

Superfícies:

- `/status` (adiciona uma linha curta de uso do provedor quando disponível)
- `openclaw status --usage` (imprime o detalhamento completo do provedor)
- Barra de menus do macOS (seção Uso em Context)

Notas:

- Os dados vêm diretamente dos endpoints de uso dos provedores (sem estimativas).
- Provedores: Anthropic, GitHub Copilot, OpenAI Codex OAuth, além de Gemini CLI/Antigravity quando esses plugins de provedor estão habilitados.
- Se não existirem credenciais correspondentes, o uso fica oculto.
- Detalhes: veja [Rastreamento de uso](/concepts/usage-tracking).

### `health`

Buscar a saúde do Gateway em execução.

Opções:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Listar sessões de conversas armazenadas.

Opções:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Resetar / Desinstalar

### `reset`

Resetar configuração/estado local (mantém a CLI instalada).

Opções:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notas:

- `--non-interactive` requer `--scope` e `--yes`.

### `uninstall`

Desinstalar o serviço do gateway + dados locais (a CLI permanece).

Opções:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notas:

- `--non-interactive` requer `--yes` e escopos explícitos (ou `--all`).

## Gateway

### `gateway`

Executar o Gateway WebSocket.

Opções:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (redefinir configuração de dev + credenciais + sessões + workspace)
- `--force` (matar listener existente na porta)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias para `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gerenciar o serviço do Gateway (launchd/systemd/schtasks).

Subcomandos:

- `gateway status` (sonda o RPC do Gateway por padrão)
- `gateway install` (instalação do serviço)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Notas:

- `gateway status` sonda o RPC do Gateway por padrão usando a porta/configuração resolvida do serviço (substitua com `--url/--token/--password`).
- `gateway status` suporta `--no-probe`, `--deep` e `--json` para scripting.
- `gateway status` também expõe serviços de gateway legados ou extras quando consegue detectá-los (`--deep` adiciona varreduras em nível de sistema). Serviços OpenClaw nomeados por perfil são tratados como de primeira classe e não são sinalizados como “extras”.
- `gateway status` imprime qual caminho de configuração a CLI usa vs qual configuração o serviço provavelmente usa (env do serviço), além da URL de sondagem resolvida.
- `gateway install|uninstall|start|stop|restart` suporta `--json` para scripting (a saída padrão permanece amigável para humanos).
- `gateway install` usa o runtime Node por padrão; bun **não é recomendado** (bugs no WhatsApp/Telegram).
- Opções de `gateway install`: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Acompanhar logs de arquivos do Gateway via RPC.

Notas:

- Sessões TTY renderizam uma visualização estruturada com cores; não TTY recua para texto simples.
- `--json` emite JSON delimitado por linhas (um evento de log por linha).

Exemplos:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Auxiliares da CLI do Gateway (use `--url`, `--token`, `--password`, `--timeout`, `--expect-final` para subcomandos RPC).
Ao passar `--url`, a CLI não aplica automaticamente configuração ou credenciais de ambiente.
Inclua `--token` ou `--password` explicitamente. A ausência de credenciais explícitas é um erro.

Subcomandos:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

RPCs comuns:

- `config.apply` (validar + gravar configuração + reiniciar + acordar)
- `config.patch` (mesclar uma atualização parcial + reiniciar + acordar)
- `update.run` (executar atualização + reiniciar + acordar)

Dica: ao chamar `config.set`/`config.apply`/`config.patch` diretamente, passe `baseHash` de
`config.get` se uma configuração já existir.

## Modelos

Veja [/concepts/models](/concepts/models) para comportamento de fallback e estratégia de varredura.

Autenticação Anthropic preferida (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (raiz)

`openclaw models` é um alias para `models status`.

Opções da raiz:

- `--status-json` (alias para `models status --json`)
- `--status-plain` (alias para `models status --plain`)

### `models list`

Opções:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Opções:

- `--json`
- `--plain`
- `--check` (sair 1=expirado/ausente, 2=expirando)
- `--probe` (sondagem ao vivo dos perfis de autenticação configurados)
- `--probe-provider <name>`
- `--probe-profile <id>` (repetível ou separado por vírgulas)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Sempre inclui a visão geral de autenticação e o status de expiração OAuth para perfis no repositório de autenticação.
`--probe` executa requisições ao vivo (pode consumir tokens e acionar limites de taxa).
`--probe` executa solicitações ao vivo (pode consumir tokens e acionar limites de taxa de ativação).

### `models set <model>`

Definir `agents.defaults.model.primary`.

### `models set-image <model>`

Definir `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Opções:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Opções:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Opções:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Opções:

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

Opções:

- `add`: auxiliar interativo de autenticação
- `setup-token`: `--provider <name>` (padrão `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Opções:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## Sistema

### `system event`

Enfileirar um evento do sistema e opcionalmente acionar um heartbeat (RPC do Gateway).

Obrigatório:

- `--text <text>`

Opções:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Controles de heartbeat (RPC do Gateway).

Opções:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Listar entradas de presença do sistema (RPC do Gateway).

Opções:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Gerenciar tarefas agendadas (RPC do Gateway). Veja [/automation/cron-jobs](/automation/cron-jobs).

Subcomandos:

- `cron status [--json]`
- `cron list [--all] [--json]` (saída em tabela por padrão; use `--json` para bruto)
- `cron add` (alias: `create`; requer `--name` e exatamente um de `--at` | `--every` | `--cron`, e exatamente um payload de `--system-event` | `--message`)
- `cron edit <id>` (patch de campos)
- `cron rm <id>` (aliases: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Todos os comandos `cron` aceitam `--url`, `--token`, `--timeout`, `--expect-final`.

## Host de nó

`node` executa um **host de nó headless** ou o gerencia como um serviço em segundo plano. Veja
[`openclaw node`](/cli/node).

Subcomandos:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodes

`nodes` se comunica com o Gateway e direciona nós pareados. Veja [/nodes](/nodes).

Opções comuns:

- `--url`, `--token`, `--timeout`, `--json`

Subcomandos:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (nó mac ou host de nó headless)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (apenas mac)

Câmera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + tela:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Localização:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Navegador

CLI de controle do navegador (Chrome/Brave/Edge/Chromium dedicados). Veja [`openclaw browser`](/cli/browser) e a [Ferramenta de navegador](/tools/browser).

Opções comuns:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Gerenciar:

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

Inspecionar:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Ações:

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## Busca de documentos

### `docs [query...]`

Pesquisar no índice de documentos ao vivo.

## TUI

### `tui`

Abrir a UI de terminal conectada ao Gateway.

Opções:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (padrão `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
