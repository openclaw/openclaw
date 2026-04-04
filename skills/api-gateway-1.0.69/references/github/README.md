# GitHub Routing Reference

**App name:** `github`
**Base URL proxied:** `api.github.com`

## API Path Pattern

```
/github/{resource}
```

GitHub API does not use a version prefix in paths. Versioning is handled via the `X-GitHub-Api-Version` header.

## Common Endpoints

### Get Authenticated User

```bash
GET /github/user
```

### Get User by Username

```bash
GET /github/users/{username}
```

### List User Repositories

```bash
GET /github/user/repos?per_page=30&sort=updated
```

### Get Repository

```bash
GET /github/repos/{owner}/{repo}
```

### List Repository Contents

```bash
GET /github/repos/{owner}/{repo}/contents/{path}
```

### List Branches

```bash
GET /github/repos/{owner}/{repo}/branches
```

### List Commits

```bash
GET /github/repos/{owner}/{repo}/commits?per_page=30
```

### List Repository Issues

```bash
GET /github/repos/{owner}/{repo}/issues?state=open&per_page=30
```

### Create Issue

```bash
POST /github/repos/{owner}/{repo}/issues
Content-Type: application/json

{
  "title": "Issue title",
  "body": "Issue description",
  "labels": ["bug"]
}
```

### List Pull Requests

```bash
GET /github/repos/{owner}/{repo}/pulls?state=open&per_page=30
```

### Create Pull Request

```bash
POST /github/repos/{owner}/{repo}/pulls
Content-Type: application/json

{
  "title": "PR title",
  "body": "PR description",
  "head": "feature-branch",
  "base": "main"
}
```

### Merge Pull Request

```bash
PUT /github/repos/{owner}/{repo}/pulls/{pull_number}/merge
Content-Type: application/json

{
  "merge_method": "squash"
}
```

### Search Repositories

```bash
GET /github/search/repositories?q={query}&per_page=30
```

### Search Issues

```bash
GET /github/search/issues?q={query}&per_page=30
```

### Get Rate Limit

```bash
GET /github/rate_limit
```

## Notes

- Repository names are case-insensitive but the API preserves case
- Issue numbers and PR numbers share the same sequence per repository
- File content must be Base64 encoded when creating/updating files
- Rate limits: 5000 requests/hour for authenticated users, 30 searches/minute
- Pagination uses `per_page` (max 100, default 30) and `page` parameters
- Some endpoints require specific OAuth scopes (e.g., `read:org` for organization operations)

## Resources

- [GitHub REST API Documentation](https://docs.github.com/en/rest)
- [Repositories API](https://docs.github.com/en/rest/repos/repos)
- [Issues API](https://docs.github.com/en/rest/issues/issues)
- [Pull Requests API](https://docs.github.com/en/rest/pulls/pulls)
