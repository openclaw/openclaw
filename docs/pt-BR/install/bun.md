---
summary: "Fluxo de trabalho com Bun (experimental): instalação e pegadinhas vs pnpm"
read_when:
  - Você quer o loop de desenvolvimento local mais rápido (bun + watch)
  - Você encontrou problemas de instalação/patch/scripts de ciclo de vida do Bun
title: "Bun (Experimental)"
---

# Bun (experimental)

Objetivo: executar este repositório com **Bun** (opcional, não recomendado para WhatsApp/Telegram)
sem divergir dos fluxos de trabalho com pnpm.

⚠️ **Não recomendado para runtime do Gateway** (bugs no WhatsApp/Telegram). Use Node em produção.

## Status

- Bun é um runtime local opcional para executar TypeScript diretamente (`bun run …`, `bun --watch …`).
- `pnpm` é o padrão para builds e continua totalmente suportado (e usado por algumas ferramentas de docs).
- Bun não pode usar `pnpm-lock.yaml` e irá ignorá-lo.

## Install

Padrão:

```sh
bun install
```

Nota: `bun.lock`/`bun.lockb` são ignorados pelo git, então não há churn no repositório de nenhuma forma. Se você quiser _nenhuma escrita de lockfile_:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Scripts de ciclo de vida do Bun (bloqueados por padrão)

O Bun pode bloquear scripts de ciclo de vida de dependências, a menos que sejam explicitamente confiáveis (`bun pm untrusted` / `bun pm trust`).
Para este repositório, os scripts comumente bloqueados não são necessários:

- `@whiskeysockets/baileys` `preinstall`: verifica Node major >= 20 (executamos Node 22+).
- `protobufjs` `postinstall`: emite avisos sobre esquemas de versão incompatíveis (sem artefatos de build).

Se você encontrar um problema real em runtime que exija esses scripts, confie neles explicitamente:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Ressalvas

- Alguns scripts ainda codificam pnpm (por exemplo, `docs:build`, `ui:*`, `protocol:check`). Execute esses via pnpm por enquanto.
