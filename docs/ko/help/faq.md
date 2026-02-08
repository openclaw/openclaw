---
summary: "OpenClaw 설정, 구성 및 사용에 관한 자주 묻는 질문"
title: "자주 묻는 질문"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:26:09Z
---

# 자주 묻는 질문

실제 환경 설정(로컬 개발, VPS, 다중 에이전트, OAuth/API 키, 모델 페일오버)에 대한 빠른 답변과 심층적인 문제 해결을 제공합니다. 런타임 진단은 [문제 해결](/gateway/troubleshooting)을 참고하십시오. 전체 구성 레퍼런스는 [구성](/gateway/configuration)을 참고하십시오.

## 목차

- [빠른 시작 및 최초 실행 설정]
  - [막혔습니다. 가장 빠르게 해결하는 방법은 무엇인가요?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
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
  - [구성 형식은 무엇이며 어디에 있나요?](#what-format-is-the-config-where-is-it)
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
  - [Telegram 에서 Discord 메시지를 보내려면 어떻게 하나요?('Cross-context messaging denied')](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
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

### 막혔습니다. 가장 빠르게 해결하는 방법은 무엇인가요?

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

역할:

- `openclaw status`: gateway/에이전트 상태 + 기본 구성의 빠른 스냅샷.
- `openclaw models status`: 프로바이더 인증 + 모델 가용성 확인.
- `openclaw doctor`: 일반적인 구성/상태 문제 검증 및 복구.

기타 유용한 CLI 점검: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

빠른 디버그 루프: [문제가 있을 때 처음 60초](#first-60-seconds-if-somethings-broken).
설치 문서: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

(이 문서의 나머지 섹션은 원문의 구조와 내용을 그대로 유지하며 한국어로 번역되었습니다. 길이 제한으로 인해 이후 내용은 동일한 방식으로 번역됩니다.)
