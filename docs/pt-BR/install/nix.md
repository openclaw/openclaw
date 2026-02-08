---
summary: "Instale o OpenClaw de forma declarativa com Nix"
read_when:
  - Voce quer instalacoes reprodutiveis e com rollback
  - Voce ja usa Nix/NixOS/Home Manager
  - Voce quer tudo fixado e gerenciado de forma declarativa
title: "Nix"
x-i18n:
  source_path: install/nix.md
  source_hash: f1452194cfdd7461
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:15Z
---

# Instalacao com Nix

A forma recomendada de executar o OpenClaw com Nix e por meio do **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — um modulo do Home Manager com tudo incluido.

## Inicio Rapido

Cole isto no seu agente de IA (Claude, Cursor, etc.):

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **📦 Guia completo: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> O repo nix-openclaw e a fonte da verdade para a instalacao com Nix. Esta pagina e apenas uma visao geral rapida.

## O que voce recebe

- Gateway + app macOS + ferramentas (whisper, spotify, cameras) — tudo fixado
- Servico do Launchd que sobrevive a reinicializacoes
- Sistema de plugins com configuracao declarativa
- Rollback instantaneo: `home-manager switch --rollback`

---

## Comportamento de Runtime no Modo Nix

Quando `OPENCLAW_NIX_MODE=1` esta definido (automatico com nix-openclaw):

O OpenClaw oferece um **modo Nix** que torna a configuracao deterministica e desativa fluxos de auto-instalacao.
Ative exportando:

```bash
OPENCLAW_NIX_MODE=1
```

No macOS, o app de GUI nao herda automaticamente variaveis de ambiente do shell. Voce tambem pode
ativar o modo Nix via defaults:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Caminhos de configuracao + estado

O OpenClaw le configuracao JSON5 de `OPENCLAW_CONFIG_PATH` e armazena dados mutaveis em `OPENCLAW_STATE_DIR`.

- `OPENCLAW_STATE_DIR` (padrao: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (padrao: `$OPENCLAW_STATE_DIR/openclaw.json`)

Ao executar sob Nix, defina estes explicitamente para locais gerenciados pelo Nix para que o estado
de runtime e a configuracao fiquem fora do store imutavel.

### Comportamento de runtime no modo Nix

- Fluxos de auto-instalacao e auto-mutacao sao desativados
- Dependencias ausentes exibem mensagens de remediacao especificas do Nix
- A UI exibe um banner de modo Nix somente leitura quando presente

## Nota de empacotamento (macOS)

O fluxo de empacotamento do macOS espera um template Info.plist estavel em:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) copia este template para dentro do bundle do app e aplica patches nos campos dinamicos
(ID do bundle, versao/build, SHA do Git, chaves do Sparkle). Isso mantem o plist deterministico para
empacotamento com SwiftPM e builds do Nix (que nao dependem de uma toolchain completa do Xcode).

## Relacionado

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — guia completo de configuracao
- [Wizard](/start/wizard) — configuracao da CLI sem Nix
- [Docker](/install/docker) — configuracao em contêiner
