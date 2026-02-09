---
summary: "Serve/Funnel do Tailscale integrado para o painel do Gateway"
read_when:
  - Expor a UI de Controle do Gateway fora do localhost
  - Automatizar o acesso ao painel via tailnet ou público
title: "Tailscale"
---

# Tailscale (painel do Gateway)

O OpenClaw pode configurar automaticamente o Tailscale **Serve** (tailnet) ou **Funnel** (público) para o
painel do Gateway e a porta WebSocket. Isso mantém o Gateway vinculado ao loopback enquanto o
Tailscale fornece HTTPS, roteamento e (para Serve) cabeçalhos de identidade.

## Modos

- `serve`: Serve somente na Tailnet via `tailscale serve`. O gateway permanece em `127.0.0.1`.
- `funnel`: HTTPS público via `tailscale funnel`. O OpenClaw exige uma senha compartilhada.
- `off`: Padrão (sem automação do Tailscale).

## Autenticação

Defina `gateway.auth.mode` para controlar o handshake:

- `token` (padrão quando `OPENCLAW_GATEWAY_TOKEN` está definido)
- `password` (segredo compartilhado via `OPENCLAW_GATEWAY_PASSWORD` ou configuração)

Quando `tailscale.mode = "serve"` e `gateway.auth.allowTailscale` é `true`,
requisições válidas de proxy do Serve podem se autenticar por meio dos cabeçalhos de identidade do Tailscale
(`tailscale-user-login`) sem fornecer um token/senha. O OpenClaw verifica
a identidade resolvendo o endereço `x-forwarded-for` por meio do daemon local do Tailscale
(`tailscale whois`) e correspondendo-o ao cabeçalho antes de aceitá-lo.
O OpenClaw só trata uma requisição como Serve quando ela chega pelo loopback com
os cabeçalhos do Tailscale `x-forwarded-for`, `x-forwarded-proto` e `x-forwarded-host`.
Para exigir credenciais explícitas, defina `gateway.auth.allowTailscale: false` ou
force `gateway.auth.mode: "password"`.

## Exemplos de configuração

### Somente Tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Abra: `https://<magicdns>/` (ou o seu `gateway.controlUi.basePath` configurado)

### Somente Tailnet (vincular ao IP da Tailnet)

Use isto quando quiser que o Gateway escute diretamente no IP da Tailnet (sem Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Conecte-se a partir de outro dispositivo da Tailnet:

- UI de Controle: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Nota: o loopback (`http://127.0.0.1:18789`) **não** funcionará neste modo.

### Internet pública (Funnel + senha compartilhada)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Prefira `OPENCLAW_GATEWAY_PASSWORD` em vez de salvar uma senha no disco.

## Exemplos de CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notas

- Serve/Funnel do Tailscale exige que a CLI `tailscale` esteja instalada e com login efetuado.
- `tailscale.mode: "funnel"` se recusa a iniciar a menos que o modo de autenticação seja `password` para evitar exposição pública.
- Defina `gateway.tailscale.resetOnExit` se quiser que o OpenClaw desfaça a configuração de `tailscale serve`
  ou `tailscale funnel` ao encerrar.
- `gateway.bind: "tailnet"` é um bind direto à Tailnet (sem HTTPS, sem Serve/Funnel).
- `gateway.bind: "auto"` prefere loopback; use `tailnet` se quiser somente Tailnet.
- Serve/Funnel expõem apenas a **UI de controle do Gateway + WS**. Os nós se conectam pelo
  mesmo endpoint WS do Gateway, então o Serve pode funcionar para acesso aos nós.

## Controle do navegador (Gateway remoto + navegador local)

Se você executa o Gateway em uma máquina, mas quer controlar um navegador em outra máquina,
execute um **host de nó** na máquina do navegador e mantenha ambos na mesma tailnet.
O Gateway fará proxy das ações do navegador para o nó; não é necessário um servidor de controle separado nem uma URL do Serve.

Evite o Funnel para controle do navegador; trate o pareamento de nós como acesso de operador.

## Pré-requisitos + limites do Tailscale

- O Serve requer HTTPS habilitado para sua tailnet; a CLI solicita caso esteja ausente.
- O Serve injeta cabeçalhos de identidade do Tailscale; o Funnel não.
- O Funnel requer Tailscale v1.38.3+, MagicDNS, HTTPS habilitado e um atributo de nó funnel.
- O Funnel oferece suporte apenas às portas `443`, `8443` e `10000` via TLS.
- O Funnel no macOS requer a variante open-source do aplicativo Tailscale.

## Saiba mais

- Visão geral do Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- Comando `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Visão geral do Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- Comando `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
