---
summary: "First-run setup flow for OpenClaw (macOS app)"
read_when:
  - Designing the macOS onboarding assistant
  - Implementing auth or identity setup
title: "Onboarding (macOS app)"
sidebarTitle: "Onboarding: macOS App"
---

The macOS app's first-run flow: pick where the Gateway runs, complete local
setup through a Crestodian conversation, grant permissions, and hand off to
the agent's own bootstrap ritual.
For CLI onboarding and a comparison of both paths, see [Onboarding Overview](/start/onboarding-overview).

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="Read the security notice displayed and decide accordingly">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

Security trust model:

- By default, OpenClaw is a personal agent: one trusted operator boundary.
- Shared/multi-user setups need lock-down: split trust boundaries, keep tool access minimal, and follow [Security](/gateway/security).
- Local onboarding defaults new configs to `tools.profile: "coding"` so fresh setups keep filesystem/runtime tools without the unrestricted `full` profile.
- If hooks/webhooks or other untrusted content feeds are enabled, use a strong modern model tier and keep strict tool policy/sandboxing.

</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Where does the **Gateway** run?

- **This Mac (Local only):** onboarding configures auth and writes credentials locally.
- **Remote (over SSH/Tailnet):** onboarding does **not** configure local auth;
  credentials must already exist on the gateway host. The remote gateway token
  field stores the token the macOS app uses to connect to that Gateway;
  existing `gateway.remote.token` SecretRef values are preserved until you
  replace them.
- **Configure later:** skip setup and leave the app unconfigured.

<Tip>
**Gateway auth tip:**

- Gateway auth mode defaults to `token` even for loopback binds, so local WS clients must authenticate.
- Setting `gateway.auth.mode: "none"` lets any local process connect; use that only on fully trusted machines.
- Use a token for multi-machine access or non-loopback binds.

</Tip>
</Step>
<Step title="CLI">
  Local setup installs the global `openclaw` CLI via npm, pnpm, or bun,
  preferring npm first. Node remains the recommended runtime for the Gateway
  itself. Existing compatible installations are reused.
</Step>
<Step title="Talk to Crestodian">
  Local setup opens a dedicated conversation with Crestodian after the Gateway
  is ready. Crestodian detects an existing Claude Code or Codex login and
  supported API keys, proposes the workspace and configuration, then waits for
  approval before writing anything. Next remains locked until the conversation
  has authored setup state. Credential prompts use masked input; after an
  ambiguous transport failure, restart the setup conversation instead of
  replaying the previous turn.

Remote and Configure Later flows skip this local setup conversation.
</Step>
<Step title="Permissions">

<Frame caption="Choose what permissions do you want to give OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Onboarding requests TCC permissions for: Automation (AppleScript), Notifications, Accessibility, Screen Recording, Microphone, Speech Recognition, Camera, and Location.

</Step>
<Step title="Onboarding Chat (dedicated session)">
  After setup, the app opens a separate agent onboarding chat so the agent can
  introduce itself and guide next steps without mixing that exchange into the
  normal conversation history. This follows the Crestodian setup conversation;
  it does not replace it. See [Bootstrapping](/start/bootstrapping) for what
  happens on the gateway host during the agent's first real turn.
</Step>
</Steps>

## Related

- [Onboarding overview](/start/onboarding-overview)
- [Getting started](/start/getting-started)
