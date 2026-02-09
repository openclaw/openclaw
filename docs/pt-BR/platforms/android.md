---
summary: "App Android (nó): runbook de conexão + Canvas/Chat/Câmera"
read_when:
  - Pareamento ou reconexão do nó Android
  - Depuração de descoberta ou autenticação do gateway Android
  - Verificação de paridade do histórico de chat entre clientes
title: "App Android"
---

# App Android (Nó)

## Snapshot de suporte

- Função: app de nó complementar (o Android não hospeda o Gateway).
- Gateway obrigatório: sim (execute no macOS, Linux ou Windows via WSL2).
- Instalação: [Primeiros passos](/start/getting-started) + [Pareamento](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Configuração](/gateway/configuration).
  - Protocolos: [Protocolo do Gateway](/gateway/protocol) (nós + plano de controle).

## Controle do sistema

O controle do sistema (launchd/systemd) fica no host do Gateway. Veja [Gateway](/gateway).

## Runbook de conexão

App de nó Android ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

O Android se conecta diretamente ao WebSocket do Gateway (padrão `ws://<host>:18789`) e usa o pareamento de propriedade do Gateway.

### Pré-requisitos

- Voce consegue executar o Gateway na máquina “master”.
- O dispositivo/emulador Android consegue alcançar o WebSocket do gateway:
  - Mesma LAN com mDNS/NSD, **ou**
  - Mesmo tailnet do Tailscale usando Wide-Area Bonjour / DNS-SD unicast (veja abaixo), **ou**
  - Host/porta do gateway manual (fallback)
- Voce consegue executar a CLI (`openclaw`) na máquina do gateway (ou via SSH).

### 1. Inicie o Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Confirme nos logs que voce ve algo como:

- `listening on ws://0.0.0.0:18789`

Para setups somente em tailnet (recomendado para Viena ⇄ Londres), faça o bind do gateway ao IP do tailnet:

- Defina `gateway.bind: "tailnet"` em `~/.openclaw/openclaw.json` no host do gateway.
- Reinicie o Gateway / app de menubar do macOS.

### 2. Verifique a descoberta (opcional)

A partir da máquina do gateway:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Mais notas de depuração: [Bonjour](/gateway/bonjour).

#### Descoberta via DNS-SD unicast no tailnet (Viena ⇄ Londres)

A descoberta NSD/mDNS do Android não atravessa redes. Se o nó Android e o gateway estiverem em redes diferentes, mas conectados via Tailscale, use Wide-Area Bonjour / DNS-SD unicast:

1. Configure uma zona DNS-SD (exemplo `openclaw.internal.`) no host do gateway e publique registros `_openclaw-gw._tcp`.
2. Configure split DNS do Tailscale para o dominio escolhido apontando para esse servidor DNS.

Detalhes e exemplo de configuração do CoreDNS: [Bonjour](/gateway/bonjour).

### 3. Conecte a partir do Android

No app Android:

- O app mantém a conexão com o gateway ativa por meio de um **serviço em primeiro plano** (notificação persistente).
- Abra **Configurações**.
- Em **Gateways descobertos**, selecione seu gateway e toque em **Conectar**.
- Se o mDNS estiver bloqueado, use **Avançado → Gateway manual** (host + porta) e **Conectar (Manual)**.

Após o primeiro pareamento bem-sucedido, o Android reconecta automaticamente ao iniciar:

- Endpoint manual (se habilitado), caso contrário
- O ultimo gateway descoberto (melhor esforço).

### 4. Aprove o pareamento (CLI)

Na máquina do gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Detalhes do pareamento: [Pareamento do Gateway](/gateway/pairing).

### 5. Verifique se o nó esta conectado

- Via status dos nós:

  ```bash
  openclaw nodes status
  ```

- Via Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Chat + histórico

A aba Chat do nó Android usa a **chave de sessão primária** do gateway (`main`), portanto o histórico e as respostas são compartilhados com o WebChat e outros clientes:

- Histórico: `chat.history`
- Enviar: `chat.send`
- Atualizações push (melhor esforço): `chat.subscribe` → `event:"chat"`

### 7. Canvas + câmera

#### Host do Canvas do Gateway (recomendado para conteudo web)

Se voce quiser que o nó mostre HTML/CSS/JS reais que o agente pode editar em disco, aponte o nó para o host do Canvas do Gateway.

Nota: os nós usam o host de canvas standalone em `canvasHost.port` (padrão `18793`).

1. Crie `~/.openclaw/workspace/canvas/index.html` no host do gateway.

2. Navegue o nó ate ele (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (opcional): se ambos os dispositivos estiverem no Tailscale, use um nome MagicDNS ou IP do tailnet em vez de `.local`, por exemplo `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Este servidor injeta um cliente de live-reload no HTML e recarrega em mudanças de arquivo.
O host A2UI fica em `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Comandos do Canvas (somente em primeiro plano):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (use `{"url":""}` ou `{"url":"/"}` para retornar ao scaffold padrão). `canvas.snapshot` retorna `{ format, base64 }` (padrão `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` alias legado)

Comandos da câmera (somente em primeiro plano; com permissão):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Veja [Nó de câmera](/nodes/camera) para parametros e helpers da CLI.
