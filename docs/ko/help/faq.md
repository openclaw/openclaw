---
summary: "OpenClaw 설정, 구성 및 사용에 관한 자주 묻는 질문"
title: "자주 묻는 질문"
---

# 자주 묻는 질문

실제 환경 설정(로컬 개발, VPS, 다중 에이전트, OAuth/API 키, 모델 페일오버)에 대한 빠른 답변과 심층적인 문제 해결을 제공합니다. 런타임 진단은 [문제 해결](/gateway/troubleshooting)을 참고하십시오. 전체 구성 레퍼런스는 [구성](/gateway/configuration)을 참고하십시오.

## Table of contents

- [빠른 시작 및 최초 실행 설정]
  - 가장 빠르게 해결하는 방법은 무엇인가요?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw 를 설치하고 설정하는 권장 방법은 무엇인가요?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [온보딩 이후 대시보드는 어떻게 여나요?](#how-do-i-open-the-dashboard-after-onboarding)
  - [localhost 와 원격에서 대시보드 토큰은 어떻게 인증하나요?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [필요한 런타임은 무엇인가요?](#what-runtime-do-i-need)
  - [Raspberry Pi 에서 실행되나요?](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi 설치 팁이 있나요?](#any-tips-for-raspberry-pi-installs)
  - ['wake up my friend' 에서 멈추고 온보딩이 진행되지 않습니다. 어떻게 해야 하나요?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [온보딩을 다시 하지 않고 새 머신(Mac mini)으로 이전할 수 있나요?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [최신 버전의 변경 사항은 어디에서 보나요?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [docs.openclaw.ai 에 접근할 수 없습니다(SSL 오류). 어떻게 하나요?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable 과 beta 의 차이는 무엇인가요?](#whats-the-difference-between-stable-and-beta)
  - [beta 버전은 어떻게 설치하며 beta 와 dev 의 차이는 무엇인가요?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [최신 빌드를 사용해 보려면 어떻게 하나요?](#how-do-i-try-the-latest-bits)
  - [설치와 온보딩에는 보통 얼마나 걸리나요?](#how-long-does-install-and-onboarding-usually-take)
  - [설치 프로그램이 멈췄나요? 더 많은 피드백을 얻으려면?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows 설치 시 git 을 찾을 수 없거나 openclaw 가 인식되지 않습니다](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [문서에서 답을 찾지 못했습니다. 더 나은 답을 얻으려면?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Linux 에 OpenClaw 를 설치하려면 어떻게 하나요?](#how-do-i-install-openclaw-on-linux)
  - [VPS 에 OpenClaw 를 설치하려면 어떻게 하나요?](#how-do-i-install-openclaw-on-a-vps)
  - [클라우드/VPS 설치 가이드는 어디에 있나요?](#where-are-the-cloudvps-install-guides)
  - [OpenClaw 에게 스스로 업데이트하도록 요청할 수 있나요?](#can-i-ask-openclaw-to-update-itself)
  - [온보딩 마법사는 실제로 무엇을 하나요?](#what-does-the-onboarding-wizard-actually-do)
  - [이걸 실행하려면 Claude 또는 OpenAI 구독이 필요한가요?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [API 키 없이 Claude Max 구독을 사용할 수 있나요?](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic "setup-token" 인증은 어떻게 동작하나요?](#how-does-anthropic-setuptoken-auth-work)
  - [Anthropic setup-token 은 어디에서 찾나요?](#where-do-i-find-an-anthropic-setuptoken)
  - [Claude 구독 인증(Claude Pro 또는 Max)을 지원하나요?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Anthropic 에서 HTTP 429 ratelimiterror 가 표시되는 이유는 무엇인가요?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock 을 지원하나요?](#is-aws-bedrock-supported)
  - [Codex 인증은 어떻게 동작하나요?](#how-does-codex-auth-work)
  - [OpenAI 구독 인증(Codex OAuth)을 지원하나요?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Gemini CLI OAuth 는 어떻게 설정하나요?](#how-do-i-set-up-gemini-cli-oauth)
  - [가벼운 대화에 로컬 모델을 사용해도 괜찮나요?](#is-a-local-model-ok-for-casual-chats)
  - [호스팅된 모델 트래픽을 특정 리전에 유지하려면 어떻게 하나요?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [설치하려면 Mac Mini 를 꼭 사야 하나요?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage 지원을 위해 Mac mini 가 필요한가요?](#do-i-need-a-mac-mini-for-imessage-support)
  - [OpenClaw 를 실행하기 위해 Mac mini 를 구매하면 MacBook Pro 에 연결할 수 있나요?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Bun 을 사용할 수 있나요?](#can-i-use-bun)
  - [Telegram: allowFrom 에 무엇을 넣어야 하나요?](#telegram-what-goes-in-allowfrom)
  - [여러 사람이 서로 다른 OpenClaw 인스턴스에서 하나의 WhatsApp 번호를 사용할 수 있나요?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - ['빠른 채팅' 에이전트와 '코딩용 Opus' 에이전트를 동시에 실행할 수 있나요?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Linux 에서 Homebrew 가 동작하나요?](#does-homebrew-work-on-linux)
  - [해커블(git) 설치와 npm 설치의 차이는 무엇인가요?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [나중에 npm 과 git 설치를 전환할 수 있나요?](#can-i-switch-between-npm-and-git-installs-later)
  - [Gateway 를 노트북에서 실행해야 하나요, 아니면 VPS 에서 실행해야 하나요?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [OpenClaw 를 전용 머신에서 실행하는 것이 얼마나 중요한가요?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [최소 VPS 요구 사항과 권장 OS 는 무엇인가요?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [VM 에서 OpenClaw 를 실행할 수 있나요? 요구 사항은 무엇인가요?](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [OpenClaw 란 무엇인가요?](#what-is-openclaw)
  - [한 문단으로 설명하는 OpenClaw](#what-is-openclaw-in-one-paragraph)
  - [가치 제안은 무엇인가요?](#whats-the-value-proposition)
  - [방금 설정했습니다. 먼저 무엇을 하면 좋을까요?](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw 의 일상적인 상위 5가지 활용 사례는 무엇인가요?](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw 가 SaaS 를 위한 리드 생성 아웃리치, 광고, 블로그 작성에 도움이 되나요?](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [웹 개발에서 Claude Code 대비 장점은 무엇인가요?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills 와 자동화](#skills-and-automation)
  - [리포지토리를 더럽히지 않고 Skills 를 커스터마이즈하려면 어떻게 하나요?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [커스텀 폴더에서 Skills 를 로드할 수 있나요?](#can-i-load-skills-from-a-custom-folder)
  - [작업별로 서로 다른 모델을 사용하려면 어떻게 하나요?](#how-can-i-use-different-models-for-different-tasks)
  - [무거운 작업 중에 봇이 멈춥니다. 이를 오프로딩하려면?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron 또는 알림이 실행되지 않습니다. 무엇을 확인해야 하나요?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Linux 에서 Skills 를 설치하려면 어떻게 하나요?](#how-do-i-install-skills-on-linux)
  - [OpenClaw 가 일정에 따라 또는 백그라운드에서 지속적으로 작업을 실행할 수 있나요?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Linux 에서 Apple macOS 전용 Skills 를 실행할 수 있나요?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Notion 또는 HeyGen 통합이 있나요?](#do-you-have-a-notion-or-heygen-integration)
  - [브라우저 제어를 위한 Chrome 확장 프로그램은 어떻게 설치하나요?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [샌드박스화와 메모리](#sandboxing-and-memory)
  - [전용 샌드박스화 문서가 있나요?](#is-there-a-dedicated-sandboxing-doc)
  - [호스트 폴더를 샌드박스에 바인딩하려면 어떻게 하나요?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [메모리는 어떻게 동작하나요?](#how-does-memory-work)
  - [메모리가 계속 잊어버립니다. 어떻게 고정하나요?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [메모리는 영구적으로 유지되나요? 한계는 무엇인가요?](#does-memory-persist-forever-what-are-the-limits)
  - [의미 기반 메모리 검색에는 OpenAI API 키가 필요한가요?](#does-semantic-memory-search-require-an-openai-api-key)
- [디스크 상의 위치](#where-things-live-on-disk)
  - [OpenClaw 에서 사용하는 모든 데이터는 로컬에 저장되나요?](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw 는 데이터를 어디에 저장하나요?](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md 는 어디에 두어야 하나요?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [권장 백업 전략은 무엇인가요?](#whats-the-recommended-backup-strategy)
  - [OpenClaw 를 완전히 제거하려면 어떻게 하나요?](#how-do-i-completely-uninstall-openclaw)
  - [에이전트가 워크스페이스 밖에서 작업할 수 있나요?](#can-agents-work-outside-the-workspace)
  - [원격 모드입니다. 세션 저장소는 어디에 있나요?](#im-in-remote-mode-where-is-the-session-store)
- [구성 기본](#config-basics)
  - [What format is the config? Where is it?](#what-format-is-the-config-where-is-it)
  - [gatewaybind lan 또는 tailnet 을 설정했더니 아무것도 리슨하지 않고 UI 에서 unauthorized 가 표시됩니다](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [왜 이제 localhost 에서도 토큰이 필요한가요?](#why-do-i-need-a-token-on-localhost-now)
  - [구성을 변경한 후 재시작해야 하나요?](#do-i-have-to-restart-after-changing-config)
  - [웹 검색(및 웹 가져오기)을 활성화하려면 어떻게 하나요?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply 가 구성을 지웠습니다. 어떻게 복구하고 방지하나요?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [여러 디바이스에 걸쳐 전문화된 워커와 함께 중앙 Gateway 를 실행하려면 어떻게 하나요?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [OpenClaw 브라우저를 헤드리스로 실행할 수 있나요?](#can-the-openclaw-browser-run-headless)
  - [브라우저 제어에 Brave 를 사용하려면 어떻게 하나요?](#how-do-i-use-brave-for-browser-control)
- [원격 Gateway 와 노드](#remote-gateways-and-nodes)
  - [Telegram, Gateway, 노드 간에 명령은 어떻게 전파되나요?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Gateway 가 원격에 호스팅된 경우 에이전트가 내 컴퓨터에 어떻게 접근하나요?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale 이 연결되었지만 응답이 없습니다. 어떻게 하나요?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [두 개의 OpenClaw 인스턴스가 서로 통신할 수 있나요(로컬 + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [여러 에이전트에 대해 별도의 VPS 가 필요한가요?](#do-i-need-separate-vpses-for-multiple-agents)
  - [VPS 에서 SSH 하는 대신 개인 노트북에 노드를 사용하는 이점이 있나요?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [노드는 Gateway 서비스를 실행하나요?](#do-nodes-run-a-gateway-service)
  - [구성을 적용하는 API / RPC 방식이 있나요?](#is-there-an-api-rpc-way-to-apply-config)
  - [첫 설치를 위한 최소한의 '합리적인' 구성은 무엇인가요?](#whats-a-minimal-sane-config-for-a-first-install)
  - [VPS 에서 Tailscale 을 설정하고 Mac 에서 연결하려면 어떻게 하나요?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Mac 노드를 원격 Gateway 에 연결하려면 어떻게 하나요(Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [두 번째 노트북에 설치해야 하나요, 아니면 노드를 추가하면 되나요?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [환경 변수와 .env 로딩](#env-vars-and-env-loading)
  - [OpenClaw 는 환경 변수를 어떻게 로드하나요?](#how-does-openclaw-load-environment-variables)
  - ['서비스를 통해 Gateway 를 시작했더니 환경 변수가 사라졌습니다.' 어떻게 하나요?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [`COPILOT_GITHUB_TOKEN` 를 설정했는데 모델 상태에 'Shell env: off.' 가 표시됩니다. 왜인가요?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [세션과 다중 채팅](#sessions-and-multiple-chats)
  - [새로운 대화를 시작하려면 어떻게 하나요?](#how-do-i-start-a-fresh-conversation)
  - [`/new` 를 보내지 않으면 세션이 자동으로 초기화되나요?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [여러 OpenClaw 인스턴스로 하나의 CEO 와 여러 에이전트 팀을 만들 수 있나요?](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [작업 도중 컨텍스트가 잘렸습니다. 어떻게 방지하나요?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [설치를 유지한 채 OpenClaw 를 완전히 초기화하려면 어떻게 하나요?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - ['context too large' 오류가 발생합니다. 어떻게 초기화 또는 압축하나요?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - ['LLM request rejected: messages.N.content.X.tool_use.input: Field required' 오류가 발생하는 이유는 무엇인가요?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [30분마다 하트비트 메시지가 오는 이유는 무엇인가요?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [WhatsApp 그룹에 '봇 계정' 을 추가해야 하나요?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [WhatsApp 그룹의 JID 는 어떻게 얻나요?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [그룹에서 OpenClaw 가 응답하지 않는 이유는 무엇인가요?](#why-doesnt-openclaw-reply-in-a-group)
  - [그룹/스레드는 다이렉트 메시지와 컨텍스트를 공유하나요?](#do-groupsthreads-share-context-with-dms)
  - [워크스페이스와 에이전트는 몇 개까지 만들 수 있나요?](#how-many-workspaces-and-agents-can-i-create)
  - [Slack 에서 여러 봇 또는 채팅을 동시에 실행할 수 있나요? 설정은 어떻게 하나요?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [모델: 기본값, 선택, 별칭, 전환](#models-defaults-selection-aliases-switching)
  - ['기본 모델' 이란 무엇인가요?](#what-is-the-default-model)
  - [어떤 모델을 권장하나요?](#what-model-do-you-recommend)
  - [구성을 지우지 않고 모델을 전환하려면 어떻게 하나요?](#how-do-i-switch-models-without-wiping-my-config)
  - [자가 호스팅 모델(llama.cpp, vLLM, Ollama)을 사용할 수 있나요?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw, Flawd, Krill 은 어떤 모델을 사용하나요?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [재시작 없이 즉시 모델을 전환하려면 어떻게 하나요?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [일상 작업에는 GPT 5.2 를, 코딩에는 Codex 5.3 을 사용할 수 있나요?](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - ['Model … is not allowed' 가 표시되고 응답이 없는 이유는 무엇인가요?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - ['Unknown model: minimax/MiniMax-M2.1' 이 표시되는 이유는 무엇인가요?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [기본값으로 MiniMax 를 사용하고 복잡한 작업에는 OpenAI 를 사용할 수 있나요?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt 는 내장 단축키인가요?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [모델 단축키(별칭)를 정의/재정의하려면 어떻게 하나요?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [OpenRouter 또는 Z.AI 와 같은 다른 프로바이더의 모델을 추가하려면 어떻게 하나요?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [모델 페일오버와 'All models failed'](#model-failover-and-all-models-failed)
  - [페일오버는 어떻게 동작하나요?](#how-does-failover-work)
  - [이 오류는 무엇을 의미하나요?](#what-does-this-error-mean)
  - [`No credentials found for profile "anthropic:default"` 수정 체크리스트](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [왜 Google Gemini 도 시도하다가 실패했나요?](#why-did-it-also-try-google-gemini-and-fail)
- [인증 프로필: 개념과 관리 방법](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [인증 프로필이란 무엇인가요?](#what-is-an-auth-profile)
  - [일반적인 프로필 ID 는 무엇인가요?](#what-are-typical-profile-ids)
  - [어떤 인증 프로필을 먼저 시도할지 제어할 수 있나요?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth 와 API 키의 차이는 무엇인가요?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: 포트, '이미 실행 중', 원격 모드](#gateway-ports-already-running-and-remote-mode)
  - [Gateway 는 어떤 포트를 사용하나요?](#what-port-does-the-gateway-use)
  - [왜 `openclaw gateway status` 는 `Runtime: running` 이지만 `RPC probe: failed` 인가요?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [왜 `openclaw gateway status` 에서 `Config (cli)` 와 `Config (service)` 가 다르게 표시되나요?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - ['another gateway instance is already listening' 은 무엇을 의미하나요?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [원격 모드에서 OpenClaw 를 실행하려면 어떻게 하나요(클라이언트가 다른 곳의 Gateway 에 연결)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [Control UI 에서 'unauthorized' 가 표시되거나 계속 재연결됩니다. 어떻게 하나요?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [`gateway.bind: "tailnet"` 를 설정했는데 바인딩되지 않거나 아무것도 리슨하지 않습니다](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [같은 호스트에서 여러 Gateway 를 실행할 수 있나요?](#can-i-run-multiple-gateways-on-the-same-host)
  - ['invalid handshake' / code 1008 은 무엇을 의미하나요?](#what-does-invalid-handshake-code-1008-mean)
- [로깅과 디버깅](#logging-and-debugging)
  - [로그는 어디에 있나요?](#where-are-logs)
  - [Gateway 서비스를 시작/중지/재시작하려면 어떻게 하나요?](#how-do-i-startstoprestart-the-gateway-service)
  - [Windows 에서 터미널을 닫았습니다. OpenClaw 를 어떻게 재시작하나요?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway 는 실행 중이지만 응답이 오지 않습니다. 무엇을 확인해야 하나요?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ['Disconnected from gateway: no reason' - 어떻게 하나요?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands 가 네트워크 오류로 실패합니다. 무엇을 확인해야 하나요?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI 에 출력이 없습니다. 무엇을 확인해야 하나요?](#tui-shows-no-output-what-should-i-check)
  - [Gateway 를 완전히 중지했다가 다시 시작하려면 어떻게 하나요?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [무언가 실패할 때 더 많은 세부 정보를 가장 빠르게 얻는 방법은 무엇인가요?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [미디어와 첨부 파일](#media-and-attachments)
  - [Skill 이 이미지/PDF 를 생성했지만 아무것도 전송되지 않았습니다](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [보안과 접근 제어](#security-and-access-control)
  - [수신 다이렉트 메시지에 OpenClaw 를 노출하는 것이 안전한가요?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [프롬프트 인젝션은 공개 봇에서만 문제인가요?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [봇에 별도의 이메일, GitHub 계정 또는 전화번호가 필요할까요?](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [문자 메시지에 대한 자율성을 부여할 수 있나요? 안전한가요?](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [개인 비서 작업에 더 저렴한 모델을 사용할 수 있나요?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Telegram 에서 `/start` 를 실행했지만 페어링 코드가 오지 않았습니다](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: 내 연락처에 메시지를 보내나요? 페어링은 어떻게 동작하나요?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [채팅 명령, 작업 중단, '멈추지 않습니다'](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [내부 시스템 메시지가 채팅에 표시되지 않게 하려면 어떻게 하나요?](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [실행 중인 작업을 중지/취소하려면 어떻게 하나요?](#how-do-i-stopcancel-a-running-task)
  - [How do I send a Discord message from Telegram? ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [봇이 연속 메시지를 '무시' 하는 것처럼 느껴지는 이유는 무엇인가요?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 문제가 있을 때 처음 60초

1. **빠른 상태 확인(첫 점검)**

   ```bash
   openclaw status
   ```

   빠른 로컬 요약: OS + 업데이트, gateway/서비스 접근성, 에이전트/세션, 프로바이더 구성 + 런타임 문제(gateway 가 접근 가능한 경우).

2. **공유 가능한 보고서(안전)**

   ```bash
   openclaw status --all
   ```

   로그 꼬리 포함 읽기 전용 진단(토큰은 마스킹됨).

3. **데몬 + 포트 상태**

   ```bash
   openclaw gateway status
   ```

   감독자 런타임 vs RPC 접근성, 프로브 대상 URL, 서비스가 사용했을 가능성이 높은 구성 표시.

4. **심층 프로브**

   ```bash
   openclaw status --deep
   ```

   gateway 헬스 체크 + 프로바이더 프로브 실행(gateway 접근 필요). [Health](/gateway/health) 참고.

5. **최신 로그 추적**

   ```bash
   openclaw logs --follow
   ```

   RPC 가 다운된 경우 다음으로 대체:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   파일 로그는 서비스 로그와 분리되어 있습니다. [Logging](/logging) 및 [문제 해결](/gateway/troubleshooting)을 참고하십시오.

6. **Doctor 실행(복구)**

   ```bash
   openclaw doctor
   ```

   구성/상태 복구 및 헬스 체크 실행. [Doctor](/gateway/doctor) 참고.

7. **Gateway 스냅샷**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   실행 중인 gateway 에 전체 스냅샷을 요청합니다(WS 전용). [Health](/gateway/health) 참고.

## 빠른 시작 및 최초 실행 설정

### Im stuck whats the fastest way to get unstuck

**머신을 직접 볼 수 있는** 로컬 AI 에이전트를 사용하십시오. Discord 에서 질문하는 것보다 훨씬 효과적입니다. 대부분의 '막힘' 사례는 **로컬 구성 또는 환경 문제**이기 때문에 원격 도움으로는 점검이 어렵습니다.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

이 도구들은 리포지토리를 읽고, 명령을 실행하고, 로그를 검사하여 머신 수준 설정(PATH, 서비스, 권한, 인증 파일)을 수정하는 데 도움을 줄 수 있습니다. 해커블(git) 설치를 통해 **전체 소스 체크아웃**을 제공하십시오:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

이 방식은 OpenClaw 를 **git 체크아웃에서 설치**하므로, 에이전트가 코드와 문서를 읽고 현재 실행 중인 정확한 버전에 대해 추론할 수 있습니다. 나중에 `--install-method git` 없이 설치 프로그램을 다시 실행하여 언제든지 stable 로 되돌릴 수 있습니다.

팁: 에이전트에게 수정 사항을 **계획하고 감독**하도록 요청한 뒤(단계별), 필요한 명령만 실행하게 하십시오. 변경 사항이 작아지고 감사하기 쉬워집니다.

실제 버그나 수정 사항을 발견했다면 GitHub 이슈를 등록하거나 PR 을 보내주십시오:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

도움을 요청할 때 다음 명령으로 시작하십시오(출력 공유):

```bash
openclaw status
openclaw models status
openclaw doctor
```

What they do:

- `openclaw status`: gateway/에이전트 상태 + 기본 구성의 빠른 스냅샷.
- `openclaw models status`: 프로바이더 인증 + 모델 가용성 확인.
- `openclaw doctor`: 일반적인 구성/상태 문제 검증 및 복구.

기타 유용한 CLI 점검: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

빠른 디버그 루프: [문제가 있을 때 처음 60초](#first-60-seconds-if-somethings-broken).
설치 문서: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### What's the recommended way to install and set up OpenClaw

The repo recommends running from source and using the onboarding wizard:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

From source (contributors/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw onboard
```

If you don't have a global install yet, run it via `pnpm openclaw onboard`.

### How do I open the dashboard after onboarding

The wizard opens your browser with a clean (non-tokenized) dashboard URL right after onboarding and also prints the link in the summary. Keep that tab open; if it didn't launch, copy/paste the printed URL on the same machine.

### How do I authenticate the dashboard token on localhost vs remote

**Localhost (same machine):**

- Open `http://127.0.0.1:18789/`.
- If it asks for auth, paste the token from `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) into Control UI settings.
- Retrieve it from the gateway host: `openclaw config get gateway.auth.token` (or generate one: `openclaw doctor --generate-gateway-token`).

**Not on localhost:**

- **Tailscale Serve** (recommended): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. If `gateway.auth.allowTailscale` is `true`, identity headers satisfy auth (no token).
- **Tailnet bind**: run `openclaw gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, paste token in dashboard settings.
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/` and paste the token in Control UI settings.

See [Dashboard](/web/dashboard) and [Web surfaces](/web) for bind modes and auth details.

### What runtime do I need

Node **>= 22** is required. `pnpm` is recommended. Bun is **not recommended** for the Gateway.

### Does it run on Raspberry Pi

예. The Gateway is lightweight - docs list **512MB-1GB RAM**, **1 core**, and about **500MB**
disk as enough for personal use, and note that a **Raspberry Pi 4 can run it**.

1. 추가적인 여유 공간(로그, 미디어, 기타 서비스)을 원한다면 **2GB를 권장**하지만,
   절대적인 최소 요구사항은 아닙니다.

2. 팁: 작은 Pi/VPS로 Gateway를 호스팅하고, 로컬 화면/카메라/캔버스 또는 명령 실행을 위해
   노트북/휴대폰에서 \*\*노드(nodes)\*\*를 페어링할 수 있습니다. 3. [Nodes](/nodes)를 참고하세요.

### 4. Raspberry Pi 설치에 대한 팁이 있나요

5. 짧은 버전: 작동은 하지만, 거친 부분이 있을 것으로 예상하세요.

- 6. **64비트** OS를 사용하고 Node >= 22를 유지하세요.
- 7. 로그를 확인하고 빠르게 업데이트할 수 있도록 **해킹 가능한 (git) 설치**를 선호하세요.
- 8. 채널/스킬 없이 시작한 다음, 하나씩 추가하세요.
- 9. 이상한 바이너리 문제가 발생하면 보통 **ARM 호환성** 문제입니다.

10. 문서: [Linux](/platforms/linux), [Install](/install).

### 11. 깨우기 화면에서 멈췄고 친구 온보딩이 부화하지 않습니다. 이제 어떻게 하나요

12. 해당 화면은 Gateway가 도달 가능하고 인증되어 있는지에 따라 달라집니다. 13. TUI는 첫 부화 시
    "Wake up, my friend!"를 자동으로 전송합니다. 14. **응답 없이** 그 문구만 보이고
    토큰이 0에 머물러 있다면, 에이전트가 실행되지 않은 것입니다.

1. Gateway 를 재시작합니다:

```bash
openclaw gateway restart
```

2. 15. 상태 + 인증 확인:

```bash
16. openclaw status
openclaw models status
openclaw logs --follow
```

3. 17. 그래도 멈춘다면 다음을 실행하세요:

```bash
openclaw doctor
```

18. Gateway가 원격에 있다면, 터널/Tailscale 연결이 활성화되어 있고 UI가 올바른 Gateway를
    가리키고 있는지 확인하세요. 자세한 내용은 [Remote access](/gateway/remote) 를 참고하십시오.

### 19. 온보딩을 다시 하지 않고 새 머신(Mac mini)으로 설정을 마이그레이션할 수 있나요

예. 20. **state 디렉터리**와 **workspace**를 복사한 다음 Doctor를 한 번 실행하세요. 21. 이렇게 하면 **두 위치 모두**를 복사하는 한
봇을 "정확히 동일하게"(메모리, 세션 기록, 인증, 채널 상태)
유지할 수 있습니다:

1. 22. 새 머신에 OpenClaw를 설치하세요.
2. 23. 이전 머신에서 `$OPENCLAW_STATE_DIR` (기본값: `~/.openclaw`)를 복사하세요.
3. 24. 워크스페이스를 복사하세요 (기본값: `~/.openclaw/workspace`).
4. 25. `openclaw doctor`를 실행하고 Gateway 서비스를 재시작하세요.

26) 이렇게 하면 설정, 인증 프로필, WhatsApp 자격 증명, 세션, 메모리가 보존됩니다. 27. 원격 모드에 있다면,
    게이트웨이 호스트가 세션 저장소와 워크스페이스를 소유한다는 점을 기억하세요.

28. **중요:** 워크스페이스만 GitHub에 커밋/푸시하면
    **메모리 + 부트스트랩 파일**은 백업되지만, 세션 기록이나 인증은 **백업되지 않습니다**. 29. 이는
    `~/.openclaw/` 아래에 있습니다(예: `~/.openclaw/agents/<agentId>/sessions/`).

30. 관련: [Migrating](/install/migrating), [디스크에서 데이터가 저장되는 위치](/help/faq#where-does-openclaw-store-its-data),
    [Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
    [Remote mode](/gateway/remote).

### 31. 최신 버전의 새로운 내용은 어디에서 볼 수 있나요

32. GitHub 변경 로그를 확인하세요:
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

33. 최신 항목은 맨 위에 있습니다. 34. 최상단 섹션이 **Unreleased**로 표시되어 있다면,
    그다음 날짜가 있는 섹션이 최신 배포 버전입니다. 35. 항목은 **Highlights**, **Changes**, **Fixes**(필요 시 문서/기타 섹션 포함)로 그룹화되어 있습니다.

### 36. docs.openclaw.ai에 접속할 수 없고 SSL 오류가 납니다. 이제 어떻게 하나요

37. 일부 Comcast/Xfinity 연결은 Xfinity Advanced Security를 통해 `docs.openclaw.ai`를
    잘못 차단합니다. 38. 이를 비활성화하거나 `docs.openclaw.ai`를 허용 목록에 추가한 후 다시 시도하세요. 39. 자세한 내용:
    [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
38. 여기에서 신고하여 차단 해제에 도움을 주세요: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

아직도 사이트에 접속할 수 없다면, 문서는 GitHub에 미러되어 있습니다:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### stable과 beta의 차이는 무엇인가요

**Stable**과 **beta**는 별도의 코드 라인이 아니라 **npm dist-tag**입니다:

- `latest` = stable
- `beta` = 테스트용 초기 빌드

빌드는 **beta**로 배포해 테스트하고, 빌드가 충분히 안정적이면 **같은 버전을 `latest`로 승격**합니다. 그래서 beta와 stable이 **같은 버전**을 가리킬 수 있습니다.

변경 사항 확인:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 베타 버전은 어떻게 설치하나요? 그리고 beta와 dev의 차이는 무엇인가요

**Beta**는 npm dist-tag `beta`입니다 (`latest`와 동일할 수도 있음).
**Dev**는 `main`의 이동하는 최신 헤드(git)이며, 배포 시 npm dist-tag `dev`를 사용합니다.

원라이너(macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows 설치 프로그램(PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

자세한 내용: [개발 채널](/install/development-channels) 및 [설치 프로그램 플래그](/install/installer).

### 설치와 온보딩은 보통 얼마나 걸리나요

대략적인 가이드:

- **설치:** 2~5분
- **온보딩:** 구성하는 채널/모델 수에 따라 5~15분

멈춘 것처럼 보이면 [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)와 [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck)에 있는 빠른 디버그 루프를 사용하세요.

### 최신 버전을 사용해 보려면 어떻게 하나요

두 가지 방법:

1. **Dev 채널(git checkout):**

```bash
openclaw update --channel dev
```

이 명령은 `main` 브랜치로 전환하고 소스에서 업데이트합니다.

2. **해킹 가능한 설치(설치 프로그램 사이트에서):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

로컬에서 편집 가능한 저장소를 제공하며, 이후 git으로 업데이트할 수 있습니다.

수동으로 깨끗한 클론을 선호한다면 다음을 사용하세요:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

문서: [Update](/cli/update), [개발 채널](/install/development-channels),
[설치](/install).

### 설치 프로그램이 멈췄습니다. 더 많은 피드백을 받으려면 어떻게 하나요

\*\*자세한 출력(verbose)\*\*으로 설치 프로그램을 다시 실행하세요:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

verbose로 베타 설치:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

해킹 가능한(git) 설치의 경우:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

추가 옵션: [설치 프로그램 플래그](/install/installer).

### Windows 설치에서 git을 찾을 수 없다고 하거나 openclaw가 인식되지 않는다고 나옵니다

Two common Windows issues:

**1) npm error spawn git / git not found**

- Install **Git for Windows** and make sure `git` is on your PATH.
- Close and reopen PowerShell, then re-run the installer.

**2) openclaw is not recognized after install**

- Your npm global bin folder is not on PATH.

- Check the path:

  ```powershell
  npm config get prefix
  ```

- Ensure `<prefix>\\bin` is on PATH (on most systems it is `%AppData%\\npm`).

- Close and reopen PowerShell after updating PATH.

If you want the smoothest Windows setup, use **WSL2** instead of native Windows.
Docs: [Windows](/platforms/windows).

### The docs didnt answer my question how do I get a better answer

Use the **hackable (git) install** so you have the full source and docs locally, then ask
your bot (or Claude/Codex) _from that folder_ so it can read the repo and answer precisely.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

More detail: [Install](/install) and [Installer flags](/install/installer).

### How do I install OpenClaw on Linux

Short answer: follow the Linux guide, then run the onboarding wizard.

- Linux quick path + service install: [Linux](/platforms/linux).
- Full walkthrough: [Getting Started](/start/getting-started).
- Installer + updates: [Install & updates](/install/updating).

### How do I install OpenClaw on a VPS

Any Linux VPS works. Install on the server, then use SSH/Tailscale to reach the Gateway.

Guides: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Remote access: [Gateway remote](/gateway/remote).

### Where are the cloudVPS install guides

We keep a **hosting hub** with the common providers. Pick one and follow the guide:

- [VPS 호스팅](/vps) (모든 제공업체를 한곳에서)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

클라우드에서 동작하는 방식: **Gateway는 서버에서 실행**되며, 노트북/휴대폰에서 Control UI(또는 Tailscale/SSH)를 통해 접근합니다. 상태 + 워크스페이스는 서버에
저장되므로, 호스트를 단일 신뢰 소스로 취급하고 백업하세요.

클라우드 Gateway에 **노드**(Mac/iOS/Android/헤드리스)를 페어링하여
로컬 화면/카메라/캔버스에 접근하거나, Gateway는 클라우드에 유지한 채
노트북에서 명령을 실행할 수 있습니다.

허브: [플랫폼](/platforms). 원격 접근: [Gateway 원격](/gateway/remote).
노드: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### OpenClaw에게 자체 업데이트를 요청할 수 있나요

짧은 답변: **가능하지만, 권장하지 않습니다**. 업데이트 과정에서
Gateway가 재시작될 수 있으며(활성 세션이 끊김), 깨끗한 git 체크아웃이 필요할 수 있고
확인 프롬프트가 표시될 수 있습니다. 더 안전한 방법: 운영자로서 셸에서 업데이트를 실행하세요.

CLI 사용:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

에이전트에서 자동화해야 한다면:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

문서: [업데이트](/cli/update), [업데이트하기](/install/updating).

### 온보딩 마법사는 실제로 무엇을 하나요

`openclaw onboard`는 권장되는 설정 경로입니다. **로컬 모드**에서는 다음을 단계별로 안내합니다:

- **모델/인증 설정** (Claude 구독의 경우 Anthropic **setup-token** 권장, OpenAI Codex OAuth 지원, API 키 선택 사항, LM Studio 로컬 모델 지원)
- **워크스페이스** 위치 + 부트스트랩 파일
- **Gateway 설정** (바인드/포트/인증/tailscale)
- **프로바이더** (WhatsApp, Telegram, Discord, Mattermost (플러그인), Signal, iMessage)
- **데몬 설치** (macOS의 LaunchAgent; Linux/WSL2의 systemd 사용자 유닛)
- **헬스 체크** 및 **스킬** 선택

구성한 모델이 알 수 없거나 인증이 누락된 경우 경고도 표시합니다.

### 이를 실행하려면 Claude 또는 OpenAI 구독이 필요한가요

아니요. **API 키**(Anthropic/OpenAI/기타)를 사용하거나
**로컬 전용 모델**로 OpenClaw를 실행할 수 있어 데이터가 기기에 유지됩니다. 구독(Claude
Pro/Max 또는 OpenAI Codex)은 해당 프로바이더에 인증하는 선택적 방법입니다.

문서: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[로컬 모델](/gateway/local-models), [모델](/concepts/models).

### API 키 없이 Claude Max 구독을 사용할 수 있나요

예. API 키 대신 **setup-token**으로 인증할 수 있습니다. 이것이 구독 경로입니다.

Claude Pro/Max 구독에는 **API 키가 포함되어 있지 않으므로**, 구독 계정에는 이 방법이 올바른 접근입니다. 중요: 이 사용 방식이 구독 정책 및 약관에 따라 허용되는지 Anthropic에 확인해야 합니다.
가장 명시적이고 지원되는 경로를 원한다면 Anthropic API 키를 사용하세요.

### Anthropic setup-token 인증은 어떻게 동작하나요

`claude setup-token`은 Claude Code CLI를 통해 **토큰 문자열**을 생성합니다(웹 콘솔에서는 사용할 수 없음). **어떤 머신에서든** 실행할 수 있습니다. 마법사에서 \*\*Anthropic 토큰(설정 토큰 붙여넣기)\*\*을 선택하거나 `openclaw models auth paste-token --provider anthropic`으로 붙여넣으세요. 토큰은 **anthropic** 제공자에 대한 인증 프로필로 저장되며 API 키처럼 사용됩니다(자동 갱신 없음). 자세한 내용: [OAuth](/concepts/oauth).

### Anthropic 설정 토큰은 어디에서 찾나요

Anthropic 콘솔에는 **없습니다**. 설정 토큰은 **어떤 머신에서든** **Claude Code CLI**가 생성합니다:

```bash
claude setup-token
```

출력된 토큰을 복사한 다음, 마법사에서 \*\*Anthropic 토큰(설정 토큰 붙여넣기)\*\*을 선택하세요. 게이트웨이 호스트에서 실행하려면 `openclaw models auth setup-token --provider anthropic`을 사용하세요. 다른 곳에서 `claude setup-token`을 실행했다면, 게이트웨이 호스트에서 `openclaw models auth paste-token --provider anthropic`으로 붙여넣으세요. [Anthropic](/providers/anthropic)을 참고하세요.

### Claude 구독 인증(Claude Pro 또는 Max)을 지원하나요

네 - **설정 토큰**을 통해 가능합니다. OpenClaw는 더 이상 Claude Code CLI OAuth 토큰을 재사용하지 않습니다. 설정 토큰이나 Anthropic API 키를 사용하세요. 토큰은 어디에서든 생성한 뒤 게이트웨이 호스트에 붙여넣으세요. [Anthropic](/providers/anthropic) 및 [OAuth](/concepts/oauth)을 참고하세요.

참고: Claude 구독 액세스는 Anthropic의 약관이 적용됩니다. 프로덕션 또는 다중 사용자 워크로드에는 일반적으로 API 키가 더 안전한 선택입니다.

### 왜 Anthropic에서 HTTP 429 ratelimiterror가 발생하나요

이는 현재 윈도우에서 **Anthropic 할당량/속도 제한**이 소진되었음을 의미합니다. **Claude 구독**(설정 토큰 또는 Claude Code OAuth)을 사용하는 경우, 윈도우가
재설정될 때까지 기다리거나 요금제를 업그레이드하세요. **Anthropic API 키**를 사용하는 경우, Anthropic 콘솔에서
사용량/청구를 확인하고 필요에 따라 한도를 상향하세요.

팁: 제공자가 속도 제한에 걸려도 OpenClaw가 계속 응답할 수 있도록 **대체 모델**을 설정하세요.
[Models](/cli/models) 및 [OAuth](/concepts/oauth)을 참고하세요.

### AWS Bedrock을 지원하나요

네 - pi-ai의 **Amazon Bedrock (Converse)** 제공자를 **수동 설정**으로 지원합니다. 게이트웨이 호스트에 AWS 자격 증명/리전을 제공하고 모델 구성에 Bedrock 제공자 항목을 추가해야 합니다. [Amazon Bedrock](/providers/bedrock) 및 [Model providers](/providers/models)을 참고하세요. 관리형 키 흐름을 선호한다면, Bedrock 앞단에 OpenAI 호환 프록시를 두는 것도 여전히 유효한 옵션입니다.

### Codex 인증은 어떻게 작동하나요

OpenClaw는 OAuth(ChatGPT 로그인)를 통해 \*\*OpenAI Code (Codex)\*\*를 지원합니다. 마법사는 OAuth 흐름을 실행할 수 있으며, 적절한 경우 기본 모델을 `openai-codex/gpt-5.3-codex`로 설정합니다. [Model providers](/concepts/model-providers) 및 [Wizard](/start/wizard)를 참고하세요.

### OpenAI 구독 인증 Codex OAuth를 지원하나요

예. OpenClaw는 **OpenAI Code (Codex) 구독 OAuth**를 완전히 지원합니다. 온보딩 마법사가
OAuth 흐름을 대신 실행해 줄 수 있습니다.

[OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), 및 [Wizard](/start/wizard)를 참고하세요.

### Gemini CLI OAuth는 어떻게 설정하나요

Gemini CLI는 `openclaw.json`에 클라이언트 ID나 시크릿을 넣는 방식이 아니라 **플러그인 인증 흐름**을 사용합니다.

단계:

1. Enable the plugin: `openclaw plugins enable google-gemini-cli-auth`
2. 로그인: `openclaw models auth login --provider google-gemini-cli --set-default`

This stores OAuth tokens in auth profiles on the gateway host. Details: [Model providers](/concepts/model-providers).

### Is a local model OK for casual chats

Usually no. OpenClaw needs large context + strong safety; small cards truncate and leak. If you must, run the **largest** MiniMax M2.1 build you can locally (LM Studio) and see [/gateway/local-models](/gateway/local-models). Smaller/quantized models increase prompt-injection risk - see [Security](/gateway/security).

### How do I keep hosted model traffic in a specific region

Pick region-pinned endpoints. OpenRouter exposes US-hosted options for MiniMax, Kimi, and GLM; choose the US-hosted variant to keep data in-region. You can still list Anthropic/OpenAI alongside these by using `models.mode: "merge"` so fallbacks stay available while respecting the regioned provider you select.

### Do I have to buy a Mac Mini to install this

아니요. OpenClaw runs on macOS or Linux (Windows via WSL2). A Mac mini is optional - some people
buy one as an always-on host, but a small VPS, home server, or Raspberry Pi-class box works too.

You only need a Mac **for macOS-only tools**. For iMessage, use [BlueBubbles](/channels/bluebubbles) (recommended) - the BlueBubbles server runs on any Mac, and the Gateway can run on Linux or elsewhere. If you want other macOS-only tools, run the Gateway on a Mac or pair a macOS node.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

### Do I need a Mac mini for iMessage support

You need **some macOS device** signed into Messages. It does **not** have to be a Mac mini -
any Mac works. **Use [BlueBubbles](/channels/bluebubbles)** (recommended) for iMessage - the BlueBubbles server runs on macOS, while the Gateway can run on Linux or elsewhere.

Common setups:

- Run the Gateway on Linux/VPS, and run the BlueBubbles server on any Mac signed into Messages.
- Run everything on the Mac if you want the simplest single‑machine setup.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac remote mode](/platforms/mac/remote).

### If I buy a Mac mini to run OpenClaw can I connect it to my MacBook Pro

예. The **Mac mini can run the Gateway**, and your MacBook Pro can connect as a
**node** (companion device). Nodes don't run the Gateway - they provide extra
capabilities like screen/camera/canvas and `system.run` on that device.

Common pattern:

- Gateway on the Mac mini (always-on).
- MacBook Pro runs the macOS app or a node host and pairs to the Gateway.
- Use `openclaw nodes status` / `openclaw nodes list` to see it.

문서: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I use Bun

Bun 은 **권장되지 않음**. We see runtime bugs, especially with WhatsApp and Telegram.
Use **Node** for stable gateways.

If you still want to experiment with Bun, do it on a non-production gateway
without WhatsApp/Telegram.

### Telegram what goes in allowFrom

`channels.telegram.allowFrom` is **the human sender's Telegram user ID** (numeric, recommended) or `@username`. 봇 사용자 이름이 아닙니다.

더 안전한 방법(서드파티 봇 없음):

- 봇에게 DM을 보낸 다음 `openclaw logs --follow`를 실행하고 `from.id`를 확인하세요.

공식 Bot API:

- 봇에게 DM을 보낸 다음 `https://api.telegram.org/bot<bot_token>/getUpdates`를 호출하고 `message.from.id`를 확인하세요.

서드파티(프라이버시 낮음):

- `@userinfobot` 또는 `@getidsbot`에 DM을 보내세요.

[/channels/telegram](/channels/telegram#access-control-dms--groups)을 참조하세요.

### 여러 사람이 하나의 WhatsApp 번호를 서로 다른 OpenClaw 인스턴스로 사용할 수 있나요?

네, **멀티 에이전트 라우팅**을 통해 가능합니다. 각 발신자의 WhatsApp **DM**(피어 `kind: "dm"`, 발신자 E.164 형식 `+15551234567`)을 서로 다른 `agentId`에 바인딩하여 각 사람이 자신의 워크스페이스와 세션 저장소를 갖도록 하세요. 응답은 여전히 **같은 WhatsApp 계정**에서 오며, DM 접근 제어(`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`)는 WhatsApp 계정별로 전역 적용됩니다. [멀티 에이전트 라우팅](/concepts/multi-agent)과 [WhatsApp](/channels/whatsapp)을 참조하세요.

### 빠른 채팅 에이전트와 코딩용 Opus 에이전트를 함께 실행할 수 있나요?

예. 멀티 에이전트 라우팅을 사용하세요. 각 에이전트에 기본 모델을 지정한 다음, 인바운드 라우트(프로바이더 계정 또는 특정 피어)를 각 에이전트에 바인딩합니다. 예제 설정은 [멀티 에이전트 라우팅](/concepts/multi-agent)에 있습니다. [모델](/concepts/models)과 [설정](/gateway/configuration)도 참조하세요.

### Homebrew는 Linux에서 동작하나요?

예. Homebrew는 Linux(Linuxbrew)를 지원합니다. 빠른 설정:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

systemd로 OpenClaw를 실행하는 경우, 로그인 셸이 아닌 환경에서도 `brew`로 설치한 도구들이 인식되도록 서비스의 PATH에 `/home/linuxbrew/.linuxbrew/bin`(또는 brew 프리픽스)을 포함하세요.
최근 빌드는 Linux systemd 서비스에서 일반적인 사용자 bin 디렉터리(예: `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`)를 앞에 추가하며, `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, `FNM_DIR`가 설정된 경우 이를 존중합니다.

### 해커블 git 설치와 npm 설치의 차이는 무엇인가요?

- **해커블(git) 설치:** 전체 소스 체크아웃으로 편집 가능하며, 기여자에게 가장 적합합니다.
  빌드를 로컬에서 실행하고 코드/문서를 패치할 수 있습니다.
- **npm 설치:** 전역 CLI 설치로 저장소가 없으며, "그냥 실행"에 가장 적합합니다.
  업데이트는 npm dist-tag에서 제공됩니다.

문서: [시작하기](/start/getting-started), [업데이트](/install/updating).

### 나중에 npm 설치와 git 설치를 전환할 수 있나요?

예. 다른 방식으로 설치한 뒤 Doctor를 실행하여 게이트웨이 서비스가 새 엔트리포인트를 가리키도록 하세요.
이 작업은 **데이터를 삭제하지 않습니다** — OpenClaw 코드 설치만 변경합니다. 사용자 상태
(`~/.openclaw`)와 워크스페이스(`~/.openclaw/workspace`)는 그대로 유지됩니다.

From npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

From git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor는 게이트웨이 서비스의 엔트리포인트 불일치를 감지하고 현재 설치에 맞게 서비스 설정을 다시 작성할지 제안합니다(자동화에서는 `--repair` 사용).

백업 팁: [백업 전략](/help/faq#whats-the-recommended-backup-strategy)을 참조하세요.

### 게이트웨이는 노트북에서 실행해야 하나요, 아니면 VPS에서 실행해야 하나요?

짧은 답변: **24/7 안정성이 필요하다면 VPS를 사용하세요**. 최소한의 번거로움을 원하고 슬립/재시작을 감수할 수 있다면 로컬에서 실행하세요.

**노트북(로컬 게이트웨이)**

- **Pros:** no server cost, direct access to local files, live browser window.
- **Cons:** sleep/network drops = disconnects, OS updates/reboots interrupt, must stay awake.

**VPS / cloud**

- **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
- **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.

**OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord all work fine from a VPS. The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).

**Recommended default:** VPS if you had gateway disconnects before. Local is great when you're actively using the Mac and want local file access or UI automation with a visible browser.

### How important is it to run OpenClaw on a dedicated machine

Not required, but **recommended for reliability and isolation**.

- **Dedicated host (VPS/Mac mini/Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.
- **Shared laptop/desktop:** totally fine for testing and active use, but expect pauses when the machine sleeps or updates.

If you want the best of both worlds, keep the Gateway on a dedicated host and pair your laptop as a **node** for local screen/camera/exec tools. See [Nodes](/nodes).
For security guidance, read [Security](/gateway/security).

### What are the minimum VPS requirements and recommended OS

OpenClaw is lightweight. For a basic Gateway + one chat channel:

- 9. **절대 최소:** 1 vCPU, 1GB RAM, 약 500MB 디스크.
- 10. **권장:** 1~2 vCPU, 2GB RAM 이상(로그, 미디어, 다중 채널을 위한 여유). 11. 노드 도구와 브라우저 자동화는 리소스를 많이 사용할 수 있습니다.

12. OS: **Ubuntu LTS**(또는 최신 Debian/Ubuntu)를 사용하세요. 13. Linux 설치 경로는 해당 환경에서 가장 잘 테스트되었습니다.

14. 문서: [Linux](/platforms/linux), [VPS 호스팅](/vps).

### Can I run OpenClaw in a VM and what are the requirements

예. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough
RAM for the Gateway and any channels you enable.

Baseline guidance:

- **Absolute minimum:** 1 vCPU, 1GB RAM.
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).
If you are running macOS in a VM, see [macOS VM](/install/macos-vm).

## OpenClaw 란 무엇인가요?

### What is OpenClaw in one paragraph

OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.

### What's the value proposition

OpenClaw is not "just a Claude wrapper." It's a **local-first control plane** that lets you run a
capable assistant on **your own hardware**, reachable from the chat apps you already use, with
stateful sessions, memory, and tools - without handing control of your workflows to a hosted
SaaS.

하이라이트:

- **Your devices, your data:** run the Gateway wherever you want (Mac, Linux, VPS) and keep the
  workspace + session history local.
- **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobile voice and Canvas on supported platforms.
- **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing
  and failover.
- **Local-only option:** run local models so **all data can stay on your device** if you want.
- **Multi-agent routing:** separate agents per channel, account, or task, each with its own
  workspace and defaults.
- **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### I just set it up what should I do first

Good first projects:

- Build a website (WordPress, Shopify, or a simple static site).
- Prototype a mobile app (outline, screens, API plan).
- Organize files and folders (cleanup, naming, tagging).
- Connect Gmail and automate summaries or follow ups.

It can handle large tasks, but it works best when you split them into phases and
use sub agents for parallel work.

### What are the top five everyday use cases for OpenClaw

Everyday wins usually look like:

- **Personal briefings:** summaries of inbox, calendar, and news you care about.
- **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
- **Reminders and follow ups:** cron or heartbeat driven nudges and checklists.
- **Browser automation:** filling forms, collecting data, and repeating web tasks.
- **Cross device coordination:** send a task from your phone, let the Gateway run it on a server, and get the result back in chat.

### Can OpenClaw help with lead gen outreach ads and blogs for a SaaS

Yes for **research, qualification, and drafting**. It can scan sites, build shortlists,
summarize prospects, and write outreach or ad copy drafts.

For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and
platform policies, and review anything before it is sent. The safest pattern is to let
OpenClaw draft and you approve.

Docs: [Security](/gateway/security).

### What are the advantages vs Claude Code for web development

OpenClaw is a **personal assistant** and coordination layer, not an IDE replacement. Use
Claude Code or Codex for the fastest direct coding loop inside a repo. Use OpenClaw when you
want durable memory, cross-device access, and tool orchestration.

Advantages:

- **Persistent memory + workspace** across sessions
- **Multi-platform access** (WhatsApp, Telegram, TUI, WebChat)
- **Tool orchestration** (browser, files, scheduling, hooks)
- **Always-on Gateway** (run on a VPS, interact from anywhere)
- **Nodes** for local browser/screen/camera/exec

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Skills and automation

### How do I customize skills without keeping the repo dirty

Use managed overrides instead of editing the repo copy. Put your changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence is `<workspace>/skills` > `~/.openclaw/skills` > bundled, so managed overrides win without touching git. Only upstream-worthy edits should live in the repo and go out as PRs.

### Can I load skills from a custom folder

예. Add extra directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence). Default precedence remains: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills`.

### How can I use different models for different tasks

Today the supported patterns are:

- **Cron jobs**: isolated jobs can set a `model` override per job.
- **Sub-agents**: route tasks to separate agents with different default models.
- **On-demand switch**: use `/model` to switch the current session model at any time.

See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands).

### The bot freezes while doing heavy work How do I offload that

Use **sub-agents** for long or parallel tasks. Sub-agents run in their own session,
return a summary, and keep your main chat responsive.

Ask your bot to "spawn a sub-agent for this task" or use `/subagents`.
Use `/status` in chat to see what the Gateway is doing right now (and whether it is busy).

Token tip: long tasks and sub-agents both consume tokens. If cost is a concern, set a
cheaper model for sub-agents via `agents.defaults.subagents.model`.

Docs: [Sub-agents](/tools/subagents).

### Cron or reminders do not fire What should I check

Cron runs inside the Gateway process. If the Gateway is not running continuously,
scheduled jobs will not run.

체크리스트:

- Confirm cron is enabled (`cron.enabled`) and `OPENCLAW_SKIP_CRON` is not set.
- Check the Gateway is running 24/7 (no sleep/restarts).
- Verify timezone settings for the job (`--tz` vs host timezone).

Debug:

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### How do I install skills on Linux

Use **ClawHub** (CLI) or drop skills into your workspace. The macOS Skills UI isn't available on Linux.
Browse skills at [https://clawhub.com](https://clawhub.com).

Install the ClawHub CLI (pick one package manager):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Can OpenClaw run tasks on a schedule or continuously in the background

예. Use the Gateway scheduler:

- **Cron jobs** for scheduled or recurring tasks (persist across restarts).
- **Heartbeat** for "main session" periodic checks.
- **Isolated jobs** for autonomous agents that post summaries or deliver to chats.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Can I run Apple macOS-only skills from Linux?

직접적으로는 아닙니다. macOS 스킬은 `metadata.openclaw.os`와 필요한 바이너리에 의해 제한되며, 스킬은 **Gateway 호스트**에서 자격이 있을 때만 시스템 프롬프트에 나타납니다. Linux에서는 `darwin` 전용 스킬(예: `apple-notes`, `apple-reminders`, `things-mac`)이 게이팅을 재정의하지 않는 한 로드되지 않습니다.

지원되는 패턴은 세 가지가 있습니다:

**옵션 A - Mac에서 Gateway 실행(가장 간단).** macOS 바이너리가 존재하는 곳에서 Gateway를 실행한 다음, [원격 모드](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)로 Linux에서 연결하거나 Tailscale을 통해 연결합니다.

Gateway 호스트가 macOS이기 때문에 스킬이 정상적으로 로드됩니다. **옵션 B - macOS 노드 사용(SSH 없음).** Linux에서 Gateway를 실행하고 macOS 노드(메뉴바 앱)를 페어링한 뒤, Mac에서 **Node Run Commands**를 "항상 묻기" 또는 "항상 허용"으로 설정합니다. OpenClaw는 필요한 바이너리가 노드에 존재할 때 macOS 전용 스킬을 사용 가능 대상으로 처리할 수 있습니다.

에이전트는 `nodes` 도구를 통해 해당 스킬을 실행합니다. "항상 묻기"를 선택한 경우, 프롬프트에서 "항상 허용"을 승인하면 해당 명령이 허용 목록에 추가됩니다.

1. **옵션 C - SSH를 통해 macOS 바이너리 프록시(고급).**

   ```bash
   Gateway는 Linux에 유지하되, 필요한 CLI 바이너리가 Mac에서 실행되는 SSH 래퍼로 해석되도록 만듭니다.
   ```

2. 그런 다음 Linux를 허용하도록 스킬을 재정의하여 계속 사용 가능 상태로 유지합니다.

3. 바이너리에 대한 SSH 래퍼를 생성합니다(예: Apple Notes용 `memo`):

   ```markdown
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

4. Linux 호스트의 `PATH`에 래퍼를 배치합니다(예: `~/bin/memo`).

### 스킬 메타데이터(워크스페이스 또는 `~/.openclaw/skills`)를 재정의하여 Linux를 허용합니다:

---
name: apple-notes
description: Manage Apple Notes via the memo CLI on macOS.
metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
---

옵션:

- 새 세션을 시작하여 스킬 스냅샷이 새로 고쳐지도록 합니다.
- Notion이나 HeyGen 연동이 있나요?

현재는 기본 제공되지 않습니다.

- **커스텀 스킬 / 플러그인:** 안정적인 API 접근에 가장 적합합니다(Notion/HeyGen 모두 API 제공).
- **브라우저 자동화:** 코드 없이 동작하지만 더 느리고 취약합니다.

클라이언트별 컨텍스트(에이전시 워크플로)를 유지하고 싶다면, 간단한 패턴은 다음과 같습니다:

클라이언트당 하나의 Notion 페이지(컨텍스트 + 선호 설정 + 진행 중 작업).

```bash
세션 시작 시 해당 페이지를 가져오도록 에이전트에 요청합니다.
```

네이티브 연동을 원한다면 기능 요청을 열거나 해당 API를 대상으로 스킬을 빌드하세요. 스킬 설치: clawhub install <skill-slug>
clawhub update --all ClawHub는 현재 디렉터리 아래의 `./skills`에 설치합니다(또는 구성된 OpenClaw 워크스페이스로 폴백). OpenClaw는 다음 세션에서 이를 `<workspace>/skills`로 처리합니다.

### 에이전트 간에 스킬을 공유하려면 `~/.openclaw/skills/<name>/SKILL.md`에 배치하세요.

일부 스킬은 Homebrew로 설치된 바이너리를 기대합니다. Linux에서는 Linuxbrew를 의미합니다(위의 Homebrew Linux FAQ 항목 참조).

```bash
openclaw browser extension install
openclaw browser extension path
```

[Skills](/tools/skills) 및 [ClawHub](/tools/clawhub)를 참고하세요.

브라우저 제어를 위한 Chrome 확장 프로그램은 어떻게 설치하나요?

내장 설치 프로그램을 사용한 다음, Chrome에서 압축 해제된 확장을 로드합니다:
Gateway 가 다른 곳에서 실행되는 경우,
Gateway 가 브라우저 액션을 프록시할 수 있도록 브라우저 머신에서 노드 호스트를 실행하십시오.
그런 다음 Chrome → `chrome://extensions` → "개발자 모드" 활성화 → "압축 해제된 확장 프로그램 로드" → 해당 폴더 선택.

## 전체 가이드(원격 Gateway + 보안 참고 포함): [Chrome extension](/tools/chrome-extension)

### Gateway가 Chrome과 동일한 머신에서 실행되는 경우(기본 설정), 보통 추가로 필요한 것은 **없습니다**.

예. [Sandboxing](/gateway/sandboxing) 을 참고하십시오. Docker 전용 설정(전체 게이트웨이를 Docker에서 실행하거나 샌드박스 이미지 사용)은 [Docker](/install/docker)를 참고하세요.

### Docker가 제한적으로 느껴집니다. 전체 기능을 활성화하려면 어떻게 하나요?

기본 이미지는 보안을 최우선으로 하며 `node` 사용자로 실행되므로 시스템 패키지, Homebrew, 번들된 브라우저가 포함되어 있지 않습니다. 더 완전한 설정을 위해:

- `OPENCLAW_HOME_VOLUME`으로 `/home/node`를 영구화하여 캐시가 유지되도록 하세요.
- `OPENCLAW_DOCKER_APT_PACKAGES`로 시스템 의존성을 이미지에 포함시키세요.
- 번들된 CLI로 Playwright 브라우저를 설치하세요:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- `PLAYWRIGHT_BROWSERS_PATH`를 설정하고 해당 경로가 영구화되었는지 확인하세요.

문서: [Docker](/install/docker), [Browser](/tools/browser).

**DM은 개인으로 유지하면서 그룹은 하나의 에이전트로 공개 샌드박스화할 수 있나요**

네 — 개인 트래픽이 **DMs**이고 공개 트래픽이 **groups**라면 가능합니다.

`agents.defaults.sandbox.mode: "non-main"`을 사용하면 그룹/채널 세션(메인 키가 아닌 키)은 Docker에서 실행되고, 메인 DM 세션은 호스트에서 유지됩니다. 그런 다음 `tools.sandbox.tools`로 샌드박스 세션에서 사용 가능한 도구를 제한하세요.

설정 안내 + 예시 구성: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

핵심 설정 참고: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### 호스트 폴더를 샌드박스에 바인딩하려면 어떻게 하나요

`agents.defaults.sandbox.docker.binds`를 `["host:path:mode"]`로 설정하세요(예: `"/home/user/src:/src:ro"`). 전역 + 에이전트별 바인드는 병합되며, `scope: "shared"`일 때는 에이전트별 바인드가 무시됩니다. 민감한 항목에는 `:ro`를 사용하고, 바인드는 샌드박스 파일시스템의 장벽을 우회한다는 점을 기억하세요. 예시와 안전 참고 사항은 [Sandboxing](/gateway/sandboxing#custom-bind-mounts) 및 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check)를 확인하세요.

### 메모리는 어떻게 동작하나요

OpenClaw 메모리는 에이전트 워크스페이스에 있는 Markdown 파일입니다:

- `memory/YYYY-MM-DD.md`의 일일 노트
- `MEMORY.md`의 큐레이션된 장기 노트(메인/개인 세션 전용)

OpenClaw는 자동 컴팩션 전에 지속 가능한 노트를 작성하도록 모델에 상기시키기 위해 **무음 사전 컴팩션 메모리 플러시**도 실행합니다. 이는 워크스페이스가 쓰기 가능할 때만 실행되며(읽기 전용 샌드박스에서는 건너뜁니다). [Memory](/concepts/memory)를 참고하십시오.

### 메모리가 계속 잊어버립니다. 어떻게 고정하나요

봇에게 **사실을 메모리에 기록하라고** 요청하세요. 장기 노트는 `MEMORY.md`에,
단기 컨텍스트는 `memory/YYYY-MM-DD.md`에 두세요.

이 영역은 아직 개선 중입니다. 모델에게 메모리를 저장하라고 상기시키면 도움이 되며;
무엇을 해야 할지 알고 있습니다. 계속 잊어버린다면 게이트웨이가 매 실행마다 동일한 워크스페이스를 사용하고 있는지 확인하세요.

문서: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

### 시맨틱 메모리 검색에 OpenAI API 키가 필요한가요

**OpenAI 임베딩**을 사용할 때만 필요합니다. Codex OAuth는 채팅/컴플리션만 포함하며
임베딩 접근 권한을 **부여하지 않습니다**. 따라서 **Codex(OAuth 또는 Codex CLI 로그인)로 로그인**해도 시맨틱 메모리 검색에는 도움이 되지 않습니다. OpenAI 임베딩은
여전히 실제 API 키(`OPENAI_API_KEY` 또는 `models.providers.openai.apiKey`)가 필요합니다.

제공자를 명시적으로 설정하지 않으면, OpenClaw는 API 키를 해석할 수 있을 때(인증 프로필, `models.providers.*.apiKey`, 또는 환경 변수) 제공자를 자동 선택합니다.
OpenAI 키가 해석되면 OpenAI를 우선하고, 그렇지 않으면 Gemini 키가 해석될 경우 Gemini를 사용합니다. 어느 키도 없으면, 구성할 때까지 메모리 검색은 비활성화된 상태로 유지됩니다. 로컬 모델 경로가 설정되어 있고 존재한다면, OpenClaw는 `local`을 선호합니다.

로컬을 유지하고 싶다면 `memorySearch.provider = "local"`로 설정하세요 (그리고 선택적으로 `memorySearch.fallback = "none"`). Gemini 임베딩을 사용하려면 `memorySearch.provider = "gemini"`로 설정하고 `GEMINI_API_KEY` (또는 `memorySearch.remote.apiKey`)를 제공하세요. **OpenAI, Gemini 또는 로컬** 임베딩 모델을 지원합니다 - 설정 세부 사항은 [Memory](/concepts/memory)를 참고하세요.

### 메모리는 영구적으로 유지되나요 제한은 무엇인가요

메모리 파일은 디스크에 저장되며 삭제할 때까지 유지됩니다. 제한은 모델이 아니라 저장 공간입니다. **세션 컨텍스트**는 여전히 모델의 컨텍스트 윈도우에 의해 제한되므로, 긴 대화는 압축되거나 잘릴 수 있습니다. 그래서 메모리 검색이 존재합니다 - 관련된 부분만 다시 컨텍스트로 가져옵니다.

문서: [Memory](/concepts/memory), [Context](/concepts/context).

## 디스크에서 항목들이 위치하는 곳

### OpenClaw와 함께 사용되는 모든 데이터는 로컬에 저장되나요

아니요 - **OpenClaw의 상태는 로컬**이지만, **외부 서비스는 여전히 당신이 전송한 내용을 확인합니다**.

- **기본적으로 로컬:** 세션, 메모리 파일, 설정, 워크스페이스는 Gateway 호스트에 위치합니다 (`~/.openclaw` + 워크스페이스 디렉터리).
- **필요에 따른 원격:** 모델 제공자(Anthropic/OpenAI 등)에게 보내는 메시지는 해당 API로 전송되며, 채팅 플랫폼(WhatsApp/Telegram/Slack 등)은 메시지 데이터를 그들의 서버에 저장합니다.
- **사용자가 제어하는 범위:** 로컬 모델을 사용하면 프롬프트는 당신의 머신에 남아 있지만, 채널 트래픽은 여전히 해당 채널의 서버를 거칩니다.

관련 항목: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

### OpenClaw는 데이터를 어디에 저장하나요

모든 것은 `$OPENCLAW_STATE_DIR` 아래에 위치합니다 (기본값: `~/.openclaw`):

| 경로                                                              | 목적                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | 메인 설정 (JSON5)                                                   |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | 레거시 OAuth 가져오기 (첫 사용 시 인증 프로필로 복사됨)                             |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 인증 프로필 (OAuth + API 키)                                          |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | 런타임 인증 캐시 (자동 관리)                                               |
| `$OPENCLAW_STATE_DIR/credentials/`                              | 프로바이더 상태 (예: `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                   | 에이전트별 상태 (agentDir + 세션)                                        |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | 대화 기록 및 상태 (에이전트별)                                              |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | 세션 메타데이터 (에이전트별)                                                |

레거시 단일 에이전트 경로: `~/.openclaw/agent/*` (`openclaw doctor`에 의해 마이그레이션됨).

**워크스페이스** (AGENTS.md, 메모리 파일, 스킬 등) `agents.defaults.workspace`를 통해 별도로 설정됩니다 (기본값: `~/.openclaw/workspace`).

### AGENTSmd SOULmd USERmd MEMORYmd는 어디에 두어야 하나요

이 파일들은 `~/.openclaw`가 아니라 **에이전트 워크스페이스**에 존재합니다.

- **워크스페이스(에이전트별)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md`(또는 `memory.md`), `memory/YYYY-MM-DD.md`, 선택적 `HEARTBEAT.md`.
- **상태 디렉터리(`~/.openclaw`)**: 설정, 자격 증명, 인증 프로필, 세션, 로그,
  그리고 공유 스킬(`~/.openclaw/skills`).

기본 워크스페이스는 `~/.openclaw/workspace`이며, 다음을 통해 설정할 수 있습니다:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

재시작 후 봇이 "기억을 잃는" 경우, Gateway가 매 실행 시 동일한
워크스페이스를 사용하고 있는지 확인하세요(그리고 기억하세요: 원격 모드는 **로컬 노트북이 아니라 게이트웨이 호스트의** 워크스페이스를 사용합니다).

팁: 지속적인 동작이나 선호를 원한다면, 채팅 기록에 의존하기보다
봇에게 **AGENTS.md 또는 MEMORY.md에 기록하도록 요청**하세요.

[Agent workspace](/concepts/agent-workspace) 및 [Memory](/concepts/memory)를 참고하세요.

### 권장되는 백업 전략은 무엇인가요

**에이전트 워크스페이스**를 **비공개** git 저장소에 두고,
어딘가에 비공개로 백업하세요(예: GitHub 비공개 저장소). 이렇게 하면 memory + AGENTS/SOUL/USER
파일을 함께 캡처할 수 있으며, 나중에 어시스턴트의 "마음"을 복원할 수 있습니다.

`~/.openclaw` 아래의 어떤 것도(자격 증명, 세션, 토큰) 커밋하지 **마세요**.
전체 복원이 필요하다면, 워크스페이스와 상태 디렉터리를
각각 별도로 백업하세요(위의 마이그레이션 질문 참고).

문서: [Agent workspace](/concepts/agent-workspace).

### OpenClaw를 완전히 제거하려면 어떻게 하나요

전용 가이드를 참고하세요: [Uninstall](/install/uninstall).

### 에이전트가 워크스페이스 밖에서도 작업할 수 있나요

예. 워크스페이스는 **기본 cwd**이자 메모리 앵커일 뿐, 강제 샌드박스는 아닙니다.
상대 경로는 워크스페이스 안에서 해석되지만, 샌드박싱이 활성화되지 않은 경우
절대 경로는 다른 호스트 위치에 접근할 수 있습니다. 격리가 필요하다면
[`agents.defaults.sandbox`](/gateway/sandboxing) 또는 에이전트별 샌드박스 설정을 사용하세요. 저장소를 기본 작업 디렉터리로 사용하고 싶다면, 해당 에이전트의
`workspace`를 저장소 루트로 지정하세요. OpenClaw 저장소는 단순한 소스 코드일 뿐입니다; 의도적으로 그 안에서
에이전트가 작업하도록 하지 않는 한 워크스페이스는 분리해 두세요.

예시(저장소를 기본 cwd로 설정):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### 원격 모드인데 세션 저장소는 어디에 있나요

세션 상태는 **게이트웨이 호스트**가 소유합니다. 원격 모드라면, 중요한 세션 저장소는 로컬 노트북이 아니라 원격 머신에 있습니다. [Session management](/concepts/session)를 참고하세요.

## 설정 기본 사항

### [구성 형식은 무엇이며 어디에 있나요?](#what-format-is-the-config-where-is-it)

OpenClaw는 `$OPENCLAW_CONFIG_PATH`(기본값: `~/.openclaw/openclaw.json`)에서
선택적 **JSON5** 설정을 읽습니다:

```
$OPENCLAW_CONFIG_PATH
```

파일이 없으면, 안전한 수준의 기본값을 사용합니다(기본 워크스페이스 `~/.openclaw/workspace` 포함).

### gatewaybind를 lan 또는 tailnet으로 설정했더니 이제 아무 것도 수신하지 않고 UI에는 unauthorized가 표시됩니다

루프백이 아닌 바인드는 **인증이 필요합니다**. `gateway.auth.mode` + `gateway.auth.token`을 설정하세요(또는 `OPENCLAW_GATEWAY_TOKEN` 사용).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

Notes:

- `gateway.remote.token`은 **원격 CLI 호출 전용**이며, 로컬 게이트웨이 인증을 활성화하지 않습니다.
- Control UI는 `connect.params.auth.token`을 통해 인증합니다(앱/UI 설정에 저장됨). URL에 토큰을 넣는 것은 피하세요.

### 왜 이제 localhost에서도 토큰이 필요한가요

마법사는 기본적으로(루프백에서도) 게이트웨이 토큰을 생성하므로 **로컬 WS 클라이언트도 인증해야 합니다**. 이렇게 하면 다른 로컬 프로세스가 Gateway를 호출하지 못하게 됩니다. 연결하려면 토큰을 Control UI 설정(또는 클라이언트 설정)에 붙여넣으세요.

**정말로** 루프백을 열어두고 싶다면 설정에서 `gateway.auth`를 제거하세요. Doctor는 언제든지 토큰을 생성해 줄 수 있습니다: `openclaw doctor --generate-gateway-token`.

### 설정을 변경한 후 다시 시작해야 하나요?

Gateway는 설정을 감시하며 핫 리로드를 지원합니다:

- `gateway.reload.mode: "hybrid"` (기본값): 안전한 변경은 즉시 적용하고, 중요한 변경은 재시작
- `hot`, `restart`, `off`도 지원됩니다.

### 웹 검색과 웹 페치를 어떻게 활성화하나요?

`web_fetch`는 API 키 없이 동작합니다. `web_search`는 Brave Search API
키가 필요합니다. **권장:** `openclaw configure --section web`을 실행하여
`tools.web.search.apiKey`에 저장하세요. 환경 변수 대안: Gateway 프로세스에 대해
`BRAVE_API_KEY`를 설정하세요.

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
      },
      fetch: {
        enabled: true,
      },
    },
  },
}
```

참고:

- 허용 목록을 사용한다면 `web_search`/`web_fetch` 또는 `group:web`을 추가하세요.
- `web_fetch` 은 기본적으로 활성화되어 있습니다 (명시적으로 비활성화하지 않는 한).
- 데몬은 `~/.openclaw/.env`(또는 서비스 환경)에서 환경 변수를 읽습니다.

문서: [Web tools](/tools/web).

### 여러 기기에 걸쳐 특화된 워커와 함께 중앙 Gateway를 어떻게 실행하나요?

일반적인 패턴은 **하나의 Gateway**(예: Raspberry Pi)와 **노드** 및 **에이전트**입니다:

- **Gateway (중앙):** 채널(Signal/WhatsApp), 라우팅, 세션을 소유합니다.
- **노드(기기):** Mac/iOS/Android가 주변 장치로 연결되어 로컬 도구(`system.run`, `canvas`, `camera`)를 노출합니다.
- **에이전트(워커):** 특수 역할(예: "Hetzner ops", "Personal data")을 위한 별도의 두뇌/워크스페이스입니다.
- **서브 에이전트:** 병렬 처리가 필요할 때 메인 에이전트에서 백그라운드 작업을 생성합니다.
- **TUI:** Gateway에 연결하여 에이전트/세션을 전환합니다.

문서: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### OpenClaw 브라우저를 헤드리스로 실행할 수 있나요?

예. 설정 옵션입니다:

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

기본값은 `false`(헤드풀)입니다. 헤드리스 모드는 일부 사이트에서 안티봇 검사를 유발할 가능성이 더 높습니다. [Browser](/tools/browser)를 참고하세요.

헤드리스는 **동일한 Chromium 엔진**을 사용하며 대부분의 자동화(폼, 클릭, 스크래핑, 로그인)에 동작합니다. 주요 차이점:

- 브라우저 창이 보이지 않습니다(시각적 요소가 필요하면 스크린샷을 사용하세요).
- 일부 사이트는 헤드리스 모드에서 자동화에 더 엄격합니다(CAPTCHA, 안티봇).
  예를 들어 X/Twitter는 종종 헤드리스 세션을 차단합니다.

### 브라우저 제어에 Brave를 어떻게 사용하나요?

`browser.executablePath`를 Brave 바이너리(또는 다른 Chromium 기반 브라우저)로 설정하고 Gateway를 재시작하세요.
[Browser](/tools/browser#use-brave-or-another-chromium-based-browser)에서 전체 설정 예제를 확인하세요.

## 원격 Gateway와 노드

### 명령은 Telegram, Gateway, 노드 간에 어떻게 전파되나요?

텔레그램 메시지는 **게이트웨이**에서 처리됩니다. 게이트웨이는 에이전트를 실행하고,
노드 도구가 필요할 때에만 **Gateway WebSocket**을 통해 노드를 호출합니다:

텔레그램 → 게이트웨이 → 에이전트 → `node.*` → 노드 → 게이트웨이 → 텔레그램

노드는 인바운드 프로바이더 트래픽을 보지 않으며, 오직 노드 RPC 호출만 수신합니다.

### 게이트웨이가 원격에 호스팅되어 있는데, 제 에이전트가 어떻게 제 컴퓨터에 접근할 수 있나요?

짧은 답변: **내 컴퓨터를 노드로 페어링하세요**. 게이트웨이는 다른 곳에서 실행되지만,
Gateway WebSocket을 통해 로컬 머신의 `node.*` 도구(화면, 카메라, 시스템)를 호출할 수 있습니다.

일반적인 설정:

1. 항상 켜져 있는 호스트(VPS/홈 서버)에서 게이트웨이를 실행합니다.
2. 게이트웨이 호스트와 내 컴퓨터를 동일한 tailnet에 둡니다.
3. Gateway WS에 접근 가능하도록 합니다(tailnet 바인드 또는 SSH 터널).
4. macOS 앱을 로컬에서 열고 **Remote over SSH** 모드(또는 직접 tailnet)로 연결하여
   노드로 등록되도록 합니다.
5. 게이트웨이에서 노드를 승인합니다:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

별도의 TCP 브리지는 필요 없으며, 노드는 Gateway WebSocket을 통해 연결됩니다.

보안 알림: macOS 노드를 페어링하면 해당 머신에서 `system.run`이 허용됩니다. 신뢰하는 장치만 페어링하고, [Security](/gateway/security)를 검토하세요.

문서: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale은 연결되어 있는데 응답이 없습니다. 이제 어떻게 하나요?

기본 사항을 확인하세요:

- 게이트웨이가 실행 중인지: `openclaw gateway status`
- 게이트웨이 상태: `openclaw status`
- 채널 상태: `openclaw channels status`

그다음 인증과 라우팅을 확인하세요:

- Tailscale Serve를 사용한다면 `gateway.auth.allowTailscale` 설정이 올바른지 확인하세요.
- SSH 터널로 연결한다면, 로컬 터널이 활성화되어 있고 올바른 포트를 가리키는지 확인하세요.
- 허용 목록(DM 또는 그룹)에 본인 계정이 포함되어 있는지 확인하세요.

문서: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### 두 개의 OpenClaw 인스턴스가 서로 통신할 수 있나요? 로컬과 VPS

예. 기본 제공되는 "봇-대-봇" 브리지는 없지만, 몇 가지
신뢰할 수 있는 방법으로 구성할 수 있습니다:

**가장 간단한 방법:** 두 봇이 모두 접근할 수 있는 일반 채팅 채널(텔레그램/슬랙/왓츠앱)을 사용합니다.
봇 A가 봇 B에게 메시지를 보내고, 봇 B는 평소처럼 응답하게 합니다.

**CLI 브리지(일반):** 다른 게이트웨이를 호출하는 스크립트를 실행하여
`openclaw agent --message ... --deliver`를 사용해 다른 봇이
리스닝하는 채팅을 대상으로 전달합니다. 한 봇이 원격 VPS에 있다면, SSH/Tailscale을 통해 해당 원격 게이트웨이를 가리키도록 CLI를 설정하세요
([Remote access](/gateway/remote) 참고).

예시 패턴(대상 게이트웨이에 접근 가능한 머신에서 실행):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

팁: 두 봇이 무한 루프에 빠지지 않도록 가드레일을 추가하세요(멘션 전용, 채널
허용 목록, 또는 "봇 메시지에는 응답하지 않기" 규칙).

문서: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### 여러 에이전트를 위해 별도의 VPS가 필요한가요?

아니요. 하나의 게이트웨이에서 여러 에이전트를 호스팅할 수 있으며, 각 에이전트는 자체 워크스페이스, 모델 기본값,
그리고 라우팅을 가질 수 있습니다. 1. 이것이 일반적인 설정이며 에이전트마다 VPS 하나를 운영하는 것보다 훨씬 저렴하고 간단합니다.

2. 강력한 격리(보안 경계)가 필요하거나 공유하고 싶지 않을 정도로 매우 다른 설정이 필요한 경우에만 별도의 VPS를 사용하세요. 3. 그 외의 경우에는 하나의 Gateway를 유지하고 여러 에이전트 또는 서브 에이전트를 사용하세요.

### 4. VPS에서 SSH로 접속하는 대신 개인 노트북에 노드를 사용하는 이점이 있나요

5. 네 - 노드는 원격 Gateway에서 노트북에 접근하는 일급 방식이며, 단순한 셸 접근 그 이상을 제공합니다. 6. Gateway는 macOS/Linux(Windows는 WSL2를 통해)에서 실행되며 가볍습니다(작은 VPS나 Raspberry Pi급 장치로 충분하고, RAM 4GB면 충분). 그래서 항상 켜져 있는 호스트 + 노트북을 노드로 사용하는 구성이 일반적입니다.

- 7. **인바운드 SSH 불필요.** 노드는 Gateway WebSocket으로 아웃바운드 연결을 하고 디바이스 페어링을 사용합니다.
- 8. **더 안전한 실행 제어.** `system.run`은 해당 노트북의 노드 허용 목록/승인을 통해 제어됩니다.
- 9. **더 많은 디바이스 도구.** 노드는 `system.run` 외에도 `canvas`, `camera`, `screen`을 노출합니다.
- 10. **로컬 브라우저 자동화.** Gateway는 VPS에 두고, Chrome은 로컬에서 실행한 뒤 Chrome 확장 + 노트북의 노드 호스트로 제어를 중계하세요.

11. SSH는 임시 셸 접근에는 괜찮지만, 지속적인 에이전트 워크플로와 디바이스 자동화에는 노드가 더 간단합니다.

12. 문서: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### 13. 두 번째 노트북에 설치해야 하나요, 아니면 노드를 추가하면 되나요

14. 두 번째 노트북에서 **로컬 도구**(screen/camera/exec)만 필요하다면 **노드**로 추가하세요. 15. 이렇게 하면 하나의 Gateway를 유지하면서 설정 중복을 피할 수 있습니다. 16. 로컬 노드 도구는 현재 macOS 전용이지만, 다른 OS로 확장할 계획입니다.

17. **강력한 격리**가 필요하거나 완전히 분리된 두 개의 봇이 필요할 때만 두 번째 Gateway를 설치하세요.

18. 문서: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### 19. 노드는 게이트웨이 서비스를 실행하나요

아니요. 20. 의도적으로 격리된 프로필을 실행하지 않는 한(참조: [Multiple gateways](/gateway/multiple-gateways)), 호스트당 **하나의 게이트웨이**만 실행해야 합니다. 21. 노드는 게이트웨이에 연결되는 주변장치입니다(iOS/Android 노드 또는 메뉴바 앱의 macOS "노드 모드"). 22. 헤드리스 노드 호스트와 CLI 제어에 대해서는 [Node host CLI](/cli/node)를 참고하세요.

23. `gateway`, `discovery`, `canvasHost` 변경 사항에는 전체 재시작이 필요합니다.

### 24. 설정을 적용하는 API RPC 방식이 있나요

예. 25. `config.apply`는 전체 설정을 검증하고 기록한 다음, 작업의 일부로 Gateway를 재시작합니다.

### 26. configapply가 내 설정을 지웠습니다. 어떻게 복구하고 이를 방지하나요

27. `config.apply`는 **전체 설정**을 교체합니다. 28. 부분 객체를 보내면 나머지는 모두 제거됩니다.

29. 복구:

- 30. 백업에서 복원하세요(git 또는 복사해 둔 `~/.openclaw/openclaw.json`).
- 31. 백업이 없다면 `openclaw doctor`를 다시 실행하고 채널/모델을 재구성하세요.
- 32. 예상치 못한 동작이었다면 버그를 제출하고 마지막으로 알고 있는 설정이나 어떤 백업이든 포함하세요.
- 33. 로컬 코딩 에이전트는 종종 로그나 히스토리에서 작동하는 설정을 재구성할 수 있습니다.

34. 방지:

- 35. 작은 변경에는 `openclaw config set`을 사용하세요.
- 36. 대화형 편집에는 `openclaw configure`를 사용하세요.

37. 문서: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### 38. 첫 설치를 위한 최소한의 합리적인 설정은 무엇인가요

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

39. 이는 작업 공간을 설정하고 누가 봇을 트리거할 수 있는지 제한합니다.

### 40. VPS에 Tailscale을 설정하고 Mac에서 연결하려면 어떻게 하나요

Minimal steps:

1. **Install + login on the VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Install + login on your Mac**
   - Use the Tailscale app and sign in to the same tailnet.

3. **Enable MagicDNS (recommended)**
   - In the Tailscale admin console, enable MagicDNS so the VPS has a stable name.

4. **Use the tailnet hostname**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

If you want the Control UI without SSH, use Tailscale Serve on the VPS:

```bash
openclaw gateway --tailscale serve
```

This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).

### How do I connect a Mac node to a remote Gateway Tailscale Serve

Serve exposes the **Gateway Control UI + WS**. Nodes connect over the same Gateway WS endpoint.

Recommended setup:

1. **Make sure the VPS + Mac are on the same tailnet**.
2. **Use the macOS app in Remote mode** (SSH target can be the tailnet hostname).
   The app will tunnel the Gateway port and connect as a node.
3. **Approve the node** on the gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars and .env loading

### How does OpenClaw load environment variables

OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

- `.env` from the current working directory
- `~/.openclaw/.env` 의 전역 대체 `.env` (일명 `$OPENCLAW_STATE_DIR/.env`)

두 `.env` 파일 모두 기존 환경 변수를 덮어쓰지 않습니다.

You can also define inline env vars in config (applied only if missing from the process env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

전체 우선순위와 소스는 [/environment](/help/environment) 를 참고하십시오.

### I started the Gateway via the service and my env vars disappeared What now

Two common fixes:

1. Put the missing keys in `~/.openclaw/.env` so they're picked up even when the service doesn't inherit your shell env.
2. Enable shell import (opt-in convenience):

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### I set COPILOTGITHUBTOKEN but models status shows Shell env off Why

`openclaw models status` reports whether **shell env import** is enabled. "Shell env: off"
does **not** mean your env vars are missing - it just means OpenClaw won't load
your login shell automatically.

If the Gateway runs as a service (launchd/systemd), it won't inherit your shell
environment. Fix by doing one of these:

1. 1. 토큰을 `~/.openclaw/.env`에 넣으세요:

   ```
   2. COPILOT_GITHUB_TOKEN=...
   ```

2. 3. 또는 셸 가져오기를 활성화하세요 (`env.shellEnv.enabled: true`).

3. 4. 또는 설정의 `env` 블록에 추가하세요(누락된 경우에만 적용).

5) 그런 다음 게이트웨이를 재시작하고 다시 확인하세요:

```bash
openclaw models status
```

6. Copilot 토큰은 `COPILOT_GITHUB_TOKEN`(또는 `GH_TOKEN` / `GITHUB_TOKEN`)에서 읽습니다.
7. [/concepts/model-providers](/concepts/model-providers) 및 [/environment](/help/environment)를 참고하세요.

## 8. 세션과 다중 채팅

### 9. 새 대화를 시작하려면 어떻게 하나요

10. `/new` 또는 `/reset`을 단독 메시지로 보내세요. 11. [세션 관리](/concepts/session)를 참고하세요.

### 12. 새 메시지를 전혀 보내지 않으면 세션이 자동으로 초기화되나요

예. 13. 세션은 `session.idleMinutes` 이후에 만료됩니다(기본값 **60**). 14. **다음**
메시지가 해당 채팅 키에 대해 새 세션 ID로 시작됩니다. 15. 이는 기록을 삭제하지 않습니다
— 단지 새 세션을 시작할 뿐입니다.

```json5
16. {
  session: {
    idleMinutes: 240,
  },
}
```

### 17. OpenClaw 인스턴스 여러 개로 한 명의 CEO와 여러 에이전트로 구성된 팀을 만들 수 있나요

18. 네, **멀티 에이전트 라우팅**과 **서브 에이전트**를 통해 가능합니다. 19. 하나의 코디네이터 에이전트와 각자 작업 공간과 모델을 가진 여러 워커 에이전트를 만들 수 있습니다.

20. 다만 이는 **재미있는 실험**으로 보는 것이 가장 좋습니다. 21. 토큰 사용량이 많고 종종
    세션을 분리한 하나의 봇을 사용하는 것보다 효율이 떨어집니다. 22. 우리가 일반적으로 상정하는 모델은
    하나의 봇과, 병렬 작업을 위한 여러 세션입니다. 23. 그
    봇은 필요할 때 서브 에이전트를 생성할 수도 있습니다.

24. 문서: [멀티 에이전트 라우팅](/concepts/multi-agent), [서브 에이전트](/tools/subagents), [Agents CLI](/cli/agents).

### 25. 작업 도중에 컨텍스트가 잘린 이유는 무엇이며 이를 어떻게 방지하나요

26. 세션 컨텍스트는 모델의 컨텍스트 창 크기에 의해 제한됩니다. 27. 긴 대화, 큰 도구 출력, 또는 많은
    파일은 압축(compaction)이나 잘림(truncation)을 유발할 수 있습니다.

28. 도움이 되는 방법:

- 29. 현재 상태를 요약해서 파일로 작성해 달라고 봇에게 요청하세요.
- 30. 긴 작업 전에는 `/compact`를 사용하고, 주제를 전환할 때는 `/new`를 사용하세요.
- 31. 중요한 컨텍스트를 작업 공간에 유지하고 봇에게 다시 읽어 달라고 요청하세요.
- 32. 긴 작업이나 병렬 작업에는 서브 에이전트를 사용해 메인 채팅을 작게 유지하세요.
- 33. 이런 일이 자주 발생한다면 더 큰 컨텍스트 창을 가진 모델을 선택하세요.

### 34. OpenClaw를 설치 상태로 유지한 채 완전히 초기화하려면 어떻게 하나요

35. reset 명령을 사용하세요:

```bash
openclaw reset
```

36. 비대화형 전체 초기화:

```bash
37. openclaw reset --scope full --yes --non-interactive
```

38. 그런 다음 온보딩을 다시 실행하세요:

```bash
openclaw onboard --install-daemon
```

Notes:

- 39. 온보딩 마법사는 기존 설정을 감지하면 **Reset** 옵션도 제공합니다. 40. [마법사](/start/wizard)를 참고하세요.
- 프로필(`--profile` / `OPENCLAW_PROFILE`)을 사용했다면 각 상태 디렉터리를 초기화하세요(기본값은 `~/.openclaw-<profile>`입니다).
- 개발용 초기화: `openclaw gateway --dev --reset` (개발 전용; 개발 설정 + 자격 증명 + 세션 + 작업 공간을 모두 삭제합니다).

### 컨텍스트가 너무 크다는 오류가 발생하는데 어떻게 초기화하거나 압축하나요?

다음 중 하나를 사용합니다:

- **압축** (대화는 유지하되 이전 턴을 요약):

  ```
  /compact
  ```

  또는 요약을 안내하려면 `/compact <instructions>`를 사용하세요.

- **초기화** (같은 채팅 키에 대해 새 세션 ID):

  ```
  /new
  /reset
  ```

계속 발생한다면:

- **세션 가지치기**를 활성화하거나 조정하세요(`agents.defaults.contextPruning`) — 오래된 도구 출력을 잘라냅니다.
- 더 큰 컨텍스트 윈도우를 가진 모델을 사용하세요.

문서: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### 왜 LLM 요청이 거부되었다는 메시지(NcontentXtooluseinput Field required)가 보이나요?

이는 제공자 검증 오류입니다: 모델이 필수 `input` 없이 `tool_use` 블록을 생성했습니다. 보통 세션 기록이 오래되었거나 손상되었음을 의미합니다(대개 긴 스레드 이후 또는 도구/스키마 변경 후).

해결: `/new`로 새 세션을 시작하세요(단독 메시지).

### 왜 30분마다 하트비트 메시지가 오나요?

하트비트는 기본적으로 **30m**마다 실행됩니다. 조정하거나 비활성화하려면:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // 또는 비활성화하려면 "0m"
      },
    },
  },
}
```

`HEARTBEAT.md` 가 존재하지만 사실상 비어 있는 경우
(빈 줄과 `# Heading` 와 같은 마크다운 헤더만 있는 경우),
OpenClaw 는 API 호출을 절약하기 위해 Heartbeat 실행을 건너뜁니다.
파일이 없으면 하트비트는 계속 실행되며, 모델이 수행할 작업을 결정합니다.

에이전트별 오버라이드는 `agents.list[].heartbeat`를 사용합니다. 문서: [Heartbeat](/gateway/heartbeat).

### WhatsApp 그룹에 봇 계정을 추가해야 하나요?

아니요. OpenClaw는 **본인 계정**으로 실행되므로, 당신이 그룹에 있으면 OpenClaw가 이를 볼 수 있습니다.
기본적으로 발신자를 허용할 때까지 그룹 응답은 차단됩니다(`groupPolicy: "allowlist"`).

그룹 응답을 **본인만** 트리거할 수 있게 하려면:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### WhatsApp 그룹의 JID는 어떻게 얻나요?

옵션 1(가장 빠름): 로그를 따라가며 그룹에 테스트 메시지를 보내세요:

```bash
openclaw logs --follow --json
```

`@g.us`로 끝나는 `chatId`(또는 `from`)를 찾으세요. 예:
`1234567890-1234567890@g.us`.

옵션 2(이미 구성/허용 목록에 있는 경우): 설정에서 그룹 목록을 나열:

```bash
openclaw directory groups list --channel whatsapp
```

문서: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### 왜 OpenClaw가 그룹에서 답장하지 않나요?

두 가지 흔한 원인:

- 멘션 게이팅이 켜져 있습니다(기본값). 봇을 @멘션해야 합니다(또는 `mentionPatterns`와 일치해야 합니다).
- `channels.whatsapp.groups`를 `"*"` 없이 구성했고 해당 그룹이 허용 목록에 없습니다.

[Groups](/channels/groups) 및 [Group messages](/channels/group-messages)를 참고하세요.

### 그룹 스레드는 DM과 컨텍스트를 공유하나요

직접 채팅은 기본적으로 메인 세션으로 병합됩니다. 그룹/채널은 자체 세션 키를 가지며, Telegram 토픽 / Discord 스레드는 별도의 세션입니다. [그룹](/channels/groups) 및 [그룹 메시지](/channels/group-messages)를 참조하세요.

### 생성할 수 있는 워크스페이스와 에이전트 수는 몇 개인가요

하드 제한은 없습니다. 수십 개(심지어 수백 개)도 괜찮지만, 다음을 주의하세요:

- **디스크 증가:** 세션 + 전사본은 `~/.openclaw/agents/<agentId>/sessions/` 아래에 저장됩니다.
- **토큰 비용:** 에이전트가 많을수록 동시 모델 사용이 늘어납니다.
- **운영 오버헤드:** 에이전트별 인증 프로필, 워크스페이스, 채널 라우팅.

팁:

- 에이전트당 **활성** 워크스페이스는 하나만 유지하세요 (`agents.defaults.workspace`).
- 디스크가 늘어나면 오래된 세션(JSONL 또는 store 항목)을 정리(삭제)하세요.
- `openclaw doctor`를 사용해 남아 있는 워크스페이스와 프로필 불일치를 찾아보세요.

### Slack에서 여러 봇이나 채팅을 동시에 실행할 수 있나요? 그리고 어떻게 설정해야 하나요

예. **멀티 에이전트 라우팅**을 사용해 여러 개의 격리된 에이전트를 실행하고, 들어오는 메시지를
채널/계정/피어 기준으로 라우팅하세요. Slack은 채널로 지원되며 특정 에이전트에 바인딩할 수 있습니다.

브라우저 접근은 강력하지만 "사람이 할 수 있는 모든 것"은 아닙니다 - 안티봇, CAPTCHA, MFA는
여전히 자동화를 차단할 수 있습니다. 가장 신뢰할 수 있는 브라우저 제어를 위해, 브라우저가 실행되는 머신에서 Chrome 확장 릴레이를 사용하세요
(게이트웨이는 어디에 두어도 됩니다).

권장 설정:

- 항상 실행되는 Gateway 호스트(VPS/Mac mini).
- 역할별로 에이전트 하나씩(바인딩).
- 해당 에이전트에 바인딩된 Slack 채널(들).
- 필요 시 확장 릴레이(또는 노드)를 통한 로컬 브라우저.

문서: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## 모델: 기본값, 선택, 별칭, 전환

### 기본 모델은 무엇인가요

OpenClaw의 기본 모델은 다음에 설정한 값입니다:

```
agents.defaults.model.primary
```

모델은 `provider/model` 형식으로 참조됩니다 (예: `anthropic/claude-opus-4-6`). 프로바이더를 생략하면 OpenClaw는 현재 임시 디프리케이션 대체로 `anthropic`을 가정하지만, 그래도 `provider/model`을 **명시적으로** 설정해야 합니다.

### 어떤 모델을 추천하나요

**권장 기본값:** `anthropic/claude-opus-4-6`.
**좋은 대안:** `anthropic/claude-sonnet-4-5`.
**안정적(개성은 적음):** `openai/gpt-5.2` - Opus와 거의 비슷하지만 개성이 조금 적습니다.
**예산형:** `zai/glm-4.7`.

MiniMax M2.1에는 자체 문서가 있습니다: [MiniMax](/providers/minimax) 그리고
[Local models](/gateway/local-models).

경험 법칙: 중요한 작업에는 **감당할 수 있는 최고의 모델**을 사용하고, 일상적인 채팅이나 요약에는 더 저렴한
모델을 사용하세요. 에이전트별로 모델을 라우팅하고 하위 에이전트를 사용해
긴 작업을 병렬화할 수 있습니다(각 하위 에이전트는 토큰을 소비합니다). [Models](/concepts/models) 및
[Sub-agents](/tools/subagents)를 참고하세요.

강력한 경고: 성능이 약하거나 과도하게 양자화된 모델은 프롬프트
인젝션과 안전하지 않은 동작에 더 취약합니다. [Security](/gateway/security)를 참고하세요.

추가 맥락: [Models](/concepts/models).

### 자체 호스팅 모델 llamacpp, vLLM, Ollama를 사용할 수 있나요

예. 로컬 서버가 OpenAI 호환 API를 노출한다면, 이를 가리키는
커스텀 프로바이더를 설정할 수 있습니다. Ollama는 직접 지원되며 가장 쉬운 경로입니다.

1. 보안 참고: 더 작거나 심하게 양자화된 모델은 프롬프트 인젝션에 더 취약합니다. 2. 도구를 사용할 수 있는 모든 봇에는 **대형 모델**을 강력히 권장합니다.
2. 그래도 소형 모델을 사용하려면 샌드박싱과 엄격한 도구 허용 목록을 활성화하세요.

4. 문서: [Ollama](/providers/ollama), [로컬 모델](/gateway/local-models),
   [모델 제공자](/concepts/model-providers), [보안](/gateway/security),
   [샌드박싱](/gateway/sandboxing).

### 5. 설정을 초기화하지 않고 모델을 전환하려면 어떻게 하나요

6. **모델 명령어**를 사용하거나 **model** 필드만 편집하세요. 7. 전체 설정 덮어쓰기를 피하세요.

8. 안전한 옵션:

- 9. 채팅에서 `/model` (빠름, 세션별)
- 10. `openclaw models set ...` (모델 설정만 업데이트)
- 11. `openclaw configure --section model` (대화형)
- 12. `~/.openclaw/openclaw.json`에서 `agents.defaults.model` 편집

13. 전체 설정을 교체할 의도가 아니라면 부분 객체로 `config.apply`를 사용하지 마세요.
14. 설정을 덮어써버렸다면 백업에서 복원하거나 `openclaw doctor`를 다시 실행하여 복구하세요.

15. 문서: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### 16. OpenClaw, Flawd, Krill은 어떤 모델을 사용하나요

- 17. **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - [Anthropic](/providers/anthropic) 참고.
- 18. **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - [MiniMax](/providers/minimax) 참고.

### 19. 재시작 없이 즉석에서 모델을 전환하려면 어떻게 하나요

20. `/model` 명령을 단독 메시지로 사용하세요:

```
21. /model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

22. `/model`, `/model list`, 또는 `/model status`로 사용 가능한 모델을 나열할 수 있습니다.

23. `/model`(및 `/model list`)는 간결한 번호 선택기를 표시합니다. 24. 번호로 선택:

```
25. /model 3
```

26. 제공자에 대해 특정 인증 프로필을 강제로 지정할 수도 있습니다(세션별):

```
27. /model opus@anthropic:default
/model opus@anthropic:work
```

28. 팁: `/model status`는 활성 에이전트, 사용 중인 `auth-profiles.json` 파일, 다음에 시도될 인증 프로필을 보여줍니다.
29. 또한 사용 가능한 경우 구성된 제공자 엔드포인트(`baseUrl`)와 API 모드(`api`)도 표시합니다.

30. **profile로 설정한 프로필을 해제하려면 어떻게 하나요**

31. `@profile` 접미사 **없이** `/model`을 다시 실행하세요:

```
32. /model anthropic/claude-opus-4-6
```

33. 기본값으로 돌아가려면 `/model`에서 선택하거나 `/model <기본 제공자/모델>`을 보내세요.
34. 어떤 인증 프로필이 활성화되어 있는지 확인하려면 `/model status`를 사용하세요.

### 35. 일상 작업에는 GPT 5.2를, 코딩에는 Codex 5.3을 사용할 수 있나요

예. 36. 하나를 기본값으로 설정하고 필요에 따라 전환하세요:

- 37. **빠른 전환(세션별):** 일상 작업에는 `/model gpt-5.2`, 코딩에는 `/model gpt-5.3-codex`.
- 38. **기본값 + 전환:** `agents.defaults.model.primary`를 `openai/gpt-5.2`로 설정한 뒤, 코딩 시 `openai-codex/gpt-5.3-codex`로 전환하세요(또는 그 반대).
- 39. **서브 에이전트:** 코딩 작업을 다른 기본 모델을 사용하는 서브 에이전트로 라우팅하세요.

40. [Models](/concepts/models) 및 [Slash commands](/tools/slash-commands)를 참고하세요.

### Why do I see Model is not allowed and then no reply

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any
session overrides. Choosing a model that isn't in that list returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

That error is returned **instead of** a normal reply. Fix: add the model to
`agents.defaults.models`, remove the allowlist, or pick a model from `/model list`.

### Why do I see Unknown model minimaxMiniMaxM21

This means the **provider isn't configured** (no MiniMax provider config or auth
profile was found), so the model can't be resolved. A fix for this detection is
in **2026.1.12** (unreleased at the time of writing).

Fix checklist:

1. Upgrade to **2026.1.12** (or run from source `main`), then restart the gateway.
2. Make sure MiniMax is configured (wizard or JSON), or that a MiniMax API key
   exists in env/auth profiles so the provider can be injected.
3. Use the exact model id (case-sensitive): `minimax/MiniMax-M2.1` or
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   and pick from the list (or `/model list` in chat).

See [MiniMax](/providers/minimax) and [Models](/concepts/models).

### Can I use MiniMax as my default and OpenAI for complex tasks

예. Use **MiniMax as the default** and switch models **per session** when needed.
Fallbacks are for **errors**, not "hard tasks," so use `/model` or a separate agent.

**Option A: switch per session**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.1" },
      models: {
        "minimax/MiniMax-M2.1": { alias: "minimax" },
        "openai/gpt-5.2": { alias: "gpt" },
      },
    },
  },
}
```

그다음:

```
/model gpt
```

**Option B: separate agents**

- Agent A default: MiniMax
- Agent B default: OpenAI
- Route by agent or use `/agent` to switch

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Are opus sonnet gpt builtin shortcuts

예. OpenClaw ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

If you set your own alias with the same name, your value wins.

### How do I defineoverride model shortcuts aliases

Aliases come from `agents.defaults.models.<modelId>.alias`. Example:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

Then `/model sonnet` (or `/<alias>` when supported) resolves to that model ID.

### How do I add models from other providers like OpenRouter or ZAI

OpenRouter (pay-per-token; many models):

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

Z.AI (GLM models):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

If you reference a provider/model but the required provider key is missing, you'll get a runtime auth error (e.g. `No API key found for provider "zai"`).

**No API key found for provider after adding a new agent**

This usually means the **new agent** has an empty auth store. Auth is per-agent and
stored in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

해결 옵션:

- Run `openclaw agents add <id>` and configure auth during the wizard.
- Or copy `auth-profiles.json` from the main agent's `agentDir` into the new agent's `agentDir`.

Do **not** reuse `agentDir` across agents; it causes auth/session collisions.

## Model failover and "All models failed"

### How does failover work

Failover happens in two stages:

1. **Auth profile rotation** within the same provider.
2. `agents.defaults.model.fallbacks` 에서 다음 모델로의 **모델 폴백**.

Cooldowns apply to failing profiles (exponential backoff), so OpenClaw can keep responding even when a provider is rate-limited or temporarily failing.

### What does this error mean

```
No credentials found for profile "anthropic:default"
```

It means the system attempted to use the auth profile ID `anthropic:default`, but could not find credentials for it in the expected auth store.

### Fix checklist for No credentials found for profile anthropicdefault

- **Confirm where auth profiles live** (new vs legacy paths)
  - Current: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (migrated by `openclaw doctor`)
- **Confirm your env var is loaded by the Gateway**
  - If you set `ANTHROPIC_API_KEY` in your shell but run the Gateway via systemd/launchd, it may not inherit it. Put it in `~/.openclaw/.env` or enable `env.shellEnv`.
- **Make sure you're editing the correct agent**
  - Multi-agent setups mean there can be multiple `auth-profiles.json` files.
- **Sanity-check model/auth status**
  - Use `openclaw models status` to see configured models and whether providers are authenticated.

**Fix checklist for No credentials found for profile anthropic**

This means the run is pinned to an Anthropic auth profile, but the Gateway
can't find it in its auth store.

- **Use a setup-token**
  - Run `claude setup-token`, then paste it with `openclaw models auth setup-token --provider anthropic`.
  - If the token was created on another machine, use `openclaw models auth paste-token --provider anthropic`.

- **If you want to use an API key instead**
  - Put `ANTHROPIC_API_KEY` in `~/.openclaw/.env` on the **gateway host**.
  - Clear any pinned order that forces a missing profile:

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **Confirm you're running commands on the gateway host**
  - 원격 모드에서는 인증 프로필이 노트북이 아니라 게이트웨이 머신에 존재합니다.

### 왜 Google Gemini도 시도하다가 실패했나요?

모델 설정에 Google Gemini가 대체(fallback)로 포함되어 있거나 Gemini 단축어로 전환한 경우, OpenClaw는 모델 대체 과정에서 이를 시도합니다. Google 자격 증명을 구성하지 않았다면 `No API key found for provider "google"`가 표시됩니다.

해결: Google 인증을 제공하거나, `agents.defaults.model.fallbacks` / 별칭에서 Google 모델을 제거하거나 피해서 대체가 그쪽으로 라우팅되지 않게 하세요.

**LLM 요청이 거부됨: thinking 시그니처가 필요함 google antigravity**

원인: 세션 기록에 **시그니처가 없는 thinking 블록**이 포함되어 있습니다(대개 중단되었거나 부분적인 스트림에서 발생). Google Antigravity는 thinking 블록에 시그니처를 요구합니다.

해결: OpenClaw는 이제 Google Antigravity Claude에 대해 시그니처가 없는 thinking 블록을 제거합니다. 여전히 나타나면 **새 세션**을 시작하거나 해당 에이전트에서 `/thinking off`를 설정하세요.

## 인증 프로필: 무엇이며 어떻게 관리하는가

관련 문서: [/concepts/oauth](/concepts/oauth) (OAuth 플로우, 토큰 저장소, 다중 계정 패턴)

### 인증 프로필이란 무엇인가

인증 프로필은 제공자에 연결된 이름이 있는 자격 증명 레코드(OAuth 또는 API 키)입니다. 프로필은 다음 위치에 있습니다:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### 일반적인 프로필 ID는 무엇인가요

OpenClaw는 다음과 같은 제공자 접두사 ID를 사용합니다:

- `anthropic:default` (이메일 식별자가 없는 경우에 흔함)
- OAuth 신원에 대한 `anthropic:<email>`
- 직접 선택한 사용자 지정 ID(예: `anthropic:work`)

### 어떤 인증 프로필이 먼저 시도될지 제어할 수 있나요?

예. 설정은 프로필에 대한 선택적 메타데이터와 제공자별 순서(\`auth.order.<provider>\`\`)를 지원합니다. 이는 비밀 정보를 저장하지 않으며, ID를 제공자/모드에 매핑하고 순환 순서를 설정합니다.

OpenClaw는 짧은 **쿨다운**(요금 제한/타임아웃/인증 실패) 상태이거나 더 긴 **비활성화** 상태(청구/크레딧 부족)인 프로필을 일시적으로 건너뛸 수 있습니다. 이를 확인하려면 `openclaw models status --json`을 실행하고 `auth.unusableProfiles`를 확인하세요. 튜닝: `auth.cooldowns.billingBackoffHours*`.

CLI를 통해 **에이전트별** 순서 재정의를 설정할 수도 있습니다(해당 에이전트의 `auth-profiles.json`에 저장됨):

```bash
# Defaults to the configured default agent (omit --agent)
openclaw models auth order get --provider anthropic

# Lock rotation to a single profile (only try this one)
openclaw models auth order set --provider anthropic anthropic:default

# Or set an explicit order (fallback within provider)
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# Clear override (fall back to config auth.order / round-robin)
openclaw models auth order clear --provider anthropic
```

특정 에이전트를 대상으로 하려면:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth와 API 키의 차이는 무엇인가요?

OpenClaw는 둘 다 지원합니다:

- **OAuth**는 (해당되는 경우) 구독 기반 접근을 활용하는 경우가 많습니다.
- **API 키**는 토큰당 과금 방식의 청구를 사용합니다.

마법사는 Anthropic setup-token과 OpenAI Codex OAuth를 명시적으로 지원하며, API 키를 대신 저장해 줄 수 있습니다.

## 게이트웨이: 포트, "이미 실행 중", 그리고 원격 모드

### 게이트웨이는 어떤 포트를 사용하나요

`gateway.port`는 WebSocket + HTTP(컨트롤 UI, 훅 등)를 위한 단일 다중화 포트를 제어합니다.

우선순위:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > 기본값 18789
```

### 왜 openclaw gateway status에 Runtime running이라고 나오지만 RPC probe failed라고 하나요

"running"은 **슈퍼바이저**의 관점(launchd/systemd/schtasks)이기 때문입니다. RPC 프로브는 CLI가 실제로 게이트웨이 WebSocket에 연결하여 `status`를 호출하는 것입니다.

`openclaw gateway status`를 사용하고 다음 줄들을 신뢰하세요:

- `Probe target:` (프로브가 실제로 사용한 URL)
- `Listening:` (실제로 해당 포트에 바인딩된 것)
- `Last gateway error:` (프로세스는 살아 있지만 포트가 리슨하지 않을 때의 일반적인 근본 원인)

### 왜 openclaw gateway status에서 Config cli와 Config service가 다르게 보이나요

서비스가 하나의 설정 파일을 실행 중인데, 당신은 다른 설정 파일을 편집하고 있기 때문입니다(보통 `--profile` / `OPENCLAW_STATE_DIR` 불일치).

수정:

```bash
openclaw gateway install --force
```

서비스가 사용할 동일한 `--profile` / 환경에서 이를 실행하세요.

### "another gateway instance is already listening"은 무엇을 의미하나요

OpenClaw는 시작 시 즉시 WebSocket 리스너를 바인딩하여 런타임 락을 강제합니다(기본값 `ws://127.0.0.1:18789`). 바인딩이 `EADDRINUSE`로 실패하면, 다른 인스턴스가 이미 리슨 중임을 나타내는 `GatewayLockError`를 던집니다.

해결: 다른 인스턴스를 중지하거나, 포트를 비우거나, `openclaw gateway --port <port>`로 실행하세요.

### 원격 모드에서 OpenClaw를 실행하여 클라이언트가 다른 곳의 게이트웨이에 연결하려면 어떻게 하나요

`gateway.mode: "remote"`로 설정하고, 선택적으로 토큰/비밀번호와 함께 원격 WebSocket URL을 지정하세요:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

Notes:

- `openclaw gateway`는 `gateway.mode`가 `local`일 때만(또는 오버라이드 플래그를 전달했을 때) 시작됩니다.
- macOS 앱은 설정 파일을 감시하며, 이 값들이 변경되면 라이브로 모드를 전환합니다.

### 컨트롤 UI에 unauthorized가 표시되거나 계속 재연결됩니다. 이제 어떻게 하나요

게이트웨이는 인증이 활성화된 상태(`gateway.auth.*`)로 실행 중이지만, UI가 일치하는 토큰/비밀번호를 보내지 않고 있습니다.

사실(코드 기준):

- 컨트롤 UI는 토큰을 브라우저 localStorage 키 `openclaw.control.settings.v1`에 저장합니다.

수정:

- 가장 빠른 방법: `openclaw dashboard` (대시보드 URL을 출력하고 복사하며, 열기를 시도합니다. 헤드리스인 경우 SSH 힌트를 표시합니다).
- 아직 토큰이 없다면: `openclaw doctor --generate-gateway-token`.
- 원격인 경우 먼저 터널링하세요: `ssh -N -L 18789:127.0.0.1:18789 user@host` 그런 다음 `http://127.0.0.1:18789/`를 여세요.
- 게이트웨이 호스트에서 `gateway.auth.token`(또는 `OPENCLAW_GATEWAY_TOKEN`)을 설정하세요.
- In the Control UI settings, paste the same token.
- 아직도 해결되지 않나요? `openclaw status --all`을 실행하고 [문제 해결](/gateway/troubleshooting)을 따르세요. 인증 세부 사항은 [대시보드](/web/dashboard)를 참고하세요.

### gatewaybind를 tailnet으로 설정했는데 바인딩이 안 되고 아무것도 리슨하지 않습니다

`tailnet` 바인드는 네트워크 인터페이스에서 Tailscale IP(100.64.0.0/10)를 선택합니다. 해당 머신이 Tailscale에 연결되어 있지 않거나(또는 인터페이스가 다운된 경우) 바인딩할 대상이 없습니다.

수정:

- Start Tailscale on that host (so it has a 100.x address), or
- Switch to `gateway.bind: "loopback"` / `"lan"`.

Note: `tailnet` is explicit. `auto` prefers loopback; use `gateway.bind: "tailnet"` when you want a tailnet-only bind.

### Can I run multiple Gateways on the same host

Usually no - one Gateway can run multiple messaging channels and agents. Use multiple Gateways only when you need redundancy (ex: rescue bot) or hard isolation.

Yes, but you must isolate:

- `OPENCLAW_CONFIG_PATH` (per-instance config)
- `OPENCLAW_STATE_DIR` (per-instance state)
- `agents.defaults.workspace` (workspace isolation)
- `gateway.port` (unique ports)

Quick setup (recommended):

- Use `openclaw --profile <name> …` per instance (auto-creates `~/.openclaw-<name>`).
- Set a unique `gateway.port` in each profile config (or pass `--port` for manual runs).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Profiles also suffix service names (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
전체 가이드: [Multiple gateways](/gateway/multiple-gateways).

### What does invalid handshake code 1008 mean

The Gateway is a **WebSocket server**, and it expects the very first message to
be a `connect` frame. If it receives anything else, it closes the connection
with **code 1008** (policy violation).

일반적인 원인은 다음과 같습니다:

- You opened the **HTTP** URL in a browser (`http://...`) instead of a WS client.
- You used the wrong port or path.
- A proxy or tunnel stripped auth headers or sent a non-Gateway request.

Quick fixes:

1. Use the WS URL: `ws://<host>:18789` (or `wss://...` if HTTPS).
2. Don't open the WS port in a normal browser tab.
3. If auth is on, include the token/password in the `connect` frame.

If you're using the CLI or TUI, the URL should look like:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

프로토콜 세부 정보: [Gateway protocol](/gateway/protocol).

## Logging and debugging

### Where are logs

File logs (structured):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

You can set a stable path via `logging.file`. File log level is controlled by `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.

Fastest log tail:

```bash
openclaw logs --follow
```

Service/supervisor logs (when the gateway runs via launchd/systemd):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` and `gateway.err.log` (default: `~/.openclaw/logs/...`; profiles use `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- 1. Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

2. 자세한 내용은 [Troubleshooting](/gateway/troubleshooting#log-locations)을 참고하세요.

### 3. Gateway 서비스를 시작/중지/재시작하려면 어떻게 하나요

4. gateway 헬퍼를 사용하세요:

```bash
5. openclaw gateway status
openclaw gateway restart
```

6. gateway를 수동으로 실행 중이라면, `openclaw gateway --force`로 포트를 다시 점유할 수 있습니다. [Gateway](/gateway)를 참조하십시오.

### 7. Windows에서 터미널을 닫았는데 OpenClaw를 어떻게 재시작하나요

8. **Windows 설치 모드는 두 가지**가 있습니다:

9. **1) WSL2 (권장):** Gateway가 Linux 내부에서 실행됩니다.

10. PowerShell을 열고 WSL에 들어간 다음 재시작하세요:

```powershell
11. wsl
openclaw gateway status
openclaw gateway restart
```

12. 서비스를 설치한 적이 없다면 포그라운드에서 시작하세요:

```bash
openclaw gateway run
```

13. **2) 네이티브 Windows (비권장):** Gateway가 Windows에서 직접 실행됩니다.

14. PowerShell을 열고 다음을 실행하세요:

```powershell
15. openclaw gateway status
openclaw gateway restart
```

16. 수동으로 실행하는 경우(서비스 없음) 다음을 사용하세요:

```powershell
openclaw gateway run
```

17. 문서: [Windows (WSL2)](/platforms/windows), [Gateway 서비스 런북](/gateway).

### 18. Gateway는 올라와 있는데 응답이 도착하지 않습니다 무엇을 확인해야 하나요

19. 빠른 상태 점검부터 시작하세요:

```bash
20. openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

일반적인 원인은 다음과 같습니다:

- 21. **gateway 호스트**에 모델 인증이 로드되지 않음 (`models status` 확인).
- 22. 채널 페어링/허용 목록이 응답을 차단함 (채널 설정 + 로그 확인).
- 23. 올바른 토큰 없이 WebChat/Dashboard가 열려 있음.

24. 원격이라면 터널/Tailscale 연결이 살아 있고 Gateway WebSocket에 접근 가능한지 확인하세요.

25. 문서: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### 26. 이유 없이 gateway에서 연결이 끊겼습니다 이제 어떻게 하나요

27. 보통 UI가 WebSocket 연결을 잃었음을 의미합니다. 다음을 확인하십시오:

1. 28. Gateway가 실행 중인가요? `openclaw gateway status`
2. 29. Gateway 상태는 정상인가요? `openclaw status`
3. 30. UI에 올바른 토큰이 있나요? `openclaw dashboard`
4. 31. 원격이라면 터널/Tailscale 링크가 살아 있나요?

32) 그런 다음 로그를 추적하세요:

```bash
openclaw logs --follow
```

33. 문서: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### 34. Telegram setMyCommands가 네트워크 오류로 실패합니다 무엇을 확인해야 하나요

35. 로그와 채널 상태부터 확인하세요:

```bash
36. openclaw channels status
openclaw channels logs --channel telegram
```

37. VPS를 사용 중이거나 프록시 뒤에 있다면, 아웃바운드 HTTPS가 허용되고 DNS가 정상인지 확인하세요.
38. Gateway가 원격에 있다면 Gateway 호스트의 로그를 보고 있는지 확인하세요.

39. 문서: [Telegram](/channels/telegram), [채널 문제 해결](/channels/troubleshooting).

### 40. TUI에 출력이 없습니다 무엇을 확인해야 하나요

First confirm the Gateway is reachable and the agent can run:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

In the TUI, use `/status` to see the current state. If you expect replies in a chat
channel, make sure delivery is enabled (`/deliver on`).

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### How do I completely stop then start the Gateway

If you installed the service:

```bash
openclaw gateway stop
openclaw gateway start
```

This stops/starts the **supervised service** (launchd on macOS, systemd on Linux).
Use this when the Gateway runs in the background as a daemon.

If you're running in the foreground, stop with Ctrl-C, then:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway restart vs openclaw gateway

- `openclaw gateway restart`: restarts the **background service** (launchd/systemd).
- `openclaw gateway`: runs the gateway **in the foreground** for this terminal session.

If you installed the service, use the gateway commands. Use `openclaw gateway` when
you want a one-off, foreground run.

### 가장 빠르게 해결하는 방법은 무엇인가요?

Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for channel auth, model routing, and RPC errors.

## Media and attachments

### My skill generated an imagePDF but nothing was sent

Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [OpenClaw assistant setup](/start/openclaw) and [Agent send](/tools/agent-send).

CLI sending:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Also check:

- The target channel supports outbound media and isn't blocked by allowlists.
- The file is within the provider's size limits (images are resized to max 2048px).

See [Images](/nodes/images).

## Security and access control

### Is it safe to expose OpenClaw to inbound DMs

Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

- Default behavior on DM-capable channels is **pairing**:
  - Unknown senders receive a pairing code; the bot does not process their message.
  - Approve with: `openclaw pairing approve <channel> <code>`
  - Pending requests are capped at **3 per channel**; check `openclaw pairing list <channel>` if a code didn't arrive.
- Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).

Run `openclaw doctor` to surface risky DM policies.

### Is prompt injection only a concern for public bots

아니요. Prompt injection is about **untrusted content**, not just who can DM the bot.
If your assistant reads external content (web search/fetch, browser pages, emails,
docs, attachments, pasted logs), that content can include instructions that try
to hijack the model. This can happen even if **you are the only sender**.

The biggest risk is when tools are enabled: the model can be tricked into
exfiltrating context or calling tools on your behalf. 영향 범위를 줄이려면:

- using a read-only or tool-disabled "reader" agent to summarize untrusted content
- keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents
- sandboxing and strict tool allowlists

Details: [Security](/gateway/security).

### Should my bot have its own email GitHub account or phone number

Yes, for most setups. Isolating the bot with separate accounts and phone numbers
reduces the blast radius if something goes wrong. This also makes it easier to rotate
credentials or revoke access without impacting your personal accounts.

Start small. Give access only to the tools and accounts you actually need, and expand
later if required.

Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

### Can I give it autonomy over my text messages and is that safe

We do **not** recommend full autonomy over your personal messages. The safest pattern is:

- Keep DMs in **pairing mode** or a tight allowlist.
- Use a **separate number or account** if you want it to message on your behalf.
- Let it draft, then **approve before sending**.

If you want to experiment, do it on a dedicated account and keep it isolated. See
[Security](/gateway/security).

### Can I use cheaper models for personal assistant tasks

Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are
more susceptible to instruction hijacking, so avoid them for tool-enabled agents
or when reading untrusted content. If you must use a smaller model, lock down
tools and run inside a sandbox. See [Security](/gateway/security).

### I ran start in Telegram but didnt get a pairing code

Pairing codes are sent **only** when an unknown sender messages the bot and
`dmPolicy: "pairing"` is enabled. `/start` by itself doesn't generate a code.

Check pending requests:

```bash
openclaw pairing list telegram
```

If you want immediate access, allowlist your sender id or set `dmPolicy: "open"`
for that account.

### WhatsApp will it message my contacts How does pairing work

아니요. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code and their message is **not processed**. OpenClaw only replies to chats it receives or to explicit sends you trigger.

Approve pairing with:

```bash
openclaw pairing approve whatsapp <code>
```

List pending requests:

```bash
openclaw pairing list whatsapp
```

Wizard phone number prompt: it's used to set your **allowlist/owner** so your own DMs are permitted. 자동 전송에 사용되는 것은 아닙니다. 개인 WhatsApp 번호로 실행하는 경우 해당 번호를 사용하고 `channels.whatsapp.selfChatMode`를 활성화하세요.

## 채팅 명령어, 작업 중단, 그리고 "멈추지 않아요"

### 채팅에 내부 시스템 메시지가 표시되지 않게 하려면 어떻게 하나요?

대부분의 내부 메시지나 도구 메시지는 해당 세션에서 **verbose** 또는 **reasoning**이 활성화된 경우에만 표시됩니다.

보이는 채팅에서 다음을 수정하세요:

```
/verbose off
/reasoning off
```

그래도 시끄럽다면 Control UI의 세션 설정을 확인하고 verbose를 **inherit**로 설정하세요. 또한 config에서 `verboseDefault`가 `on`으로 설정된 봇 프로필을 사용하고 있지 않은지도 확인하세요.

문서: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### 실행 중인 작업을 중지/취소하려면 어떻게 하나요?

다음 중 아무 것이나 **단독 메시지로** 보내세요(슬래시 없음):

```
stop
abort
esc
wait
exit
interrupt
```

이것들은 중단 트리거이며(슬래시 명령이 아님)입니다.

백그라운드 프로세스(exec 도구에서 실행된 경우)의 경우, 에이전트에게 다음을 실행하라고 요청할 수 있습니다:

```
process action:kill sessionId:XXX
```

슬래시 명령 개요: [Slash commands](/tools/slash-commands)를 참고하세요.

대부분의 명령은 `/`로 시작하는 **단독** 메시지로 보내야 하지만, 몇 가지 단축키(예: `/status`)는 허용 목록에 있는 발신자에 한해 인라인으로도 동작합니다.

### [Telegram 에서 Discord 메시지를 보내려면 어떻게 하나요?('Cross-context messaging denied')](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)

OpenClaw는 기본적으로 **교차 제공자** 메시징을 차단합니다. 도구 호출이 Telegram에 바인딩되어 있으면, 명시적으로 허용하지 않는 한 Discord로는 전송되지 않습니다.

에이전트에 대해 교차 제공자 메시징을 활성화하세요:

```json5
{
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marker: { enabled: true, prefix: "[from {channel}] " },
          },
        },
      },
    },
  },
}
```

config를 수정한 후 게이트웨이를 재시작하세요. 단일 에이전트에만 적용하려면 `agents.list[].tools.message` 아래에 설정하세요.

### 봇이 연속으로 빠르게 보낸 메시지를 무시하는 것처럼 느껴지는 이유는 무엇인가요?

큐 모드는 진행 중인 실행과 새 메시지가 어떻게 상호작용하는지를 제어합니다. `/queue`를 사용해 모드를 변경하세요:

- `steer` - 새 메시지가 현재 작업을 재지정합니다.
- `followup` - 메시지를 하나씩 실행합니다.
- `collect` - 메시지를 묶어 한 번만 응답합니다(기본값).
- `steer-backlog` - 지금은 재지정하고, 이후 백로그를 처리합니다.
- `interrupt` - 현재 실행을 중단하고 새로 시작합니다.

followup 모드에는 `debounce:2s cap:25 drop:summarize` 같은 옵션을 추가할 수 있습니다.

## 스크린샷/채팅 로그의 정확한 질문에 답하세요.

**Q: "API 키를 사용할 때 Anthropic의 기본 모델은 무엇인가요?"**

**A:** OpenClaw에서는 자격 증명과 모델 선택이 분리되어 있습니다. `ANTHROPIC_API_KEY`를 설정하거나(또는 auth 프로필에 Anthropic API 키를 저장하면) 인증이 활성화되지만, 실제 기본 모델은 `agents.defaults.model.primary`에 구성한 값입니다(예: `anthropic/claude-sonnet-4-5` 또는 `anthropic/claude-opus-4-6`). `No credentials found for profile "anthropic:default"`가 표시된다면, 실행 중인 에이전트에 대해 게이트웨이가 예상 위치의 `auth-profiles.json`에서 Anthropic 자격 증명을 찾지 못했다는 의미입니다.

---

아직 해결되지 않았나요? [Discord](https://discord.com/invite/clawd)에서 질문하거나 [GitHub discussion](https://github.com/openclaw/openclaw/discussions)을 열어주세요.
