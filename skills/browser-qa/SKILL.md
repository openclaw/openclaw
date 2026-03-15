---
name: browser-qa
description: Structured browser QA for UI verification. Use when a change touches web UI, navigation, forms, layout, visual state, or browser-observable behavior and you need evidence-based VERIFY output.
homepage: https://docs.openclaw.ai/tools/browser
metadata:
  {
    "openclaw":
      {
        "emoji": "🧪",
        "requires": { "bins": ["openclaw"] },
      },
  }
---

# Browser QA

Use this skill during **VERIFY** whenever work changes a browser-visible surface.

This skill exists to make QA evidence-first and repeatable. Prefer OpenClaw's
managed browser before inventing a new browser workflow.

## Primary tools

- `openclaw browser` — managed browser runtime for live checks
- project-local Playwright — smoke/regression checks when the repo already has it

## When to use it

Use `browser-qa` when the task changes:

- pages, routes, or navigation
- forms, modals, drawers, or menus
- layout, spacing, or responsive behavior
- visual state after mutations
- console/network-visible browser behavior
- deployment verification on a live/staging URL

Do **not** use this skill as a substitute for backend/unit testing when no
browser-visible behavior changed.

## VERIFY workflow

### 1. Choose the QA depth

- **Visual check only** — layout/style copy changes, quick sanity checks
- **Playwright smoke only** — existing deterministic flow/spec already covers the change
- **Both** — meaningful UI changes, regressions, or anything user-facing and risky

### 2. Managed browser check

Start from OpenClaw's isolated browser profile unless the task specifically
needs an attached system browser tab.

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open <URL>
openclaw browser --browser-profile openclaw snapshot --interactive --compact --depth 6
openclaw browser --browser-profile openclaw screenshot
```

Useful follow-ups:

```bash
openclaw browser --browser-profile openclaw console
openclaw browser --browser-profile openclaw network
openclaw browser --browser-profile openclaw click <ref>
openclaw browser --browser-profile openclaw type <ref> "value"
openclaw browser --browser-profile openclaw highlight <ref>
```

Guidance:

- Re-run `snapshot` after navigation or major DOM changes; refs are not stable.
- Prefer `--interactive` snapshots for action refs.
- Use screenshots when the claim is visual.
- Use console/network output when the claim involves runtime errors or failed requests.

### 3. Playwright smoke run

If the project already has Playwright, use the smallest relevant spec set.

```bash
cd <project-root>
npx playwright test e2e/<relevant-spec>.spec.ts
```

If you do not know the relevant spec yet:

1. look for `playwright.config.*`
2. inspect `e2e/` or equivalent test folders
3. choose the narrowest spec that exercises the changed surface

Do **not** create a large new browser test suite during VERIFY unless the user
asked for test authoring as part of the task.

Project-specific runner note:

- Not every repo uses `npx playwright test` directly. Check `package.json`, project scripts, or local docs for the canonical browser test command before running a generic Playwright command.
- Prefer the repo's existing wrapper (`bun`, `npm`, `pnpm`, or a custom script`) when one exists.

### 4. Evidence report

Always publish browser QA as evidence, not vibes.

```markdown
## Browser QA Evidence
- **Surface checked:** <page / route / flow / component>
- **Method:** managed browser | playwright | both
- **Commands run:** <exact commands>
- **Evidence reviewed:** snapshot refs, screenshots, console logs, network logs, test output
- **Observed result:** <what actually happened>
- **Mismatch vs expected:** none | <exact gap>
- **Artifacts:** <screenshot path, trace, test output, or none>
- **Next owner / next step:** <who acts next or "none">
```

Never say "looks good" without naming the surface and evidence.

## Patterns

### Quick local UI sanity check

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open http://127.0.0.1:3000
openclaw browser --browser-profile openclaw snapshot --interactive --compact --depth 6
openclaw browser --browser-profile openclaw screenshot
```

### Live/staging verification

```bash
openclaw browser --browser-profile openclaw open https://staging.example.com
openclaw browser --browser-profile openclaw snapshot --interactive --compact --depth 6
openclaw browser --browser-profile openclaw screenshot
openclaw browser --browser-profile openclaw console
openclaw browser --browser-profile openclaw network
```

### Existing Playwright flow

```bash
cd <project-root>
npx playwright test e2e/<relevant-spec>.spec.ts
```

### Mixed verification

```bash
openclaw browser --browser-profile openclaw open http://127.0.0.1:3000
openclaw browser --browser-profile openclaw snapshot --interactive --compact --depth 6
openclaw browser --browser-profile openclaw screenshot
cd <project-root>
npx playwright test e2e/<relevant-spec>.spec.ts
```

## Notes

- Prefer the managed `openclaw` browser profile for isolated, agent-safe checks.
- Use project Playwright config rather than ad-hoc browser scripts when it already exists.
- Keep the QA step proportional: smallest evidence that proves the change is correct.
