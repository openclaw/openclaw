---
summary: "OpenClaw CLI를 위한 스크립트 기반 온보딩 및 에이전트 설정"
read_when:
  - 스크립트 또는 CI에서 온보딩을 자동화할 때
  - 특정 프로바이더에 대한 비대화형 예제가 필요할 때
title: "CLI 자동화"
sidebarTitle: "CLI automation"
---

# CLI 자동화

`--non-interactive`를 사용하여 `openclaw onboard`을 자동화합니다.

<Note>
`--json`은 비대화형 모드를 의미하지 않습니다. 스크립트에서는 `--non-interactive` (및 `--workspace`)를 사용하십시오.
</Note>

## 기본 비대화형 예제

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

기계 판독 가능한 요약을 위해 `--json`를 추가하십시오.

## 프로바이더별 예제

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

## 다른 에이전트 추가

`openclaw agents add <name>`를 사용하여 자체 워크스페이스, 세션 및 인증 프로필을 갖는 별도의 에이전트를 생성합니다. `--workspace` 없이 실행하면 마법사가 시작됩니다.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

설정되는 항목:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

참고 사항:

- 기본 워크스페이스는 `~/.openclaw/workspace-<agentId>`을 따릅니다.
- 인바운드 메시지를 라우팅하려면 `bindings`를 추가하십시오(마법사에서 설정할 수 있습니다).
- 비대화형 플래그: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## 관련 문서

- 온보딩 허브: [온보딩 마법사 (CLI)](/start/wizard)
- 전체 참조: [CLI 온보딩 참조](/start/wizard-cli-reference)
- 명령 참조: [`openclaw onboard`](/cli/onboard)
