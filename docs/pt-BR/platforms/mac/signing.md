---
summary: "Etapas de assinatura para builds de depuração do macOS geradas por scripts de empacotamento"
read_when:
  - Criando ou assinando builds de depuração do mac
title: "Assinatura no macOS"
---

# assinatura no mac (builds de depuração)

Este app geralmente é criado a partir de [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), que agora:

- define um identificador de bundle de depuração estável: `ai.openclaw.mac.debug`
- grava o Info.plist com esse bundle id (sobrescreva via `BUNDLE_ID=...`)
- chama [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) para assinar o binário principal e o bundle do app, de modo que o macOS trate cada rebuild como o mesmo bundle assinado e mantenha as permissões do TCC (notificações, acessibilidade, gravação de tela, microfone, fala). Para permissões estáveis, use uma identidade de assinatura real; ad-hoc é opt-in e frágil (veja [permissões do macOS](/platforms/mac/permissions)).
- usa `CODESIGN_TIMESTAMP=auto` por padrão; ele habilita timestamps confiáveis para assinaturas Developer ID. Defina `CODESIGN_TIMESTAMP=off` para pular o timestamp (builds de depuração offline).
- injeta metadados de build no Info.plist: `OpenClawBuildTimestamp` (UTC) e `OpenClawGitCommit` (hash curto), para que o painel Sobre possa mostrar build, git e canal de depuração/produção.
- **O empacotamento requer Node 22+**: o script executa builds em TS e o build da UI de Controle.
- lê `SIGN_IDENTITY` do ambiente. Adicione `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (ou seu certificado Developer ID Application) ao rc do seu shell para sempre assinar com seu certificado. Assinatura ad-hoc exige opt-in explícito via `ALLOW_ADHOC_SIGNING=1` ou `SIGN_IDENTITY="-"` (não recomendado para testes de permissões).
- executa uma auditoria de Team ID após a assinatura e falha se qualquer Mach-O dentro do bundle do app estiver assinado por um Team ID diferente. Defina `SKIP_TEAM_ID_CHECK=1` para ignorar.

## Uso

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Nota sobre assinatura ad-hoc

Ao assinar com `SIGN_IDENTITY="-"` (ad-hoc), o script desativa automaticamente o **Hardened Runtime** (`--options runtime`). Isso é necessário para evitar crashes quando o app tenta carregar frameworks incorporados (como o Sparkle) que não compartilham o mesmo Team ID. Assinaturas ad-hoc também quebram a persistência das permissões do TCC; veja [permissões do macOS](/platforms/mac/permissions) para etapas de recuperação.

## Metadados de build para o Sobre

`package-mac-app.sh` carimba o bundle com:

- `OpenClawBuildTimestamp`: ISO8601 UTC no momento do empacotamento
- `OpenClawGitCommit`: hash curto do git (ou `unknown` se indisponível)

A aba Sobre lê essas chaves para mostrar versão, data do build, commit do git e se é um build de depuração (via `#if DEBUG`). Execute o empacotador para atualizar esses valores após mudanças no código.

## Por quê

As permissões do TCC estão vinculadas ao identificador do bundle _e_ à assinatura de código. Builds de depuração sem assinatura, com UUIDs variáveis, faziam o macOS esquecer as concessões após cada rebuild. Assinar os binários (ad-hoc por padrão) e manter um bundle id/caminho fixo (`dist/OpenClaw.app`) preserva as concessões entre builds, alinhando-se à abordagem do VibeTunnel.
