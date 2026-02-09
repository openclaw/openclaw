---
summary: "Runbook para o serviço Gateway, ciclo de vida e operações"
read_when:
  - Ao executar ou depurar o processo do gateway
title: "Runbook do Gateway"
---

# Runbook do serviço Gateway

Última atualização: 2025-12-09

## O que é

- O processo sempre ativo que possui a conexão única Baileys/Telegram e o plano de controle/eventos.
- Substitui o comando legado `gateway`. Ponto de entrada da CLI: `openclaw gateway`.
- Executa até ser interrompido; sai com código diferente de zero em erros fatais para que o supervisor o reinicie.

## Como executar (local)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- O hot reload de configuração observa `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`).
  - Modo padrão: `gateway.reload.mode="hybrid"` (aplica mudanças seguras a quente, reinicia em críticas).
  - O hot reload usa reinício em processo via **SIGUSR1** quando necessário.
  - Desative com `gateway.reload.mode="off"`.
- Vincula o plano de controle WebSocket a `127.0.0.1:<port>` (padrão 18789).
- A mesma porta também serve HTTP (UI de controle, hooks, A2UI). Multiplexação em porta única.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Inicia um servidor de arquivos Canvas por padrão em `canvasHost.port` (padrão `18793`), servindo `http://<gateway-host>:18793/__openclaw__/canvas/` a partir de `~/.openclaw/workspace/canvas`. Desative com `canvasHost.enabled=false` ou `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Registra logs no stdout; use launchd/systemd para mantê-lo ativo e rotacionar logs.
- Passe `--verbose` para espelhar logs de depuração (handshakes, req/res, eventos) do arquivo de log para o stdio durante a solução de problemas.
- `--force` usa `lsof` para encontrar listeners na porta escolhida, envia SIGTERM, registra o que foi encerrado e então inicia o gateway (falha rapidamente se `lsof` estiver ausente).
- Se você executar sob um supervisor (launchd/systemd/modo de processo filho do app mac), um stop/restart normalmente envia **SIGTERM**; builds mais antigas podem expor isso como `pnpm` `ELIFECYCLE` código de saída **143** (SIGTERM), que é um desligamento normal, não uma falha.
- **SIGUSR1** aciona um reinício em processo quando autorizado (ferramenta/config do gateway aplicar/atualizar, ou habilite `commands.restart` para reinícios manuais).
- A autenticação do Gateway é exigida por padrão: defina `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) ou `gateway.auth.password`. Clientes devem enviar `connect.params.auth.token/password` a menos que usem identidade Tailscale Serve.
- O assistente agora gera um token por padrão, mesmo em loopback.
- Precedência de portas: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > padrão `18789`.

## Acesso remoto

- Tailscale/VPN é preferido; caso contrário, túnel SSH:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Os clientes então se conectam a `ws://127.0.0.1:18789` através do túnel.

- Se um token estiver configurado, os clientes devem incluí-lo em `connect.params.auth.token` mesmo através do túnel.

## Múltiplos gateways (mesmo host)

Geralmente desnecessário: um Gateway pode atender a vários canais de mensagens e agentes. Use múltiplos Gateways apenas para redundância ou isolamento rigoroso (ex: bot de resgate).

Compatível se você isolar estado + configuração e usar portas exclusivas. Guia completo: [Múltiplos gateways](/gateway/multiple-gateways).

Os nomes de serviço são sensíveis ao perfil:

- macOS: `bot.molt.<profile>` (o legado `com.openclaw.*` ainda pode existir)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Os metadados de instalação são incorporados à configuração do serviço:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Padrão Rescue-Bot: mantenha um segundo Gateway isolado com seu próprio perfil, diretório de estado, workspace e espaçamento de porta base. Guia completo: [Guia de rescue-bot](/gateway/multiple-gateways#rescue-bot-guide).

### Perfil Dev (`--dev`)

Caminho rápido: execute uma instância dev totalmente isolada (config/estado/workspace) sem tocar na sua configuração principal.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Padrões (podem ser sobrescritos via env/flags/config):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- porta do serviço de controle do navegador = `19003` (derivada: `gateway.port+2`, apenas loopback)
- `canvasHost.port=19005` (derivada: `gateway.port+4`)
- `agents.defaults.workspace` passa a ser `~/.openclaw/workspace-dev` por padrão quando você executa `setup`/`onboard` sob `--dev`.

Portas derivadas (regras práticas):

- Porta base = `gateway.port` (ou `OPENCLAW_GATEWAY_PORT` / `--port`)
- porta do serviço de controle do navegador = base + 2 (apenas loopback)
- `canvasHost.port = base + 4` (ou `OPENCLAW_CANVAS_HOST_PORT` / sobrescrita por config)
- As portas CDP do perfil do navegador são alocadas automaticamente a partir de `browser.controlPort + 9 .. + 108` (persistidas por perfil).

Checklist por instância:

- `gateway.port` exclusivo
- `OPENCLAW_CONFIG_PATH` exclusivo
- `OPENCLAW_STATE_DIR` exclusivo
- `agents.defaults.workspace` exclusivo
- números de WhatsApp separados (se usar WA)

Instalação de serviço por perfil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Exemplo:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protocolo (visão do operador)

- Documentação completa: [Protocolo do Gateway](/gateway/protocol) e [Protocolo Bridge (legado)](/gateway/bridge-protocol).
- Primeiro frame obrigatório do cliente: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- O Gateway responde `res {type:"res", id, ok:true, payload:hello-ok }` (ou `ok:false` com um erro e então fecha).
- Após o handshake:
  - Requisições: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Eventos: `{type:"event", event, payload, seq?, stateVersion?}`
- Entradas de presença estruturadas: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (para clientes WS, `instanceId` vem de `connect.client.instanceId`).
- As respostas `agent` são em duas etapas: primeiro `res` ack `{runId,status:"accepted"}`, depois um `res` `{runId,status:"ok"|"error",summary}` final após o término da execução; a saída em streaming chega como `event:"agent"`.

## Métodos (conjunto inicial)

- `health` — snapshot completo de saúde (mesma forma que `openclaw health --json`).
- `status` — resumo curto.
- `system-presence` — lista de presença atual.
- `system-event` — publicar uma nota de presença/sistema (estruturada).
- `send` — enviar uma mensagem pelos canais ativos.
- `agent` — executar um turno de agente (transmite eventos de volta na mesma conexão).
- `node.list` — listar nós pareados + atualmente conectados (inclui `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` e `commands` anunciados).
- `node.describe` — descrever um nó (capacidades + comandos `node.invoke` suportados; funciona para nós pareados e para nós não pareados atualmente conectados).
- `node.invoke` — invocar um comando em um nó (ex.: `canvas.*`, `camera.*`).
- `node.pair.*` — ciclo de vida de pareamento (`request`, `list`, `approve`, `reject`, `verify`).

Veja também: [Presence](/concepts/presence) para entender como a presença é produzida/deduplicada e por que um `client.instanceId` estável importa.

## Eventos

- `agent` — eventos de ferramenta/saída transmitidos da execução do agente (com tag de sequência).
- `presence` — atualizações de presença (deltas com stateVersion) enviadas a todos os clientes conectados.
- `tick` — keepalive/no-op periódico para confirmar vivacidade.
- `shutdown` — o Gateway está saindo; o payload inclui `reason` e `restartExpectedMs` opcional. Os clientes devem reconectar.

## Integração WebChat

- O WebChat é uma UI SwiftUI nativa que fala diretamente com o WebSocket do Gateway para histórico, envios, abortar e eventos.
- O uso remoto passa pelo mesmo túnel SSH/Tailscale; se um token do gateway estiver configurado, o cliente o inclui durante `connect`.
- O app macOS conecta via um único WS (conexão compartilhada); ele hidrata a presença a partir do snapshot inicial e escuta eventos `presence` para atualizar a UI.

## Tipagem e validação

- O servidor valida cada frame de entrada com AJV contra o JSON Schema emitido a partir das definições do protocolo.
- Clientes (TS/Swift) consomem tipos gerados (TS diretamente; Swift via o gerador do repositório).
- As definições do protocolo são a fonte da verdade; regenere schema/modelos com:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Snapshot de conexão

- `hello-ok` inclui um `snapshot` com `presence`, `health`, `stateVersion` e `uptimeMs` além de `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` para que os clientes renderizem imediatamente sem requisições extras.
- `health`/`system-presence` permanecem disponíveis para atualização manual, mas não são obrigatórios no momento da conexão.

## Códigos de erro (formato res.error)

- Os erros usam `{ code, message, details?, retryable?, retryAfterMs? }`.
- Códigos padrão:
  - `NOT_LINKED` — WhatsApp não autenticado.
  - `AGENT_TIMEOUT` — o agente não respondeu dentro do prazo configurado.
  - `INVALID_REQUEST` — falha de validação de schema/parâmetros.
  - `UNAVAILABLE` — o Gateway está desligando ou uma dependência está indisponível.

## Comportamento de keepalive

- Eventos `tick` (ou WS ping/pong) são emitidos periodicamente para que os clientes saibam que o Gateway está ativo mesmo quando não há tráfego.
- Confirmações de envio/agente permanecem respostas separadas; não sobrecarregue ticks para envios.

## Replay / lacunas

- Os eventos não são reproduzidos. Os clientes detectam lacunas de sequência e devem atualizar (`health` + `system-presence`) antes de continuar. O WebChat e os clientes macOS agora fazem autoatualização ao detectar lacunas.

## Supervisão (exemplo macOS)

- Use launchd para manter o serviço ativo:
  - Program: caminho para `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: caminhos de arquivo ou `syslog`
- Em falha, o launchd reinicia; uma configuração fatal incorreta deve continuar saindo para que o operador perceba.
- LaunchAgents são por usuário e exigem uma sessão logada; para setups headless use um LaunchDaemon personalizado (não fornecido).
  - `openclaw gateway install` grava `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (ou `bot.molt.<profile>.plist`; o legado `com.openclaw.*` é limpo).
  - `openclaw doctor` audita a configuração do LaunchAgent e pode atualizá-la para os padrões atuais.

## Gerenciamento do serviço Gateway (CLI)

Use a CLI do Gateway para instalar/iniciar/parar/reiniciar/status:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Notas:

- `gateway status` sonda o RPC do Gateway por padrão usando a porta/config resolvida do serviço (sobrescreva com `--url`).
- `gateway status --deep` adiciona varreduras em nível de sistema (LaunchDaemons/unidades system).
- `gateway status --no-probe` ignora a sonda RPC (útil quando a rede está fora).
- `gateway status --json` é estável para scripts.
- `gateway status` reporta **tempo de execução do supervisor** (launchd/systemd em execução) separadamente de **alcançabilidade RPC** (conexão WS + status RPC).
- `gateway status` imprime o caminho da config + alvo da sonda para evitar confusão de “localhost vs bind LAN” e incompatibilidades de perfil.
- `gateway status` inclui a última linha de erro do gateway quando o serviço parece em execução mas a porta está fechada.
- `logs` faz tail do log de arquivo do Gateway via RPC (sem necessidade de `tail`/`grep` manuais).
- Se outros serviços semelhantes a gateway forem detectados, a CLI avisa a menos que sejam serviços de perfil OpenClaw.
  Ainda recomendamos **um gateway por máquina** para a maioria dos setups; use perfis/portas isolados para redundância ou um bot de resgate. Veja [Múltiplos gateways](/gateway/multiple-gateways).
  - Limpeza: `openclaw gateway uninstall` (serviço atual) e `openclaw doctor` (migrações legadas).
- `gateway install` é um no-op quando já instalado; use `openclaw gateway install --force` para reinstalar (mudanças de perfil/env/caminho).

App mac empacotado:

- OpenClaw.app pode empacotar um relay de gateway baseado em Node e instalar um LaunchAgent por usuário rotulado
  `bot.molt.gateway` (ou `bot.molt.<profile>`; rótulos legados `com.openclaw.*` ainda descarregam corretamente).
- Para parar de forma limpa, use `openclaw gateway stop` (ou `launchctl bootout gui/$UID/bot.molt.gateway`).
- Para reiniciar, use `openclaw gateway restart` (ou `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` só funciona se o LaunchAgent estiver instalado; caso contrário, use `openclaw gateway install` primeiro.
  - Substitua o rótulo por `bot.molt.<profile>` ao executar um perfil nomeado.

## Supervisão (unit de usuário systemd)

O OpenClaw instala um **serviço de usuário systemd** por padrão no Linux/WSL2. Nós
recomendamos serviços de usuário para máquinas de usuário único (ambiente mais simples, config por usuário).
Use um **serviço de sistema** para servidores multiusuário ou sempre ativos (sem
necessidade de lingering, supervisão compartilhada).

`openclaw gateway install` grava a unit de usuário. `openclaw doctor` audita a
unit e pode atualizá-la para corresponder aos padrões recomendados atuais.

Crie `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Habilite lingering (necessário para que o serviço de usuário sobreviva a logout/idle):

```
sudo loginctl enable-linger youruser
```

A integração inicial executa isso no Linux/WSL2 (pode solicitar sudo; grava `/var/lib/systemd/linger`).
Depois habilite o serviço:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternativa (serviço de sistema)** – para servidores sempre ativos ou multiusuário, você pode
instalar uma unit **system** do systemd em vez de uma unit de usuário (sem lingering).
Crie `/etc/systemd/system/openclaw-gateway[-<profile>].service` (copie a unit acima,
troque `WantedBy=multi-user.target`, defina `User=` + `WorkingDirectory=`), então:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Instalações no Windows devem usar **WSL2** e seguir a seção de systemd do Linux acima.

## Verificações operacionais

- Vivacidade: abra WS e envie `req:connect` → espere `res` com `payload.type="hello-ok"` (com snapshot).
- Prontidão: chame `health` → espere `ok: true` e um canal vinculado em `linkChannel` (quando aplicável).
- Depuração: assine os eventos `tick` e `presence`; garanta que `status` mostre idade de vínculo/autenticação; entradas de presença mostram o host do Gateway e clientes conectados.

## Garantias de segurança

- Assuma um Gateway por host por padrão; se executar múltiplos perfis, isole portas/estado e aponte para a instância correta.
- Não há fallback para conexões Baileys diretas; se o Gateway estiver fora, os envios falham rapidamente.
- Frames iniciais não-connect ou JSON malformado são rejeitados e o socket é fechado.
- Desligamento gracioso: emite evento `shutdown` antes de fechar; os clientes devem lidar com fechamento + reconexão.

## Ajudantes de CLI

- `openclaw gateway health|status` — solicita saúde/status via WS do Gateway.
- `openclaw message send --target <num> --message "hi" [--media ...]` — envia via Gateway (idempotente para WhatsApp).
- `openclaw agent --message "hi" --to <num>` — executa um turno de agente (aguarda o final por padrão).
- `openclaw gateway call <method> --params '{"k":"v"}'` — invocador de método bruto para depuração.
- `openclaw gateway stop|restart` — parar/reiniciar o serviço de gateway supervisionado (launchd/systemd).
- Subcomandos auxiliares do Gateway assumem um gateway em execução em `--url`; eles não iniciam mais um automaticamente.

## Orientações de migração

- Descontinue usos de `openclaw gateway` e da porta de controle TCP legada.
- Atualize os clientes para falar o protocolo WS com connect obrigatório e presença estruturada.
