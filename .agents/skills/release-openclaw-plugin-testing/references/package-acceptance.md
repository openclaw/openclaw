# Package Acceptance proof

## Package Acceptance Plan

Full Release Validation owns final candidate qualification with admitted Q
(default Q=C, or an explicit reviewed exact Q) and the
exact publication tarballs. Use standalone Package Acceptance for diagnostics
or postpublish confidence, not as a replacement candidate qualification:

```bash
gh workflow run package-acceptance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f workflow_ref=main \
  -f source=ref \
  -f package_ref=<branch-or-sha> \
  -f suite_profile=custom \
  -f docker_lanes='plugins-offline plugin-update doctor-switch update-channel-switch config-reload mcp-channels npm-onboard-channel-agent' \
  -f telegram_mode=mock-openai
```

Use `source=npm -f package_spec=openclaw@beta` for published beta proof. These
standalone diagnostic/confidence runs may use trusted current harness code;
candidate qualification must retain its exact admitted Q instead, without
changing C's source, package bytes, version, or baselines.

For extended-stable shared publication, require complete exact-target Full
Release Validation from the admitted `release-ci/*` harness at the exact Q,
with trusted P admission and publication tooling separate. Direct
canonical-branch or `main` producers do not satisfy the protected publisher.
Package Acceptance is a post-publish selector smoke:

```bash
gh workflow run package-acceptance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@extended-stable \
  -f suite_profile=package \
  -f telegram_mode=mock-openai
```

Record the resolved version. Still verify every package and selector in the
tag's `all-publishable` inventory; one smoke is not registry readback.
