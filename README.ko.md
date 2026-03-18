# 🦞 OpenClaw — 개인 AI 어시스턴트

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.svg">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.svg" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**OpenClaw**는 여러분의 기기에서 직접 실행되는 _개인 AI 어시스턴트_입니다.
이미 사용하고 있는 채널(WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, BlueBubbles, IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal, WebChat)에서 응답합니다. macOS/iOS/Android에서 음성으로 대화하고, 제어 가능한 라이브 Canvas를 렌더링할 수 있습니다. Gateway는 단순한 제어 플레인이며, 실제 제품은 어시스턴트 그 자체입니다.

로컬에서 빠르고 항상 작동하는 개인 단일 사용자 어시스턴트를 원한다면, 바로 이것입니다.

[웹사이트](https://openclaw.ai) · [문서](https://docs.openclaw.ai) · [비전](VISION.md) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [시작하기](https://docs.openclaw.ai/start/getting-started) · [업데이트](https://docs.openclaw.ai/install/updating) · [쇼케이스](https://docs.openclaw.ai/start/showcase) · [FAQ](https://docs.openclaw.ai/help/faq) · [온보딩](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

권장 설정: 터미널에서 `openclaw onboard`를 실행하세요.
OpenClaw Onboard는 게이트웨이, 워크스페이스, 채널 및 스킬 설정을 단계별로 안내합니다. **macOS, Linux 및 Windows(WSL2 사용 강력 권장)**에서 작동하는 권장 CLI 설정 경로입니다.
npm, pnpm 또는 bun과 함께 작동합니다.
처음 설치하시나요? 여기서 시작: [시작하기](https://docs.openclaw.ai/start/getting-started)

## 스폰서

| OpenAI                                                            | Vercel                                                            | Blacksmith                                                                   | Convex                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [![OpenAI](docs/assets/sponsors/openai.svg)](https://openai.com/) | [![Vercel](docs/assets/sponsors/vercel.svg)](https://vercel.com/) | [![Blacksmith](docs/assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) | [![Convex](docs/assets/sponsors/convex.svg)](https://www.convex.dev/) |

**구독 (OAuth):**

- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

모델 참고: 많은 제공자/모델이 지원되지만, 최상의 경험과 낮은 프롬프트 주입 위험을 위해 사용 가능한 최신 세대의 가장 강력한 모델을 사용하세요. [온보딩](https://docs.openclaw.ai/start/onboarding)을 참조하세요.

## 모델 (선택 + 인증)

- 모델 구성 + CLI: [모델](https://docs.openclaw.ai/concepts/models)
- 인증 프로필 로테이션 (OAuth vs API 키) + 폴백: [모델 페일오버](https://docs.openclaw.ai/concepts/model-failover)

## 설치 (권장)

런타임: **Node ≥22**.

```bash
npm install -g openclaw@latest
# 또는: pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

OpenClaw Onboard는 Gateway 데몬(launchd/systemd 사용자 서비스)을 설치하여 계속 실행되도록 합니다.

## 빠른 시작 (TL;DR)

런타임: **Node ≥22**.

초보자 가이드 전체 (인증, 페어링, 채널): [시작하기](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# 메시지 보내기
openclaw message send --to +1234567890 --message "Hello from OpenClaw"

# 어시스턴트와 대화 (선택적으로 연결된 채널로 전달: WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/IRC/Microsoft Teams/Matrix/Feishu/LINE/Mattermost/Nextcloud Talk/Nostr/Synology Chat/Tlon/Twitch/Zalo/Zalo Personal/WebChat)
openclaw agent --message "Ship checklist" --thinking high
```

업그레이드하시나요? [업데이트 가이드](https://docs.openclaw.ai/install/updating) (그리고 `openclaw doctor` 실행).

## 개발 채널

- **stable**: 태그된 릴리스 (`vYYYY.M.D` 또는 `vYYYY.M.D-<patch>`), npm dist-tag `latest`.
- **beta**: 프리릴리스 태그 (`vYYYY.M.D-beta.N`), npm dist-tag `beta` (macOS 앱이 누락될 수 있음).
- **dev**: `main`의 이동 헤드, npm dist-tag `dev` (게시될 때).

채널 전환 (git + npm): `openclaw update --channel stable|beta|dev`.
세부 정보: [개발 채널](https://docs.openclaw.ai/install/development-channels).

## 소스에서 설치 (개발)

소스에서 빌드하려면 `pnpm`을 선호합니다. TypeScript를 직접 실행하려면 Bun은 선택 사항입니다.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # 첫 실행 시 UI 종속성 자동 설치
pnpm build

pnpm openclaw onboard --install-daemon

# 개발 루프 (소스/구성 변경 시 자동 재로드)
pnpm gateway:watch
```

참고: `pnpm openclaw ...`는 TypeScript를 직접 실행합니다 (`tsx` 사용). `pnpm build`는 Node / 패키지된 `openclaw` 바이너리를 통해 실행하기 위한 `dist/`를 생성합니다.

## 보안 기본값 (DM 액세스)

OpenClaw는 실제 메시징 표면에 연결됩니다. 인바운드 DM을 **신뢰할 수 없는 입력**으로 취급하세요.

전체 보안 가이드: [보안](https://docs.openclaw.ai/gateway/security)

Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack의 기본 동작:

- **DM 페어링** (`dmPolicy="pairing"` / `channels.discord.dmPolicy="pairing"` / `channels.slack.dmPolicy="pairing"`; 레거시: `channels.discord.dm.policy`, `channels.slack.dm.policy`): 알 수 없는 발신자는 짧은 페어링 코드를 받으며 봇은 메시지를 처리하지 않습니다.
- 승인: `openclaw pairing approve <channel> <code>` (그러면 발신자가 로컬 허용 목록 저장소에 추가됩니다).
- 공개 인바운드 DM은 명시적 옵트인이 필요합니다: `dmPolicy="open"`을 설정하고 채널 허용 목록에 `"*"`를 포함하세요 (`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`; 레거시: `channels.discord.dm.allowFrom`, `channels.slack.dm.allowFrom`).

`openclaw doctor`를 실행하여 위험하거나 잘못 구성된 DM 정책을 확인하세요.

## 주요 기능

- **[로컬 우선 게이트웨이](https://docs.openclaw.ai/gateway)** — 세션, 채널, 도구 및 이벤트를 위한 단일 제어 플레인.
- **[다중 채널 인박스](https://docs.openclaw.ai/channels)** — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), iMessage (레거시), IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal, WebChat, macOS, iOS/Android.
- **[다중 에이전트 라우팅](https://docs.openclaw.ai/gateway/configuration)** — 인바운드 채널/계정/피어를 격리된 에이전트로 라우팅 (워크스페이스 + 에이전트별 세션).
- **[Voice Wake](https://docs.openclaw.ai/nodes/voicewake) + [Talk Mode](https://docs.openclaw.ai/nodes/talk)** — macOS/iOS의 웨이크 워드 및 Android의 연속 음성 (ElevenLabs + 시스템 TTS 폴백).
- **[라이브 Canvas](https://docs.openclaw.ai/platforms/mac/canvas)** — [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)가 있는 에이전트 기반 시각적 워크스페이스.
- **[일급 도구](https://docs.openclaw.ai/tools)** — 브라우저, 캔버스, 노드, cron, 세션 및 Discord/Slack 액션.
- **[컴패니언 앱](https://docs.openclaw.ai/platforms/macos)** — macOS 메뉴 바 앱 + iOS/Android [노드](https://docs.openclaw.ai/nodes).
- **[온보딩](https://docs.openclaw.ai/start/wizard) + [스킬](https://docs.openclaw.ai/tools/skills)** — 번들/관리/워크스페이스 스킬이 포함된 온보딩 기반 설정.

## 스타 히스토리

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

## 지금까지 구축한 모든 것

### 핵심 플랫폼

- 세션, 프레즌스, 구성, cron, 웹훅, [Control UI](https://docs.openclaw.ai/web) 및 [Canvas 호스트](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)가 있는 [Gateway WS 제어 플레인](https://docs.openclaw.ai/gateway).
- [CLI 인터페이스](https://docs.openclaw.ai/tools/agent-send): gateway, agent, send, [온보딩](https://docs.openclaw.ai/start/wizard) 및 [doctor](https://docs.openclaw.ai/gateway/doctor).
- 도구 스트리밍 및 블록 스트리밍이 있는 RPC 모드의 [Pi 에이전트 런타임](https://docs.openclaw.ai/concepts/agent).
- [세션 모델](https://docs.openclaw.ai/concepts/session): 직접 채팅을 위한 `main`, 그룹 격리, 활성화 모드, 큐 모드, 답장. 그룹 규칙: [그룹](https://docs.openclaw.ai/channels/groups).
- [미디어 파이프라인](https://docs.openclaw.ai/nodes/images): 이미지/오디오/비디오, 전사 훅, 크기 제한, 임시 파일 수명 주기. 오디오 세부 정보: [오디오](https://docs.openclaw.ai/nodes/audio).

### 채널

- **WhatsApp**: 공식 Business API + whatsapp-web.js (로컬). 가이드: [WhatsApp](https://docs.openclaw.ai/channels/whatsapp).
- **Telegram**: 봇 + 사용자 계정 (MTProto). 가이드: [Telegram](https://docs.openclaw.ai/channels/telegram).
- **Discord**: 봇 + 사용자 selfbot. 가이드: [Discord](https://docs.openclaw.ai/channels/discord).
- **Slack**: 봇 + 워크스페이스 앱. 가이드: [Slack](https://docs.openclaw.ai/channels/slack).
- **Google Chat**: 봇 API. 가이드: [Google Chat](https://docs.openclaw.ai/channels/google-chat).
- **Signal**: signal-cli. 가이드: [Signal](https://docs.openclaw.ai/channels/signal).
- **iMessage**: OSX-Messages 브리지 (레거시) / BlueBubbles. 가이드: [iMessage](https://docs.openclaw.ai/channels/imessage).
- **Microsoft Teams**: 봇 프레임워크. 가이드: [Teams](https://docs.openclaw.ai/channels/teams).
- **Matrix**: matrix-js-sdk. 가이드: [Matrix](https://docs.openclaw.ai/channels/matrix).
- **IRC**: irc 클라이언트. 가이드: [IRC](https://docs.openclaw.ai/channels/irc).
- 추가 채널: Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal.

### 도구

- **[Browser](https://docs.openclaw.ai/tools/browser)**: Playwright 기반 브라우저 자동화, 스크린샷, 상호 작용.
- **[Canvas](https://docs.openclaw.ai/platforms/mac/canvas)**: 에이전트가 제어하는 라이브 시각적 워크스페이스.
- **[Cron](https://docs.openclaw.ai/tools/cron)**: 예약된 작업 및 자동화.
- **[Sessions](https://docs.openclaw.ai/concepts/session)**: 다중 세션 관리 및 격리.
- **[Skills](https://docs.openclaw.ai/tools/skills)**: 재사용 가능한 워크플로우 및 기능.

### 플랫폼

- **[macOS 앱](https://docs.openclaw.ai/platforms/macos)**: 메뉴 바 통합, Voice Wake, Canvas.
- **[iOS 앱](https://docs.openclaw.ai/platforms/ios)**: 모바일 노드, Voice Wake.
- **[Android 앱](https://docs.openclaw.ai/platforms/android)**: 모바일 노드, 연속 음성.
- **[Web UI](https://docs.openclaw.ai/web)**: 브라우저 기반 Control UI.

## 커뮤니티

- **[Discord](https://discord.gg/clawd)**: 공식 커뮤니티 서버
- **[GitHub Discussions](https://github.com/openclaw/openclaw/discussions)**: 질문 및 토론
- **[GitHub Issues](https://github.com/openclaw/openclaw/issues)**: 버그 리포트 및 기능 요청

## 기여

기여를 환영합니다! [기여 가이드](CONTRIBUTING.md)를 참조하세요.

## 라이선스

[MIT License](LICENSE)

---

**참고**: 이 문서는 [원본 README](README.md)의 한국어 번역입니다. 최신 정보는 영문 원본을 참조하세요.
