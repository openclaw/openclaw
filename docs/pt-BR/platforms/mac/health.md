---
summary: "Como o app do macOS reporta estados de saúde do gateway/Baileys"
read_when:
  - Depurando indicadores de saúde do app do macOS
title: "Verificações de saúde"
---

# Verificações de saúde no macOS

Como ver se o canal vinculado está saudável a partir do app da barra de menus.

## Barra de menus

- O ponto de status agora reflete a saúde do Baileys:
  - Verde: vinculado + socket aberto recentemente.
  - Laranja: conectando/reintentando.
  - Vermelho: deslogado ou falha na sonda.
- A linha secundária mostra "linked · auth 12m" ou exibe o motivo da falha.
- O item de menu "Run Health Check" aciona uma sonda sob demanda.

## Configurações

- A aba Geral ganha um cartão de Saúde mostrando: idade da autenticação vinculada, caminho/contagem do session-store, horário da última verificação, último erro/código de status e botões para Run Health Check / Reveal Logs.
- Usa um snapshot em cache para que a UI carregue instantaneamente e faça fallback de forma elegante quando offline.
- **Aba Canais** exibe o status do canal + controles para WhatsApp/Telegram (QR de login, logout, sonda, última desconexão/erro).

## Como a sonda funciona

- O app executa `openclaw health --json` via `ShellExecutor` a cada ~60s e sob demanda. A sonda carrega credenciais e reporta o status sem enviar mensagens.
- Armazena em cache o último snapshot válido e o último erro separadamente para evitar flicker; mostra o timestamp de cada um.

## Em caso de dúvida

- Você ainda pode usar o fluxo da CLI em [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) e acompanhar `/tmp/openclaw/openclaw-*.log` para `web-heartbeat` / `web-reconnect`.
