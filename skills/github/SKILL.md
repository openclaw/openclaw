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

For GitHub Projects V2 and other features only available via GraphQL, use `gh api graphql`.

### Schema Introspection

If you encounter an `undefinedField` error, introspect the schema to find the correct field/mutation names:

```bash
# List all mutations
gh api graphql -f query='{ __schema { mutationType { fields { name } } } }'

# Get details of a specific mutation
gh api graphql -f query='{ __type(name: "Mutation") { fields { name args { name } } } }'
```

### Common GraphQL Patterns

Query with variables:

```bash
gh api graphql -f query='query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }' -F owner=myorg -F repo=myrepo
```

Mutation with input:

```bash
gh api graphql -f query='mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { field { id } } }' -F input='{"fieldId": "...", "singleSelectOptions": [...]}'
```

### Troubleshooting GraphQL Errors

When you get an `undefinedField` error:

1. **Check available mutations**: `gh api graphql -f query='{ __schema { mutationType { fields { name } } } }'`
2. **Verify input types**: Use `__type(name: "InputTypeName")` to see required fields
3. **Use the correct field names**: GraphQL is case-sensitive and exact

Example - fixing a wrong mutation name:

```bash
# Wrong (will fail)
gh api graphql -f query='mutation { updateProjectV2SingleSelectField(...) { ... } }'

# Correct (use introspection to find actual mutation name)
gh api graphql -f query='mutation { updateProjectV2Field(...) { ... } }'
```

## JSON Output

Most commands support `--json` for structured output. You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
