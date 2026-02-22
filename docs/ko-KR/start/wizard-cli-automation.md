---
summary: "OpenClaw CLI의 스크립트를 통한 온보딩 및 에이전트 설정"
read_when:
  - 스크립트 또는 CI에서 온보딩을 자동화하고 있는 경우
  - 특정 프로바이더에 대한 비대화형 예제가 필요한 경우
title: "CLI 자동화"
sidebarTitle: "CLI 자동화"
---

# CLI 자동화

`openclaw onboard`를 자동화하려면 `--non-interactive`를 사용하세요.

<Note>
`--json`은 비대화형 모드를 암시하지 않습니다. 스크립트를 위해 `--non-interactive` (및 `--workspace`)를 사용하세요.
</Note>

## 비대화형 기본 예제

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

`--json`을 추가하여 기계가 읽을 수 있는 요약을 얻을 수 있습니다.

## 프로바이더 별 예제

<AccordionGroup>
  <Accordion title="Gemini 예제">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI 예제">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI 게이트웨이 예제">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI 게이트웨이 예제">
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
  <Accordion title="Moonshot 예제">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic 예제">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen 예제">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="커스텀 프로바이더 예제">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice custom-api-key \
      --custom-base-url "https://llm.example.com/v1" \
      --custom-model-id "foo-large" \
      --custom-api-key "$CUSTOM_API_KEY" \
      --custom-provider-id "my-custom" \
      --custom-compatibility anthropic \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```

    `--custom-api-key`는 선택 사항입니다. 생략하면 온보딩은 `CUSTOM_API_KEY`를 확인합니다.

  </Accordion>
</AccordionGroup>

## 다른 에이전트 추가

`openclaw agents add <name>`를 사용하여 별도의 작업공간, 세션, 인증 프로파일을 갖춘 별도의 에이전트를 생성하세요. `--workspace` 없이 실행하면 마법사를 실행합니다.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

설정 내용:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

주의사항:

- 기본 작업공간은 `~/.openclaw/workspace-<agentId>`를 따릅니다.
- 수신 메시지를 라우팅하려면 `bindings`를 추가하세요 (마법사가 이를 수행할 수 있습니다).
- 비대화형 플래그: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## 관련 문서

- 온보딩 허브: [온보딩 마법사 (CLI)](/ko-KR/start/wizard)
- 전체 참조: [CLI 온보딩 참조](/ko-KR/start/wizard-cli-reference)
- 명령어 참조: [`openclaw onboard`](/ko-KR/cli/onboard)
