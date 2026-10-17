---
summary: "Use Cloudflare Clef, Clef Flash, and Clef Omni for typed text and image decisions through the host CLI"
title: "Cloudflare Clef"
read_when:
  - Selecting a Cloudflare decision model
  - Using an existing Cloudflare CLI login for decisions
  - Evaluating image evidence with Clef Omni
---

# Cloudflare Clef

The `cloudflare-clef` plugin connects the Decision role to Cloudflare Workers AI
through the Gateway host's `cf` CLI. It uses the CLI's existing login and token
refresh; OpenClaw does not read, copy, or store its OAuth tokens.

This source-checkout plugin is an unpublished candidate. It needs a host with the
prepared V2 Decision provider API. No chat model, image-generation provider, or
Cloudflare management tools are registered.

The package is private and npm/ClawHub publication is disabled until a released
host with the required V2 exports has been verified. OpenClaw `2026.10.4` does
not export that API; it is not a supported installation target for this candidate.
Official repository ownership and publication remain a maintainer decision.

## Setup

Install the Cloudflare CLI separately. This transport was tested with
`cf` **1.0.0-beta.12**; it is not Wrangler. Run these commands as the same OS user
that runs the Gateway:

```bash
cf auth login
cf auth whoami
openclaw plugins install --link ./extensions/cloudflare-clef
```

Merge the following into the existing configuration. Replace the executable path
with the output of `command -v cf` on your host. For multiple accounts, set the
optional `accountId`; `profile` optionally selects a CLI authentication profile.

```json5
{
  plugins: {
    entries: {
      "cloudflare-clef": {
        enabled: true,
        config: { binaryPath: "/absolute/path/to/cf" },
      },
    },
  },
  agents: {
    defaults: { decisionModel: "cloudflare-clef/clef" },
  },
}
```

Reload plugins through the Gateway's plugin management surface. Select a model
in the Control UI's **Decision** picker; do not replace the primary chat model.
Selection alone starts no evaluations and does not enable Decision assistance.
Hosted calls send only the supplied evidence and rubrics to Cloudflare and use
normal Workers AI billing, including image input tokens.

## Models and input

| Reference                    | Decision input supported by this plugin     |
| ---------------------------- | ------------------------------------------- |
| `cloudflare-clef/clef`       | Text, JSON, or one embedded image with text |
| `cloudflare-clef/clef-flash` | Text, JSON, or one embedded image with text |
| `cloudflare-clef/clef-omni`  | Text, JSON, or one embedded image with text |

All three routes support Boolean, Choice, and Score questions. The plugin keeps
provider probabilities, confidence, and fractional scores without thresholding,
normalizing, or recomputing them. Boolean questions map to Clef's `noul` wire type.

The core `decision_evaluate` tool currently accepts text and JSON state. Native
image input is available to plugin consumers through
`api.runtime.decisions.evaluateV2`:

```ts
const outcome = await api.runtime.decisions.evaluateV2(
  {
    state: {
      type: "image",
      dataUri: suppliedImageDataUri,
      text: "Evaluate the supplied image only.",
    },
    questions: {
      red: {
        type: "boolean",
        instructions: "Is the large square red?",
      },
    },
  },
  {
    agentId,
    purpose: "image.color-check",
    rubricVersion: "1",
    timeoutMs: 30000,
    signal,
  },
);
```

The selected Decision model, not the request, chooses which Clef route runs.
Image input must be an embedded PNG, JPEG, or WebP data URI, at most four MiB
decoded under the host's V2 image limit. The adapter neither reads local paths nor
fetches remote URLs. The host validates encoding and size; Cloudflare validates
the media contents and pixel limits.

**Audio/video are not exposed by this plugin.** Cloudflare's Clef Omni API
supports them, but the shared OpenClaw Decision content and catalog contracts
currently support only text/JSON, image, and list content. Multiple images,
audio/video, sort, tags, and explicit reasoning controls are not advertised or
encoded as hidden fields in JSON state. They need a separate shared-contract
extension before they can be supported end-to-end.

See the official [Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
[Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/), and
[Clef Omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/) schemas.

## Transport and failure behavior

- No shell. Each evaluation runs `cf ai run @cf/cloudflare/<selected-model>` with
  `--body @<private-file>`. Evidence never appears in process arguments.
- Requests run in an isolated private temporary directory, not a project directory,
  so project-local Cloudflare configuration is not loaded. Request files are
  mode `0600` and are removed after child-process settlement.
- The adapter passes only OS/config-directory and locale environment variables to
  the CLI, plus the explicitly configured account ID. Gateway secrets, Node flags,
  and ambient Cloudflare token overrides are not inherited.
  A synthetic availability marker satisfies the prepared host contract; it is
  not a credential or a claim that the CLI is logged in. Login is checked by
  the CLI when an evaluation runs.
- HTTP base URLs, headers, proxy/TLS request overrides, and explicit reasoning
  settings are rejected rather than silently ignored. Configure authentication
  through the CLI, not `models.providers.cloudflare-clef.apiKey`. Host API-key
  overrides and host auth-profile selectors are rejected instead of silently
  switching to the CLI identity. Select CLI profiles with the plugin's `profile` setting.
- Up to 64 questions, 2–255 Choice options, and 2–10 Score levels. Question IDs
  use letters, digits, `_`, `.`, or `-`, at most 100 characters. Host limits also apply.
- CLI output is bounded to four MiB. Errors expose only an unavailable category,
  not provider diagnostics that might contain submitted evidence.
- Cancellation and deadlines terminate the child process group on POSIX and
  await settlement before deleting request files. No retries, model fallback,
  auto-login, or credential copying occur. Windows descendant cleanup is not
  equivalent to POSIX process-group cleanup; live verification is POSIX-only.

Missing login returns `credentials-unavailable`; rejected authentication returns
`authentication`. Rate limits, unsupported input, transport failures, and invalid
responses remain distinct. Do not interpret an unavailable result as a negative
answer. After fixing a latched authentication failure, reload the plugin through
plugin management before repeating an explicit evaluation.

## Verify

Run offline checks with `pnpm test:extension cloudflare-clef`. Opt-in live tests
exercise text and a synthetic red-square image on all three routes, with Boolean,
Choice, and Score questions in each request:

```bash
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CF_CLEF=1 pnpm test:live -- extensions/cloudflare-clef/provider.live.test.ts
```

For production-boundary proof, the registered-host suite loads the actual plugin
and a small consumer plugin that calls `api.runtime.decisions.evaluateV2`.
It exercises prepared model/catalog/auth resolution, a real CLI image evaluation,
caller cancellation, and rejection after consumer disposal or provider reload.
An observing executable delegates to the real `cf` process and records dispatch
counts. The suite asserts that rejected authority starts no additional CLI process,
and that cancellation settles child processes and removes private request files.
OpenClaw state, agent files, and config paths are isolated from the running Gateway;
only the CLI's existing login is used. No inference or authority predicates are mocked.

```bash
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CF_CLEF=1 pnpm test:live -- src/decisions/cloudflare-clef.live.test.ts
```

The live tests require an existing CLI login and incur provider charges. If the
live runner stages a separate home, the CLI configuration must be available there;
this adapter does not copy credentials. The repository's explicitly selected
real-home live mode is suitable for this CLI-only probe when the operator intends
to use their existing login. `OPENCLAW_LIVE_CF_BINARY` and
`OPENCLAW_LIVE_CF_PROFILE` optionally select the executable and CLI profile.
