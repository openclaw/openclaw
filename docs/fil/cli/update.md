---
summary: "CLI reference para sa `openclaw update` (ligtas-ligtas na source update + awtomatikong pag-restart ng Gateway)"
read_when:
  - Gusto mong mag-update ng source checkout nang ligtas
  - Kailangan mong maunawaan ang behavior ng shorthand na `--update`
title: "update"
---

# `openclaw update`

Ligtas na i-update ang OpenClaw at magpalit sa pagitan ng stable/beta/dev na mga channel.

Kung nag-install ka via **npm/pnpm** (global install, walang git metadata), ang mga update ay dumadaan sa daloy ng package manager sa [Updating](/install/updating).

## Paggamit

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

## Mga opsyon

- `--no-restart`: laktawan ang pag-restart ng serbisyo ng Gateway pagkatapos ng matagumpay na update.
- `--channel <stable|beta|dev>`: itakda ang update channel (git + npm; naka-persist sa config).
- `--tag <dist-tag|version>`: i-override ang npm dist-tag o bersyon para sa update na ito lamang.
- `--json`: mag-print ng machine-readable na `UpdateRunResult` JSON.
- `--timeout <seconds>`: timeout kada hakbang (default ay 1200s).

Tandaan: nangangailangan ng kumpirmasyon ang mga downgrade dahil maaaring masira ng mas lumang bersyon ang configuration.

## `update status`

Ipakita ang aktibong update channel + git tag/branch/SHA (para sa mga source checkout), pati ang availability ng update.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Mga opsyon:

- `--json`: mag-print ng machine-readable na status JSON.
- `--timeout <seconds>`: timeout para sa mga check (default ay 3s).

## `update wizard`

Interactive na daloy para pumili ng update channel at kumpirmahin kung ire-restart ang Gateway
pagkatapos mag-update (ang default ay mag-restart). Kung pipiliin mo ang `dev` nang walang git checkout,
mag-aalok itong gumawa ng isa.

## Ano ang ginagawa nito

Kapag tahasan kang nagpapalit ng channel (`--channel ...`), pinananatili rin ng OpenClaw na naka-align ang
paraan ng pag-install:

- `dev` → tinitiyak ang isang git checkout (default: `~/openclaw`, i-override gamit ang `OPENCLAW_GIT_DIR`),
  ina-update ito, at ini-install ang global CLI mula sa checkout na iyon.
- `stable`/`beta` → nag-i-install mula sa npm gamit ang katugmang dist-tag.

## Daloy ng git checkout

Mga channel:

- `stable`: i-checkout ang pinakabagong non-beta tag, pagkatapos ay build + doctor.
- `beta`: i-checkout ang pinakabagong `-beta` tag, pagkatapos ay build + doctor.
- `dev`: i-checkout ang `main`, pagkatapos ay fetch + rebase.

High-level:

1. Nangangailangan ng malinis na worktree (walang uncommitted na pagbabago).
2. Lumilipat sa napiling channel (tag o branch).
3. Kumukuha ng upstream (dev lang).
4. Dev lang: preflight lint + TypeScript build sa isang temp worktree; kung bumagsak ang tip, aatras hanggang 10 commit para hanapin ang pinakabagong malinis na build.
5. Nagre-rebase sa napiling commit (dev lang).
6. Ini-install ang deps (mas gusto ang pnpm; npm bilang fallback).
7. Nagbu-build + nagbu-build ng Control UI.
8. Pinapatakbo ang `openclaw doctor` bilang huling “safe update” na check.
9. Sini-sync ang mga plugin sa aktibong channel (gumagamit ang dev ng bundled extensions; ang stable/beta ay npm) at ina-update ang mga npm-installed na plugin.

## `--update` shorthand

`openclaw --update` ay nire-rewrite sa `openclaw update` (kapaki-pakinabang para sa mga shell at launcher script).

## Tingnan din

- `openclaw doctor` (nag-aalok na patakbuhin muna ang update sa mga git checkout)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
