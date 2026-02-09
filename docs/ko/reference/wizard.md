---
summary: "CLI 온보딩 마법사의 전체 레퍼런스: 모든 단계, 플래그, 설정 필드"
read_when:
  - 특정 마법사 단계나 플래그를 찾아볼 때
  - 비대화형 모드로 온보딩을 자동화할 때
  - 마법사 동작을 디버깅할 때
title: "온보딩 마법사 레퍼런스"
sidebarTitle: "마법사 레퍼런스"
---

# 온보딩 마법사 레퍼런스

이 문서는 `openclaw onboard` CLI 마법사의 전체 레퍼런스입니다.
상위 수준 개요는 [Onboarding Wizard](/start/wizard)를 참고하십시오.

## 흐름 상세 (로컬 모드)

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json` 이 존재하면 **유지 / 수정 / 초기화** 중에서 선택합니다.
    - 마법사를 다시 실행해도 명시적으로 **초기화**를 선택하지 않는 한
      (또는 `--reset` 을 전달하지 않는 한) 아무것도 삭제되지 않습니다.
    - 설정이 유효하지 않거나 레거시 키를 포함하는 경우, 마법사는 중단하고
      계속하기 전에 `openclaw doctor` 를 실행하라고 요청합니다.
    - 초기화는 `trash` 를 사용하며(`rm` 는 절대 사용하지 않음) 다음 범위를 제공합니다:
      - 설정만
      - 설정 + 자격 증명 + 세션
      - 전체 초기화(워크스페이스도 제거)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API 키(권장)**: 존재하면 `ANTHROPIC_API_KEY` 를 사용하거나 키 입력을 요청한 뒤, 데몬 사용을 위해 저장합니다.
    - **Anthropic OAuth (Claude Code CLI)**: macOS 에서는 Keychain 항목 'Claude Code-credentials' 를 확인합니다('Always Allow' 를 선택해야 launchd 시작이 차단되지 않음). Linux/Windows 에서는 존재할 경우 `~/.claude/.credentials.json` 을 재사용합니다.
    - **Anthropic 토큰(setup-token 붙여넣기)**: 어떤 머신에서든 `claude setup-token` 을 실행한 뒤 토큰을 붙여넣습니다(이름 지정 가능, 비워두면 기본값).
    - **OpenAI Code (Codex) 구독 (Codex CLI)**: `~/.codex/auth.json` 이 존재하면 마법사가 이를 재사용할 수 있습니다.
    - **OpenAI Code (Codex) 구독 (OAuth)**: 브라우저 플로우로 진행하며 `code#state` 를 붙여넣습니다.
      - 모델이 설정되지 않았거나 `openai/*` 인 경우 `agents.defaults.model` 을 `openai-codex/gpt-5.2` 로 설정합니다.
    - **OpenAI API 키**: 존재하면 `OPENAI_API_KEY` 을 사용하거나 키 입력을 요청한 뒤, launchd 가 읽을 수 있도록 `~/.openclaw/.env` 에 저장합니다.
    - **xAI (Grok) API 키**: `XAI_API_KEY` 입력을 요청하고 xAI 를 모델 프로바이더로 구성합니다.
    - **OpenCode Zen (멀티 모델 프록시)**: `OPENCODE_API_KEY` (또는 `OPENCODE_ZEN_API_KEY`, https://opencode.ai/auth 에서 발급) 입력을 요청합니다.
    - **API 키**: 키를 대신 저장합니다.
    - **Vercel AI Gateway (멀티 모델 프록시)**: `AI_GATEWAY_API_KEY` 입력을 요청합니다.
    - 자세한 내용: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: Account ID, Gateway ID, `CLOUDFLARE_AI_GATEWAY_API_KEY` 입력을 요청합니다.
    - 자세한 내용: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: 설정이 자동으로 기록됩니다.
    - 자세한 내용: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic 호환)**: `SYNTHETIC_API_KEY` 입력을 요청합니다.
    - 자세한 내용: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: 설정이 자동으로 기록됩니다.
    - **Kimi Coding**: 설정이 자동으로 기록됩니다.
    - 자세한 내용: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **건너뛰기**: 아직 인증을 구성하지 않습니다.
    - 감지된 옵션에서 기본 모델을 선택합니다(또는 프로바이더/모델을 수동으로 입력).
    - 마법사는 모델 검사를 실행하고 구성된 모델을 알 수 없거나 인증이 누락된 경우 경고합니다.
    - OAuth 자격 증명은 `~/.openclaw/credentials/oauth.json` 에, 인증 프로필은 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 에 저장됩니다(API 키 + OAuth).
    - 자세한 내용: [/concepts/oauth](/concepts/oauth)    
<Note>
    헤드리스/서버 팁: 브라우저가 있는 머신에서 OAuth 를 완료한 뒤
    `~/.openclaw/credentials/oauth.json` (또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`) 를
    게이트웨이 호스트로 복사하십시오.
    </Note>
  </Step>
  <Step title="Workspace">
    - 기본값은 `~/.openclaw/workspace` (구성 가능).
    - 에이전트 부트스트랩 의식을 위해 필요한 워크스페이스 파일을 시드합니다.
    - 전체 워크스페이스 레이아웃 + 백업 가이드: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - 포트, 바인드, 인증 모드, Tailscale 노출.
    - 인증 권장 사항: 로컬 loopback 이더라도 **Token** 을 유지하여 로컬 WS 클라이언트가 반드시 인증하도록 하십시오.
    - 모든 로컬 프로세스를 완전히 신뢰하는 경우에만 인증을 비활성화하십시오.
    - non‑loopback 바인드는 여전히 인증이 필요합니다.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): 선택적 QR 로그인.
    - [Telegram](/channels/telegram): 봇 토큰.
    - [Discord](/channels/discord): 봇 토큰.
    - [Google Chat](/channels/googlechat): 서비스 계정 JSON + 웹훅 오디언스.
    - [Mattermost](/channels/mattermost) (플러그인): 봇 토큰 + 기본 URL.
    - [Signal](/channels/signal): 선택적 `signal-cli` 설치 + 계정 구성.
    - [BlueBubbles](/channels/bluebubbles): **iMessage 권장**; 서버 URL + 비밀번호 + 웹훅.
    - [iMessage](/channels/imessage): 레거시 `imsg` CLI 경로 + DB 접근.
    - 다이렉트 메시지 보안: 기본값은 페어링입니다. 첫 다이렉트 메시지는 코드를 전송하며, `openclaw pairing approve <channel><code>` 를 통해 승인하거나 허용 목록을 사용하십시오.
  </Step><code>` 를 통해 승인하거나 허용 목록을 사용하십시오.
  </Step>
  <Step title="데몬 설치">
    - macOS: LaunchAgent
      - 로그인된 사용자 세션이 필요합니다. 헤드리스의 경우 사용자 정의 LaunchDaemon 을 사용하십시오(제공되지 않음).
    - Linux (및 WSL2 를 통한 Windows): systemd 사용자 유닛
      - 로그아웃 후에도 Gateway 가 유지되도록 `loginctl enable-linger <user>` 를 통해 lingering 활성화를 시도합니다.
      - sudo 를 요청할 수 있습니다(`/var/lib/systemd/linger` 기록). 먼저 sudo 없이 시도합니다.
    - **런타임 선택:** Node (권장; WhatsApp/Telegram 에 필수). Bun 은 **권장되지 않음**.
  </Step>
  <Step title="헬스 체크">
    - 필요 시 Gateway 를 시작하고 `openclaw health` 을 실행합니다.
    - 팁: `openclaw status --deep` 는 상태 출력에 게이트웨이 헬스 프로브를 추가합니다(접근 가능한 게이트웨이 필요).
  </Step>
  <Step title="Skills (권장)">
    - 사용 가능한 Skills 를 읽고 요구 사항을 확인합니다.
    - 노드 매니저를 선택합니다: **npm / pnpm** (bun 은 권장되지 않음).
    - 선택적 의존성을 설치합니다(일부는 macOS 에서 Homebrew 사용).
  </Step>
  <Step title="마침">
    - 요약 + 다음 단계, 추가 기능을 위한 iOS/Android/macOS 앱 포함.
  </Step>
</Steps>

<Note>
GUI 가 감지되지 않으면 마법사는 브라우저를 여는 대신 Control UI 를 위한 SSH 포트 포워딩 안내를 출력합니다.
Control UI 에셋이 없는 경우 마법사는 빌드를 시도하며, 대체 수단은 `pnpm ui:build` 입니다(UI 의존성을 자동 설치).
</Note>

## 비대화형 모드

`--non-interactive` 를 사용하여 온보딩을 자동화하거나 스크립트화할 수 있습니다:

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

머신 판독 가능한 요약을 위해 `--json` 를 추가하십시오.

<Note>
`--json` 는 **비대화형 모드**를 의미하지 않습니다. 스크립트에서는 `--non-interactive` (및 `--workspace`) 를 사용하십시오.
</Note>

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

### 에이전트 추가(비대화형)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway 마법사 RPC

Gateway 는 RPC 를 통해 마법사 흐름을 노출합니다(`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
클라이언트(macOS 앱, Control UI)는 온보딩 로직을 재구현하지 않고도 단계를 렌더링할 수 있습니다.

## Signal 설정 (signal-cli)

마법사는 GitHub 릴리스에서 `signal-cli` 를 설치할 수 있습니다:

- 적절한 릴리스 에셋을 다운로드합니다.
- `~/.openclaw/tools/signal-cli/<version>/` 아래에 저장합니다.
- 설정에 `channels.signal.cliPath` 를 기록합니다.

참고 사항:

- JVM 빌드는 **Java 21** 이 필요합니다.
- 가능한 경우 네이티브 빌드를 사용합니다.
- Windows 는 WSL2 를 사용하며, signal-cli 설치는 WSL 내부에서 Linux 흐름을 따릅니다.

## 마법사가 기록하는 내용

`~/.openclaw/openclaw.json` 에 기록되는 일반적인 필드:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (MiniMax 선택 시)
- `gateway.*` (모드, 바인드, 인증, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 프롬프트 중 선택한 경우 채널 허용 목록(Slack/Discord/Matrix/Microsoft Teams)(가능한 경우 이름이 ID 로 해석됨).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 은 `agents.list[]` 와 선택적 `bindings` 를 기록합니다.

WhatsApp 자격 증명은 `~/.openclaw/credentials/whatsapp/<accountId>/` 아래에 저장됩니다.
세션은 `~/.openclaw/agents/<agentId>/sessions/` 아래에 저장됩니다.

일부 채널은 플러그인으로 제공됩니다. 온보딩 중 하나를 선택하면,
구성 전에 설치(npm 또는 로컬 경로)를 요청받게 됩니다.

## 관련 문서

- 마법사 개요: [Onboarding Wizard](/start/wizard)
- macOS 앱 온보딩: [Onboarding](/start/onboarding)
- 설정 레퍼런스: [Gateway configuration](/gateway/configuration)
- 프로바이더: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (레거시)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
