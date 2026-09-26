---
summary: "Use on-device Apple Foundation Models for lightweight OpenClaw setup on a Mac"
read_when:
  - You want to set up OpenClaw on a Mac without an API key
  - You want to use Apple Intelligence for short local tasks
title: "Apple Foundation Models"
---

The bundled Apple Foundation Models plugin runs Apple's on-device model through
the native Foundation Models framework. It is a free local **setup and utility**
model. Setup saves it in `utilityModel` and preserves your regular agent model.
When no primary model is configured, it can power the OpenClaw setup assistant.
Choose a separate primary model before starting regular agent chat.

## Requirements

These requirements apply to the Mac running the Gateway. A Mac app connected to
a Linux or Windows Gateway does not provide this local inference route.

- A Mac with Apple silicon running macOS 27 or later.
- Apple Intelligence enabled in System Settings, with its model downloaded.
- Installed Apple Swift developer tools with the macOS 27 SDK.
- An available system model with at least 8,192 context tokens.

The plugin queries the actual model name, availability, and context window.
AFM 3 Core Advanced has been tested with an 8,192-token window. Older on-device
variants with a 4K window do not qualify for this setup option; having a Mac does
not imply that the larger variant is available.

## Set up

Run:

```bash
openclaw onboard
```

Allow local discovery, then choose **Apple Foundation Models** when it appears.
Setup offers this option only after a background probe confirms that the model is
available and has at least 8,192 context tokens. It stays hidden while eligibility
is unknown, when prerequisites are missing, or when the model has a smaller window.

On first discovery, OpenClaw compiles the bundled Swift helper in a temporary
directory with your installed Apple tools, reads the native model's availability
and context size, and removes the temporary helper. Compilation and probing run
in child processes so they do not block the Gateway's event loop. Discovery does
not install an inference helper or change your configuration. It is bounded and
cancellable; a failed or timed-out check does not offer the model.

Selecting the detected model builds its persistent helper and rechecks eligibility
before activation. OpenClaw does not install developer tools, download a
third-party executable, or accept license terms for you. If the tools are missing,
install Xcode or the appropriate Apple Command Line Tools and retry. The tools
must include a macOS 27 SDK.

OpenClaw tests the selected utility route before saving it. The model reference
is `apple-fm/system`; setup records the detected model name and context limit.
No API key or provider auth profile is created. The native route uses the
OpenClaw runtime even if your primary model uses a different agent runtime.

On a fresh installation, onboarding opens the OpenClaw setup assistant. It can
inspect configuration and help with channels and other setup. The interface keeps
regular agent setup incomplete until you choose and verify a primary model in
**Model Setup** or by rerunning `openclaw onboard`. Afterward, Apple remains the
utility model; the system assistant follows the primary model normally.

On an existing installation, choosing Apple preserves your primary model,
fallbacks, and credentials. If an older config relied on an implicit primary,
setup records that existing route before adding the Apple provider. Doctor and
normal config writes apply the same [utility-model migration](/gateway/config-agents/models#agents.defaults.model).
If that migration is still pending, setup asks you to run `openclaw doctor --fix`
or choose an explicit primary before connecting Apple.
Explicit utility-model configuration can also be set per agent
with `agents.entries.<id>.utilityModel`.

Later discovery reuses the prepared helper and checks the current model again.
To select Apple explicitly from a script:

```bash
openclaw onboard --non-interactive --auth-choice apple-fm --accept-risk
```

## Runtime behavior

Model inference runs on the Gateway's Mac; proposed tool calls go through
OpenClaw's normal execution and approval flow. The helper is started for model
requests; no HTTP server, launch agent, or separate model daemon is installed.
OpenClaw retains ownership of tool execution and its normal approval checks.

Utility calls power short internal tasks such as session titles and progress
narration through OpenClaw's existing utility-model routing. Apple is not selected
as the ordinary agent's primary model by onboarding.

The model shares its context window across instructions, tool definitions,
conversation, tool results, and output. The provider defaults to a maximum of
1,024 output tokens per reply. A large workspace or a full agent prompt can exceed
the window even before useful conversation history accumulates. Keep setup
questions focused; the small on-device model can be less reliable than a larger
model on complex requests.

Native generation supports closed objects, arrays, primitive types, enums,
nullable values, and supported schema unions. String length and regex constraints
remain enforced by OpenClaw after generation because Apple does not provide usable
native guides for them. Structured responses are checked against the caller's
original schema before publication. Unsupported structural schemas fail explicitly.

## Troubleshooting

If Apple Intelligence is unavailable, enable it in System Settings and wait for
the model download to finish. Retry setup after changing its availability.

If the reported context window is below 8,192 tokens, choose another local or
cloud model. OpenClaw does not inflate the model's advertised limit.

If the native helper is missing after an update, use **Recheck & repair** on the
configured utility card in Model Setup, or rerun onboarding and select the
detected Apple model. This compiles the helper matching the installed plugin and
verifies the utility route again. Ordinary inference never compiles code or
installs dependencies.

See [Model providers](/concepts/model-providers) for other inference options.
