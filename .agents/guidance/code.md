# Code

Read when writing or reviewing implementation code. Paths and commands in this document are repository-root
relative unless explicitly stated otherwise. The root AGENTS.md Arxi execution
and authorization rules apply to every example and linked skill.

- TS ESM, strict. Avoid `any`; prefer real types, `unknown`, narrow adapters.
- No `@ts-nocheck`. Lint suppressions only intentional + explained.
- Static-analysis fixes must strengthen the owning type/runtime contract or remove an unsafe operation. Never satisfy a checker by rephrasing or moving an assertion, widening a generic, adding a marker type, or replacing typed access with `Reflect`/property probes.
- New lint rules need a stated semantic invariant, must use type information when available, and start in a clean owner scope with no baseline. If a rule mainly rewards syntax changes or has an easy equivalent-expression bypass, do not add it.
- External boundaries: prefer `zod` or existing schema helpers.
- Runtime branching: discriminated unions/closed codes over freeform strings. Avoid semantic sentinels (`?? 0`, empty object/string).
- Cross-function state: when valid combos matter, return a closed mode/result shape. Avoid parallel nullable fields or derived booleans that callers must keep in sync; make impossible states unrepresentable.
- Keep expressions readable within the existing formatter settings. Extract helpers only when they clarify actual domain logic, not to optimize line wrapping.
- Keep complex decisions readable; ordinary expressions in arguments do not require extra variables or helpers.
- Prefer clear control flow; do not create separate processing stages unless the logic needs them.
- Use named intermediates only for domain meaning or readability; avoid temp-variable soup.
- Correct but not over-engineered: correctness on real inputs/states is mandatory; layers, guards, and generality for imagined ones are defects. Extremely unlikely edge cases are tradable for real simplification — name the accepted tradeoff (comment or PR) so it is a decision, not an oversight.
- New helpers/files must pay rent immediately — fewer call paths, fewer concepts, or less repeated logic — and only after checking existing code cannot absorb the behavior with less surface. No helpers for one-off compat, naming translation, or speculative resilience.
- Keep APIs narrow: export only current caller needs; keep types/helpers local by default; return the smallest useful shape — no broad result objects, flags, or metadata callers don't use.
- Avoid adapter layers that only rename fields. Move real responsibility or leave code local.
- Inline simple one-use objects/spreads when clearer. Extract only when it removes duplication or hard logic.
- Review tests before landing for duplication and value; tests protect canonical behavior and migration boundaries, not obsolete internals — delete tests for just-removed behavior/fallback paths instead of updating them.
- Reuse existing narrow helpers where appropriate; repeated code alone does not require a new abstraction.
- Prefer ctor parameter properties for injected deps/config. Do not ban them for erasable-syntax purity.
- Prefer `satisfies` for registries/config maps; derive types from schemas when a runtime schema already exists.
- Table-drive repetitive tests when it reduces code and keeps failure names clear.
- When changing module/loading boundaries, avoid static+dynamic imports for the same production module; use `*.runtime.ts` lazy boundaries. Run `pnpm build` on the production server and check `[INEFFECTIVE_DYNAMIC_IMPORT]`.
- Cycles: keep `pnpm check:import-cycles` + architecture/madge green.
- Classes: no prototype mixins/mutations. Prefer inheritance/composition. Tests prefer per-instance stubs.
- SwiftUI: Observation (`@Observable`, `@Bindable`) over new `ObservableObject`.
- Provider tool schemas: prefer flat string enum helpers over `Type.Union([Type.Literal(...)])`; some providers reject `anyOf`.
- Split files only when required for the change or a concrete maintainability problem; size alone is not a reason.
- File-length findings are advisory. Do not split files, trim coverage or add suppressions solely to meet a numeric line cap; fix a concrete maintainability problem within the task when one exists. Existing suppressions need no unrelated cleanup.
- Naming: **OpenClaw** product/docs; `openclaw` CLI/package/path/config.
- Agents navigate by grep: exported symbols use 2-3 word unique names; no generic single-word exports (`get`, `run`, `create`, `handle`).
- New modules/dirs concept-named; no new `utils/`, `helpers/`, `common/`. One spelling per concept repo-wide.
- English: American spelling.
