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

Use the `gh` CLI to interact with GitHub. For commands like `gh issue`, `gh pr`, and `gh run`, always specify `--repo owner/repo` when not in a git directory. For `gh api`, include the owner/repo in the URL path or query body.

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

The `gh api` command supports both REST and GraphQL. Use it for anything not available through other `gh` subcommands.

REST example:

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

GraphQL example:

```bash
gh api graphql -f query='query { organization(login: "owner") { projectsV2(first: 10) { nodes { id title } } } }'
```

When a `gh` subcommand doesn't support what you need (e.g. `gh project` can't modify field options), use `gh api graphql` with the appropriate mutation. **Do not guess mutation or field names** — introspect the schema first:

```bash
gh api graphql -f query='{ __schema { mutationType { fields { name } } } }' --jq '.data.__schema.mutationType.fields[].name' | grep -i project
```

Then inspect the input type for the mutation you need:

```bash
gh api graphql -f query='{ __type(name: "UpdateProjectV2FieldInput") { inputFields { name type { name kind ofType { name } } } } }'
```

If a GraphQL call returns an `undefinedField` error, use the introspection queries above to find the correct mutation and field names.

## JSON Output

Most commands support `--json` for structured output. You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
