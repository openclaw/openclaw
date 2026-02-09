---
summary: "Nós: pareamento, capacidades, permissões e auxiliares de CLI para canvas/câmera/tela/sistema"
read_when:
  - Pareamento de nós iOS/Android a um gateway
  - Uso de canvas/câmera do nó para contexto do agente
  - Adição de novos comandos de nó ou auxiliares de CLI
title: "Nodes"
---

# Nodes

Um **nó** é um dispositivo complementar (macOS/iOS/Android/headless) que se conecta ao **WebSocket** do Gateway (mesma porta dos operadores) com `role: "node"` e expõe uma superfície de comandos (por exemplo, `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Detalhes do protocolo: [Gateway protocol](/gateway/protocol).

Transporte legado: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; obsoleto/removido para nós atuais).

O macOS também pode rodar em **modo nó**: o app da barra de menus conecta-se ao servidor WS do Gateway e expõe seus comandos locais de canvas/câmera como um nó (assim `openclaw nodes …` funciona neste Mac).

Notas:

- Nós são **periféricos**, não gateways. Eles não executam o serviço de gateway.
- Mensagens de Telegram/WhatsApp/etc. chegam ao **gateway**, não aos nós.
- Runbook de solução de problemas: [/nodes/troubleshooting](/nodes/troubleshooting)

## Pareamento + status

**Nós WS usam pareamento de dispositivo.** Os nós apresentam uma identidade de dispositivo durante `connect`; o Gateway
cria uma solicitação de pareamento de dispositivo para `role: node`. Aprove via CLI (ou UI) do dispositivo.

CLI rápido:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Notas:

- `nodes status` marca um nó como **pareado** quando sua função de pareamento de dispositivo inclui `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) é um armazenamento de pareamento de nós separado e pertencente ao gateway; ele **não** bloqueia o handshake WS de `connect`.

## Host remoto de nó (system.run)

Use um **host de nó** quando seu Gateway roda em uma máquina e você quer que comandos
sejam executados em outra. O modelo ainda fala com o **gateway**; o gateway
encaminha chamadas de `exec` para o **host de nó** quando `host=node` é selecionado.

### O que roda onde

- **Host do Gateway**: recebe mensagens, executa o modelo, roteia chamadas de ferramentas.
- **Host de nó**: executa `system.run`/`system.which` na máquina do nó.
- **Aprovações**: aplicadas no host de nó via `~/.openclaw/exec-approvals.json`.

### Iniciar um host de nó (foreground)

Na máquina do nó:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Gateway remoto via túnel SSH (bind em loopback)

Se o Gateway fizer bind em loopback (`gateway.bind=loopback`, padrão no modo local),
hosts de nó remotos não conseguem se conectar diretamente. Crie um túnel SSH e aponte o
host de nó para a extremidade local do túnel.

Exemplo (host de nó -> host do gateway):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notas:

- O token é `gateway.auth.token` da configuração do gateway (`~/.openclaw/openclaw.json` no host do gateway).
- `openclaw node run` lê `OPENCLAW_GATEWAY_TOKEN` para autenticação.

### Iniciar um host de nó (serviço)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Parear + nomear

No host do gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Opções de nomeação:

- `--display-name` em `openclaw node run` / `openclaw node install` (persiste em `~/.openclaw/node.json` no nó).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (sobrescrita no gateway).

### Colocar comandos na lista de permissões

Aprovações de exec são **por host de nó**. Adicione entradas de lista de permissões a partir do gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

As aprovações ficam no host de nó em `~/.openclaw/exec-approvals.json`.

### Vinculação de exec ao nó

Configure os padrões (configuração do gateway):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Ou por sessão:

```
/exec host=node security=allowlist node=<id-or-name>
```

Depois de definido, qualquer chamada de `exec` com `host=node` roda no host de nó (sujeito à lista de permissões/aprovações do nó).

Relacionado:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Invocando comandos

Baixo nível (RPC bruto):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Existem auxiliares de nível mais alto para os fluxos comuns de “dar ao agente um anexo de MÍDIA”.

## Capturas de tela (snapshots do canvas)

Se o nó estiver exibindo o Canvas (WebView), `canvas.snapshot` retorna `{ format, base64 }`.

Auxiliar de CLI (grava em um arquivo temporário e imprime `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Controles do Canvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notas:

- `canvas present` aceita URLs ou caminhos de arquivo local (`--target`), além de `--x/--y/--width/--height` opcional para posicionamento.
- `canvas eval` aceita JS inline (`--js`) ou um argumento posicional.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notas:

- Apenas A2UI v0.8 JSONL é suportado (v0.9/createSurface é rejeitado).

## Fotos + vídeos (câmera do nó)

Fotos (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Clipes de vídeo (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notas:

- O nó deve estar **em primeiro plano** para `canvas.*` e `camera.*` (chamadas em segundo plano retornam `NODE_BACKGROUND_UNAVAILABLE`).
- A duração do clipe é limitada (atualmente `<= 60s`) para evitar payloads base64 muito grandes.
- O Android solicitará permissões de `CAMERA`/`RECORD_AUDIO` quando possível; permissões negadas falham com `*_PERMISSION_REQUIRED`.

## Gravações de tela (nós)

Os nós expõem `screen.record` (mp4). Exemplo:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notas:

- `screen.record` exige que o app do nó esteja em primeiro plano.
- O Android mostrará o prompt do sistema de captura de tela antes da gravação.
- As gravações de tela são limitadas a `<= 60s`.
- `--no-audio` desativa a captura do microfone (suportado em iOS/Android; o macOS usa áudio de captura do sistema).
- Use `--screen <index>` para selecionar um display quando houver múltiplas telas disponíveis.

## Localização (nós)

Os nós expõem `location.get` quando Localização está habilitada nas configurações.

Auxiliar de CLI:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notas:

- A Localização vem **desativada por padrão**.
- “Sempre” exige permissão do sistema; a busca em segundo plano é por melhor esforço.
- A resposta inclui lat/lon, precisão (metros) e timestamp.

## SMS (nós Android)

Nós Android podem expor `sms.send` quando o usuário concede permissão de **SMS** e o dispositivo suporta telefonia.

Invocação de baixo nível:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Notas:

- O prompt de permissão deve ser aceito no dispositivo Android antes que a capacidade seja anunciada.
- Dispositivos apenas Wi‑Fi sem telefonia não anunciarão `sms.send`.

## Comandos do sistema (host de nó / nó mac)

O nó macOS expõe `system.run`, `system.notify` e `system.execApprovals.get/set`.
O host de nó headless expõe `system.run`, `system.which` e `system.execApprovals.get/set`.

Exemplos:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notas:

- `system.run` retorna stdout/stderr/código de saída no payload.
- `system.notify` respeita o estado de permissão de notificações no app macOS.
- `system.run` suporta `--cwd`, `--env KEY=VAL`, `--command-timeout` e `--needs-screen-recording`.
- `system.notify` suporta `--priority <passive|active|timeSensitive>` e `--delivery <system|overlay|auto>`.
- Nós macOS descartam sobrescritas de `PATH`; hosts de nó headless só aceitam `PATH` quando ele prefixa o PATH do host de nó.
- No modo nó do macOS, `system.run` é controlado por aprovações de exec no app macOS (Configurações → Exec approvals).
  Ask/allowlist/full se comportam da mesma forma que no host de nó headless; prompts negados retornam `SYSTEM_RUN_DENIED`.
- No host de nó headless, `system.run` é controlado por aprovações de exec (`~/.openclaw/exec-approvals.json`).

## Associar nó Exec

Quando vários nós estão disponíveis, você pode vincular exec a um nó específico.
Isso define o nó padrão para `exec host=node` (e pode ser sobrescrito por agente).

Padrão global:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Sobrescrita por agente:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Remover para permitir qualquer nó:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Mapa de permissões

Os nós podem incluir um mapa `permissions` em `node.list` / `node.describe`, indexado pelo nome da permissão (por exemplo, `screenRecording`, `accessibility`) com valores booleanos (`true` = concedida).

## Host de nó headless (multiplataforma)

O OpenClaw pode rodar um **host de nó headless** (sem UI) que se conecta ao WebSocket do Gateway
e expõe `system.run` / `system.which`. Isso é útil em Linux/Windows
ou para executar um nó mínimo ao lado de um servidor.

Inicie-o:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Notas:

- O pareamento ainda é necessário (o Gateway mostrará um prompt de aprovação do nó).
- O host de nó armazena seu id de nó, token, nome de exibição e informações de conexão do gateway em `~/.openclaw/node.json`.
- As aprovações de exec são aplicadas localmente via `~/.openclaw/exec-approvals.json`
  (veja [Exec approvals](/tools/exec-approvals)).
- No macOS, o host de nó headless prefere o host de exec do app complementar quando acessível e
  faz fallback para execução local se o app estiver indisponível. Defina `OPENCLAW_NODE_EXEC_HOST=app` para exigir
  o app, ou `OPENCLAW_NODE_EXEC_FALLBACK=0` para desativar o fallback.
- Adicione `--tls` / `--tls-fingerprint` quando o WS do Gateway usar TLS.

## Modo nó do Mac

- O app da barra de menus do macOS conecta-se ao servidor WS do Gateway como um nó (assim `openclaw nodes …` funciona neste Mac).
- Em modo remoto, o app abre um túnel SSH para a porta do Gateway e conecta-se a `localhost`.
