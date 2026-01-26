---
title: Developer guide
---

## Copilot SDK integration

When integrating GitHub Copilot, use the official `@github/copilot-sdk` package and avoid any other `@github/copilot*` packages. This keeps auditing simple and avoids divergent behavior.

Best practices:

- Centralize Copilot usage in a single module or provider.
- Keep secrets and access tokens in config, not source code.
- Add tests that cover Copilot entry points.

For enforcement details, see [Copilot SDK usage](/validation/copilot-usage).
