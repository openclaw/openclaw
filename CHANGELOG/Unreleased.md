## Unreleased

### Fixes

- Developer checks: serialize package-boundary compilers within the shared memory budget, reject crashed negative canaries, and retain canary inputs until compiler cleanup is verified.

- Developer checks: contain SDK declaration compilers within the shared host memory budget, serialize their batches, and join cancellation through artifact release before publishing lint or compiler completion.

- Developer checks: contain compiler graph discovery within the shared host memory budget, preserve cancellation while waiting or between queries, and refuse unbounded execution on unsupported local hosts.

- Codex: restore background memory narratives and isolated text completions on agent-scoped local runtimes with administrator-managed hooks, preserving managed hooks and existing native-account/proxy routing while keeping ordinary hooks and model tools isolated. (#151658)
- Sandboxes: honor each registered runtime owner's pruning policy so a stricter agent cannot evict another agent's containers or browser bridges.

### Changes

- Messaging: allow cross-provider sends and other guarded message actions by default, including WebChat-to-Discord notifications. Existing configurations that omit `tools.message.crossContext.allowAcrossProviders` adopt the new default on upgrade; explicit `false` remains enforced globally and per agent. Set `allowAcrossProviders: false` to retain provider isolation, or both it and `allowWithinProvider: false` to restrict guarded actions to the current bound conversation. See [security guidance](https://docs.openclaw.ai/gateway/security/tool-permissions#cross-provider-messaging). (#149875)
