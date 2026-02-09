---
summary: "Canais estável, beta e dev: semântica, troca e marcação"
read_when:
  - Você quer alternar entre estável/beta/dev
  - Você está marcando ou publicando pré-lançamentos
title: "Canais de desenvolvimento"
---

# Canais de desenvolvimento

Última atualização: 2026-01-21

O OpenClaw oferece três canais de atualização:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (builds em teste).
- **dev**: head móvel de `main` (git). npm dist-tag: `dev` (quando publicado).

Publicamos builds no **beta**, testamos e então **promovemos um build validado para `latest`**
sem alterar o número de versão — os dist-tags são a fonte da verdade para instalações via npm.

## Alternando canais

Checkout do git:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` fazem checkout da tag correspondente mais recente (geralmente a mesma tag).
- `dev` muda para `main` e faz rebase no upstream.

Instalação global via npm/pnpm:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Isso atualiza por meio do dist-tag npm correspondente (`latest`, `beta`, `dev`).

Quando você **explicitamente** troca de canal com `--channel`, o OpenClaw também alinha
o método de instalação:

- `dev` garante um checkout git (padrão `~/openclaw`, sobrescreva com `OPENCLAW_GIT_DIR`),
  atualiza-o e instala a CLI global a partir desse checkout.
- `stable`/`beta` instalam a partir do npm usando o dist-tag correspondente.

Dica: se você quiser estável + dev em paralelo, mantenha dois clones e aponte seu gateway para o estável.

## Plugins e canais

Ao trocar de canal com `openclaw update`, o OpenClaw também sincroniza as fontes dos plugins:

- `dev` prefere plugins empacotados a partir do checkout git.
- `stable` e `beta` restauram pacotes de plugins instalados via npm.

## Boas práticas de marcação

- Marque releases nos quais você quer que checkouts git parem (`vYYYY.M.D` ou `vYYYY.M.D-<patch>`).
- Mantenha as tags imutáveis: nunca mova ou reutilize uma tag.
- Os dist-tags do npm continuam sendo a fonte da verdade para instalações via npm:
  - `latest` → stable
  - `beta` → build candidato
  - `dev` → snapshot do main (opcional)

## Disponibilidade do app para macOS

Builds beta e dev podem **não** incluir um app para macOS. Tudo bem:

- A tag do git e o dist-tag do npm ainda podem ser publicados.
- Destaque “sem build para macOS neste beta” nas notas de release ou no changelog.
