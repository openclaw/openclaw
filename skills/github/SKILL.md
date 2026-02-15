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

For advanced operations like GitHub Projects V2, use `gh api graphql`:

```bash
gh api graphql -f query='
  query {
    repository(owner: "owner", name: "repo") {
      projectsV2(first: 5) {
        nodes { id title }
      }
    }
  }
'
```

When a mutation name is unknown, introspect the schema first:

```bash
gh api graphql -f query='{ __type(name: "Mutation") { fields { name description } } }' --jq '.data.__type.fields[] | select(.name | test("project"; "i")) | "\(.name): \(.description)"'
```

Pass variables with `-F`:

```bash
gh api graphql -f query='
  mutation($projectId: ID!, $title: String!) {
    addProjectV2DraftIssue(input: {projectId: $projectId, title: $title}) {
      projectItem { id }
    }
  }
' -F projectId="PVT_xxx" -F title="New item"
```

## JSON Output

Most commands support `--json` for structured output. You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
