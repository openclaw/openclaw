---
date: 2026-04-04
topic: plugin-boundary-enforcement
---

# Plugin Boundary Enforcement

## Problem Frame

OpenClaw has clear architectural intent around plugin and extension boundaries, but the
tooling model is still too permissive. Bundled plugins live in workspace package
directories and the repo already has boundary guard scripts, yet TypeScript still treats
most of the repo as one project and the root config maps `openclaw/plugin-sdk/*`
directly to source files under `src/plugin-sdk/*`.

That creates the exact failure mode the project keeps fighting:

- bundled plugins can drift into imports that are only accidentally available
- editor autocomplete can suggest internals that should be off-limits
- AI agents can see a large source tree that appears importable even when the docs say it
  should not be
- interface expansion and accidental leakage are easy to confuse

This work is about making the architecture fail closed. When a bundled plugin imports
something outside the allowed contract, that import should break. If the dependency is
actually legitimate, the fix should be a separate, reviewed interface change rather than
an implicit exception.

## Requirements

**Bundled Plugin Import Contract**

- R1. Production bundled plugin code under `extensions/*` must be allowed to import only:
  `openclaw/plugin-sdk/*` and same-package relative imports.
- R2. Production bundled plugin code must not be able to import `src/**` directly,
  whether by relative path, path alias, or package alias that resolves to non-public core
  source.
- R3. Production bundled plugin code must not be able to import another bundled plugin's
  files, source directories, or package exports. The allowed cross-package contract is
  `openclaw/plugin-sdk/*`, not other bundled plugin packages.
- R4. The new enforcement model must intentionally break existing accidental imports that
  fall outside the allowed contract. Restoring any broken capability must require an
  explicit interface change in later work.

**Interface Shape**

- R5. `openclaw/plugin-sdk/*` must become the canonical generic cross-package contract
  for plugin authors.
- R6. Generic seams currently used broadly across many plugins must remain representable
  through explicit public interfaces. The initial seam map from the repo scan includes:
  provider seams, channel seams, config/account/secret seams, runtime/store seams, and
  capability seams such as CLI backend, speech, media understanding, realtime voice,
  sandbox, ACP, and memory host seams.
- R7. Plugin-specific seams currently published under `openclaw/plugin-sdk/*` must be
  treated as candidates for reduction, freezing, or replacement by more generic seams
  rather than as precedent for adding more plugin-named subpaths.
- R8. Planning must distinguish between justified shared interfaces and accidental
  leakage. A repeated import pattern alone is not enough to justify promotion into a
  public seam.

**Tooling Enforcement**

- R9. The repo must enforce plugin boundaries primarily through real package resolution
  and package-local TypeScript project boundaries rather than primarily through custom
  grep-style guard scripts.
- R10. Editor and compiler behavior should align with the allowed contract so that
  autocomplete, jump-to-definition, and typechecking steer contributors toward legal
  imports by default.
- R11. The existing boundary guard scripts and tests should remain as backstop validation,
  but the intended steady state is that illegal imports fail earlier through workspace,
  package, and TypeScript configuration.
- R12. The enforcement design should require minimal physical file movement in the first
  phase. Strengthening package and project boundaries should come before any large-scale
  directory reshuffle.

**Migration Behavior**

- R13. The first phase must prioritize strong enforcement for bundled plugins without
  requiring an immediate full-repo package split for every core area.
- R14. The first phase must preserve a path to later refactor or reduce the current
  plugin-specific SDK surface without forcing that entire cleanup into the initial
  enforcement change.
- R15. Planning must define a migration approach that lets maintainers measure breakage,
  understand which imports fail, and decide case-by-case whether to remove the dependency
  or promote a new explicit interface in subsequent work.

## Repo Scan Findings

The current import graph suggests a real shared seam model already exists, even though it
is weakly enforced:

| Seam area             | High-signal examples from current imports                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic provider seam | `plugin-entry`, `provider-entry`, `provider-model-shared`, `provider-onboard`, `provider-auth*`, `provider-stream`, `provider-http`, `provider-web-search`, `provider-usage`                 |
| Generic channel seam  | `core`, `channel-config-*`, `channel-contract`, `channel-policy`, `channel-pairing`, `channel-lifecycle`, `channel-reply-pipeline`, `channel-status`, `channel-actions`, `directory-runtime` |
| Generic runtime seam  | `config-runtime`, `routing`, `runtime-env`, `runtime-store`, `secret-input`, `security-runtime`, `ssrf-runtime`, `status-helpers`, `text-runtime`, `outbound-runtime`                        |
| Capability seam       | `cli-backend`, `cli-runtime`, `speech`, `image-generation`, `media-understanding`, `realtime-voice`, `realtime-transcription`, `sandbox`, `acp-runtime`, `memory-core-host-*`                |

The scan also found a large amount of bundled-plugin-local contract shaping through files
such as `runtime-api.ts`, `api.ts`, `config-api.ts`, and `contract-api.ts`. Those local
barrels are important signals for planning, but they do not override R1-R4.

## Success Criteria

- Illegal bundled-plugin imports fail through normal TypeScript/package resolution rather
  than only through custom lint scripts.
- A contributor working inside `extensions/<id>` sees autocomplete and type resolution
  aligned with the allowed contract instead of the entire repo.
- A bundled plugin that depends on a non-interface core helper breaks after the change.
- Maintainers can classify breakage into two buckets:
  imports to delete and interfaces to add deliberately in later work.
- The first phase improves enforcement materially without requiring a mass file move.

## Scope Boundaries

- This brainstorm does not define the exact package-by-package implementation sequence.
- This brainstorm does not bless all currently exported plugin-specific SDK subpaths as
  permanent architecture.
- This brainstorm does not require a whole-repo physical move into new top-level
  directories in phase 1.
- This brainstorm does not include the follow-up interface refactors needed to restore
  any intentionally broken but justified cross-package capability.

## Key Decisions

- Fail closed for bundled plugins: bundled plugins may import only
  `openclaw/plugin-sdk/*` plus same-package relative imports.
- Break accidental imports on purpose: compatibility with current leakage is not a goal of
  the first enforcement phase.
- Favor compiler/package enforcement over policy-only enforcement: custom boundary scripts
  remain useful, but they are not the primary mechanism the architecture should rely on.
- Keep the first phase low-churn in layout: enforce boundaries before doing a repo-wide
  move.

## Dependencies / Assumptions

- The current repo already has a pnpm workspace, extension package roots, boundary guard
  scripts, and a large exported `plugin-sdk` surface.
- The root `tsconfig.json` path mapping is a major reason the current model does not fail
  closed.
- Official TypeScript guidance warns against using `paths` to point at sibling monorepo
  packages instead of using real workspaces and package resolution.

## Outstanding Questions

### Deferred to Planning

- [Affects R5] Technical: Which minimal set of package-local `tsconfig.json` files and
  project references is sufficient to enforce R1-R4 in phase 1?
- [Affects R7] Technical: Which currently exported plugin-specific `plugin-sdk` subpaths
  should be frozen temporarily, which should be replaced by generic seams, and which
  should be removed outright?
- [Affects R9] Needs research: What is the cleanest way to combine pnpm workspace
  dependencies, package `exports`, and TypeScript project references here without
  destabilizing the existing build and release flow?
- [Affects R13] Technical: Which core slices need to become real package boundaries in
  phase 1, and which can remain internal behind the root package while bundled plugin
  enforcement is tightened?
- [Affects R15] Technical: What migration/reporting mechanism should planning use to
  classify broken imports into “delete dependency” versus “design a new interface”?

## Next Steps

→ /prompts:ce-plan for structured implementation planning
