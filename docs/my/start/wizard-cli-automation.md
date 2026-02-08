---
summary: "OpenClaw CLI အတွက် စာရင်းသွင်းခြင်းနှင့် အေးဂျင့် တပ်ဆင်ခြင်းကို စကရစ်ဖြင့် အလိုအလျောက်လုပ်ဆောင်ရန်"
read_when:
  - စကရစ်များ သို့မဟုတ် CI တွင် စာရင်းသွင်းခြင်းကို အလိုအလျောက်လုပ်ဆောင်နေသောအခါ
  - သတ်မှတ်ထားသော provider များအတွက် အပြန်အလှန်မရှိသော ဥပမာများလိုအပ်သောအခါ
title: "CLI အလိုအလျောက်လုပ်ဆောင်မှု"
sidebarTitle: "CLI automation"
x-i18n:
  source_path: start/wizard-cli-automation.md
  source_hash: 5b5463359a87cfe6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:58Z
---

# CLI အလိုအလျောက်လုပ်ဆောင်မှု

`--non-interactive` ကို အသုံးပြု၍ `openclaw onboard` ကို အလိုအလျောက်လုပ်ဆောင်ပါ။

<Note>
`--json` သည် အပြန်အလှန်မရှိသော မုဒ်ကို ဆိုလိုခြင်းမဟုတ်ပါ။ စကရစ်များအတွက် `--non-interactive` (နှင့် `--workspace`) ကို အသုံးပြုပါ။
</Note>

## အခြေခံ အပြန်အလှန်မရှိသော ဥပမာ

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

စက်ဖြင့်ဖတ်ရှုနိုင်သော အကျဉ်းချုပ်ကို ရရှိရန် `--json` ကို ထည့်ပါ။

## Provider အလိုက် ဥပမာများ

<AccordionGroup>
  <Accordion title="Gemini ဥပမာ">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI ဥပမာ">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway ဥပမာ">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway ဥပမာ">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot ဥပမာ">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic ဥပမာ">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen ဥပမာ">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

## အေးဂျင့်တစ်ခု ထပ်ထည့်ခြင်း

ကိုယ်ပိုင် workspace၊ sessions နှင့် auth profiles ပါဝင်သော သီးခြားအေးဂျင့်တစ်ခုကို ဖန်တီးရန် `openclaw agents add <name>` ကို အသုံးပြုပါ။ `--workspace` မပါဘဲ လည်ပတ်ပါက wizard ကို စတင်ဖွင့်လှစ်မည်ဖြစ်သည်။

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

သတ်မှတ်ပေးသည်များ—

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

မှတ်ချက်များ—

- မူလ workspace များသည် `~/.openclaw/workspace-<agentId>` ကို လိုက်နာပါသည်။
- အဝင်မက်ဆေ့ချ်များကို လမ်းကြောင်းချရန် `bindings` ကို ထည့်ပါ (wizard မှလည်း လုပ်ဆောင်နိုင်သည်)။
- အပြန်အလှန်မရှိသော flags များ— `--model`, `--agent-dir`, `--bind`, `--non-interactive`။

## ဆက်စပ် စာတမ်းများ

- စာရင်းသွင်းခြင်း ဗဟို: [Onboarding Wizard (CLI)](/start/wizard)
- အပြည့်အစုံ ရည်ညွှန်းချက်: [CLI Onboarding Reference](/start/wizard-cli-reference)
- အမိန့် ရည်ညွှန်းချက်: [`openclaw onboard`](/cli/onboard)
