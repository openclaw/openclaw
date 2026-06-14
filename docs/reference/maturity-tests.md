---
summary: "How OpenClaw maps the maturity scorecard to QA coverage and evidence."
read_when:
  - Reading QA scorecard coverage
  - Adding coverage IDs to QA scenarios
  - Finding evidence for a maturity category
title: "Maturity tests"
---

Maturity tests are QA evidence linked to the OpenClaw maturity scorecard. They help maintainers see which scorecard categories already have runnable proof and which ones still need coverage.

The scorecard has two source files:

- `taxonomy.yaml` defines surfaces, categories, maturity levels, profile membership, and feature coverage IDs.
- `docs/maturity-scores.yaml` records the current score snapshot and LTS status.

QA scenarios connect to the scorecard by using the same coverage IDs:

- `qa/scenarios/**/*.md` stores `coverage.primary` and `coverage.secondary` IDs.
- `extensions/qa-lab` joins scenario coverage to the taxonomy report.
- `qa suite` writes `qa-evidence.json` for the scenarios it runs.

## Find Coverage

Start with the coverage inventory when a requirement needs a runnable mapping:

```bash
pnpm openclaw qa coverage --match <surface-or-coverage-id>
pnpm openclaw qa coverage --json --match <surface-or-coverage-id>
```

The report includes a **Scorecard Taxonomy** section, profile membership, mapped coverage IDs, evidence refs, and matching `qa suite --scenario ...` commands.

## Add Coverage

When a category needs new evidence:

1. Start from the matching `taxonomy.yaml` surface and category.
2. Reuse an existing feature `coverageIds` value, or add a broad behavior-shaped ID.
3. Add that ID to `coverage.primary` in the scenario that proves it.
4. Use `coverage.secondary` only for supporting evidence.
5. Add useful `docsRefs` and `codeRefs` to the scenario.
6. Run `pnpm openclaw qa coverage --match <coverage-id>` and then run the smallest relevant scenario or test lane.

## Related docs

- [QA overview](/concepts/qa-e2e-automation)
- [Testing](/help/testing)
- [Matrix QA](/concepts/qa-matrix)
