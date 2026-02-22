---
summary: "CLI 온보딩 마법사에 대한 전체 참조: 모든 단계, 플래그 및 설정 필드"
read_when:
  - 특정 마법사 단계나 플래그를 찾고 있을 때
  - 비대화형 모드로 온보딩 자동화할 때
  - 마법사 동작을 디버깅할 때
title: "온보딩 마법사 참조"
sidebarTitle: "마법사 참조"
---

# 온보딩 마법사 참조

이 문서는 `openclaw onboard` CLI 마법사에 대한 전체 참조입니다.
고급 개요는 [온보딩 마법사](/ko-KR/start/wizard)를 참조하세요.

## 흐름 세부사항 (로컬 모드)

<Steps>
  <Step title="기존 설정 감지">
    - `~/.openclaw/openclaw.json`이 존재하면 **유지 / 수정 / 초기화**를 선택합니다.
    - 마법사를 다시 실행해도 **초기화**를 명시적으로 선택하거나 `--reset`을 전달하지 않는 한 아무것도 삭제되지 않습니다.
    - 설정이 잘못되었거나 레거시 키가 포함된 경우, 마법사는 중단되고 계속하기 전에 `openclaw doctor`를 실행하도록 요청합니다.
    - 초기화는 `trash`를 사용하고(절대 `rm` 사용 안 함) 범위를 제공합니다:
      - 설정만
      - 설정 + 자격 증명 + 세션
      - 전체 초기화 (작업 공간도 제거)
  </Step>
  <Step title="모델/인증">
    - **Anthropic API 키 (권장)**: 존재하는 경우 `ANTHROPIC_API_KEY`를 사용하거나 키를 요청받아 데몬 사용을 위해 저장합니다.
    - **Anthropic OAuth (Claude Code CLI)**: macOS에서 마법사는 키체인 항목 "Claude Code-credentials"를 확인합니다(출시 시점의 차단을 방지하려면 "항상 허용" 선택); Linux/Windows에서는 존재하는 경우 `~/.claude/.credentials.json`을 재사용합니다.
    - **Anthropic 토큰 (setup-token 붙여넣기)**: 어떤 기기에서든 `claude setup-token`을 실행한 후 토큰을 붙여넣습니다(이름 지정 가능; 비워두면 기본값).
    - **OpenAI Code (Codex) 구독 (Codex CLI)**: `~/.codex/auth.json`이 존재하는 경우, 마법사는 이를 재사용할 수 있습니다.
    - **OpenAI Code (Codex) 구독(OAuth)**: 브라우저 흐름; `code#state`를 붙여넣습니다.
      - 모델이 설정되지 않았거나 `openai/*`일 때 `agents.defaults.model`을 `openai-codex/gpt-5.2`로 설정합니다.
    - **OpenAI API 키**: 존재하는 경우 `OPENAI_API_KEY`를 사용하거나 키를 요청받아 `~/.openclaw/.env`에 저장하여 launchd가 읽을 수 있게 합니다.
    - **xAI (Grok) API 키**: `XAI_API_KEY`를 요청받아 xAI를 모델 프로바이더로 설정합니다.
    - **OpenCode Zen (다중 모델 프록시)**: `OPENCODE_API_KEY`(또는 `OPENCODE_ZEN_API_KEY`)를 요청받습니다. https://opencode.ai/auth에서 받을 수 있습니다.
    - **API 키**: 키를 저장해줍니다.
    - **Vercel AI 게이트웨이 (다중 모델 프록시)**: `AI_GATEWAY_API_KEY`를 요청받습니다.
    - 자세한 내용: [Vercel AI 게이트웨이](/ko-KR/providers/vercel-ai-gateway)
    - **Cloudflare AI 게이트웨이**: 계정 ID, 게이트웨이 ID, 그리고 `CLOUDFLARE_AI_GATEWAY_API_KEY`를 요청받습니다.
    - 자세한 내용: [Cloudflare AI 게이트웨이](/ko-KR/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: 설정이 자동으로 작성됩니다.
    - 자세한 내용: [MiniMax](/ko-KR/providers/minimax)
    - **Synthetic (Anthropic 호환)**: `SYNTHETIC_API_KEY`를 요청받습니다.
    - 자세한 내용: [Synthetic](/ko-KR/providers/synthetic)
    - **Moonshot (Kimi K2)**: 설정이 자동으로 작성됩니다.
    - **Kimi Coding**: 설정이 자동으로 작성됩니다.
    - 자세한 내용: [Moonshot AI (Kimi + Kimi Coding)](/ko-KR/providers/moonshot)
    - **건너뛰기**: 아직 인증이 설정되지 않았습니다.
    - 감지된 옵션에서 기본 모델을 선택하거나 프로바이더/모델을 수동으로 입력합니다.
    - 마법사는 모델 검사를 수행하고 구성된 모델이 불명확하거나 인증이 누락된 경우 경고합니다.
    - OAuth 자격 증명은 `~/.openclaw/credentials/oauth.json`에 저장됩니다. 인증 프로필은 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`에 저장됩니다 (API 키 + OAuth).
    - 자세한 내용: [/concepts/oauth](/ko-KR/concepts/oauth)
    <Note>
    헤드리스/서버 팁: 브라우저가 있는 기기에서 OAuth를 완료한 후 `~/.openclaw/credentials/oauth.json` (또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`)을 게이트웨이 호스트로 복사하세요.
    </Note>
  </Step>
  <Step title="작업 공간">
    - 기본 `~/.openclaw/workspace` (구성 가능).
    - 에이전트 부트스트랩 의식을 위해 필요한 작업 공간 파일을 시드합니다.
    - 전체 작업 공간 레이아웃 + 백업 가이드: [에이전트 작업 공간](/ko-KR/concepts/agent-workspace)
  </Step>
  <Step title="게이트웨이">
    - 포트, 바인드, 인증 모드, tailscale 노출.
    - 인증 권장: 로컬 WS 클라이언트가 인증해야 하므로 **토큰**을 유지하세요.
    - 인증은 모든 로컬 프로세스를 완전히 신뢰할 경우에만 비활성화하십시오.
    - 비‑루프백 바인드는 여전히 인증이 필요합니다.
  </Step>
  <Step title="채널">
    - [WhatsApp](/ko-KR/channels/whatsapp): 선택적 QR 로그인.
    - [Telegram](/ko-KR/channels/telegram): 봇 토큰.
    - [Discord](/ko-KR/channels/discord): 봇 토큰.
    - [Google Chat](/ko-KR/channels/googlechat): 서비스 계정 JSON + 웹훅 대상.
    - [Mattermost](/ko-KR/channels/mattermost) (플러그인): 봇 토큰 + 기본 URL.
    - [Signal](/ko-KR/channels/signal): 선택적 `signal-cli` 설치 + 계정 설정.
    - [BlueBubbles](/ko-KR/channels/bluebubbles): **iMessage에 권장됨**; 서버 URL + 비밀번호 + 웹훅.
    - [iMessage](/ko-KR/channels/imessage): 레거시 `imsg` CLI 경로 + DB 액세스.
    - 다이렉트 메시지 보안: 기본값은 페어링입니다. 첫 번째 다이렉트 메시지는 코드를 보냅니다; `openclaw pairing approve <channel> <code>`를 통해 승인하거나 허용 목록을 사용하세요.
  </Step>
  <Step title="데몬 설치">
    - macOS: LaunchAgent
      - 로그인된 사용자 세션이 필요합니다; 헤드리스의 경우 사용자 정의 LaunchDaemon을 사용하세요 (제공되지 않음).
    - Linux (및 WSL2를 통한 Windows): systemd 사용자 단위
      - 마법사는 `loginctl enable-linger <user>`를 사용하여 로그아웃 후에도 게이트웨이가 계속 유지되도록 하려고 시도합니다.
      - sudo를 요청할 수 있습니다 ( `/var/lib/systemd/linger`를 작성합니다); 먼저 sudo 없이 시도합니다.
    - **런타임 선택:** Node (권장됨; WhatsApp/Telegram에 필요). Bun은 **권장되지 않음**.
  </Step>
  <Step title="상태 확인">
    - 게이트웨이를 시작하고 (필요한 경우) `openclaw health`를 실행합니다.
    - 팁: `openclaw status --deep`은 상태 출력에 게이트웨이 상태 프로브를 추가합니다 (게이트웨이에 접근 가능해야 함).
  </Step>
  <Step title="스킬 (권장)">
    - 사용 가능한 스킬을 읽고 요구 사항을 확인합니다.
    - 노드 관리자를 선택할 수 있게 합니다: **npm / pnpm** (bun은 권장되지 않음).
    - 선택적 종속성을 설치합니다 (일부는 macOS에서 Homebrew 사용).
  </Step>
  <Step title="완료">
    - 요약 + 다음 단계, 추가 기능을 위한 iOS/Android/macOS 앱 포함.
  </Step>
</Steps>

<Note>
GUI가 감지되지 않으면 마법사는 브라우저를 여는 대신 Control UI에 대한 SSH 포트-포워딩 지침을 출력합니다.
Control UI 자산이 누락된 경우, 마법사는 이를 빌드하려고 시도합니다. 대체 방법은 `pnpm ui:build` (UI 종속성 자동 설치)입니다.
</Note>

## 비대화형 모드

`--non-interactive`를 사용하여 자동화하거나 스크립트로 온보딩할 수 있습니다:

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

기계판독 가능한 요약을 위해 `--json`을 추가하세요.

<Note>
`--json`은 **비대화형 모드**를 자동으로 포함하지 않습니다. 스크립트에는 `--non-interactive` (및 `--workspace`)를 사용하세요.
</Note>

<AccordionGroup>
  <Accordion title="Gemini 예시">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI 예시">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI 게이트웨이 예시">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI 게이트웨이 예시">
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
  <Accordion title="Moonshot 예시">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic 예시">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen 예시">
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

### 에이전트 추가 (비대화형)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## 게이트웨이 마법사 RPC

게이트웨이는 RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`)를 통해 마법사 흐름을 노출합니다.
클라이언트 (macOS 앱, Control UI)는 온보딩 논리를 재구현하지 않고도 단계를 렌더링할 수 있습니다.

## Signal 설정 (signal-cli)

마법사는 GitHub 릴리즈에서 `signal-cli`를 설치할 수 있습니다:

- 적절한 릴리즈 에셋을 다운로드합니다.
- `~/.openclaw/tools/signal-cli/<version>/`에 저장됩니다.
- 설정에 `channels.signal.cliPath`를 작성합니다.

참고 사항:

- JVM 빌드는 **Java 21**이 필요합니다.
- 네이티브 빌드는 사용할 수 있을 때 사용됩니다.
- Windows는 WSL2를 사용하며, signal-cli 설치는 Linux 내의 흐름을 따릅니다.

## 마법사가 기록하는 것

`~/.openclaw/openclaw.json`에 일반적으로 포함되는 필드:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (MiniMax가 선택된 경우)
- `gateway.*` (모드, 바인드, 인증, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 프롬프트 동안 선택하면 채널 허용 목록 (Slack/Discord/Matrix/Microsoft Teams) (가능한 경우 이름이 ID로 변환됨).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`는 `agents.list[]`와 선택적 `bindings`를 기록합니다.

WhatsApp 자격 증명은 `~/.openclaw/credentials/whatsapp/<accountId>/`에 보관됩니다.
세션은 `~/.openclaw/agents/<agentId>/sessions/`에 저장됩니다.

일부 채널은 플러그인으로 제공됩니다. 온보딩 중 하나를 선택하면 마법사는 구성 전에 설치하도록 요청할 것입니다 (npm 또는 로컬 경로).

## 관련 문서

- 마법사 개요: [온보딩 마법사](/ko-KR/start/wizard)
- macOS 앱 온보딩: [온보딩](/ko-KR/start/onboarding)
- 설정 참조: [게이트웨이 구성](/ko-KR/gateway/configuration)
- 프로바이더: [WhatsApp](/ko-KR/channels/whatsapp), [Telegram](/ko-KR/channels/telegram), [Discord](/ko-KR/channels/discord), [Google Chat](/ko-KR/channels/googlechat), [Signal](/ko-KR/channels/signal), [BlueBubbles](/ko-KR/channels/bluebubbles) (iMessage), [iMessage](/ko-KR/channels/imessage) (레거시)
- 스킬: [스킬](/ko-KR/tools/skills), [스킬 설정](/ko-KR/tools/skills-config)
