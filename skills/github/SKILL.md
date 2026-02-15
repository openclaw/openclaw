---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "bins": ["gh"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
            {
              "id": "apt",
              "kind": "apt",
              "package": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (apt)",
            },
          ],
      },
  }
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

## Pull Requests

Check CI status on a PR:

```bash
gh pr checks 55 --repo owner/repo
```

List recent workflow runs:

```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:

```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:

```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get PR with specific fields:

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## GraphQL API

For GitHub Projects V2, Discussions, and other features not exposed via REST, use `gh api graphql`:

```bash
gh api graphql -f query='{ viewer { login } }'
```

### Schema Introspection

**Always introspect before using unfamiliar mutations.** Do not guess mutation names — they differ from training data (e.g., `updateProjectV2Field` not `updateProjectV2SingleSelectField`).

List available mutations matching a pattern:

```bash
gh api graphql -f query='{ __schema { mutationType { fields { name } } } }' \
  --jq '.data.__schema.mutationType.fields[].name | select(test("ProjectV2"))'
```

Get a mutation's input fields:

```bash
gh api graphql -f query='{ __type(name: "UpdateProjectV2FieldInput") { inputFields { name type { name ofType { name } } } } }'
```

### Projects V2 Example

Add a status option to a project field:

```bash
gh api graphql -f query='
  mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
    updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
      projectV2Field { ... on ProjectV2SingleSelectField { options { name } } }
    }
  }' -f fieldId="PVTSSF_..." -f options='[{"name":"Ready","color":"GREEN"}]'
```

### Error Recovery

If you get `undefinedField`, introspect the schema to find the correct name:

```bash
# Find mutations containing "Field"
gh api graphql -f query='{ __schema { mutationType { fields { name } } } }' \
  --jq '.data.__schema.mutationType.fields[].name | select(contains("Field"))'
```

## JSON Output

Most commands support `--json` for structured output. You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
