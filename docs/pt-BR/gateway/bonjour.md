---
summary: "Descoberta Bonjour/mDNS + depuração (beacons do Gateway, clientes e modos de falha comuns)"
read_when:
  - Depurando problemas de descoberta Bonjour no macOS/iOS
  - Alterando tipos de serviço mDNS, registros TXT ou UX de descoberta
title: "Descoberta Bonjour"
---

# Descoberta Bonjour / mDNS

O OpenClaw usa Bonjour (mDNS / DNS‑SD) como uma **conveniência apenas para LAN** para descobrir
um Gateway ativo (endpoint WebSocket). É de melhor esforço e **não** substitui SSH nem
conectividade baseada em Tailnet.

## Bonjour de área ampla (DNS‑SD unicast) sobre Tailscale

Se o nó e o gateway estiverem em redes diferentes, o mDNS multicast não atravessa a
fronteira. Você pode manter a mesma UX de descoberta mudando para **DNS‑SD unicast**
("Bonjour de Área Ampla") sobre o Tailscale.

Passos em alto nível:

1. Execute um servidor DNS no host do gateway (acessível pela Tailnet).
2. Publique registros DNS‑SD para `_openclaw-gw._tcp` sob uma zona dedicada
   (exemplo: `openclaw.internal.`).
3. Configure **DNS dividido** do Tailscale para que o domínio escolhido resolva por esse
   servidor DNS para os clientes (incluindo iOS).

O OpenClaw oferece suporte a qualquer domínio de descoberta; `openclaw.internal.` é apenas um exemplo.
Nós iOS/Android navegam tanto por `local.` quanto pelo domínio de área ampla configurado.

### Configuração do Gateway (recomendado)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Configuração única do servidor DNS (host do gateway)

```bash
openclaw dns setup --apply
```

Isso instala o CoreDNS e o configura para:

- escutar na porta 53 apenas nas interfaces Tailscale do gateway
- servir o domínio escolhido (exemplo: `openclaw.internal.`) a partir de `~/.openclaw/dns/<domain>.db`

Valide a partir de uma máquina conectada à tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Configurações de DNS do Tailscale

No console de administração do Tailscale:

- Adicione um servidor de nomes apontando para o IP da tailnet do gateway (UDP/TCP 53).
- Adicione DNS dividido para que o domínio de descoberta use esse servidor de nomes.

Depois que os clientes aceitarem o DNS da tailnet, nós iOS podem navegar por
`_openclaw-gw._tcp` no seu domínio de descoberta sem multicast.

### Segurança do listener do Gateway (recomendado)

A porta WS do Gateway (padrão `18789`) vincula-se ao loopback por padrão. Para acesso
LAN/tailnet, faça o bind explicitamente e mantenha a autenticação habilitada.

Para configurações somente de tailnet:

- Defina `gateway.bind: "tailnet"` em `~/.openclaw/openclaw.json`.
- Reinicie o Gateway (ou reinicie o app de menubar do macOS).

## O que anuncia

Apenas o Gateway anuncia `_openclaw-gw._tcp`.

## Tipos de serviço

- `_openclaw-gw._tcp` — beacon de transporte do gateway (usado por nós macOS/iOS/Android).

## Chaves TXT (dicas não secretas)

O Gateway anuncia pequenas dicas não secretas para tornar os fluxos de UI convenientes:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (apenas quando TLS está habilitado)
- `gatewayTlsSha256=<sha256>` (apenas quando TLS está habilitado e a impressão digital está disponível)
- `canvasPort=<port>` (apenas quando o host do canvas está habilitado; padrão `18793`)
- `sshPort=<port>` (padrão 22 quando não sobrescrito)
- `transport=gateway`
- `cliPath=<path>` (opcional; caminho absoluto para um entrypoint executável `openclaw`)
- `tailnetDns=<magicdns>` (dica opcional quando a Tailnet está disponível)

## Depuração no macOS

Ferramentas internas úteis:

- Procurar instâncias:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Resolver uma instância (substitua `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Se a navegação funciona mas a resolução falha, geralmente você está esbarrando em uma
política de LAN ou em um problema do resolvedor mDNS.

## Depuração nos logs do Gateway

O Gateway grava um arquivo de log rotativo (impresso na inicialização como
`gateway log file: ...`). Procure por linhas `bonjour:`, especialmente:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Depuração no nó iOS

O nó iOS usa `NWBrowser` para descobrir `_openclaw-gw._tcp`.

Para capturar logs:

- Ajustes → Gateway → Avançado → **Logs de depuração de descoberta**
- Ajustes → Gateway → Avançado → **Logs de descoberta** → reproduzir → **Copiar**

O log inclui transições de estado do navegador e alterações no conjunto de resultados.

## Modos de falha comuns

- **Bonjour não cruza redes**: use Tailnet ou SSH.
- **Multicast bloqueado**: algumas redes Wi‑Fi desativam mDNS.
- **Suspensão / troca de interfaces**: o macOS pode derrubar temporariamente resultados mDNS; tente novamente.
- **Navegar funciona mas resolver falha**: mantenha nomes de máquina simples (evite emojis ou
  pontuação) e reinicie o Gateway. O nome da instância do serviço deriva do nome do host, então
  nomes excessivamente complexos podem confundir alguns resolvedores.

## Nomes de instância escapados (`\032`)

O Bonjour/DNS‑SD frequentemente escapa bytes em nomes de instância de serviço como sequências
decimais `\DDD` (por exemplo, espaços viram `\032`).

- Isso é normal no nível do protocolo.
- UIs devem decodificar para exibição (o iOS usa `BonjourEscapes.decode`).

## Desativação / configuração

- `OPENCLAW_DISABLE_BONJOUR=1` desativa a divulgação (legado: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` em `~/.openclaw/openclaw.json` controla o modo de bind do Gateway.
- `OPENCLAW_SSH_PORT` sobrescreve a porta SSH anunciada no TXT (legado: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publica uma dica de MagicDNS no TXT (legado: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` sobrescreve o caminho da CLI anunciada (legado: `OPENCLAW_CLI_PATH`).

## Documentos relacionados

- Política de descoberta e seleção de transporte: [Discovery](/gateway/discovery)
- Pareamento de nós + aprovações: [Gateway pairing](/gateway/pairing)
