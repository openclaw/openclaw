---
title: Copilot SDK usage
---

Clawdbot integrations that use GitHub Copilot must rely on the official `@github/copilot-sdk` package. This keeps the integration consistent and simplifies maintenance.

## Requirements

- Use `@github/copilot-sdk` for all Copilot API integrations.
- Do not import or depend on other `@github/copilot*` packages.
- Keep Copilot usage in a dedicated module so usage can be audited easily.

## Automated enforcement

The repo ships a validation script that scans for non-SDK Copilot usage.

- Run `pnpm copilot:check` to validate the tree.
- The check runs in CI via the Vitest guard in the test suite.

## Current status

Clawdbot integrates with GitHub Copilot via the official `@github/copilot-sdk` package.

## Examples

Allowed:

```
import { createClient } from "@github/copilot-sdk";
```

Disallowed:

```
import { CopilotClient } from "@github/copilot";
```

For guidance on integrating Copilot, see the [Developer guide](/developer-guide).
