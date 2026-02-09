---
summary: "Monitore a expiração de OAuth para provedores de modelo"
read_when:
  - Configurando monitoramento de expiração de autenticação ou alertas
  - Automatizando verificações de renovação de OAuth do Claude Code / Codex
title: "Monitoramento de autenticação"
---

# Monitoramento de autenticação

O OpenClaw expõe a saúde da expiração de OAuth via `openclaw models status`. Use isso para
automação e alertas; scripts são extras opcionais para fluxos de trabalho no telefone.

## Preferido: verificação via CLI (portátil)

```bash
openclaw models status --check
```

Códigos de saída:

- `0`: OK
- `1`: credenciais expiradas ou ausentes
- `2`: expirando em breve (dentro de 24h)

Isso funciona em cron/systemd e não requer scripts adicionais.

## Scripts opcionais (ops / fluxos de trabalho no telefone)

Eles ficam em `scripts/` e são **opcionais**. Eles assumem acesso SSH ao
host do gateway e são ajustados para systemd + Termux.

- `scripts/claude-auth-status.sh` agora usa `openclaw models status --json` como a
  fonte de verdade (recorrendo a leituras diretas de arquivos se a CLI não estiver disponível),
  então mantenha `openclaw` em `PATH` para os timers.
- `scripts/auth-monitor.sh`: alvo de timer cron/systemd; envia alertas (ntfy ou telefone).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: timer de usuário do systemd.
- `scripts/claude-auth-status.sh`: verificador de autenticação do Claude Code + OpenClaw (completo/json/simples).
- `scripts/mobile-reauth.sh`: fluxo guiado de reautenticação via SSH.
- `scripts/termux-quick-auth.sh`: status de widget com um toque + abrir URL de autenticação.
- `scripts/termux-auth-widget.sh`: fluxo completo guiado de widget.
- `scripts/termux-sync-widget.sh`: sincroniza credenciais do Claude Code → OpenClaw.

Se voce não precisa de automação no telefone ou timers do systemd, ignore esses scripts.
