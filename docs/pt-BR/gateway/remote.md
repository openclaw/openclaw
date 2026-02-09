---
summary: "Acesso remoto usando túneis SSH (Gateway WS) e tailnets"
read_when:
  - Ao executar ou solucionar problemas de configurações remotas do gateway
title: "Acesso remoto"
---

# Acesso remoto (SSH, túneis e tailnets)

Este repositório oferece suporte a “remoto via SSH” mantendo um único Gateway (o mestre) em execução em um host dedicado (desktop/servidor) e conectando clientes a ele.

- Para **operadores (você / o app macOS)**: o tunelamento SSH é o fallback universal.
- Para **nós (iOS/Android e dispositivos futuros)**: conectar ao **WebSocket** do Gateway (LAN/tailnet ou túnel SSH conforme necessário).

## A ideia central

- O WebSocket do Gateway se liga ao **loopback** na porta configurada (padrão 18789).
- Para uso remoto, você encaminha essa porta de loopback via SSH (ou usa uma tailnet/VPN e reduz a necessidade de túneis).

## Configurações comuns de VPN/tailnet (onde o agente vive)

Pense no **host do Gateway** como “onde o agente vive”. Ele é dono de sessões, perfis de autenticação, canais e estado.
Seu laptop/desktop (e nós) se conectam a esse host.

### 1. Gateway sempre ligado na sua tailnet (VPS ou servidor doméstico)

Execute o Gateway em um host persistente e acesse-o via **Tailscale** ou SSH.

- **Melhor UX:** mantenha `gateway.bind: "loopback"` e use **Tailscale Serve** para a UI de Controle.
- **Fallback:** mantenha loopback + túnel SSH a partir de qualquer máquina que precise de acesso.
- **Exemplos:** [exe.dev](/install/exe-dev) (VM fácil) ou [Hetzner](/install/hetzner) (VPS de produção).

Isso é ideal quando seu laptop entra em repouso com frequência, mas você quer o agente sempre ativo.

### 2. Desktop de casa executa o Gateway, laptop é controle remoto

O laptop **não** executa o agente. Ele se conecta remotamente:

- Use o modo **Remote over SSH** do app macOS (Ajustes → Geral → “OpenClaw runs”).
- O app abre e gerencia o túnel, então WebChat + verificações de saúde “simplesmente funcionam”.

Runbook: [acesso remoto no macOS](/platforms/mac/remote).

### 3. Laptop executa o Gateway, acesso remoto a partir de outras máquinas

Mantenha o Gateway local, mas exponha-o com segurança:

- Túnel SSH para o laptop a partir de outras máquinas, ou
- Tailscale Serve para a UI de Controle e mantenha o Gateway apenas em loopback.

Guia: [Tailscale](/gateway/tailscale) e [Visão geral da Web](/web).

## Fluxo de comandos (o que roda onde)

Um serviço de gateway é dono de estado + canais. Nós são periféricos.

Exemplo de fluxo (Telegram → nó):

- Mensagem do Telegram chega ao **Gateway**.
- O Gateway executa o **agente** e decide se deve chamar uma ferramenta de nó.
- O Gateway chama o **nó** via WebSocket do Gateway (RPC `node.*`).
- O nó retorna o resultado; o Gateway responde de volta ao Telegram.

Notas:

- **Nós não executam o serviço de gateway.** Apenas um gateway deve rodar por host, a menos que você execute intencionalmente perfis isolados (veja [Múltiplos gateways](/gateway/multiple-gateways)).
- O “modo nó” do app macOS é apenas um cliente de nó via WebSocket do Gateway.

## Túnel SSH (CLI + ferramentas)

Crie um túnel local para o WS remoto do Gateway:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Com o túnel ativo:

- `openclaw health` e `openclaw status --deep` agora alcançam o gateway remoto via `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` também pode apontar para a URL encaminhada via `--url` quando necessário.

Nota: substitua `18789` pelo seu `gateway.port` configurado (ou `--port`/`OPENCLAW_GATEWAY_PORT`).
Nota: ao passar `--url`, a CLI não faz fallback para credenciais de configuração ou de ambiente.
Inclua `--token` ou `--password` explicitamente. A ausência de credenciais explícitas é um erro.

## Padrões remotos da CLI

Você pode persistir um destino remoto para que os comandos da CLI o usem por padrão:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Quando o gateway é apenas loopback, mantenha a URL em `ws://127.0.0.1:18789` e abra o túnel SSH primeiro.

## UI de chat via SSH

O WebChat não usa mais uma porta HTTP separada. A UI de chat em SwiftUI conecta-se diretamente ao WebSocket do Gateway.

- Encaminhe `18789` via SSH (veja acima) e, em seguida, conecte os clientes a `ws://127.0.0.1:18789`.
- No macOS, prefira o modo “Remote over SSH” do app, que gerencia o túnel automaticamente.

## App macOS “Remote over SSH”

O app da barra de menus do macOS pode conduzir a mesma configuração de ponta a ponta (verificações de status remoto, WebChat e encaminhamento de Voice Wake).

Runbook: [acesso remoto no macOS](/platforms/mac/remote).

## Regras de segurança (remoto/VPN)

Versão curta: **mantenha o Gateway apenas em loopback** a menos que você tenha certeza de que precisa de um bind.

- **Loopback + SSH/Tailscale Serve** é o padrão mais seguro (sem exposição pública).
- **Binds não-loopback** (`lan`/`tailnet`/`custom`, ou `auto` quando loopback não está disponível) devem usar tokens/senhas de autenticação.
- `gateway.remote.token` é **apenas** para chamadas remotas da CLI — **não** habilita autenticação local.
- `gateway.remote.tlsFingerprint` fixa o certificado TLS remoto ao usar `wss://`.
- **Tailscale Serve** pode autenticar via cabeçalhos de identidade quando `gateway.auth.allowTailscale: true`.
  Defina como `false` se você quiser tokens/senhas em vez disso.
- Trate o controle pelo navegador como acesso de operador: apenas tailnet + pareamento deliberado de nós.

Aprofundamento: [Segurança](/gateway/security).
