---
summary: "Referência da CLI para `openclaw doctor` (verificações de saúde + reparos guiados)"
read_when:
  - Você tem problemas de conectividade/autenticação e quer correções guiadas
  - Você atualizou e quer uma verificação de sanidade
title: "doctor"
---

# `openclaw doctor`

Verificações de saúde + correções rápidas para o gateway e os canais.

Relacionado:

- Solução de problemas: [Troubleshooting](/gateway/troubleshooting)
- Auditoria de segurança: [Security](/gateway/security)

## Exemplos

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Notas:

- Prompts interativos (como correções de keychain/OAuth) só são executados quando o stdin é um TTY e `--non-interactive` **não** está definido. Execuções sem interface (cron, Telegram, sem terminal) ignorarão os prompts.
- `--fix` (alias de `--repair`) grava um backup em `~/.openclaw/openclaw.json.bak` e remove chaves de configuração desconhecidas, listando cada remoção.

## macOS: substituições por variáveis de ambiente `launchctl`

Se você executou anteriormente `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (ou `...PASSWORD`), esse valor substitui seu arquivo de configuração e pode causar erros persistentes de “não autorizado”.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
