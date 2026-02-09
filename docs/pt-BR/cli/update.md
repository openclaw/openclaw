---
summary: "Referência da CLI para `openclaw update` (atualização de origem relativamente segura + reinício automático do gateway)"
read_when:
  - Voce quer atualizar um checkout de origem com segurança
  - Voce precisa entender o comportamento do atalho `--update`
title: "update"
---

# `openclaw update`

Atualize o OpenClaw com segurança e alterne entre os canais stable/beta/dev.

Se voce instalou via **npm/pnpm** (instalação global, sem metadados git), as atualizações acontecem pelo fluxo do gerenciador de pacotes em [Updating](/install/updating).

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: pula o reinício do serviço do Gateway após uma atualização bem-sucedida.
- `--channel <stable|beta|dev>`: define o canal de atualização (git + npm; persistido na configuração).
- `--tag <dist-tag|version>`: substitui o dist-tag do npm ou a versão apenas para esta atualização.
- `--json`: imprime JSON `UpdateRunResult` legível por máquina.
- `--timeout <seconds>`: tempo limite por etapa (o padrão é 1200s).

Nota: downgrades exigem confirmação porque versões mais antigas podem quebrar a configuração.

## `update status`

Mostra o canal de atualização ativo + tag/branch/SHA do git (para checkouts de origem), além da disponibilidade de atualização.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: imprime JSON de status legível por máquina.
- `--timeout <seconds>`: tempo limite para verificações (o padrão é 3s).

## `update wizard`

Fluxo interativo para escolher um canal de atualização e confirmar se deve reiniciar o Gateway
após a atualização (o padrão é reiniciar). Se voce selecionar `dev` sem um checkout git, ele
oferece criar um.

## What it does

Quando voce troca de canal explicitamente (`--channel ...`), o OpenClaw também mantém o
método de instalação alinhado:

- `dev` → garante um checkout git (padrão: `~/openclaw`, substitua com `OPENCLAW_GIT_DIR`),
  atualiza-o e instala a CLI global a partir desse checkout.
- `stable`/`beta` → instala a partir do npm usando o dist-tag correspondente.

## Git checkout flow

Channels:

- `stable`: faz checkout da tag não-beta mais recente e então build + doctor.
- `beta`: faz checkout da tag `-beta` mais recente e então build + doctor.
- `dev`: faz checkout de `main` e então fetch + rebase.

High-level:

1. Requer uma worktree limpa (sem alterações não commitadas).
2. Alterna para o canal selecionado (tag ou branch).
3. Faz fetch do upstream (apenas dev).
4. Apenas dev: lint de pré-checagem + build TypeScript em uma worktree temporária; se a ponta falhar, volta até 10 commits para encontrar o build limpo mais recente.
5. Faz rebase sobre o commit selecionado (apenas dev).
6. Instala dependências (pnpm preferido; fallback para npm).
7. Build + build da Control UI.
8. Executa `openclaw doctor` como a verificação final de “atualização segura”.
9. Sincroniza plugins com o canal ativo (dev usa extensões empacotadas; stable/beta usa npm) e atualiza plugins instalados via npm.

## `--update` shorthand

`openclaw --update` é reescrito para `openclaw update` (útil para shells e scripts de inicialização).

## See also

- `openclaw doctor` (oferece executar a atualização primeiro em checkouts git)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
