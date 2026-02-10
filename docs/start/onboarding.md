---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "First-run onboarding flow for OpenClaw (macOS app)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Designing the macOS onboarding assistant（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing auth or identity setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Onboarding (macOS App)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sidebarTitle: "Onboarding: macOS App"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Onboarding (macOS App)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This doc describes the **current** first‑run onboarding flow. The goal is a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
smooth “day 0” experience: pick where the Gateway runs, connect auth, run the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wizard, and let the agent bootstrap itself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For a general overview of onboarding paths, see [Onboarding Overview](/start/onboarding-overview).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Step title="Approve macOS warning">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Frame>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Frame>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Step title="Approve find local networks">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Frame>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Frame>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Step title="Welcome and security notice">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Frame caption="Read the security notice displayed and decide accordingly">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Frame>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Step title="Local vs Remote">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Frame>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Frame>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Where does the **Gateway** run?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **This Mac (Local only):** onboarding can run OAuth flows and write credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  locally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote (over SSH/Tailnet):** onboarding does **not** run OAuth locally;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  credentials must exist on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Configure later:** skip setup and leave the app unconfigured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Gateway auth tip:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The wizard now generates a **token** even for loopback, so local WS clients must authenticate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you disable auth, any local process can connect; use that only on fully trusted machines.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a **token** for multi‑machine access or non‑loopback binds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Step title="Permissions">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Frame caption="Choose what permissions do you want to give OpenClaw">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Frame>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Onboarding requests TCC permissions needed for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Automation (AppleScript)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Notifications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Accessibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Screen Recording（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Microphone（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Speech Recognition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Camera（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Step title="CLI">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Info>This step is optional</Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The app can install the global `openclaw` CLI via npm/pnpm so terminal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflows and launchd tasks work out of the box.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Step title="Onboarding Chat (dedicated session)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  After setup, the app opens a dedicated onboarding chat session so the agent can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  introduce itself and guide next steps. This keeps first‑run guidance separate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  from your normal conversation. See [Bootstrapping](/start/bootstrapping) for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  what happens on the gateway host during the first agent run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
