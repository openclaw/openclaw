# QuickJS Code Mode

Run Code Mode JavaScript in an isolated QuickJS WebAssembly guest. The plugin
supplies the `quickjs` executor for tool orchestration, including suspended
cells that resume through Code Mode's wait flow.

## Get started

Choose **QuickJS (isolated)** in the Code Mode executor setting, or set
`tools.codeMode.executor` to `quickjs`. Executor selection is separate from
activation; use `tools.codeMode.enabled` to choose automatic or explicit
activation.

The bundled executor activates when selected unless explicitly disabled or
denied. Guest isolation does not remove permissions from tools exposed through
the bridge; normal tool policy and approvals still apply. Suspended cells do
not survive Gateway restarts.

See [Code Mode executors](https://docs.openclaw.ai/tools/code-mode/executors) for
selection, execution limits, and security boundaries.
