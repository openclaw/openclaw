---
summary: "Workflow ng Bun (eksperimental): pag-install at mga gotcha kumpara sa pnpm"
read_when:
  - Gusto mo ang pinakamabilis na local dev loop (bun + watch)
  - Nakaranas ka ng mga isyu sa Bun install/patch/lifecycle scripts
title: "Bun (Eksperimental)"
---

# Bun (eksperimental)

Layunin: patakbuhin ang repo na ito gamit ang **Bun** (opsyonal, hindi inirerekomenda para sa WhatsApp/Telegram)
nang hindi lumilihis mula sa mga workflow ng pnpm.

Note: ang `bun.lock`/`bun.lockb` ay naka-gitignore, kaya walang repo churn alinmang paraan. 2. Gumamit ng Node para sa production.

## Status

- Ang Bun ay isang opsyonal na local runtime para direktang patakbuhin ang TypeScript (`bun run …`, `bun --watch …`).
- Ang `pnpm` ang default para sa builds at nananatiling ganap na suportado (at ginagamit ng ilang docs tooling).
- Hindi magagamit ng Bun ang `pnpm-lock.yaml` at babalewalain ito.

## Install

Default:

```sh
bun install
```

Kung gusto mo ng _walang pagsusulat ng lockfile_: Maaaring harangin ng Bun ang mga dependency lifecycle script maliban kung hayagang pinagkakatiwalaan (`bun pm untrusted` / `bun pm trust`).

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Mga lifecycle script ng Bun (naka-block bilang default)

Para sa repo na ito, hindi kinakailangan ang mga karaniwang nahaharang na script:
May ilang script na naka-hardcode pa rin sa pnpm (hal. `docs:build`, `ui:*`, `protocol:check`).

- `@whiskeysockets/baileys` `preinstall`: tinitingnan ang Node major >= 20 (tumatakbo kami sa Node 22+).
- `protobufjs` `postinstall`: naglalabas ng mga babala tungkol sa hindi tugmang version schemes (walang build artifacts).

Kung makaranas ka ng tunay na runtime issue na nangangailangan ng mga script na ito, hayagan silang pagkatiwalaan:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Mga caveat

- **dev**: gumagalaw na head ng `main` (git). 8. Patakbuhin muna ang mga iyon gamit ang pnpm sa ngayon.
