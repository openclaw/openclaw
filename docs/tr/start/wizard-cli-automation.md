---
summary: "OpenClaw CLI için betik tabanlı onboarding ve ajan kurulumu"
read_when:
  - Betikler veya CI içinde onboarding’i otomatikleştiriyorsanız
  - Belirli sağlayıcılar için etkileşimsiz örneklere ihtiyacınız varsa
title: "CLI Otomasyonu"
sidebarTitle: "CLI automation"
---

# CLI Otomasyonu

`--non-interactive` kullanarak `openclaw onboard` işlemini otomatikleştirin.

<Note>
`--json` etkileşimsiz mod anlamına gelmez. Betikler için `--non-interactive` (ve `--workspace`) kullanın.
</Note>

## Temel etkileşimsiz örnek

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

Makine tarafından okunabilir bir özet için `--json` ekleyin.

## Sağlayıcıya özgü örnekler

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
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
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
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

## 5. Başka bir ajan ekle

Kendi çalışma alanı, oturumları ve kimlik doğrulama profilleri olan ayrı bir ajan oluşturmak için `openclaw agents add <name>` kullanın. `--workspace` olmadan çalıştırmak sihirbazı başlatır.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

6. Ayarladıkları:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notlar:

- Varsayılan çalışma alanları `~/.openclaw/workspace-<agentId>` düzenini izler.
- Gelen mesajları yönlendirmek için `bindings` ekleyin (sihirbaz bunu yapabilir).
- Etkileşimsiz bayraklar: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## İlgili dokümanlar

- Onboarding merkezi: [Onboarding Wizard (CLI)](/start/wizard)
- Tam referans: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Komut referansı: [`openclaw onboard`](/cli/onboard)
