# STATUS

Updated At: <ISO8601>
Owner: <name>

## Runtime

| Check               | Command                          | Result | Last Checked |
| ------------------- | -------------------------------- | ------ | ------------ | -------- |
| Gateway health      | `openclaw health`                | `<ok   | fail>`       | `<time>` |
| Browser service     | `openclaw browser status --json` | `<ok   | fail>`       | `<time>` |
| Model provider auth | `<provider-specific check>`      | `<ok   | fail>`       | `<time>` |
| Vector DB           | `<db health check>`              | `<ok   | fail>`       | `<time>` |
| Graph DB            | `<db health check>`              | `<ok   | fail>`       | `<time>` |

## Recent Error Signals

| Signal                          | Count (24h) | Threshold | Status |
| ------------------------------- | ----------: | --------: | ------ | ---- | ---------- |
| `FailoverError: 401`            |       `<n>` | `<limit>` | `<ok   | warn | critical>` |
| `tab not found`                 |       `<n>` | `<limit>` | `<ok   | warn | critical>` |
| `Unknown ref`                   |       `<n>` | `<limit>` | `<ok   | warn | critical>` |
| `read tool called without path` |       `<n>` | `<limit>` | `<ok   | warn | critical>` |

## Ingestion Quality Gates

| Pipeline              | Expected | Actual | Pass  |
| --------------------- | -------: | -----: | ----- | ---- |
| Source count          |    `<n>` |  `<n>` | `<yes | no>` |
| Parsed count          |    `<n>` |  `<n>` | `<yes | no>` |
| Embedded count        |    `<n>` |  `<n>` | `<yes | no>` |
| Retrieval smoke tests |    `<k>` |  `<k>` | `<yes | no>` |

## Notes

- <important operational notes>
