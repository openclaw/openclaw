# Catalog watch investigation

Synthetic reproduction for #165686. These diagnostic scripts do not change Gateway behavior or claim that the incident is fixed.

Use Node 24 from a prepared OpenClaw source checkout. Prepare the Gateway with `node scripts/worktree-setup.mjs gateway`, then run:

```sh
node scripts/diagnostics/catalog-watch-probe/fs-safe-churn.mjs
node scripts/diagnostics/catalog-watch-probe/gateway-churn.mjs /path/to/new-results-directory
```

The fs-safe probe selects two entries and a missing Skills tree. It measures 30 seconds idle, 60 seconds of unrelated session appends at 20 Hz, a 1,000-file burst, and a selected-file positive control. Native observation must be available. Writer work runs in a separate process; CPU and event-loop measurements describe the observer.

The Gateway probe uses an isolated, unauthenticated Codex home, enables the Codex and OpenAI plugins, and never requests a model turn. It waits up to 15 minutes for readiness, explicitly refreshes the full catalog through `models.list`, then measures quiet and busy-home phases and edits a selected skill. The preload records fs-safe scopes, health transitions, invalidation reasons/details, worker starts/exits, CPU, RSS and event-loop utilization. CPU is process-wide: use the Gateway main-isolate samples and never sum worker samples. Worker exits are not necessarily catalog rebuilds; correlate them with phases and logs. SIGINT and SIGTERM cancel the workload and join process-tree cleanup.

Output contains only fixture state, but inspect logs before sharing. This does not reproduce Telegram traffic, authenticated discovery, existing SQLite state, the reporter's skill inventory, or the Windows scheduled-task installation. Cross-OS conclusions must identify the actual operating systems, source revision, dependency versions and machine sizes.
