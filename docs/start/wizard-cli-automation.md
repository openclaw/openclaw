---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Scripted onboarding and agent setup for the OpenClaw CLI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are automating onboarding in scripts or CI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need non-interactive examples for specific providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "CLI Automation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sidebarTitle: "CLI automation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# CLI Automation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--non-interactive` to automate `openclaw onboard`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--json` does not imply non-interactive mode. Use `--non-interactive` (and `--workspace`) for scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Baseline non-interactive example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --auth-choice apiKey \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --anthropic-api-key "$ANTHROPIC_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --gateway-bind loopback \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --install-daemon \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --daemon-runtime node \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --skip-skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add `--json` for a machine-readable summary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Provider-specific examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Gemini example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice gemini-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gemini-api-key "$GEMINI_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Z.AI example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice zai-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --zai-api-key "$ZAI_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Vercel AI Gateway example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice ai-gateway-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Cloudflare AI Gateway example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice cloudflare-ai-gateway-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --cloudflare-ai-gateway-account-id "your-account-id" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Moonshot example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice moonshot-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --moonshot-api-key "$MOONSHOT_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Synthetic example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice synthetic-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --synthetic-api-key "$SYNTHETIC_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="OpenCode Zen example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice opencode-zen \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --opencode-zen-api-key "$OPENCODE_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Add another agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `openclaw agents add <name>` to create a separate agent with its own workspace,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessions, and auth profiles. Running without `--workspace` launches the wizard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents add work \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --workspace ~/.openclaw/workspace-work \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --model openai/gpt-5.2 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --bind whatsapp:biz \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What it sets:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].name`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].agentDir`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default workspaces follow `~/.openclaw/workspace-<agentId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `bindings` to route inbound messages (the wizard can do this).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full reference: [CLI Onboarding Reference](/start/wizard-cli-reference)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Command reference: [`openclaw onboard`](/cli/onboard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
