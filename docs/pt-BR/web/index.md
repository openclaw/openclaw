---
summary: "Superfícies web do Gateway: UI de Controle, modos de bind e segurança"
read_when:
  - Você quer acessar o Gateway via Tailscale
  - Você quer a UI de Controle no navegador e edição de configuração
title: "Web"
---

# Web (Gateway)

O Gateway serve uma pequena **UI de Controle no navegador** (Vite + Lit) a partir da mesma porta do WebSocket do Gateway:

- padrão: `http://<host>:18789/`
- prefixo opcional: defina `gateway.controlUi.basePath` (por exemplo, `/openclaw`)

As funcionalidades ficam em [UI de Controle](/web/control-ui).
Esta página foca em modos de bind, segurança e superfícies expostas à web.

## Webhooks

Quando `hooks.enabled=true`, o Gateway também expõe um pequeno endpoint de webhook no mesmo servidor HTTP.
Veja [Configuração do Gateway](/gateway/configuration) → `hooks` para autenticação + payloads.

## Configuração (ativado por padrão)

A UI de Controle é **ativada por padrão** quando os assets estão presentes (`dist/control-ui`).
Você pode controlá-la via configuração:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Acesso via Tailscale

### Serve integrado (recomendado)

Mantenha o Gateway em loopback e deixe o Tailscale Serve fazer o proxy:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Depois inicie o gateway:

```bash
openclaw gateway
```

Abra:

- `https://<magicdns>/` (ou o `gateway.controlUi.basePath` configurado)

### Bind no tailnet + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Depois inicie o gateway (token exigido para binds fora de loopback):

```bash
openclaw gateway
```

Abra:

- `http://<tailscale-ip>:18789/` (ou o `gateway.controlUi.basePath` configurado)

### Internet pública (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Notas de segurança

- A autenticação do Gateway é exigida por padrão (token/senha ou cabeçalhos de identidade do Tailscale).
- Binds fora de loopback ainda **exigem** um token/senha compartilhado (`gateway.auth` ou env).
- O assistente gera um token do gateway por padrão (mesmo em loopback).
- A UI envia `connect.params.auth.token` ou `connect.params.auth.password`.
- A UI de Controle envia cabeçalhos anti-clickjacking e aceita apenas conexões de websocket do navegador de mesma origem, a menos que `gateway.controlUi.allowedOrigins` esteja definido.
- Com Serve, os cabeçalhos de identidade do Tailscale podem satisfazer a autenticação quando
  `gateway.auth.allowTailscale` é `true` (nenhum token/senha necessário). Defina
  `gateway.auth.allowTailscale: false` para exigir credenciais explícitas. Veja
  [Tailscale](/gateway/tailscale) e [Segurança](/gateway/security).
- `gateway.tailscale.mode: "funnel"` exige `gateway.auth.mode: "password"` (senha compartilhada).

## Construindo a UI

O Gateway serve arquivos estáticos a partir de `dist/control-ui`. Compile-os com:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
