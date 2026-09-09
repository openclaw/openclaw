---
doc-schema-version: 1
summary: "Index of the private QA stack: qa-lab, qa-channel, repo-backed scenarios, live transport lanes, transport adapters, and reporting."
read_when:
  - Understanding how the QA stack fits together
  - Extending qa-lab, qa-channel, or a transport adapter
  - Adding repo-backed QA scenarios
  - Building higher-realism QA automation around the Gateway dashboard
title: "QA overview"
---

The private QA stack exercises OpenClaw in a realistic, channel-shaped way that
a unit test cannot.

Pieces:

- `extensions/qa-channel`: synthetic message channel with DM, channel, thread,
  reaction, edit, and delete surfaces.
- `extensions/qa-lab`: debugger UI, QA bus, scenario runners, and live
  transport adapters for observing the transcript, injecting inbound messages,
  and exporting a Markdown report.
- `qa/`: repo-backed seed assets for the kickoff task and baseline QA
  scenarios.
- [Mantis](/concepts/mantis): before/after live verification for bugs that
  need real transports, browser screenshots, VM state, and PR evidence.

This page is an index. The QA stack is documented on eight pages, one per
reader job. Open the page that matches your task.

| Page                                                                                | Read it when                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Command surface](/concepts/qa-e2e-automation/command-surface)                      | You need the right `qa` subcommand or a profile-backed `qa run` selector.                                                                                                 |
| [Operator flow](/concepts/qa-e2e-automation/operator-flow)                          | You are bringing up QA Lab and running a lane: observability smokes, the Matrix live lane, Discord Mantis, the Slack desktop runner, or the credential-pool health check. |
| [Canonical scenario coverage](/concepts/qa-e2e-automation/scenario-coverage)        | You are choosing what a run covers, or you need the Multipass suite lane.                                                                                                 |
| [Channel QA reference](/concepts/qa-e2e-automation/channel-qa-reference)            | You are running the Buzz, Telegram, or Discord lane, or you need the flags every real-transport lane accepts.                                                             |
| [Slack QA](/concepts/qa-e2e-automation/slack-qa)                                    | You are running the Slack lane or provisioning its workspace, app, and scopes.                                                                                            |
| [WhatsApp QA and credentials](/concepts/qa-e2e-automation/whatsapp-and-credentials) | You are running the WhatsApp lane or leasing credentials from the Convex pool.                                                                                            |
| [Extending the QA stack](/concepts/qa-e2e-automation/extending-the-stack)           | You are adding seed assets, a provider mock lane, a transport adapter, or a channel.                                                                                      |
| [QA reporting](/concepts/qa-e2e-automation/qa-reporting)                            | You are reading a QA report, an evidence file, or a character-eval judged report.                                                                                         |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/concepts/qa-e2e-automation#matrix-live-lane`
still resolves. Each entry points at the page that now holds the content.

- <a id="command-surface" />[Command surface](/concepts/qa-e2e-automation/command-surface#command-surface)
- <a id="profile-backed-qa-run" />[Profile-backed `qa run`](/concepts/qa-e2e-automation/command-surface#profile-backed-qa-run)
- <a id="operator-flow" />[Operator flow](/concepts/qa-e2e-automation/operator-flow#operator-flow)
- <a id="observability-smokes" />[Observability smokes](/concepts/qa-e2e-automation/operator-flow#observability-smokes)
- <a id="matrix-live-lane" />[Matrix live lane](/concepts/qa-e2e-automation/operator-flow#matrix-live-lane)
- <a id="discord-mantis-scenarios" />[Discord Mantis scenarios](/concepts/qa-e2e-automation/operator-flow#discord-mantis-scenarios)
- <a id="mantis-slack-desktop-and-visual-task-runners" />[Mantis Slack desktop and visual-task runners](/concepts/qa-e2e-automation/operator-flow#mantis-slack-desktop-and-visual-task-runners)
- <a id="credential-pool-health-check" />[Credential pool health check](/concepts/qa-e2e-automation/operator-flow#credential-pool-health-check)
- <a id="canonical-scenario-coverage" />[Canonical scenario coverage](/concepts/qa-e2e-automation/scenario-coverage#canonical-scenario-coverage)
- <a id="buzz%2C-discord%2C-slack%2C-telegram%2C-and-whatsapp-qa-reference" /><a id="buzz-discord-slack-telegram-and-whatsapp-qa-reference" />[Buzz, Discord, Slack, Telegram, and WhatsApp QA reference](/concepts/qa-e2e-automation/channel-qa-reference#buzz-discord-slack-telegram-and-whatsapp-qa-reference)
- <a id="shared-cli-flags" />[Shared CLI flags](/concepts/qa-e2e-automation/channel-qa-reference#shared-cli-flags)
- <a id="buzz-qa" />[Buzz QA](/concepts/qa-e2e-automation/channel-qa-reference#buzz-qa)
- <a id="telegram-qa" />[Telegram QA](/concepts/qa-e2e-automation/channel-qa-reference#telegram-qa)
- <a id="discord-qa" />[Discord QA](/concepts/qa-e2e-automation/channel-qa-reference#discord-qa)
- <a id="slack-qa" />[Slack QA](/concepts/qa-e2e-automation/slack-qa#slack-qa)
- <a id="setting-up-the-slack-workspace" />[Setting up the Slack workspace](/concepts/qa-e2e-automation/slack-qa#setting-up-the-slack-workspace)
- <a id="whatsapp-qa" />[WhatsApp QA](/concepts/qa-e2e-automation/whatsapp-and-credentials#whatsapp-qa)
- <a id="convex-credential-pool" />[Convex credential pool](/concepts/qa-e2e-automation/whatsapp-and-credentials#convex-credential-pool)
- <a id="repo-backed-seeds" />[Repo-backed seeds](/concepts/qa-e2e-automation/extending-the-stack#repo-backed-seeds)
- <a id="provider-mock-lanes" />[Provider mock lanes](/concepts/qa-e2e-automation/extending-the-stack#provider-mock-lanes)
- <a id="transport-adapters" />[Transport adapters](/concepts/qa-e2e-automation/extending-the-stack#transport-adapters)
- <a id="adding-a-channel" />[Adding a channel](/concepts/qa-e2e-automation/extending-the-stack#adding-a-channel)
- <a id="scenario-helper-names" />[Scenario helper names](/concepts/qa-e2e-automation/extending-the-stack#scenario-helper-names)
- <a id="reporting" />[Reporting](/concepts/qa-e2e-automation/qa-reporting#reporting)

### Portable confidence evidence

Use `qa confidence-export` to capture a confidence manifest and every lane input
in one evidence bundle. Use `qa confidence-replay` to verify that bundle against
a separately received SHA-256 digest and rerun the existing classification
without the original artifact directory, provider credentials, or a live harness.
Replay does not execute commands from the artifacts.

For example, given an artifact directory containing `profile.json`:

```json
{
  "version": 1,
  "profile": "portable-check",
  "lanes": [
    {
      "id": "checks",
      "title": "Deterministic checks",
      "kind": "generic-pass-summary",
      "artifact": "checks.json",
      "required": true,
      "failureVerdict": "product-bug"
    }
  ]
}
```

With `checks.json` containing `{"pass":true}`, export the inputs:

```bash
pnpm openclaw qa confidence-export \
  --artifact-root ./proof-inputs \
  --manifest profile.json \
  --strict-global-pass \
  --output ./confidence-bundle.json
```

The command prints the output path, artifact count, and `sha256`. Share the
digest through a trusted channel separately from the bundle. The recipient runs:

```bash
pnpm openclaw qa confidence-replay \
  --bundle ./confidence-bundle.json \
  --expected-sha256 <digest-from-export>
```

Replay prints JSON with separate `integrity` and `report` fields. A valid bundle
can still produce a failing confidence report; the command exits with status 1
when `report.pass` is false. `--strict-global-pass` and `--strict-zero-unknowns`
are captured at export and cannot be changed at replay. Without strict flags,
the existing confidence-report semantics still allow classified failures, so
use `--strict-global-pass` when every required lane must pass.

The bundle preserves exact input bytes, the manifest, export time, and missing
artifact entries. Replay uses portable artifact paths and the captured time;
repeated replay with the same OpenClaw build produces the same report. Different
OpenClaw versions may classify the same evidence differently. An omitted lane
entry is rejected rather than treated as missing. Invalid artifact JSON remains
an unknown lane instead of becoming a pass.

Export paths must be portable paths relative to `--artifact-root`, with no
absolute paths, `..`, symlink components, or hard-linked files. Export captures
only the declared files; it does not recursively include logs or follow artifact
references inside a summary. The format allows at most 256 entries, including
the manifest and replay descriptor, 8 MiB per file, 16 MiB of decoded content,
and 24 MiB of serialized input. The output file is created with owner-only
permissions where supported and never overwrites an existing file.

Stop artifact producers before exporting: individual files are guarded reads,
not an atomic snapshot of a running suite. Review selected inputs before sharing;
the bundle preserves their contents and does not automatically redact secrets.
Re-export after redaction and share the new digest.

**Integrity is not attestation.** Matching a trusted digest proves which bytes
were received, not who produced them, whether a producer told the truth, or
whether candidate code was independently tested. A digest received only alongside
an untrusted bundle does not establish authenticity. Replay neither reruns model
work nor changes Workboard completion state.

## Related docs

- [Maturity scorecard](/maturity/scorecard)
- [Personal agent benchmark pack](/concepts/personal-agent-benchmark-pack)
- [QA Channel](/channels/qa-channel)
- [Testing](/help/testing)
- [Dashboard](/web/dashboard)
