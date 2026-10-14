# Finishing the migration

Done means **zero Lit outside third-party bundles**: no `lit`/`@lit/*` imports, `html`/`svg`/`css` templates, `@state`/`@property`, `requestUpdate`, `@lit/task`, `ReactiveController`, Lit custom-element registrations, `wa-*` tags, or Lit-importing tests. The only exception is the upstream A2UI Lit catalog inside the sandboxed Canvas bundle. Track it with:

```bash
pnpm ui:solid:inventory --json
```

The Lit ratchet blocks only new production files under `ui/src` that import Lit. Tests and recognized moves or splits of existing Lit code are exempt; metric totals and per-file growth, including TODO counts, remain advisory. Use `defineSolidBridge` from `ui/src/lit/solid-bridge.ts` to mount Solid components from remaining Lit callers.

## How a port lands

- One focused PR per area, branched from `main` and landed on `main`. The app works at every commit.
- Port a component together with its tests. Delete the Lit class in the same PR, and route remaining Lit callers through the bridge.
- Keep host tags, classes, routes, and E2E selectors. Keep the quantitative gates green.
- If something you need is still in flight in another lane, port what doesn't need it, poll `origin/main`, and merge `main` when it lands. Never merge an unlanded branch.
- Proof: touched tests, `tsgo`, lint, `pnpm ui:parity` or inspected screenshots, WebKit for overlay/focus code, and the inventory shrinking. Run `$autoreview`, then land through `scripts/pr` (the `gh` shim blocks direct `gh pr merge`).

## Order of the endgame

1. Every page, chat component, and shared component ported, with Lit callers on the bridge.
2. The Web Awesome exit: every `wa-*` usage replaced by owned primitives; then remove the package, its patch, the theme import, the `--wa-*` token bridges, `wa-light`/`wa-dark`, and the PostCSS workaround. Re-home the five implicit theme values (font weights 400/500, the 75 ms fast transition, the 0.1875rem focus ring and its 0.0625rem offset).
3. The final Lit sweep:
   - delete `ui/src/lit/` (light-DOM bases, controllers, the bridge)
   - delete `i18n/lib/lit-controller.ts`, the `@lit/context` token in `app/context.ts`, and the Lit warnings test setup
   - remove `lit`, `@lit/*`, and `@lit-labs/*` from every manifest and the lockfile
   - delete Lit-only lint and stylelint configuration (postcss-lit) and the Lit ratchet itself
   - update `ui/AGENTS.md` to drop the Lit-specific guidance
4. Inventory at zero; the full UI suites, E2E (Chromium and WebKit), parity gallery, and startup budget green.

## Codemod

`scripts/codemods/lit-to-solid.mts` (once landed) converts mechanical bindings and leaves `TODO(solid2): <reason>` markers for ownership decisions. Resolve every marker before you land. It never converts `keyed`, `live`, `guard`, `cache`, custom directives, unsafe HTML, controller lifetimes, or cancellation.
