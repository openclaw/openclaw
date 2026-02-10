---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw onboard` (interactive onboarding wizard)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want guided setup for gateway, workspace, auth, channels, and skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "onboard"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw onboard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Interactive onboarding wizard (local or remote Gateway setup).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related guides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding overview: [Onboarding Overview](/start/onboarding-overview)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI onboarding reference: [CLI Onboarding Reference](/start/wizard-cli-reference)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI automation: [CLI Automation](/start/wizard-cli-automation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS onboarding: [Onboarding (macOS App)](/start/onboarding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --flow quickstart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --flow manual（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --mode remote --remote-url ws://gateway-host:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Flow notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `quickstart`: minimal prompts, auto-generates a gateway token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `manual`: full prompts for port/bind/auth (alias of `advanced`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fastest first chat: `openclaw dashboard` (Control UI, no channel setup).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Custom Provider: connect any OpenAI or Anthropic compatible endpoint,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  including hosted providers not listed. Use Unknown to auto-detect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common follow-up commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents add <name>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--json` does not imply non-interactive mode. Use `--non-interactive` for scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
