---
summary: "Descoberta de nós e transportes (Bonjour, Tailscale, SSH) para localizar o gateway"
read_when:
  - Implementar ou alterar descoberta/publicidade via Bonjour
  - Ajustar modos de conexão remota (direto vs SSH)
  - Projetar descoberta de nós + pareamento para nós remotos
title: "Descoberta e Transportes"
---

# Descoberta & transportes

O OpenClaw tem dois problemas distintos que parecem semelhantes à primeira vista:

1. **Controle remoto do operador**: o app de barra de menus do macOS controlando um gateway executando em outro lugar.
2. **Pareamento de nós**: iOS/Android (e nós futuros) encontrando um gateway e pareando de forma segura.

O objetivo de design é manter toda a descoberta/publicidade de rede no **Node Gateway** (`openclaw gateway`) e manter os clientes (app mac, iOS) como consumidores.

## Termos

- **Gateway**: um único processo de gateway de longa duração que é dono do estado (sessões, pareamento, registro de nós) e executa canais. A maioria das configurações usa um por host; configurações isoladas com múltiplos gateways são possíveis.
- **Gateway WS (plano de controle)**: o endpoint WebSocket em `127.0.0.1:18789` por padrão; pode ser vinculado à LAN/tailnet via `gateway.bind`.
- **Transporte WS direto**: um endpoint Gateway WS voltado para LAN/tailnet (sem SSH).
- **Transporte SSH (fallback)**: controle remoto encaminhando `127.0.0.1:18789` via SSH.
- **Bridge TCP legado (deprecated/removido)**: transporte de nós mais antigo (veja [Bridge protocol](/gateway/bridge-protocol)); não é mais anunciado para descoberta.

Detalhes de protocolo:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Por que mantemos tanto “direto” quanto SSH

- **WS direto** é a melhor UX na mesma rede e dentro de uma tailnet:
  - auto-descoberta na LAN via Bonjour
  - tokens de pareamento + ACLs sob controle do gateway
  - não requer acesso a shell; a superfície de protocolo pode permanecer restrita e auditável
- **SSH** continua sendo o fallback universal:
  - funciona em qualquer lugar onde você tenha acesso SSH (mesmo entre redes não relacionadas)
  - sobrevive a problemas de multicast/mDNS
  - não requer novas portas de entrada além do SSH

## Entradas de descoberta (como os clientes aprendem onde o gateway está)

### 1. Bonjour / mDNS (somente LAN)

O Bonjour é best-effort e não atravessa redes. Ele é usado apenas para conveniência de “mesma LAN”.

Direção alvo:

- O **gateway** anuncia seu endpoint WS via Bonjour.
- Os clientes navegam e exibem uma lista “escolher um gateway”, depois armazenam o endpoint escolhido.

Solução de problemas e detalhes do beacon: [Bonjour](/gateway/bonjour).

#### Detalhes do beacon de serviço

- Tipos de serviço:
  - `_openclaw-gw._tcp` (beacon de transporte do gateway)
- Chaves TXT (não secretas):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (ou o que for anunciado)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (somente quando TLS está habilitado)
  - `gatewayTlsSha256=<sha256>` (somente quando TLS está habilitado e a impressão digital está disponível)
  - `canvasPort=18793` (porta padrão do host do canvas; serve `/__openclaw__/canvas/`)
  - `cliPath=<path>` (opcional; caminho absoluto para um entrypoint ou binário executável `openclaw`)
  - `tailnetDns=<magicdns>` (dica opcional; detectada automaticamente quando o Tailscale está disponível)

Desativar/substituir:

- `OPENCLAW_DISABLE_BONJOUR=1` desativa a publicidade.
- `gateway.bind` em `~/.openclaw/openclaw.json` controla o modo de bind do Gateway.
- `OPENCLAW_SSH_PORT` substitui a porta SSH anunciada no TXT (padrão 22).
- `OPENCLAW_TAILNET_DNS` publica uma dica `tailnetDns` (MagicDNS).
- `OPENCLAW_CLI_PATH` substitui o caminho da CLI anunciada.

### 2. Tailnet (entre redes)

Para configurações no estilo Londres/Viena, o Bonjour não ajuda. O alvo “direto” recomendado é:

- Nome MagicDNS do Tailscale (preferido) ou um IP estável da tailnet.

Se o gateway conseguir detectar que está sendo executado sob o Tailscale, ele publica `tailnetDns` como uma dica opcional para os clientes (incluindo beacons de área ampla).

### 3. Alvo manual / SSH

Quando não há rota direta (ou o direto está desativado), os clientes sempre podem se conectar via SSH encaminhando a porta de gateway em loopback.

Veja [Remote access](/gateway/remote).

## Seleção de transporte (política do cliente)

Comportamento recomendado do cliente:

1. Se um endpoint direto pareado estiver configurado e acessível, use-o.
2. Caso contrário, se o Bonjour encontrar um gateway na LAN, ofereça uma escolha “Usar este gateway” com um toque e salve-o como o endpoint direto.
3. Caso contrário, se um DNS/IP de tailnet estiver configurado, tente direto.
4. Caso contrário, recorra ao SSH.

## Pareamento + autenticação (transporte direto)

O gateway é a fonte de verdade para admissão de nós/clientes.

- As solicitações de pareamento são criadas/aprovadas/rejeitadas no gateway (veja [Gateway pairing](/gateway/pairing)).
- O gateway aplica:
  - autenticação (token / par de chaves)
  - escopos/ACLs (o gateway não é um proxy bruto para todos os métodos)
  - limites de taxa

## Responsabilidades por componente

- **Gateway**: anuncia beacons de descoberta, é dono das decisões de pareamento e hospeda o endpoint WS.
- **App macOS**: ajuda você a escolher um gateway, mostra prompts de pareamento e usa SSH apenas como fallback.
- **Nós iOS/Android**: navegam pelo Bonjour como conveniência e se conectam ao Gateway WS pareado.
