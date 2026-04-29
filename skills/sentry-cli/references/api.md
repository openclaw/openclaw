---
name: sentry-cli-api
version: 0.27.0
description: Make an authenticated API request
requires:
  bins: ["sentry"]
  auth: true
---

# API Commands

Make an authenticated API request

### `sentry api <endpoint>`

Make an authenticated API request

**Flags:**
- `-X, --method <value> - The HTTP method for the request - (default: "GET")`
- `-d, --data <value> - Inline JSON body for the request (like curl -d)`
- `-F, --field <value>... - Add a typed parameter (key=value, key[sub]=value, key[]=value)`
- `-f, --raw-field <value>... - Add a string parameter without JSON parsing`
- `-H, --header <value>... - Add a HTTP request header in key:value format`
- `--input <value> - The file to use as body for the HTTP request (use "-" to read from standard input)`
- `--silent - Do not print the response body`
- `--verbose - Include full HTTP request and response in the output`
- `-n, --dry-run - Show the resolved request without sending it`

**Examples:**

```bash
# List organizations
sentry api organizations/

# Get a specific issue
sentry api issues/123456789/

# Create a release
sentry api organizations/my-org/releases/ \
  -X POST -F version=1.0.0

# With inline JSON body
sentry api issues/123456789/ \
  -X POST -d '{"status": "resolved"}'

# Update an issue status
sentry api issues/123456789/ \
  -X PUT -F status=resolved

# Assign an issue
sentry api issues/123456789/ \
  -X PUT --field assignedTo="user@example.com"

sentry api projects/my-org/my-project/ -X DELETE

# Add custom headers
sentry api organizations/ -H "X-Custom: value"

# Read body from a file
sentry api projects/my-org/my-project/releases/ -X POST --input release.json

# Verbose mode (shows full HTTP request/response)
sentry api organizations/ --verbose

# Preview the request without sending
sentry api organizations/ --dry-run
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
