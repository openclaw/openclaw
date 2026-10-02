# GitHub Copilot

Use models available to your GitHub Copilot account in OpenClaw. This plugin
provides account login, model discovery, and embeddings. Model access depends on
your Copilot plan and organization policy.

## Get started

Sign in with GitHub's device flow:

```bash
openclaw models auth login-github-copilot
```

Then browse models with `openclaw models list --provider github-copilot` and
select one for your agent. Enterprise accounts can use the dedicated Enterprise
login option.

This is the model provider; the separate Copilot SDK harness plugin runs native
Copilot agent sessions. See the [GitHub Copilot guide](https://docs.openclaw.ai/providers/github-copilot)
for both options and account requirements.
