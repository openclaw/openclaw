## Unreleased

### Fixes

- OpenAI-compatible embeddings now reject an operator role that cannot use the selected agent before calling the embedding provider, including when an agent-scoped session key selects the owner.
