# Skill Creator Protocol

## Trigger

Use this protocol when either condition is true:

- Novel domain where no existing skill provides reliable coverage.
- Repeated task pattern appears >= 3 times with inconsistent quality.

## Protocol

1. Scope

- Define the exact outcome, constraints, and quality metric.

2. Contract

- Inputs: required data and context boundaries.
- Outputs: exact artifact format and acceptance criteria.
- Guardrails: forbidden actions and safety boundaries.

3. Workflow

- Build minimal viable skill first.
- Add references/scripts only if they improve reliability.
- Add deterministic test checks where possible.

4. Promotion

- Run quality gates.
- Review diff.
- Promote only after explicit user approval.

5. Continuous improvement

- Track failure classes.
- Apply one targeted improvement per cycle.
