---
summary: "Acesso e autenticação do dashboard do Gateway (Control UI)"
read_when:
  - Alterando a autenticação ou os modos de exposição do dashboard
title: "Dashboard"
---

# Dashboard (Control UI)

O dashboard do Gateway é a Control UI no navegador servida em `/` por padrão
(substitua com `gateway.controlUi.basePath`).

Abertura rápida (Gateway local):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (ou [http://localhost:18789/](http://localhost:18789/))

Referências principais:

- [Control UI](/web/control-ui) para uso e capacidades da UI.
- [Tailscale](/gateway/tailscale) para automação de Serve/Funnel.
- [Web surfaces](/web) para modos de bind e notas de segurança.

A autenticação é aplicada no handshake do WebSocket via `connect.params.auth`
(token ou senha). Veja `gateway.auth` em [Configuração do Gateway](/gateway/configuration).

Nota de segurança: a Control UI é uma **superfície administrativa** (chat, config, aprovações de exec).
Nao a exponha publicamente. A UI armazena o token em `localStorage` apos o primeiro carregamento.
Prefira localhost, Tailscale Serve ou um túnel SSH.

## Caminho rapido (recomendado)

- Apos a integração inicial, a CLI abre automaticamente o dashboard e imprime um link limpo (sem token).
- Reabrir a qualquer momento: `openclaw dashboard` (copia o link, abre o navegador se possivel, mostra dica de SSH se estiver headless).
- Se a UI solicitar autenticacao, cole o token de `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) nas configuracoes da Control UI.

## Noções basicas de token (local vs remoto)

- **Localhost**: abra `http://127.0.0.1:18789/`.
- **Fonte do token**: `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`); a UI armazena uma copia no localStorage apos voce se conectar.
- **Nao localhost**: use Tailscale Serve (sem token se `gateway.auth.allowTailscale: true`), bind do tailnet com um token ou um túnel SSH. Veja [Web surfaces](/web).

## Se voce vir “unauthorized” / 1008

- Garanta que o gateway esteja acessivel (local: `openclaw status`; remoto: túnel SSH `ssh -N -L 18789:127.0.0.1:18789 user@host` e depois abra `http://127.0.0.1:18789/`).
- Recupere o token do host do gateway: `openclaw config get gateway.auth.token` (ou gere um: `openclaw doctor --generate-gateway-token`).
- Nas configuracoes do dashboard, cole o token no campo de autenticacao e conecte.
