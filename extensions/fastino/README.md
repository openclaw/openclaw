# Fastino GLiDE for OpenClaw

Native Boolean, Choice, and Score decisions through the separate Decision model
role. This plugin is a development-checkout candidate; its metadata does not
claim that an npm or ClawHub package has been published.

Use a matching OpenClaw checkout with the Decision V2 contract:

```sh
pnpm openclaw plugins install ./extensions/fastino
pnpm openclaw models auth login --provider fastino --method api-key
```

Enter the API key in the protected prompt, or provide `FASTINO_API_KEY` to the
Gateway process. Connecting credentials does not change model selection. Select
`fastino/fastino/GLiDE` in the Decision picker.

This initial adapter accepts text and JSON evidence, not image state or chat.
Decision evaluations send supplied evidence to the provider and incur its normal
usage charges. No live-provider proof has been performed for this candidate.

See the [Fastino GLiDE setup and API contract guide](https://docs.openclaw.ai/providers/fastino)
and [Decision model documentation](https://docs.openclaw.ai/concepts/decision-models)
for installation, limits, credential handling, and result semantics.
