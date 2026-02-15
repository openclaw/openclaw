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

Use `gh api graphql` for GitHub's GraphQL API (required for Projects V2, Discussions, etc.):

Query example:
```bash
gh api graphql -f query='query { viewer { login } }'
```

Mutation example:
```bash
gh api graphql -f query='mutation($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }' -f input='{"projectId":"...","contentId":"..."}'
```

### Schema Introspection

When unsure about field or mutation names, introspect the schema first:

```bash
# List available fields on a type
gh api graphql -f query='{ __type(name: "Mutation") { fields { name description } } }' --jq '.data.__type.fields[] | "\(.name): \(.description)"' | grep -i project

# Get input fields for a mutation
gh api graphql -f query='{ __type(name: "UpdateProjectV2FieldInput") { inputFields { name type { name } } } }'
```

Always introspect before using unfamiliar mutations — do not guess mutation or field names.

## JSON Output

Most commands support `--json` for structured output. You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
