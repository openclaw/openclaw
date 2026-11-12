---
name: labs-graduation
description: "Move a feature out of Control UI Labs, either on by default or still off by default. Use when asked to promote, graduate or ship a Labs feature."
---

# Graduate a Labs feature

Graduation removes a feature's Labs switch and makes it a normal feature. Two separate decisions, made by the owner before any code:

1. **Leave Labs:** the feature gets a permanent home (its own settings or plugin page) and loses Labs wording.
2. **Default:** on by default, or still off by default.

They are independent. #197029 first tried both, then shipped only the first: Advisor left Labs but stayed off. Ask which one is wanted; do not assume "graduate" means "on by default".

Precedents: Swarm on by default (#136514), Tool Search on by default (#154068), native plugin UI on without a Labs opt-in (de50262a1f96), Labs features moved into Settings (#145460), Advisor out of Labs and still off (#197029).

## Before the PR

- **Measure cost or risk on the real route** if the feature costs money or tokens, or changes behavior for users who never opted in. Today's numbers from mocks or unit tests are not proof. #197074 merged a cache-cost claim from a mock that live providers disproved, and was reverted in #197175. Use the live measurement the feature's own PRs already established, and put the numbers in the PR body.
- **Settle known defects first.** Advisor's graduation waited for its fork cache fixes (#197203, #197223, #197224, #197226) because default-on would have charged every user the uncached cost.
- **Find the enable path that remains.** After the Labs row goes, users must still be able to turn the feature on from the UI. A bundled plugin uses **Settings → Plugins → <name> → Enable**; a core feature needs its settings page. Add a switch only if none exists.

## The change

1. **Default.** Change it only if the owner chose on by default: a bundled plugin's `enabledByDefault` in `openclaw.plugin.json`, or the core config default. An existing explicit `false` (or the feature's opt-out value) must keep working, and an existing `true` must stay on. Never add a migration that rewrites saved config to change someone's choice.
2. **Labs.** Remove the entry from `ui/src/pages/labs/labs-registry.ts` and everything only it used: `labs-page.tsx` rows or slots, `labs-feature-state.ts` entries, strings and tests.
3. **Docs.** Move the feature's section out of `docs/concepts/experimental-features.md` into its own reference page. Leave a one-paragraph note there with the old anchor, saying it graduated, its default, and where to turn it on. Update the "Labs includes ..." list and the "Currently documented flags" table.
4. **Wording.** Remove "Experimental" and "OpenClaw Labs" from the manifest description, package description, README, plugin summary, and any user- or model-facing text such as prompt prefixes.
5. **Generated files.** Regenerate, never hand-merge: `pnpm config:docs:gen`, `pnpm plugins:inventory:gen`. Control UI locale artifacts (`*.meta.json`, `*.tm.jsonl`, `catalog-fallbacks.json`) stay out of the PR per `ui/AGENTS.md`; the locale refresh workflow updates them. `pnpm ui:i18n:verify` must pass.
6. **Upgrade proof.** Only for a default change: prove across a real upgrade that no saved entry gets the new default, an explicit off stays off, and an explicit on stays on. A default that stays the same needs no upgrade case; #197029 dropped the one it had built for default-on.

## Proof in the PR

- Control UI screenshots, inspected for private data before upload: Labs before and after, and the enable path working on a real Gateway. Attach them with `gh pr comment <n> --attach '<file>#<alt text>'`.
- The enable path tested end to end: the switch saves the expected config and takes effect without a restart.
- The feature's tests and the Labs page tests pass; the test-lines ratchet does not grow.
- Docs claims match code. ClawSweeper caught Advisor's "at most one review per `everyMinutes`", which was false with `everyToolCalls` on.

## After merge

The new location only appears in builds that include the merge. Tell users the exact path, and that older builds still show the Labs switch.
