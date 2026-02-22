---
summary: "OpenClaw 설정, 구성 및 사용에 대한 자주 묻는 질문"
title: "자주 묻는 질문"
---

# 자주 묻는 질문

현실 세계의 설정(로컬 개발, VPS, 다중 에이전트, OAuth/API 키, 모델 장애 조치)에 대한 빠른 답변과 심층적인 문제 해결. 런타임 진단은 [문제 해결](/gateway/troubleshooting)을 참조하십시오. 전체 설정 참조는 [구성](/gateway/configuration)을 참조하십시오.

## 목차

- [빠른 시작 및 첫 실행 설정]
  - [문제에 직면했을 때 가장 빠르게 해결하는 방법은?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw를 설치하고 설정하는 권장 방법은 무엇인가요?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [온보딩 후 대시보드를 어떻게 엽니까?](#how-do-i-open-the-dashboard-after-onboarding)
  - [로컬호스트와 원격에서 대시보드(토큰)를 어떻게 인증하나요?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [어떤 런타임이 필요합니까?](#what-runtime-do-i-need)
  - [라즈베리 Pi에서 실행됩니까?](#does-it-run-on-raspberry-pi)
  - [라즈베리 Pi 설치에 대한 팁이 있나요?](#any-tips-for-raspberry-pi-installs)
  - ["Wake up my friend"에서 멈춰 있습니다 / 온보딩이 진행되지 않습니다. 이제 어떻게 해야 하나요?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [설정을 새로운 기기(Mac mini)로 이전할 수 있나요, 온보딩을 다시 하지 않고?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [최신 버전의 새로운 점을 어디에서 볼 수 있나요?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [docs.openclaw.ai에 액세스할 수 없습니다 (SSL 오류). 이제 어떻게 하나요?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [안정 버전과 베타 버전의 차이는 무엇인가요?](#whats-the-difference-between-stable-and-beta)
  - [베타 버전을 어떻게 설치하며, 베타와 개발의 차이는 무엇인가요?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [최신 버전을 어떻게 시도하나요?](#how-do-i-try-the-latest-bits)
  - [설치와 온보딩은 보통 얼마나 걸리나요?](#how-long-does-install-and-onboarding-usually-take)
  - [설치 프로그램이 멈췄습니다. 어떻게 해야 더 많은 피드백을 받을 수 있습니까?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows에서 git을 찾을 수 없거나 OpenClaw가 인식되지 않는다는 메시지가 나옵니다.](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [문서가 제 질문에 답하지 않았습니다 - 더 나은 답변을 얻으려면 어떻게 해야 하나요?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Linux에 OpenClaw를 어떻게 설치하나요?](#how-do-i-install-openclaw-on-linux)
  - [VPS에 OpenClaw를 설치하는 방법은?](#how-do-i-install-openclaw-on-a-vps)
  - [클라우드/VPS 설치 가이드는 어디에 있나요?](#where-are-the-cloudvps-install-guides)
  - [OpenClaw에게 자체 업데이트를 요청할 수 있나요?](#can-i-ask-openclaw-to-update-itself)
  - [온보딩 마법사는 실제로 무엇을 하나요?](#what-does-the-onboarding-wizard-actually-do)
  - [이것을 실행하려면 Claude 또는 OpenAI 구독이 필요합니까?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [API 키 없이 Claude Max 구독을 사용할 수 있나요?](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic "setup-token" 인증은 어떻게 작동하나요?](#how-does-anthropic-setuptoken-auth-work)
  - [어디에서 Anthropic setup-token을 찾을 수 있나요?](#where-do-i-find-an-anthropic-setuptoken)
  - [Claude 구독 인증(Claude Pro 또는 Max)을 지원합니까?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Anthropic에서 `HTTP 429: rate_limit_error`를 보는 이유는 무엇인가요?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock이 지원됩니까?](#is-aws-bedrock-supported)
  - [Codex 인증은 어떻게 작동하나요?](#how-does-codex-auth-work)
  - [OpenAI 구독 인증(Codex OAuth)을 지원합니까?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Gemini CLI OAuth을 어떻게 설정하나요?](#how-do-i-set-up-gemini-cli-oauth)
  - [일반 채팅에 로컬 모델을 사용해도 괜찮나요?](#is-a-local-model-ok-for-casual-chats)
  - [호스팅된 모델 트래픽을 특정 지역에 유지하려면 어떻게 해야 하나요?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [이것을 설치하려면 Mac Mini를 구매해야 하나요?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage 지원을 위해 Mac mini가 필요합니까?](#do-i-need-a-mac-mini-for-imessage-support)
  - [OpenClaw를 실행하기 위해 Mac mini를 구입한 경우, MacBook Pro에 연결할 수 있나요?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Bun을 사용할 수 있나요?](#can-i-use-bun)
  - [Telegram: `allowFrom`에 무엇을 입력해야 하나요?](#telegram-what-goes-in-allowfrom)
  - [여러 OpenClaw 인스턴스와 하나의 WhatsApp 번호를 여러 사람이 사용할 수 있나요?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - ["빠른 채팅" 에이전트와 "Opus for coding" 에이전트를 실행할 수 있나요?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew가 Linux에서 작동하나요?](#does-homebrew-work-on-linux)
  - [해킹 가능한(git) 설치와 npm 설치의 차이점은 무엇인가요?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [나중에 npm과 git 설치 간 전환할 수 있나요?](#can-i-switch-between-npm-and-git-installs-later)
  - [게이트웨이를 노트북 또는 VPS에 실행해야 하나요?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [전용 머신에서 OpenClaw를 실행하는 것이 얼마나 중요한가요?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [최소 VPS 요구 사항과 권장 OS는 무엇인가요?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [OpenClaw를 VM에서 실행할 수 있으며 요구 사항은 무엇인가요?](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [OpenClaw란 무엇인가요?](#what-is-openclaw)
  - [한 문장으로 OpenClaw란 무엇인가요?](#what-is-openclaw-in-one-paragraph)
  - [가치 제안은 무엇인가요?](#whats-the-value-proposition)
  - [설정을 완료했습니다. 무엇을 먼저 해야 하나요?](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw의 일상적인 사용 사례 상위 5가지는 무엇인가요?](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw가 SaaS의 리드 생성 외연 광고 및 블로그에 도움이 될 수 있나요?](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [웹 개발에 있어서 Claude Code보다 어떤 장점이 있나요?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [스킬과 자동화](#skills-and-automation)
  - [저장소를 더럽히지 않고 스킬을 어떻게 커스터마이즈하나요?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [사용자 지정 폴더에서 스킬을 로드할 수 있나요?](#can-i-load-skills-from-a-custom-folder)
  - [다른 작업에 다른 모델을 어떻게 사용할 수 있나요?](#how-can-i-use-different-models-for-different-tasks)
  - [봇이 무거운 작업을 수행할 때 멈춥니다. 이를 어떻게 해소하나요?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron 또는 리마인더가 실행되지 않습니다. 무엇을 확인해야 하나요?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Linux에 스킬을 어떻게 설치하나요?](#how-do-i-install-skills-on-linux)
  - [OpenClaw가 일정에 따라 또는 백그라운드에서 계속해서 작업을 수행할 수 있나요?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Linux에서 macOS 전용 스킬을 실행할 수 있나요?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Notion 또는 HeyGen 통합이 있나요?](#do-you-have-a-notion-or-heygen-integration)
  - [브라우저 사용 권한을 장악하기 위해 Chrome 확장을 어떻게 설치하나요?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [샌드박스 격리와 메모리](#sandboxing-and-memory)
  - [전용 샌드박스 문서가 있나요?](#is-there-a-dedicated-sandboxing-doc)
  - [호스트 폴더를 샌드박스에 어떻게 바인딩하나요?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [메모리는 어떻게 작동합니까?](#how-does-memory-work)
  - [메모리가 계속 잊어버립니다. 어떻게 유지시키나요?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [메모리는 영원히 지속되나요? 제한이 있나요?](#does-memory-persist-forever-what-are-the-limits)
  - [의미적 메모리 검색에는 OpenAI API 키가 필요합니까?](#does-semantic-memory-search-require-an-openai-api-key)
- [파일 저장 위치](#where-things-live-on-disk)
  - [OpenClaw에서 사용되는 모든 데이터가 로컬에 저장되나요?](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw가 데이터를 어디에 저장하나요?](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md는 어디에 있어야 하나요?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [권장하는 백업 전략은 무엇인가요?](#whats-the-recommended-backup-strategy)
  - [OpenClaw를 완전히 제거하려면 어떻게 하나요?](#how-do-i-completely-uninstall-openclaw)
  - [에이전트가 작업 공간 외부에서 작동할 수 있나요?](#can-agents-work-outside-the-workspace)
  - [원격 모드입니다. 세션 저장소는 어디 있나요?](#im-in-remote-mode-where-is-the-session-store)
- [설정 기본](#config-basics)
  - [설정의 형식은 무엇이며, 어디에 있나요?](#what-format-is-the-config-where-is-it)
  - [`gateway.bind: "lan"`(또는 `"tailnet"`)을 설정했더니 아무것도 수신하지 않거나 UI가 승인되지 않았다고 합니다.](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [왜 이제 로컬호스트에서 토큰이 필요할까요?](#why-do-i-need-a-token-on-localhost-now)
  - [설정을 변경한 후 다시 시작해야 하나요?](#do-i-have-to-restart-after-changing-config)
  - [웹 검색(및 웹 가져오기)을 어떻게 활성화합니까?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply가 내 설정을 지웠습니다. 어떻게 복구하고 이를 피할 수 있을까요?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [특수 작업자를 여러 디바이스에 걸쳐 중앙 게이트웨이로 어떻게 실행하나요?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [OpenClaw 브라우저를 헤드리스로 실행할 수 있나요?](#can-the-openclaw-browser-run-headless)
  - [브라우저 제어에 Brave를 어떻게 사용합니까?](#how-do-i-use-brave-for-browser-control)
- [원격 게이트웨이 및 노드](#remote-gateways-and-nodes)
  - [Telegram, 게이트웨이, 노드 간의 명령이 어떻게 전파됩니까?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [게이트웨이가 원격으로 호스팅되는 경우, 내 에이전트가 내 컴퓨터에 어떻게 액세스할 수 있을까요?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale이 연결되었지만 응답이 없습니다. 이제 어떻게 해야 하나요?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [두 개의 OpenClaw 인스턴스(로컬 + VPS)가 서로 대화할 수 있나요?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [여러 에이전트를 위해 별도의 VPS가 필요합니까?](#do-i-need-separate-vpses-for-multiple-agents)
  - [VPS에서 SSH를 사용할 때 노드를 사용하는 대신 개인 노트북에 노드를 사용하는 이점이 있나요?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [노드가 게이트웨이 서비스를 실행합니까?](#do-nodes-run-a-gateway-service)
  - [설정을 적용하는 API/RPC 방법이 있나요?](#is-there-an-api-rpc-way-to-apply-config)
  - [첫 설치를 위한 최소 "무결성" 설정은 무엇인가요?](#whats-a-minimal-sane-config-for-a-first-install)
  - [VPS에서 Tailscale을 어떻게 설정하고 내 Mac에서 연결합니까?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Mac 노드를 원격 게이트웨이에 어떻게 연결합니까 (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [두 번째 노트북에 설치해야 하나요, 아니면 노드를 추가하는 것이 좋나요?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [환경 변수 및 .env 로딩](#env-vars-and-env-loading)
  - [OpenClaw가 환경 변수를 어떻게 로드합니까?](#how-does-openclaw-load-environment-variables)
  - ["서비스를 통해 게이트웨이를 시작했는데 환경 변수가 사라졌습니다." 이제 어떻게 해야 하나요?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [`COPILOT_GITHUB_TOKEN`을 설정했지만 모델 상태는 "Shell env: off."라고 표시됩니다. 왜 이런가요?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [세션 및 다중 채팅](#sessions-and-multiple-chats)
  - [새로운 대화를 어떻게 시작하나요?](#how-do-i-start-a-fresh-conversation)
  - [`/new`를 보낸 적이 없으면 세션이 자동으로 재설정됩니까?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [OpenClaw 인스턴스를 한 CEO와 여러 에이전트로 구성된 팀으로 만들 수 있나요?](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [작업 중간에 컨텍스트가 잘려나간 이유는 무엇이며, 이를 어떻게 방지할 수 있나요?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [OpenClaw를 완전히 재설정하고 설치된 상태를 유지하려면 어떻게 해야 합니까?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - ["컨텍스트가 너무 큽니다" 오류가 발생했습니다 - 어떻게 리셋하거나 컴팩트하게 만들까요?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - ["LLM 요청 거부됨: messages.N.content.X.tool_use.input: 필드 필요"를 보는 이유는 무엇인가요?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [30분마다 왜 하트비트 메시지가 나타납니까?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [WhatsApp 그룹에 "봇 계정"을 추가해야 하나요?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [WhatsApp 그룹의 JID를 어떻게 얻나요?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [왜 OpenClaw는 그룹에서 답장하지 않나요?](#why-doesnt-openclaw-reply-in-a-group)
  - [그룹/스레드가 다이렉트 메시지와 컨텍스트를 공유합니까?](#do-groupsthreads-share-context-with-dms)
  - [얼마나 많은 워크스페이스와 에이전트를 만들 수 있습니까?](#how-many-workspaces-and-agents-can-i-create)
  - [여러 봇 또는 채팅을 동시에 실행할 수 있나요(Slack) 그리고 어떻게 설정해야 하나요?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [모델: 기본값, 선택, 별칭, 전환](#models-defaults-selection-aliases-switching)
  - ["기본 모델"이란 무엇인가요?](#what-is-the-default-model)
  - [추천하는 모델은 무엇인가요?](#what-model-do-you-recommend)
  - [설정을 지우지 않고 모델을 어떻게 전환하나요?](#how-do-i-switch-models-without-wiping-my-config)
  - [자체 호스팅 모델(llama.cpp, vLLM, Ollama)를 사용할 수 있나요?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw, Flawd, Krill은 어떤 모델을 사용합니까?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [재시작 없이 즉시 모델을 전환할 수 있나요?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [일상 업무에는 GPT 5.2를, 코딩에는 Codex 5.3를 사용할 수 있나요?](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - ["모델 … 허용되지 않음"이라고 하고 응답이 없는 이유는?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - ["Unknown model: minimax/MiniMax-M2.1" 메시지를 보는 이유는 무엇인가요?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [MiniMax를 기본값으로 사용하고 복잡한 작업에 OpenAI를 사용할 수 있나요?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt는 내장된 단축키인가요?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [모델 단축키(별칭)를 어떻게 정의/재정의하나요?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [OpenRouter 또는 Z.AI와 같은 다른 프로바이더에서 모델을 어떻게 추가합니까?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [모델 장애 조치 및 "모든 모델 실패"](#model-failover-and-all-models-failed)
  - [장애 조치는 어떻게 작동하나요?](#how-does-failover-work)
  - [이 오류는 무엇을 의미합니까?](#what-does-this-error-mean)
  - [`No credentials found for profile "anthropic:default"`에 대한 수정 체크리스트](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Google Gemini도 시도하고 실패한 이유는?](#why-did-it-also-try-google-gemini-and-fail)
- [인증 프로파일: 그것들이 무엇이며 어떻게 관리하나요](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [인증 프로파일이란 무엇인가요?](#what-is-an-auth-profile)
  - [일반적인 프로파일 ID는 무엇인가요?](#what-are-typical-profile-ids)
  - [어떤 인증 프로파일을 먼저 시도할지 제어할 수 있나요?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth와 API 키: 차이점은 무엇인가요?](#oauth-vs-api-key-whats-the-difference)
- [게이트웨이: 포트, "이미 실행 중", 원격 모드](#gateway-ports-already-running-and-remote-mode)
  - [게이트웨이는 어떤 포트를 사용하나요?](#what-port-does-the-gateway-use)
  - [왜 `openclaw gateway status`는 `Runtime: running`이라고 하지만 `RPC probe: failed`라고 합니까?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [왜 `openclaw gateway status`는 `Config (cli)`와 `Config (service)`가 다르다고 표시합니까?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - ["또 다른 게이트웨이 인스턴스가 이미 수신 중"이라는 메시지는 무엇을 의미하나요?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [OpenClaw를 원격 모드에서 어떻게 실행하나요 (클라이언트가 다른 곳에 있는 게이트웨이에 연결)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [제어 UI가 "토큰 없음" (또는 계속 재연결 중)이라고 합니다. 이제 어떻게 하나요?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [`gateway.bind: "tailnet"`을 설정했지만 바인드할 수 없거나 아무것도 수신하지 않습니다](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [같은 호스트에서 여러 게이트웨이를 실행할 수 있나요?](#can-i-run-multiple-gateways-on-the-same-host)
  - ["잘못된 핸드셰이크" / 코드 1008은 무엇을 의미합니까?](#what-does-invalid-handshake-code-1008-mean)
- [로깅 및 디버깅](#logging-and-debugging)
  - [로그는 어디에 있나요?](#where-are-logs)
  - [게이트웨이 서비스를 시작/중지/재시작하는 방법은?](#how-do-i-startstoprestart-the-gateway-service)
  - [Windows에서 터미널을 닫았습니다 - OpenClaw를 어떻게 다시 시작하나요?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [게이트웨이는 실행 중이지만 응답이 도착하지 않습니다. 무엇을 확인해야 하나요?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["게이트웨이와의 연결이 끊어졌습니다. 이유 없음" - 이제 어떻게 해야 하나요?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands가 네트워크 오류로 실패합니다. 무엇을 확인해야 하나요?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI가 출력을 표시하지 않습니다. 무엇을 확인해야 하나요?](#tui-shows-no-output-what-should-i-check)
  - [게이트웨이를 완전히 중지한 다음 다시 시작하려면 어떻게 합니까?](#how-do-i-completely-stop-then-start-the-gateway)
  - [간단하게 설명: `openclaw gateway restart`와 `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [무엇인가 잘못되었을 때 정보를 가장 빠르게 얻는 방법은 무엇인가요?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [미디어 및 첨부파일](#media-and-attachments)
  - [내 스킬이 이미지/PDF를 생성했지만 전송되지 않았습니다](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [보안 및 접근 제어](#security-and-access-control)
  - [OpenClaw를 인바운드 다이렉트 메시지에 공개하는 것이 안전한가요?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [프롬프트 인젝션은 공용 봇에만 해당되는 문제입니까?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [봇이 독자적인 이메일, GitHub 계정, 전화번호를 가져야 합니까?](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [텍스트 메시지에 대한 자율 권한을 제공할 수 있으며 그것이 안전한가요?](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [개인 비서 작업에 더 저렴한 모델을 사용할 수 있나요?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Telegram에서 `/start`를 실행했지만 페어링 코드를 받지 못했습니다](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: 내 연락처에게 메시지를 보내나요? 페어링은 어떻게 작동하나요?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [채팅 명령, 작업 중지 및 "멈추지 않음"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [내부 시스템 메시지가 채팅에 표시되지 않도록 하려면 어떻게 합니까](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [실행 중인 작업을 중지/취소하려면 어떻게 합니까?](#how-do-i-stopcancel-a-running-task)
  - [Telegram에서 Discord 메시지를 보내려면 어떻게 합니까? ("교차 컨텍스트 메시징 거부됨")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [봇이 "빨리 쏟아지는" 메시지를 "무시"하는 것처럼 보이는 이유는?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 문제가 발생했을 때 처음 60초

1. **빠른 상태 확인 (첫 번째 확인)**

   ```bash
   openclaw status
   ```

   빠른 로컬 요약: OS + 업데이트, 게이트웨이/서비스 도달 가능성, 에이전트/세션, 프로바이더 설정 + 런타임 문제 (게이트웨이에 도달할 수 있을 경우).

2. **공유 가능한 보고서 (공유 안전함)**

   ```bash
   openclaw status --all
   ```

   로그 끝자락을 포함하여 읽기 전용 진단 (토큰은 수정됨).

3. **데몬 + 포트 상태**

   ```bash
   openclaw gateway status
   ```

   감독자 런타임과 RPC 도달 가능성, 프로브 대상 URL, 서비스가 사용했을 것으로 예상되는 설정을 보여줌.

4. **심층 프로브**

   ```bash
   openclaw status --deep
   ```

   게이트웨이 상태 확인 + 프로바이더 프로브 실행 (도달할 수 있는 게이트웨이 필요). [Health](/gateway/health) 참조.

5. **최신 로그 추적**

   ```bash
   openclaw logs --follow
   ```

   RPC가 다운된 경우, 다음을 사용:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   파일 로그는 서비스 로그와 별도입니다; [Logging](/logging) 및 [Troubleshooting](/gateway/troubleshooting) 참조.

6. **의사 실행 (수리)**

   ```bash
   openclaw doctor
   ```

   설정/상태 수리/마이그레이션 + 상태 확인 실행. [Doctor](/gateway/doctor) 참조.

7. **게이트웨이 스냅샷**

   ```bash
   openclaw health --json
   openclaw health --verbose   # 오류 시 대상 URL + 설정 경로 보여줌
   ```

   실행 중인 게이트웨이에 전체 스냅샷 요청 (WS 전용). [Health](/gateway/health) 참조.

## 빠른 시작 및 첫 실행 설정

### 막혔습니다. 문제를 가장 빠르게 해결하는 방법은 무엇인가요?

**여러분의 머신을 볼 수 있는** 로컬 AI 에이전트를 사용하세요. Discord에서 질문하는 것보다 더 효과적입니다. "막혔습니다"라는 대부분의 경우가 원격 도움으로 검토할 수 없는 **로컬 설정 또는 환경 문제**입니다.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

이 도구들은 저장소를 읽고, 명령을 실행하며, 로그를 검토하고 머신 레벨 설정 (PATH, 서비스, 권한, 인증 파일)을 수정하는 데 도움을 줄 수 있습니다. 해커블 (git) 설치를 통해 **전체 소스 체크아웃**을 제공합니다:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

이 명령은 git 체크아웃에서 OpenClaw를 설치하므로 에이전트가 코드와 문서를 읽고 실행 중인 정확한 버전을 이해할 수 있습니다. 나중에 `--install-method git` 없이 설치를 다시 실행하여 언제든지 안정적인 버전으로 전환할 수 있습니다.

팁: 에이전트에게 **수정 계획 및 감독**을 요청하여 반드시 필요한 명령만 실행하세요. 이는 변경 사항을 작게 유지하고 감사하기 쉽게 만듭니다.

실제 버그나 수정을 발견하면 GitHub issue를 작성하거나 PR을 보내주세요:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

다음 명령으로 시작하세요. (도움이 필요할 때 출력 내용을 공유하세요):

```bash
openclaw status
openclaw models status
openclaw doctor
```

이 명령들은 다음을 수행합니다:

- `openclaw status`: 게이트웨이/에이전트 상태 및 기본 설정의 빠른 스냅숏.
- `openclaw models status`: 프로바이더 인증 및 모델 가용성을 확인합니다.
- `openclaw doctor`: 일반적인 구성/상태 문제를 검증하고 수리합니다.

기타 유용한 CLI 검사: `openclaw status --all`, `openclaw logs --follow`, `openclaw gateway status`, `openclaw health --verbose`.

빠른 디버그 루프: [문제가 발생할 경우 처음 60초](#first-60-seconds-if-something's-broken). 설치 문서: [설치](/install), [설치 프로그램 플래그](/install/installer), [업데이트](/install/updating).

### OpenClaw를 설치하고 설정하는 권장 방법은 무엇인가요

리포지토리는 소스에서 실행하고 온보딩 마법사를 사용하는 것을 권장합니다:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

마법사는 또한 UI 자산을 자동으로 빌드할 수 있습니다. 온보딩 후 일반적으로 포트 **18789**에서 게이트웨이를 실행합니다.

소스에서 (기여자/개발자):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # 첫 실행 시 UI 종속성을 자동 설치합니다
openclaw onboard
```

아직 전역 설치가 없는 경우, `pnpm openclaw onboard`로 실행하세요.

### 온보딩 후 대시보드를 어떻게 여나요

마법사는 온보딩 직후 브라우저에 깨끗한 (토큰화되지 않은) 대시보드 URL을 열고, 요약에 링크를 출력합니다. 해당 탭을 열어 두세요; 만약 실행되지 않았다면, 출력된 URL을 복사하여 같은 머신에서 접속하세요.

### 로컬호스트와 원격에서 대시보드 토큰을 어떻게 인증하나요

**로컬호스트 (같은 머신에서):**

- `http://127.0.0.1:18789/`를 엽니다.
- 인증 요청이 있으면 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)에서 토큰을 Control UI 설정에 붙여넣으세요.
- 게이트웨이 호스트에서 `openclaw config get gateway.auth.token`으로 토큰을 가져오세요 (또는 `openclaw doctor --generate-gateway-token`으로 생성하세요).

**로컬호스트가 아닌 경우:**

- **Tailscale Serve** (권장): 루프백을 유지하고, `openclaw gateway --tailscale serve`를 실행하여 `https://<magicdns>/`를 엽니다. `gateway.auth.allowTailscale`이 `true`이면, 인증 헤더가 Control UI/WebSocket 인증을 만족시킵니다 (토큰 불필요, 신뢰할 수 있는 게이트웨이 호스트 가정); HTTP API는 여전히 토큰/비밀번호가 필요합니다.
- **Tailnet 바인드**: `openclaw gateway --bind tailnet --token "<token>"`을 실행하고, `http://<tailscale-ip>:18789/`을 열어 대시보드 설정에 토큰을 붙여넣으세요.
- **SSH 터널**: `ssh -N -L 18789:127.0.0.1:18789 user@host`를 실행한 후, `http://127.0.0.1:18789/`을 열고 Control UI 설정에 토큰을 붙여넣으세요.

[대시보드](/web/dashboard) 및 [웹 표면](/web)을 참조하여 바인드 모드 및 인증 세부 사항을 확인하세요.

### 어떤 런타임이 필요하나요

Node **>= 22**가 필요합니다. `pnpm`을 권장합니다. Gateway에는 Bun이 **권장되지 않습니다**.

### Raspberry Pi에서 실행되나요

예. 게이트웨이는 가볍습니다 - 문서에서는 **512MB-1GB RAM**, **1 코어**, 약 **500MB** 디스크를 개인용으로 충분하다고 나열하고 있으며, **Raspberry Pi 4에서 실행할 수 있습니다**.

추가 여유 공간 (로그, 미디어, 기타 서비스)을 원한다면, **2GB를 권장**하지만 필수는 아닙니다.

팁: 작은 Pi/VPS가 게이트웨이를 호스팅할 수 있으며, **노드**를 노트북/휴대폰에 페어링하여 로컬 화면/카메라/캔버스 또는 명령 실행이 가능합니다. [노드](/nodes)를 참조하세요.

### Raspberry Pi 설치 팁이 있나요

간단한 버전: 작동하지만 약간의 문제가 있을 수 있습니다.

- **64비트** OS를 사용하고 Node >= 22를 유지하세요.
- 로그를 보고 빠르게 업데이트할 수 있도록 **해커블 (git) 설치**를 선호하세요.
- 채널/스킬 없이 시작한 다음 하나씩 추가하세요.
- 이상한 이진 문제를 만나면, 이는 대개 **ARM 호환성** 문제입니다.

문서: [Linux](/platforms/linux), [설치](/install).

### 친구 온보딩이 멈추고 깨어나지 않습니다. 이제 어떻게 해야 하나요

이 화면은 게이트웨이가 도달 가능하고 인증된 상태에 의존합니다. TUI도 최초 해치 시 자동으로 "Wake up, my friend!"를 전송합니다. 응답이 없고 토큰이 0이면 에이전트가 실행된 적이 없습니다.

1. 게이트웨이를 재시작 합니다:

```bash
openclaw gateway restart
```

2. 상태 및 인증을 확인합니다:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. 아직도 멈춘다면, 명령을 실행합니다:

```bash
openclaw doctor
```

게이트웨이가 원격인 경우, 터널/Tailscale 연결이 활성화되고 UI가 올바른 게이트웨이에 연결되어 있는지 확인하세요. [원격 접속](/gateway/remote)을 참조하세요.

### 재설치 없이 새 머신 Mac mini로 설정을 이전할 수 있나요

예. **상태 디렉토리**와 **작업 공간**을 복사한 다음 Doctor를 한 번 실행하세요. 이렇게 하면 (메모리, 세션 기록, 인증 및 채널 상태)를 정확히 동일하게 유지할 수 있습니다. **두 위치 모두**를 복사하는 것이 중요합니다:

1. 새 머신에 OpenClaw를 설치합니다.
2. 이전 머신에서 `$OPENCLAW_STATE_DIR` (기본값: `~/.openclaw`)을 복사합니다.
3. 작업 공간을 복사합니다 (기본값: `~/.openclaw/workspace`).
4. `openclaw doctor`를 실행하고 게이트웨이 서비스를 재시작합니다.

이 작업은 구성, 인증 프로파일, WhatsApp 인증 정보, 세션 및 메모리를 보존합니다. 원격 모드인 경우 게이트웨이 호스트가 세션 저장소와 작업 공간을 소유하고 있음을 기억하세요.

**중요:** 워크스페이스를 GitHub에 커밋/푸시하면 **메모리 + 부트스트랩 파일**은 백업되지만 **세션 기록이나 인증은 백업되지 않습니다**. 이러한 정보는 `~/.openclaw/` 아래에 저장됩니다 (예를 들어 `~/.openclaw/agents/<agentId>/sessions/`).

관련 항목: [마이그레이션](/install/migrating), [디스크에 있는 항목 위치](/help/faq#where-does-openclaw-store-its-data),
[에이전트 작업 공간](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[원격 모드](/gateway/remote).

### 최신 버전의 새로운 사항을 어디서 확인할 수 있나요

GitHub 변경 로그를 확인하세요:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

최신 항목은 맨 위에 있습니다. 상단 섹션이 **Unreleased**로 표시된 경우, 다음 날짜가 있는 섹션은 가장 최근에 배포된 버전입니다. 항목은 **주요 특징**, **변경 사항**, **수정**으로 그룹화되어 있습니다 (필요할 때 문서/기타 섹션도 포함됩니다).

### docs.openclaw.ai에 SSL 오류가 표시됩니다. 이제 어떻게 해야 하나요

일부 Comcast/Xfinity 연결에서 `docs.openclaw.ai`가 Xfinity 고급 보안을 통해 잘못 차단됩니다. 이를 비활성화하거나 `docs.openclaw.ai`을 허용 목록에 추가한 후 다시 시도하세요. 자세한 내용: [문제 해결](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity). 차단 해제를 도와주시려면 여기에서 보고해주세요: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

여전히 사이트에 접속할 수 없다면, GitHub에 사용 설명서가 미러링되어 있습니다:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 안정 버전과 베타 버전의 차이점은 무엇인가요

**안정(stable)**과 **베타(beta)**는 **npm 배포 태그**이며, 별도의 코드 라인은 아닙니다:

- `latest` = 안정
- `beta` = 테스트를 위한 초기 빌드

베타에 빌드를 배포하고 테스트한 후, 빌드가 안정적이라 판단되면 **같은 버전을 `latest`로 승격합니다**. 따라서 베타와 안정 버전은 **같은 버전**을 가리킬 수 있습니다.

변경 사항 확인하기:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 베타 버전을 설치하는 방법과 베타, 개발 버전의 차이점

**베타**는 npm 배포 태그 `beta`이며, `latest`와 일치할 수 있습니다.
**개발(dev)**은 `main`의 이동 헤드 (git); 배포 시 npm 배포 태그 `dev`를 사용합니다.

한 줄 명령어 (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows 설치 프로그램 (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

자세한 내용: [개발 채널](/install/development-channels) 및 [설치 프로그램 플래그](/install/installer).

### 설치 및 온보딩에는 보통 얼마나 시간이 걸리나요

대략적인 가이드:

- **설치:** 2-5분
- **온보딩:** 설정한 채널/모델 수에 따라 5-15분 소요

중단되면 [설치 프로그램 중단](/help/faq#installer-stuck--how-do-i-get-more-feedback) 및 [막혔습니다](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck)에 있는 빠른 디버그 루프를 사용하세요.

### 최신 기능을 어떻게 체험할 수 있나요

두 가지 옵션:

1. **개발 채널 (git 체크아웃):**

```bash
openclaw update --channel dev
```

이 명령은 `main` 브랜치로 전환하고 소스를 업데이트합니다.

2. **해커블 설치 (설치 사이트에서):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

이를 통해 로컬 저장소를 얻을 수 있으며, 이후 git을 통해 업데이트할 수 있습니다.

깨끗한 클론을 수동으로 선호하는 경우:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

문서: [업데이트하기](/cli/update), [개발 채널](/install/development-channels), [설치](/install).

### 설치 프로그램이 중단되었습니다. 더 많은 피드백을 얻을 수 있는 방법은 무엇인가요?

**자세한 출력**과 함께 설치 프로그램을 다시 실행하세요:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

베타 설치 자세한 출력:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

해커블 (git) 설치의 경우:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Windows (PowerShell) 동등 명령어:

```powershell
# install.ps1은 아직 전용 -Verbose 플래그가 없습니다.
Set-PSDebug -Trace 1
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
Set-PSDebug -Trace 0
```

다른 옵션: [설치 프로그램 플래그](/install/installer).

### Windows 설치에서 git을 찾지 못하거나 openclaw를 인식하지 못합니다

Windows에서의 두 가지 일반적인 문제:

**1) npm 오류 spawn git / git을 찾지 못함**

- **Git for Windows**를 설치하고 `git`이 PATH에 있는지 확인하세요.
- PowerShell을 닫았다가 다시 열고, 설치 프로그램을 다시 실행하세요.

**2) 설치 후 openclaw가 인식되지 않습니다**

- 여러분의 npm 글로벌 bin 폴더가 PATH에 없습니다.
- 경로를 확인하세요:

  ```powershell
  npm config get prefix
  ```

- `<prefix>\\bin`이 PATH에 있는지 확인하세요 (대부분의 시스템에서는 `%AppData%\\npm`입니다).
- PATH를 업데이트한 후 PowerShell을 닫았다가 다시 여세요.

Windows에서 최적의 설정을 원한다면, **WSL2를 사용**하세요 (네이티브 Windows 대신).

문서: [Windows](/platforms/windows).

### 문서가 질문에 대해 답변하지 않았습니다. 더 나은 답변을 어떻게 얻을 수 있나요?

전체 소스와 문서를 로컬로 갖도록 **해커블 (git) 설치**를 사용한 후, 해당 폴더에서
봇 (또는 Claude/Codex)에게 질문하세요. 이는 저장소를 읽고 정확하게 답변할 수 있습니다.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

자세한 내용: [설치](/install) 및 [설치 프로그램 플래그](/install/installer).

### Linux에 OpenClaw를 어떻게 설치하나요

간단한 답변: Linux 가이드를 따라 한 후 온보딩 마법사를 실행하세요.

- Linux 빠른 경로 + 서비스 설치: [Linux](/platforms/linux).
- 전체 단계별 설명: [시작하기](/start/getting-started).
- 설치 프로그램 + 업데이트: [설치 및 업데이트](/install/updating).

### VPS에 OpenClaw를 어떻게 설치하나요

모든 Linux VPS가 작동합니다. 서버에 설치한 후 SSH/Tailscale을 사용하여 게이트웨이에 접근하세요.

가이드: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
원격 접속: [게이트웨이 원격](/gateway/remote).

### CloudVPS 설치 가이드는 어디에 있나요

우리는 일반적인 프로바이더들과 함께 **호스팅 허브**를 유지합니다. 가이드를 따라야 하는 프로바이더를 선택하세요:

- [VPS 호스팅](/vps) (모든 프로바이더를 한곳에)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

클라우드에서 작동 방식: **Gateway는 서버에서 실행**되며, 여러분은 Control UI (또는 Tailscale/SSH)를 통해 노트북/휴대폰에서 접근합니다. 상태 및 작업 공간은 서버에 존재하므로 호스트를 진실의 근원으로 대하고 백업하세요.

**노드**(Mac/iOS/Android/헤드리스)를 클라우드 게이트웨이에 페어링하여 로컬 화면/카메라/캔버스를 액세스하거나 노트북에서 명령어를 실행하면서 게이트웨이는 클라우드에 유지합니다.

허브: [플랫폼](/platforms). 원격 접근: [게이트웨이 원격](/gateway/remote).
노드: [노드](/nodes), [노드 CLI](/cli/nodes).

### OpenClaw에게 스스로 업데이트하도록 요청할 수 있나요

간단한 답변: **가능하지만 권장되지 않습니다**. 업데이트 흐름은 게이트웨이를 재시작할 수 있습니다 (액티브 세션을 드롭함), 깔끔한 git 체크아웃이 필요할 수 있으며,
확인 프롬프트가 있을 수 있습니다. 안전한 방법: 운영자로서 셸에서 업데이트를 실행하십시오.

CLI를 사용하세요:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

에이전트에서 자동화하셔야 한다면:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

문서: [업데이트](/cli/update), [업데이트](/install/updating).

### 온보딩 마법사는 실제로 무엇을 하나요

`openclaw onboard`는 권장 설정 경로입니다. **로컬 모드**에서는 다음을 안내합니다:

- **모델/인증 설정** (Anthropic **설정-토큰**을 Claude 구독에 권장, OpenAI Codex OAuth 지원, API 키 선택 가능, LM Studio 로컬 모델 지원)
- **작업 공간** 위치 및 부트스트랩 파일
- **게이트웨이 설정** (바인드/포트/인증/Tailscale)
- **프로바이더** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **데몬 설치** (macOS에서는 LaunchAgent; Linux/WSL2에서는 systemd 사용자 유닛)
- **상태 검사** 및 **스킬** 선택

구성한 모델이 알려지지 않았거나 인증이 누락된 경우 경고도 표시합니다.

### 이 프로그램을 실행하려면 Claude 또는 OpenAI 구독이 필요한가요

아니요. **API 키**(Anthropic/OpenAI/기타) 또는 **로컬 전용 모델**로 OpenClaw를 실행할 수 있습니다. 데이터는 장치에 유지됩니다. 구독(Claude Pro/Max 또는 OpenAI Codex)은 선택적으로 프로바이더를 인증하는 방법입니다.

문서: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[로컬 모델](/gateway/local-models), [모델](/concepts/models).

### Claude Max 구독을 API 키 없이 사용할 수 있나요

예. **설정-토큰**을 사용하여 API 키 대신 인증할 수 있습니다. 이것이 구독 경로입니다.

Claude Pro/Max 구독은 **API 키를 포함하지 않으므로**, 이는 구독 계정에 대한 올바른 접근 방식입니다. 이 사용이 Anthropic의 구독 정책 및 조건 하에서 허용되는지 Anthropic에 확인해야 합니다. 가장 명확하고 지원받는 경로를 원한다면 Anthropic API 키를 사용하세요.

### Anthropic 설정-토큰 인증은 어떻게 작동하나요

`claude setup-token`은 Claude Code CLI를 통해 **토큰 문자열**을 생성합니다 (웹 콘솔에선 제공되지 않습니다). **어떤 머신에서든** 실행할 수 있습니다. 마법사에서 **Anthropic token (설정-토큰 붙여넣기)**를 선택하거나 `openclaw models auth paste-token --provider anthropic`로 붙여 넣습니다. 토큰은 **anthropic** 프로바이더에 대한 인증 프로파일로 저장되며, API 키처럼 사용됩니다 (자동 새로고침 없음). 자세한 내용: [OAuth](/concepts/oauth).

### Anthropic 설정-토큰은 어디서 찾을 수 있나요?

Anthropic 콘솔에는 **없습니다**. 설정-토큰은 **어떤 머신에서든** Claude Code CLI에 의해 생성됩니다:

```bash
claude setup-token
```

출력된 토큰을 복사한 후 마법사에서는 **Anthropic token (설정-토큰 붙여넣기)**를 선택하세요. 게이트웨이 호스트에서 실행하려면, `openclaw models auth setup-token --provider anthropic`을 사용하세요. 다른 곳에서 `claude setup-token`을 실행한 경우 게이트웨이 호스트에 `openclaw models auth paste-token --provider anthropic`을 사용하여 붙여 넣습니다. [Anthropic](/providers/anthropic)을 참조하세요.

### Claude 구독 인증 (Claude Pro 또는 Max)을 지원하나요

예 - **설정-토큰을 통해** 가능합니다. OpenClaw는 이제 Claude Code CLI OAuth 토큰을 재사용하지 않습니다; 설정-토큰을 사용하거나 Anthropic API 키를 사용하세요. 어디서든 토큰을 생성하고 게이트웨이 호스트에 붙여 넣으세요. [Anthropic](/providers/anthropic) 및 [OAuth](/concepts/oauth)를 참조하세요.

참고: Claude 구독 접근은 Anthropic의 조건 관리를 따릅니다. 프로덕션 또는 다중 사용자 워크로드의 경우, 일반적으로 API 키가 더 안전한 선택입니다.

### Anthropic에서 HTTP 429 ratelimiterror가 표시되는 이유는 무엇인가요?

이는 현재 윈도우에서 여러분의 **Anthropic 할당량/속도 제한**이 소진되었음을 의미합니다. 만약 **Claude 구독**(설정-토큰 또는 Claude Code OAuth)을 사용하는 경우, 윈도우가 리셋될 때까지 기다리거나 플랜을 업그레이드하세요. **Anthropic API 키**를 사용하는 경우 Anthropic 콘솔에서 사용량/청구를 확인하고 필요한 경우 제한을 상향하세요.

팁: **대체 모델**을 설정하여 프로바이더가 속도 제한을 받는 동안에도 OpenClaw가 계속 응답할 수 있도록 하세요. [모델](/cli/models) 및 [OAuth](/concepts/oauth)를 참조하세요.

### AWS Bedrock이 지원되나요

예 - pi-ai의 **Amazon Bedrock (Converse)** 프로바이더를 **수동 설정으로 지원**합니다. 게이트웨이 호스트에 AWS 자격증명/지역을 제공하고 모델 설정에 Bedrock 프로바이더 항목을 추가해야 합니다. [Amazon Bedrock](/providers/bedrock) 및 [모델 프로바이더](/providers/models)를 참조하세요. 관리형 키 흐름을 선호한다면, Bedrock 앞에 OpenAI 호환 프록시를 두는 것도 여전히 유효한 옵션입니다.

### Codex 인증은 어떻게 작동하나요

OpenClaw는 **OpenAI Code (Codex)**를 OAuth (ChatGPT 로그인)에 의해 지원합니다. 마법사는 OAuth 흐름을 실행할 수 있으며, 상황에 맞게 `openai-codex/gpt-5.3-codex`를 기본 모델로 설정합니다. [모델 프로바이더](/concepts/model-providers) 및 [마법사](/start/wizard)를 참조하세요.

### OpenAI 구독 Codex OAuth를 지원하나요

예. OpenClaw는 **OpenAI Code (Codex) 구독 OAuth**를 완벽히 지원합니다. 온보딩 마법사가 OAuth 흐름을 수행할 수 있습니다.

[OAuth](/concepts/oauth), [모델 프로바이더](/concepts/model-providers), [마법사](/start/wizard)를 참조하세요.

### Gemini CLI OAuth는 어떻게 설정하나요

Gemini CLI는 **플러그인 인증 흐름**을 사용하며, `openclaw.json`에는 클라이언트 ID 또는 비밀이 포함되어 있지 않습니다.

단계:

1. 플러그인을 활성화합니다: `openclaw plugins enable google-gemini-cli-auth`
2. 로그인합니다: `openclaw models auth login --provider google-gemini-cli --set-default`

이는 게이트웨이 호스트에 인증 프로파일로 OAuth 토큰을 저장합니다. 세부사항: [모델 프로바이더](/concepts/model-providers).

### 캐주얼한 채팅에 로컬 모델이 괜찮을까요

보통은 아닙니다. OpenClaw는 큰 컨텍스트와 강력한 안전성을 필요로 하며, 작은 카드들은 잘리고 유출됩니다. 만약 꼭 필요하다면, 지역 (LM 스튜디오)에서 가능한 가장 큰 MiniMax M2.1 빌드를 실행하세요. [로컬 모델](/gateway/local-models)를 참조하세요. 작은/양자화된 모델은 프롬프트-주입 위험을 증가시킵니다 - [보안](/gateway/security)를 참조하세요.

### 호스팅 된 모델 트래픽을 특정 지역에 유지하려면 어떻게 해야하나요

지역 고정된 엔드포인트를 선택하세요. OpenRouter는 MiniMax, Kimi, GLM의 미국 호스팅 옵션을 제공하며, 데이터가 해당 지역에 유지되도록 미국 호스팅 변형을 선택하세요. `models.mode: "merge"`를 사용하여 Anthropic/OpenAI를 이들과 함께 나열할 수 있으며, 선택한 지역 프로바이더를 존중하면서 대체 모델을 유지할 수 있습니다.

### 이 프로그램을 설치하려면 Mac Mini를 구매해야 하나요

아니요. OpenClaw는 macOS 또는 Linux (Windows는 WSL2)를 지원합니다. Mac mini는 선택 사항입니다 - 항상 켜져 있는 호스트로 구입하는 경우도 있지만, 작은 VPS, 가정용 서버 또는 Raspberry Pi 급의 상자도 작동합니다.

여러분은 **macOS 전용 도구**를 위해서만 Mac이 필요합니다. iMessage의 경우, [BlueBubbles](/channels/bluebubbles)를 사용하세요 (권장) - BlueBubbles 서버는 어떤 Mac에서든 실행되며, Gateway는 Linux 또는 다른 곳에서 실행할 수 있습니다. 다른 macOS 전용 도구를 원한다면, Gateway를 Mac에서 실행하거나 macOS 노드를 페어링하세요.

문서: [BlueBubbles](/channels/bluebubbles), [노드](/nodes), [Mac 원격 모드](/platforms/mac/remote).

### iMessage 지원을 위해 Mac mini가 필요합니까?

메시지에 로그인된 **어떤 macOS 장치**가 필요합니다. 그것이 Mac mini일 필요는 없습니다 - 어떤 Mac이든 작동합니다. **[BlueBubbles](/channels/bluebubbles)를 사용하세요** (권장). BlueBubbles 서버는 macOS에서 실행되며, Gateway는 Linux 또는 다른 곳에서 실행될 수 있습니다.

일반적인 설정:

- 게이트웨이는 Linux/VPS에서 실행하고, BlueBubbles 서버는 메시지에 로그인된 어떤 Mac에서도 실행합니다.
- 가장 간단한 단일 머신 설정을 원하면 모든 것을 Mac에서 실행합니다.

문서: [BlueBubbles](/channels/bluebubbles), [노드](/nodes),
[Mac 원격 모드](/platforms/mac/remote).

### Mac mini를 구매해서 OpenClaw를 실행하면 MacBook Pro에 연결할 수 있나요

예. **Mac mini는 게이트웨이를 실행할 수 있으며**, MacBook Pro는 **노드** (동반 장치)로 연결할 수 있습니다. 노드는 게이트웨이를 실행하지 않으며, 해당 장치에서 화면/카메라/캔버스 및 `system.run`과 같은 추가 기능을 제공합니다.

일반적인 패턴:

- Mac mini에서 게이트웨이 (항상 켜진 상태).
- MacBook Pro는 macOS 앱 또는 노드 호스트를 실행하고 게이트웨이에 페어링합니다.
- `openclaw nodes status` / `openclaw nodes list`를 사용하여 확인합니다.

문서: [노드](/nodes), [노드 CLI](/cli/nodes).

### Bun을 사용할 수 있나요

Bun은 **권장되지 않습니다**. 특히 WhatsApp 및 Telegram과의 런타임 버그를 경험합니다.
안전한 게이트웨이에는 **Node**를 사용하세요.

Bun을 사용하고 싶다면, 비생산 게이트웨이에서 실험하세요 (WhatsApp/Telegram 없이).

### Telegram에서 allowFrom에 무엇을 넣어야 하나요

`channels.telegram.allowFrom`는 **사람 송신자의 Telegram 사용자 ID** (숫자)입니다. 이는 봇 사용자 이름이 아닙니다.

온보딩 마법사는 `@username` 입력을 받아 숫자 ID로 해결하지만, OpenClaw 인증은 숫자 ID만 사용합니다.

더 안전한 방법 (타사 봇 없음):

- 봇에게 다이렉트 메시지를 보내고, `openclaw logs --follow`를 실행하여 `from.id`를 읽습니다.

공식 봇 API:

- 봇에게 다이렉트 메시지를 보내고, `https://api.telegram.org/bot<bot_token>/getUpdates`를 호출하여 `message.from.id`를 읽습니다.

타사 (덜 개인적인 방법):

- `@userinfobot` 또는 `@getidsbot`에게 다이렉트 메시지를 보냅니다.

[/channels/telegram](/channels/telegram#access-control-dms--groups)을 참조하세요.

### 다른 OpenClaw 인스턴스에서 한 WhatsApp 번호를 여러 명이 사용할 수 있나요

예, **다중 에이전트 라우팅**을 통해 가능합니다. 송신자의 WhatsApp **다이렉트 메시지** (피어 `kind: "direct"`, 송신자 E.164는 예를 들어 `+15551234567`)를 다른 `agentId`에 바인딩하여 각 사람들이 자신만의 작업 공간과 세션 저장소를 갖도록 합니다. 응답은 **같은 WhatsApp 계정**에서 계속 오고, 다이렉트 메시지 접근 제어 (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`)는 WhatsApp 계정당 전역적입니다. [다중 에이전트 라우팅](/concepts/multi-agent) 및 [WhatsApp](/channels/whatsapp)을 참조하세요.

### 빠른 채팅 에이전트와 코딩 에이전트용 Opus를 실행할 수 있나요

예. 다중 에이전트 라우팅을 사용하세요: 각 에이전트에 자체 기본 모델을 부여한 다음, 각 에이전트에 대한 들어오는 경로 (프로바이더 계정 또는 특정 피어)를 바인딩합니다. 예제 구성은 [다중 에이전트 라우팅](/concepts/multi-agent)에 있습니다. [모델](/concepts/models) 및 [구성](/gateway/configuration)도 참조하세요.

### Linux에서 Homebrew가 작동하나요

네. Homebrew는 Linux(Linuxbrew)를 지원합니다. 빠른 설정:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

시스템인가를 통해 OpenClaw를 실행하는 경우, 서비스 PATH에 `/home/linuxbrew/.linuxbrew/bin` (또는 brew 프리픽스)을 포함시켜 `brew`로 설치된 도구가 비로그인 셸에서도 해상될 수 있도록 하세요.
최근 빌드도 Linux 시스템 서비스에서 일반 사용자 bin dir (예: `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`)을 선행하고, 설정된 `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, `FNM_DIR`를 존중합니다.

### 해커블 git 설치와 npm 설치의 차이점은 무엇인가요

- **해커블 (git) 설치:** 전체 소스 체크아웃, 편집 가능, 기여자에게 최적의 선택.
  로컬에서 빌드를 실행할 수 있고 코드/문서를 패치할 수 있습니다.
- **npm 설치:** 전역 CLI 설치, 저장소 없음, "그냥 실행하기"에 적합.
  업데이트는 npm 배포 태그에서 제공합니다.

문서: [시작하기](/start/getting-started), [업데이트](/install/updating).

### 나중에 npm과 git 설치 간 전환할 수 있나요

예. 다른 설치 방식을 설치한 다음 Doctor를 실행하여 게이트웨이 서비스가 새로운 엔트리포인트를 가리키도록 하세요.
이 과정은 **데이터를 삭제하지 않습니다** - 단지 OpenClaw 코드 설치만 변경합니다. 상태
(`~/.openclaw`)와 워크스페이스 (`~/.openclaw/workspace`)는 그대로 유지됩니다.

npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor는 게이트웨이 서비스 엔트리포인트 불일치를 탐지하고, 현재 설치와 일치하도록 서비스 구성을 재작성할 것을 권합니다 (자동화에서는 `--repair` 사용).

백업 팁: [백업 전략](/help/faq#whats-the-recommended-backup-strategy)을 참조하세요.

### 게이트웨이를 랩톱이나 VPS에서 실행해야 하나요

짧은 답변: **24/7 안정성을 원하신다면 VPS를 사용하세요**. 가장 낮은 마찰을 원하고, 절전/재부팅이 문제되지 않는다면 로컬에서 실행하세요.

**노트북 (로컬 게이트웨이)**

- **장점:** 서버 비용 없음, 로컬 파일에 즉시 접근 가능, 라이브 브라우저 창.
- **단점:** 잠자기/네트워크 드롭 = 연결 끊김, 운영 체제 업데이트/재부팅은 끊김을 초래, 계속 깨어 있어야 함.

**VPS / 클라우드**

- **장점:** 항상 켜져 있음, 안정적인 네트워크, 노트북 절전 문제 없음, 계속 실행하기 쉽습니다.
- **단점:** 대개 헤드리스 실행 (스크린샷 사용), 원격 파일 접근만 가능, 업데이트를 위해 SSH가 필요합니다.

**OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost (플러그인)/Discord는 모두 VPS에서 잘 작동합니다. 유일한 실제 트레이드오프는 **헤드리스 브라우저** vs 보이는 창입니다. [브라우저](/tools/browser)를 참조하세요.

**추천 기본값:** 게이트웨이 연결 끊김이 있었던 경우에는 VPS가 더 좋습니다. 로컬은 Mac을 적극적으로 사용하는 경우와 로컬 파일 접근이나 UI 자동화를 원할 때 적합합니다 (보이는 브라우저 포함).

### OpenClaw를 전용 머신에서 실행하는 것이 얼마나 중요한가요

필수는 아니지만 **신뢰성과 격리**를 위해 권장됩니다.

- **전용 호스트 (VPS/Mac mini/Pi):** 항상 켜져 있고, 절전/재부팅이 적으며, 권한이 깨끗하며, 계속 실행하기 쉽습니다.
- **공유 랩톱/데스크탑:** 테스트와 적극적 사용에는 충분하지만, 머신이 절전 모드로 들어가거나 업데이트될 때마다 중단될 수 있습니다.

두 가지의 장점을 모두 원한다면, 게이트웨이를 전용 호스트에 유지하고 랩톱을 **노드**로 페어링하여 로컬 화면/카메라/실행 도구를 사용하세요. [노드](/nodes)를 참조하세요.
보안 지침은 [보안](/gateway/security)을 읽어보세요.

### 최소 VPS 요구 사항과 권장 OS는 무엇인가요

OpenClaw는 가볍습니다. 기본 게이트웨이 + 하나의 채팅 채널을 위한:

- **절대 최소:** 1 vCPU, 1GB RAM, ~500MB 디스크.
- **권장:** 1-2 vCPU, 2GB RAM 이상 여유 공간이 필요할 경우 (로그, 미디어, 여러 채널). 노드 도구와 브라우저 자동화는 많은 자원을 소비할 수 있습니다.

OS: **Ubuntu LTS** (또는 최신 Debian/Ubuntu)를 사용하세요. Linux 설치 경로가 가장 많이 테스트되었습니다.

문서: [Linux](/platforms/linux), [VPS 호스팅](/vps).

### OpenClaw를 VM에서 실행할 수 있으며 요구 사항은 무엇인가요

예. VM을 VPS처럼 다루세요: 항상 켜져 있어야 하고, 접근할 수 있으며 게이트웨이 및 활성화하려는 모든 채널을 실행할 수 있는 충분한
RAM이 있어야 합니다.

기본적인 안내:

- **절대 최소:** 1 vCPU, 1GB RAM.
- **권장:** 여러 채널, 브라우저 자동화 또는 미디어 도구를 실행하는 경우 2GB 이상의 RAM.
- **OS:** Ubuntu LTS 또는 최신 Debian/Ubuntu.

Windows에서 실행 중이라면, **WSL2가 가장 쉽고 VM 스타일 설정**이며, 최고의 도구 호환성을 가지고 있습니다. [Windows](/platforms/windows), [VPS 호스팅](/vps)를 참조하세요.
macOS를 VM에서 실행 중이라면, [macOS VM](/install/macos-vm)을 참조하세요.

## OpenClaw란 무엇인가?

### OpenClaw를 한 문단으로 설명하기

OpenClaw는 개인 AI 어시스턴트로, 사용자가 소유한 장치에서 실행됩니다. WhatsApp, Telegram, Slack, Mattermost (플러그인), Discord, Google Chat, Signal, iMessage, WebChat과 같은 메시징 서비스에서 응답하며, 지원되는 플랫폼에서는 음성 및 실시간 Canvas도 가능하게 합니다. **게이트웨이**는 항상 켜져 있는 제어 플레인이고, 어시스턴트가 제품입니다.

### 가치 제안

OpenClaw는 "단순한 Claude 래퍼"가 아닙니다. **로컬 우선 제어 플레인**으로, **사용자의 하드웨어에서** 강력한 어시스턴트를 실행할 수 있으며, 이미 사용 중인 채팅 앱에서 접근 가능하고, 상태 저장 세션, 메모리 및 도구를 제공합니다. 이로써 호스팅된 SaaS에 워크플로를 넘기지 않아도 됩니다.

주요 특징:

- **사용자의 장치, 사용자의 데이터:** 게이트웨이를 원하는 곳 (Mac, Linux, VPS)에서 실행하고, 작업공간 및 세션 기록을 로컬에 유지합니다.
- **웹 샌드박스가 아닌 실제 채널:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/등과 지원되는 플랫폼에서는 모바일 음성과 Canvas도 가능.
- **모델 비종속적:** Anthropic, OpenAI, MiniMax, OpenRouter 등을 사용할 수 있으며, 에이전트 별 라우팅 및 페일오버가 가능합니다.
- **로컬 전용 옵션:** 로컬 모델을 실행하여 **모든 데이터를 사용자의 장치에 유지**할 수 있습니다.
- **멀티 에이전트 라우팅:** 채널, 계정 또는 작업별로 개별 에이전트를 분리하여 각각 고유한 작업공간과 기본 설정을 가집니다.
- **오픈 소스 및 확장 가능성:** 공급업체 종속 없이 검사, 확장 및 자체 호스팅이 가능합니다.

문서: [게이트웨이](/gateway), [채널](/channels), [멀티 에이전트](/concepts/multi-agent), [메모리](/concepts/memory).

### 설정을 완료했습니다. 무엇을 먼저 해야 하나요

좋은 시작 프로젝트:

- 웹사이트 구축 (WordPress, Shopify, 또는 간단한 정적 사이트).
- 모바일 앱 프로토타입 (개요, 화면, API 계획).
- 파일 및 폴더 정리 (정리, 네이밍, 태깅).
- Gmail 연결 및 요약 자동화 또는 후속 작업 자동화.

커다란 작업을 처리할 수 있지만, 단계를 나누고 병렬 작업을 위해 하위 에이전트를 사용하는 것이 가장 효과적입니다.

### OpenClaw의 일상적인 주요 사용 사례 다섯 가지는 무엇인가요

일상적인 성공 사례는 보통 다음과 같습니다:

- **개인 브리핑:** 관심 있는 받은 편지함, 일정 및 뉴스 요약.
- **리서치 및 초안 작성:** 이메일 또는 문서의 빠른 리서치, 요약, 초안 작성.
- **리마인더 및 후속 작업:** 크론 또는 하트비트 기반 독촉 및 체크리스트.
- **브라우저 자동화:** 폼 입력, 데이터 수집, 웹 작업 반복.
- **디바이스 간 조정:** 휴대폰에서 작업을 보내고, 게이트웨이가 서버에서 실행하며 결과를 채팅에서 받음.

### OpenClaw가 SaaS를 위한 리드 생성 아웃리치 광고 및 블로그에 도움을 줄 수 있나요

예, **리서치, 자격 평가, 초안 작성**에 도움을 줄 수 있습니다. 사이트를 스캔하고, 후보 리스트를 작성하고, 잠재 고객을 요약하고, 아웃리치 또는 광고 카피 초안을 작성할 수 있습니다.

**아웃리치 또는 광고 실행**에 대한 경우, 사람을 참여시키세요. 스팸을 피하고, 현지 법률 및 플랫폼 정책을 준수하며, 보내기 전에 모든 것을 검토하세요. OpenClaw가 작성하고 사용자가 승인하는 것이 가장 안전한 방식입니다.

문서: [보안](/gateway/security).

### 웹 개발을 위한 Claude Code와 비교한 장점은 무엇인가요

OpenClaw는 **개인 어시스턴트**이며, 조정 레이어로 IDE 대체물이 아닙니다. 레포 내부에서 가장 빠른 직접 코딩 루프를 위해 Claude Code 또는 Codex를 사용하세요. 지속 가능한 메모리, 기기 간 접근 및 도구 오케스트레이션이 필요할 때 OpenClaw를 사용하세요.

장점:

- **세션 간 지속 메모리 및 작업공간**
- **멀티 플랫폼 접근** (WhatsApp, Telegram, TUI, WebChat)
- **도구 오케스트레이션** (브라우저, 파일, 일정 관리, 후크)
- **항상 켜진 게이트웨이** (VPS에서 실행, 어디서든지 상호작용)
- **노드**를 통한 로컬 브라우저/화면/카메라/실행

전시: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## 스킬 및 자동화

### 리포를 더럽히지 않고 스킬을 커스터마이즈 하려면 어떻게 하나요

리포 복사본을 수정하는 대신 관리된 오버라이드를 사용하세요. 변경 사항을 `~/.openclaw/skills/<name>/SKILL.md`에 넣거나 `~/.openclaw/openclaw.json`의 `skills.load.extraDirs`를 통해 폴더를 추가하세요. 우선순위는 `<workspace>/skills` > `~/.openclaw/skills` > 번들됨이며, 관리된 오버라이드는 git을 건드리지 않고 승리합니다. 리포에는 상류에 적합한 편집만이 있어야 하고, PR로 나가야 합니다.

### 사용자 지정 폴더에서 스킬을 로드할 수 있나요

예. `~/.openclaw/openclaw.json`의 `skills.load.extraDirs`를 통해 추가 디렉토리를 추가하세요 (가장 낮은 우선순위). 기본 우선순위는 `<workspace>/skills` → `~/.openclaw/skills` → 번들 → `skills.load.extraDirs`입니다. `clawhub`는 기본적으로 `./skills`에 설치하며, OpenClaw는 이를 `<workspace>/skills`로 취급합니다.

### 다른 작업에 다른 모델을 사용하는 방법

현재 지원되는 패턴은 다음과 같습니다:

- **크론 작업:** 격리된 작업은 작업별로 `model` 오버라이드를 설정할 수 있습니다.
- **하위 에이전트:** 작업을 서로 다른 기본 모델을 사용하는 별도의 에이전트로 라우팅합니다.
- **요청 시 전환:** `/model`을 사용하여 언제든지 현재 세션의 모델을 전환하세요.

[크론 작업](/automation/cron-jobs), [멀티 에이전트 라우팅](/concepts/multi-agent), [슬래시 명령](/tools/slash-commands)을 참조하세요.

### 봇이 무거운 작업을 할 때 멈춥니다. 이를 어떻게 오프로드하나요

긴 작업이나 병렬 작업에는 **하위 에이전트**를 사용하세요. 하위 에이전트는 자체 세션에서 실행되어 요약을 반환하고 주요 채팅 응답성을 유지합니다.

봇에게 "이 작업을 위한 하위 에이전트를 생성해"라고 요청하거나 `/subagents`를 사용하세요.
채팅에서 `/status`를 사용하여 게이트웨이가 현재 무엇을 하고 있는지 확인하세요 (그리고 그것이 바쁜지).

토큰 팁: 긴 작업과 하위 에이전트 모두 토큰을 사용합니다. 비용이 걱정된다면 `agents.defaults.subagents.model`을 통해 하위 에이전트에 저렴한 모델을 설정하세요.

문서: [하위 에이전트](/tools/subagents).

### Discord에서 스레드 바인딩 서브에이전트 세션은 어떻게 작동하나요

스레드 바인딩을 사용하세요. Discord 스레드를 서브에이전트나 세션 대상에 바인딩하면 해당 스레드의 후속 메시지가 바인딩된 세션에 머물도록 할 수 있습니다.

기본 흐름:

- `sessions_spawn`에서 `thread: true`를 사용하여 생성합니다 (지속적인 후속 작업을 위해 선택적으로 `mode: "session"`).
- 또는 `/focus <target>`으로 수동으로 바인딩합니다.
- `/agents`로 바인딩 상태를 확인합니다.
- `/session ttl <duration|off>`로 자동 해제를 제어합니다.
- `/unfocus`로 스레드를 분리합니다.

필요한 설정:

- 글로벌 기본값: `session.threadBindings.enabled`, `session.threadBindings.ttlHours`.
- Discord 오버라이드: `channels.discord.threadBindings.enabled`, `channels.discord.threadBindings.ttlHours`.
- 생성 시 자동 바인딩: `channels.discord.threadBindings.spawnSubagentSessions: true` 설정.

문서: [하위 에이전트](/ko-KR/tools/subagents), [Discord](/ko-KR/channels/discord), [설정 레퍼런스](/ko-KR/gateway/configuration-reference), [슬래시 명령](/ko-KR/tools/slash-commands).

### 크론이나 리마인더가 실행되지 않습니다. 무엇을 확인해야 하나요

크론은 Gateway 프로세스 내에서 실행됩니다. 게이트웨이가 지속적으로 실행되지 않으면, 예약된 작업은 실행되지 않습니다.

체크리스트:

- 크론이 활성화되어 있는지 확인 (`cron.enabled`), 그리고 `OPENCLAW_SKIP_CRON`이 설정되어 있지 않은지 확인.
- 게이트웨이가 24/7 작동 중인지 확인 (슬립/재시작 없음).
- 작업의 시간대 설정을 확인 (`--tz` vs 호스트 시간대).

디버그:

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

문서: [크론 작업](/automation/cron-jobs), [크론 vs 하트비트](/automation/cron-vs-heartbeat).

### Linux에서 스킬을 어떻게 설치하나요

**ClawHub** (CLI)를 사용하거나 스킬을 작업공간에 넣으세요. macOS Skills UI는 Linux에서 사용할 수 없습니다.
[https://clawhub.com](https://clawhub.com)에서 스킬을 찾아보세요.

ClawHub CLI 설치 (하나의 패키지 관리자 선택):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw가 일정에 따라 또는 백그라운드에서 계속 실행할 수 있나요

예. 게이트웨이 스케줄러를 사용하세요:

- **크론 작업**은 예약된 또는 반복 작업을 위해 (재시작 중에도 지속됨).
- **하트비트**는 "주 세션" 주기적 검사.
- **격리 작업**은 요약을 게시하거나 채팅에 전달하는 자율 에이전트.

문서: [크론 작업](/automation/cron-jobs), [크론 vs 하트비트](/automation/cron-vs-heartbeat), [하트비트](/gateway/heartbeat).

### Linux에서 Apple macOS 전용 스킬을 실행할 수 있나요?

직접적으로는 불가능합니다. macOS 스킬은 `metadata.openclaw.os` 및 필요한 바이너리에 의해 제한되며, **게이트웨이 호스트**에서 적격할 때만 시스템 프롬프트에 나타납니다. Linux에서 `darwin` 전용 스킬 (예: `apple-notes`, `apple-reminders`, `things-mac`)은 게이트웨이를 Mac에서 실행하기 전까지는 로드되지 않습니다.

지원되는 세 가지 패턴이 있습니다:

**옵션 A - Mac에서 게이트웨이를 실행 (가장 간단함).**
macOS 바이너리가 있는 곳에서 게이트웨이를 실행한 다음, Linux에서 [원격 모드](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) 또는 Tailscale을 통해 연결합니다. 게이트웨이 호스트가 macOS이므로 스킬은 정상적으로 로드됩니다.

**옵션 B - macOS 노드 사용 (SSH 없음).**
Linux에서 게이트웨이를 실행하고, macOS 노드 (menubar 앱)를 연결하고, Mac에서 **노드 실행 명령**을 "항상 묻기" 또는 "항상 허용"으로 설정합니다. OpenClaw는 노드에 필요한 바이너리가 있을 때 macOS 전용 스킬을 적격으로 간주할 수 있습니다. 에이전트는 `nodes` 도구를 통해 해당 스킬을 실행합니다. "항상 묻기"를 선택했다면, 프롬프트에서 "항상 허용"을 승인하면 그 명령이 허용 목록에 추가됩니다.

**옵션 C - SSH를 통해 macOS 바이너리 프록시 (고급).**
게이트웨이를 Linux에 유지하고, 필요한 CLI 바이너리를 Mac에서 실행하는 SSH 래퍼로 해결합니다. 그런 다음 스킬을 Linux에도 허용하도록 오버라이드하여 적격 상태를 유지합니다.

1. 바이너리의 SSH 래퍼 생성 (예: Apple Notes 용 `memo`):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Linux 호스트의 `PATH`에 래퍼를 두세요 (예: `~/bin/memo`).
3. 스킬 메타데이터를 오버라이드하여 (작업공간 또는 `~/.openclaw/skills`) Linux를 허용:

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. 스킬 스냅샷을 새로고침하기 위해 새로운 세션을 시작합니다.

### Notion 또는 HeyGen 통합이 있나요

오늘날에는 내장되지 않았습니다.

옵션:

- **사용자 정의 스킬 / 플러그인:** 신뢰할 수 있는 API 액세스에 적합 (Notion/HeyGen 모두 API가 있음).
- **브라우저 자동화:** 코드 없이 작동하지만 느리고 불안정합니다.

클라이언트 별 컨텍스트 (에이전시 워크플로우)를 유지하고 싶다면, 간단한 패턴은:

- 클라이언트당 하나의 Notion 페이지 (컨텍스트 + 선호도 + 활성 작업).
- 세션 시작 시 해당 페이지를 검색하도록 에이전트에게 요청.

네이티브 통합을 원한다면 기능 요청을 열거나 해당 API를 목표로 스킬을 구축하세요.

스킬 설치:

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub는 현재 디렉토리 아래 `./skills`에 설치되며 (또는 구성된 OpenClaw 작업공간으로 돌아감); OpenClaw는 이를 다음 세션에서 `<workspace>/skills`로 취급합니다. 에이전트 간 공유된 스킬의 경우, 이를 `~/.openclaw/skills/<name>/SKILL.md`에 놓으세요. 몇몇 스킬은 Homebrew를 통해 설치된 바이너리를 기대합니다; Linux에서는 Linuxbrew를 의미합니다 (위의 Homebrew Linux FAQ 항목 참조). [스킬](/tools/skills)과 [ClawHub](/tools/clawhub)를 참조하세요.

### 브라우저 인수용 Chrome 확장을 설치하려면 어떻게 하나요

내장된 설치 프로그램을 사용한 다음 Chrome에서 미포장 확장을 로드하세요:

```bash
openclaw browser extension install
openclaw browser extension path
```

그런 다음 Chrome → `chrome://extensions` → "개발자 모드" 활성화 → "미포장 로드" → 해당 폴더를 선택합니다.

전체 가이드 (원격 게이트웨이 + 보안 노트 포함): [Chrome 확장](/tools/chrome-extension)

게이트웨이가 Chrome과 같은 기기에서 실행되는 경우 (기본 설정), 보통 **추가적인 것이 필요하지 않습니다**.
게이트웨이가 다른 곳에서 실행되는 경우, 게이트웨이가 브라우저 동작을 프록시할 수 있도록 브라우저 기기에 노드 호스트를 실행하세요.
여전히 제어하려는 탭에서 확장 버튼을 클릭해야 합니다 (자동 첨부되지 않음).

## 샌드박스 격리 및 메모리

### 전용 샌드박스 격리 문서가 있나요

네. [샌드박스 격리](/gateway/sandboxing)를 참조하세요. Docker-specific 설정 (Docker 전체 게이트웨이 또는 샌드박스 이미지)에 대해서는 [Docker](/install/docker)를 참조하세요.

### Docker가 제한적으로 느껴집니다. 전체 기능을 활성화하려면 어떻게 하나요

기본 이미지는 보안 우선으로 `node` 사용자로 실행되므로 시스템 패키지, Homebrew 또는 번들 브라우저를 포함하지 않습니다. 더 완벽한 설정을 위해:

- 캐시를 유지할 수 있도록 `OPENCLAW_HOME_VOLUME`으로 `/home/node`를 지속시킵니다.
- `OPENCLAW_DOCKER_APT_PACKAGES`로 시스템 종속성을 이미지에 삽입합니다.
- 번들된 CLI를 통해 Playwright 브라우저를 설치합니다:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- `PLAYWRIGHT_BROWSERS_PATH`를 설정하고 경로가 지속되도록 확인합니다.

문서: [Docker](/install/docker), [브라우저](/tools/browser).

**다이렉트 메시지를 개인용으로 유지하면서 공개 그룹을 하나의 에이전트로 샌드박스 격리할 수 있나요**

네 - 개인 트래픽이 **다이렉트 메시지**이고, 공개 트래픽이 **그룹**이라면 가능합니다.

`agents.defaults.sandbox.mode: "non-main"`을 사용하여 그룹/채널 세션 (비주요 키)이 Docker에서 실행되도록 하면서, 주요 다이렉트 메시지 세션은 호스트에서 유지됩니다. 그런 다음 `tools.sandbox.tools`를 통해 샌드박스 격리된 세션에서 사용 가능한 도구를 제한합니다.

설정 과정 + 예제 구성: [그룹: 개인 다이렉트 메시지 + 공개 그룹](/channels/groups#pattern-personal-dms-public-groups-single-agent)

핵심 구성 참조: [게이트웨이 구성](/gateway/configuration#agentsdefaultssandbox)

### 샌드박스에 호스트 폴더를 바인딩하려면 어떻게 하나요

`agents.defaults.sandbox.docker.binds`를 `["host:path:mode"]`로 설정합니다 (예: `"/home/user/src:/src:ro"`). 전역 및 에이전트별 바인드는 병합되며; 에이전트별 바인드는 `scope: "shared"`일 때 무시됩니다. 민감한 항목에는 `:ro`를 사용하고 바인드는 샌드박스 파일시스템 벽을 우회한다는 것을 기억하세요. 예시 및 안전 노트를 위해 [샌드박스 격리](/gateway/sandboxing#custom-bind-mounts) 및 [샌드박스와 도구 정책 vs 권한 강화](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check)를 참조하세요.

### 메모리는 어떻게 작동하나요

OpenClaw 메모리는 에이전트 작업 공간의 Markdown 파일에 불과합니다:

- 일일 노트는 `memory/YYYY-MM-DD.md`에 기록됩니다.
- 큐레이션된 장기 노트는 `MEMORY.md`에 기록됩니다 (주요/개인 세션만).

OpenClaw는 또한 **자동 메모리 플러시**를 실행하여 모델에게 자동 압축 전에 지속 가능한 노트를 작성하도록 상기시킵니다. 이는 작업공간이 쓰기 가능할 때만 실행됩니다 (읽기 전용 샌드박스는 이를 생략합니다). [메모리](/concepts/memory)를 참조하세요.

### 메모리가 계속 무언가를 잊어버립니다. 어떻게 고정할 수 있나요

봇에게 **머리에 저장할 사실**을 문서화하라고 요청하세요. 장기 노트는 `MEMORY.md`로 가고, 단기 컨텍스트는 `memory/YYYY-MM-DD.md`로 가야 합니다.

이는 여전히 개선 중인 영역입니다. 모델에게 메모리를 저장하도록 리마인드하면 도움이 됩니다; 모델은 무엇을 해야 할지 알고 있습니다. 계속 잊어버리는 경우, 게이트웨이가 매번 동일한 작업공간을 사용하고 있는지 확인하세요.

문서: [메모리](/concepts/memory), [에이전트 작업공간](/concepts/agent-workspace).

### 시맨틱 메모리 검색에 OpenAI API 키가 필요하나요

**OpenAI 임베딩**을 사용하는 경우에만 필요합니다. Codex OAuth는 채팅/완성을 포함하되 임베딩 접근을 부여하지 않으므로, **Codex에 로그인 (OAuth 또는 Codex CLI 로그인)**해도 시맨틱 메모리 검색에는 도움이 되지 않습니다. OpenAI 임베딩은 여전히 실제 API 키 (`OPENAI_API_KEY` 또는 `models.providers.openai.apiKey`)가 필요합니다.

프로바이더를 명시적으로 설정하지 않으면, OpenClaw는 API 키를 해석할 수 있을 때 자동으로 프로바이더를 선택합니다 (인증 프로파일, `models.providers.*.apiKey`, 환경 변수). OpenAI 키가 해석될 경우 OpenAI를 우선하며, 그 외에는 Gemini가 우선됩니다. 두 키 모두 사용 가능하지 않으면, 메모리 검색은 구성될 때까지 비활성화됩니다. 로컬 모델 경로가 구성되어 있고 접근 가능한 경우, OpenClaw는 `local`을 선호합니다.

로컬을 선호하신다면, `memorySearch.provider = "local"` (그리고 선택적으로 `memorySearch.fallback = "none"`)을 설정하세요. Gemini 임베딩을 원하신다면, `memorySearch.provider = "gemini"`를 설정하고 `GEMINI_API_KEY` (또는 `memorySearch.remote.apiKey`)를 제공합니다. 우리는 **OpenAI, Gemini 또는 로컬** 임베딩 모델을 지원합니다 - [메모리](/concepts/memory)에서 설정 세부 사항을 확인하세요.

### 메모리는 영구적으로 지속되나요. 제한은 무엇인가요

메모리 파일은 디스크에 존재하며 삭제할 때까지 지속됩니다. 제한은 모델이 아닌 저장 용량입니다. **세션 컨텍스트**는 여전히 모델 컨텍스트 윈도우에 의해 제한되므로, 긴 대화는 압축되거나 잘릴 수 있습니다. 이는 메모리 검색이 존재하는 이유인데, 관련 부분만 컨텍스트로 다시 끌어옵니다.

문서: [메모리](/concepts/memory), [컨텍스트](/concepts/context).

## 디스크에 정보 저장 위치

### OpenClaw와 함께 사용된 모든 데이터가 로컬에 저장되나요

아니요 - **OpenClaw의 상태는 로컬에 있습니다**, 하지만 **외부 서비스는 여전히 여러분이 보낸 내용을 볼 수 있습니다**.

- **기본적으로 로컬:** 세션, 메모리 파일, 설정, 워크스페이스는 게이트웨이 호스트
  (`~/.openclaw` + 워크스페이스 디렉토리)에 존재합니다.
- **필수적으로 원격:** 모델 프로바이더(Anthropic/OpenAI/등)에 보낸 메시지는
  그들의 API로 전송되며, 채팅 플랫폼(WhatsApp/Telegram/Slack/등)은 메시지 데이터를 그들의
  서버에 저장합니다.
- **관리 가능한 범위:** 로컬 모델을 사용하면 프롬프트가 기기에 남아 있지만, 채널
  트래픽은 여전히 채널의 서버를 통해 전달됩니다.

관련 항목: [에이전트 워크스페이스](/concepts/agent-workspace), [Memory](/concepts/memory).

### OpenClaw는 데이터를 어디에 저장하나요

모든 것이 `$OPENCLAW_STATE_DIR` (기본값: `~/.openclaw`) 아래에 저장됩니다:

| 경로                                                            | 목적                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | 메인 구성 (JSON5)                                       |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | 구 OAuth 가져오기 (처음 사용 시 인증 프로파일로 복사됨) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 인증 프로파일 (OAuth + API 키)                          |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | 런타임 인증 캐시 (자동 관리)                            |
| `$OPENCLAW_STATE_DIR/credentials/`                              | 프로바이더 상태 (예: `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                   | 에이전트별 상태 (agentDir + 세션)                       |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | 대화 이력 & 상태 (에이전트별)                           |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | 세션 메타데이터 (에이전트별)                            |

레거시 단일 에이전트 경로: `~/.openclaw/agent/*` (`openclaw doctor`에 의해 마이그레이션됨).

여러분의 **워크스페이스** (AGENTS.md, 메모리 파일, 스킬 등)는 별도로 존재하며 `agents.defaults.workspace`에서 설정됩니다 (기본값: `~/.openclaw/workspace`).

### AGENTSmd SOULmd USERmd MEMORYmd는 어디에 있어야 하나요

이 파일들은 `~/.openclaw`가 아닌 **에이전트 워크스페이스**에 있어야 합니다.

- **워크스페이스 (에이전트별)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (또는 `memory.md`), `memory/YYYY-MM-DD.md`, 선택적 `HEARTBEAT.md`.
- **상태 디렉터리 (`~/.openclaw`)**: 설정, 자격 증명, 인증 프로파일, 세션, 로그,
  및 공유 스킬 (`~/.openclaw/skills`).

기본 워크스페이스는 `~/.openclaw/workspace`이며, 다음과 같이 구성 가능합니다:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

봇이 재시작 후 "forget"한다면, 게이트웨이가 매 번 동일한 워크스페이스를 사용하고 있는지 확인하세요 (그리고 기억하세요: 원격 모드는 자신의 로컬 랩톱이 아닌 **게이트웨이 호스트의** 워크스페이스를 사용합니다).

팁: 장기적인 행동이나 선호도를 원한다면, 챗 히스토리에 의존하기보다는 봇에게 이를 **AGENTS.md 또는 MEMORY.md에 작성하라고 요청**하세요.

[에이전트 워크스페이스](/concepts/agent-workspace) 및 [Memory](/concepts/memory)를 참조하세요.

### 추천 백업 전략은 무엇인가요

여러분의 **에이전트 워크스페이스**를 **개인** git 저장소에 넣고 어디론가 비공개로 백업하세요
(예: GitHub 비공개). 이는 메모리 + AGENTS/SOUL/USER 파일을 캡처하며, 나중에 도우미의 "mind"를 복원할 수 있게 해줍니다.

`~/.openclaw` (자격 증명, 세션, 토큰)의 하위 애칭은 커밋하지 마세요.
전체 복원이 필요하다면, 워크스페이스와 상태 디렉터리를 별도로 백업하세요 (위의 마이그레이션 질문을 참조하세요).

문서: [에이전트 워크스페이스](/concepts/agent-workspace).

### OpenClaw를 완전히 제거하려면 어떻게 해야 하나요

전용 가이드를 참조하세요: [Uninstall](/install/uninstall).

### 에이전트가 워크스페이스 외부에서 작동할 수 있나요

네. 워크스페이스는 **기본 현재 작업 디렉터리**이며 메모리 앵커로 사용되지만, 하드 샌드박스는 아닙니다.
상대 경로는 워크스페이스 내부에서 해결되며, 절대 경로는 샌드박스 격리가 활성화되지 않은 한 다른 호스트 위치에 액세스할 수 있습니다. 격리가 필요하다면
[`agents.defaults.sandbox`](/gateway/sandboxing) 또는 에이전트별 샌드박스 설정을 사용하세요. 레포를 기본 작업 디렉터리로 설정하고 싶다면, 해당 에이전트의
`workspace`를 레포 루트로 설정하세요. OpenClaw 레포는 단순한 소스 코드에 불과합니다; 에이전트가 의도치 않게 그 내부에서 작업하도록 하려는 것이 아니라면 워크스페이스는 별도로 유지하세요.

예시 (레포를 기본 작업 디렉터리로 설정):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### 원격 모드에 있을 때 세션 저장소는 어디에 있나요

세션 상태는 **게이트웨이 호스트**에 속해 있습니다. 원격 모드일 때, 신경 쓸 세션 저장소는 로컬 랩톱이 아닌 원격 기기에 있습니다. [Session management](/concepts/session)를 참조하세요.

## 설정 기본 사항

### 설정 형식은 무엇이며 어디에 있나요

OpenClaw는 선택적인 **JSON5** 구성을 `$OPENCLAW_CONFIG_PATH` (기본값: `~/.openclaw/openclaw.json`)에서 읽습니다:

```
$OPENCLAW_CONFIG_PATH
```

파일이 없으면 안전한 기본값을 사용합니다 (기본 워크스페이스가 `~/.openclaw/workspace`인 것을 포함해서).

### gatewaybind lan 또는 tailnet으로 설정했는데 아무것도 듣지 않습니다 UI가 허가되지 않았다고 말합니다

비루프백 바인드는 **인증**이 필요합니다. `gateway.auth.mode` + `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)을 설정합니다.

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

참고 사항:

- `gateway.remote.token`은 **원격 CLI 호출** 전용이며, 로컬 게이트웨이 인증을 활성화하지 않습니다.
- Control UI는 `connect.params.auth.token`을 통해 인증합니다 (앱/UI 설정에 저장됨). 토큰을 URL에 넣지 마세요.

### 지금 로컬 호스트에서 토큰이 필요한 이유는 무엇인가요

마법사는 기본적으로 게이트웨이 토큰을 생성합니다 (심지어 루프백에서도) 그래서 **로컬 WS 클라이언트는 인증해야 합니다**. 이는 다른 로컬 프로세스가 게이트웨이를 호출하는 것을 차단합니다. 토큰을 Control UI 설정 (또는 클라이언트 설정)에 붙여넣어 연결하세요.

**정말로** 열린 루프백을 원한다면 `gateway.auth`를 설정에서 삭제하세요. Doctor는 언제든지 토큰을 생성할 수 있습니다: `openclaw doctor --generate-gateway-token`.

### 설정 변경 후 재시작해야 하나요

게이트웨이는 설정을 감시하고 핫 리로드를 지원합니다:

- `gateway.reload.mode: "hybrid"` (기본값): 안전한 변경사항은 핫 적용, 중요한 변경사항은 재시작
- `hot`, `restart`, `off`도 지원됩니다

### 웹 검색 및 웹 가져오기를 어떻게 활성화하나요

`web_fetch`는 API 키 없이 작동합니다. `web_search`는 Brave 검색 API 키가 필요합니다. **권장 사항:** `openclaw configure --section web`을 실행하여 `tools.web.search.apiKey`에 저장하세요. 환경 대안: 게이트웨이 프로세스에 `BRAVE_API_KEY` 설정.

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

참고 사항:

- 허용 목록을 사용하는 경우, `web_search`/`web_fetch` 또는 `group:web`을 추가하세요.
- 기본적으로 `web_fetch`는 활성화되어 있습니다 (명시적으로 비활성화되지 않는 한).
- 데몬은 `~/.openclaw/.env` (또는 서비스 환경)에서 환경 변수를 읽습니다.

Docs: [Web tools](/tools/web).

### 여러 장치에서 특수 작업자와 함께 중앙 게이트웨이를 실행하려면 어떻게 해야 하나요

일반적인 패턴은 **하나의 게이트웨이** (예: Raspberry Pi)와 **노드** 및 **에이전트**입니다:

- **게이트웨이 (중앙):** 채널 (Signal/WhatsApp), 라우팅 및 세션 소유.
- **노드 (장치):** Mac/iOS/Android는 외부 장치로 연결되고 로컬 도구 (`system.run`, `canvas`, `camera`)를 노출합니다.
- **에이전트 (작업자):** 특수 역할을 위해 별도의 브레인/워크스페이스 (예: "Hetzner ops", "개인 데이터").
- **하위 에이전트:** 병렬 처리를 원할 때 메인 에이전트에서 백그라운드 작업 생성.
- **TUI:** 게이트웨이에 연결하고 에이전트/세션 전환.

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### OpenClaw 브라우저는 헤드리스로 실행할 수 있나요

네. 구성 옵션입니다:

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

기본값은 `false` (헤드풀)입니다. 헤드리스 모드는 일부 사이트에서 안티 봇 검사에 걸릴 확률이 높습니다. [Browser](/tools/browser)를 참조하세요.

헤드리스 모드는 **동일한 Chromium 엔진**을 사용하며 대부분의 자동화 (양식, 클릭, 스크래핑, 로그인)에 적합합니다. 주요 차이점:

- 보이는 브라우저 창이 없습니다 (비주얼이 필요하면 스크린샷을 사용하세요).
- 일부 사이트는 헤드리스 모드에서 자동화에 대해 더욱 엄격합니다 (캡챠, 안티 봇).
  예를 들어, X/Twitter는 종종 헤드리스 세션을 차단합니다.

### 브라우저 제어를 위해 Brave를 사용하려면 어떻게 해야 하나요

`browser.executablePath`를 Brave 바이너리 (또는 다른 Chromium 기반 브라우저)로 설정하고 게이트웨이를 재시작하세요.
[Browser](/tools/browser#use-brave-or-another-chromium-based-browser)의 전체 구성 예제를 참조하세요.

## 원격 게이트웨이와 노드

### Telegram, 게이트웨이 및 노드 간의 명령은 어떻게 전파되나요

Telegram 메시지는 **게이트웨이**에 의해 처리됩니다. 게이트웨이는 에이전트를 실행하고
노드 도구가 필요할 때 게이트웨이 WebSocket을 통해 노드를 호출합니다:

Telegram → 게이트웨이 → 에이전트 → `node.*` → 노드 → 게이트웨이 → Telegram

노드는 인바운드 프로바이더 트래픽을 보지 않으며, 노드 RPC 호출만 수신합니다.

### 게이트웨이가 원격에 호스팅될 때 에이전트가 내 컴퓨터에 액세스할 수 있는 방법은 무엇인가요

짧은 답변: **귀하의 컴퓨터를 노드로 연결**하세요. 게이트웨이가 다른 곳에 실행되지만,
Gateway WebSocket을 통해 로컬 기기에서 `node.*` 도구 (화면, 카메라, 시스템)를 호출할 수 있습니다.

일반적인 설정:

1. 항상 켜져 있는 호스트 (VPS/홈 서버)에서 게이트웨이를 실행하세요.
2. 게이트웨이 호스트 + 로컬 컴퓨터를 같은 tailnet에 두세요.
3. 게이트웨이 WS가 접근 가능한지 확인하세요 (tailnet bind 또는 SSH 터널).
4. 로컬에서 macOS 앱을 열고 **Remote over SSH** 모드 (또는 직렬 tailnet)로 연결하여 노드로 등록합니다.
5. 게이트웨이에서 노드를 승인합니다:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

별도의 TCP 브리지가 필요하지 않으며, 노드는 게이트웨이 WebSocket을 통해 연결됩니다.

보안 경고: macOS 노드를 연결하면 그 기기에서 `system.run`이 가능해집니다. 신뢰할 수 있는 기기만 연결하고, [Security](/gateway/security)를 검토하세요.

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS 원격 모드](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale은 연결되었지만 응답이 없습니다. 이제 무엇을 해야 하나요

기본 사항을 확인하세요:

- 게이트웨이가 실행 중인지: `openclaw gateway status`
- 게이트웨이 상태: `openclaw status`
- 채널 상태: `openclaw channels status`

그 다음 인증 및 라우팅을 확인하세요:

- Tailscale Serve를 사용하는 경우, `gateway.auth.allowTailscale`이 올바르게 설정되어 있는지 확인하세요.
- SSH 터널을 통해 연결하는 경우, 로컬 터널이 작동 중이며 올바른 포트를 가리키고 있는지 확인하세요.
- 허용 목록 (다이렉트 메시지 또는 그룹)에 자신의 계정이 있는지 확인하세요.

Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [채널](/channels).

### 두 OpenClaw 인스턴스는 서로 대화할 수 있나요 로컬 VPS

네. 내장된 "bot-to-bot" 브리지가 없지만 몇 가지 신뢰할 수 있는 방법으로 연결할 수 있습니다:

**가장 간단한 방법:** 두 봇이 접속할 수 있는 일반적인 채팅 채널 (Telegram/Slack/WhatsApp)을 사용하세요.
봇 A가 봇 B에게 메시지를 보내고, 봇 B가 평소처럼 응답하도록 하세요.

**CLI 브리지 (일반):** 다른 게이트웨이를 `openclaw agent --message ... --deliver`와 호출하는
스크립트를 실행하여 그 봇이 듣고 있는 채팅을 대상으로 합니다. 하나의 봇이 원격 VPS에 있는 경우,
SSH/Tailscale을 통해 CLI를 그 원격 게이트웨이에 연결하세요 (see [Remote access](/gateway/remote)).

패턴 예시 (대상 게이트웨이에 접근할 수 있는 기기에서 실행):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

팁: 두 봇이 끊임없이 루프하지 않도록 하기 위해, 가이드레일을 추가하세요 (mention-only, 채널 허용 목록, 또는 "bot 메시지에 응답하지 않음" 규칙).

Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### 여러 에이전트를 위해 별도의 VPS가 필요한가요

아니요. 하나의 게이트웨이가 여러 에이전트를 호스팅할 수 있으며, 각각 고유의 워크스페이스, 모델 기본값,
라우팅을 가집니다. 이는 정상적인 설정이며, 에이전트당 하나의 VPS를 운영하는 것보다 훨씬 저렴하고 간단합니다.

보안 경계 또는 공유하고 싶지 않은 매우 다른 설정이 필요할 때만 별도의 VPS를 사용하세요. 그렇지 않으면
하나의 게이트웨이를 유지하고 여러 에이전트 또는 하위 에이전트를 사용하세요.

### 개인 랩톱에서 노드를 사용하는 것이 VPS에서 SSH로 접속하는 것보다 이점이 있나요

네 - 노드는 원격 게이트웨이에서 랩톱에 접근할 수 있는 방식이며, 단순한 셸 접근 이상을 제공합니다.
게이트웨이는 macOS/Linux (Windows는 WSL2를 통해)에서 실행되며 경량입니다 (작은 VPS나 Raspberry Pi급 상자로 충분합니다; 4 GB RAM이면 충분합니다), 그래서 일반적인 설정은 항상 켜져 있는 호스트와 노드로서의 랩톱입니다.

- **인바운드 SSH가 필요 없습니다.** 노드는 게이트웨이 WebSocket으로 연결하며 장치 페어링을 사용합니다.
- **안전한 실행 제어.** `system.run`은 해당 랩톱의 노드 허용 목록/승인을 통해 제한됩니다.
- **더 많은 장치 도구.** 노드는 `canvas`, `camera`, `screen`을 `system.run` 외에도 노출합니다.
- **로컬 브라우저 자동화.** 게이트웨이는 VPS에 유지하되, Chrome을 로컬에서 실행하고 Chrome 확장 프로그램 + 랩톱의 노드 호스트로 제어를 중계합니다.

SSH는 애드 혹 셸 액세스에 적합하지만, 노드는 지속적인 에이전트 워크플로우 및 장치 자동화에 더 간단합니다.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome 확장 프로그램](/tools/chrome-extension).

### 두 번째 랩톱에 설치해야 하나요 아니면 그냥 노드를 추가하면 되나요

두 번째 랩톱에서 **로컬 도구** (화면/카메라/실행)만 필요하다면, **노드**로 추가하세요. 이는 단일 게이트웨이를 유지하며 중복 구성을 피할 수 있습니다. 로컬 노드 도구는 현재 macOS 전용이지만, 다른 운영 체제로 확장할 계획입니다.

**하드 격리** 또는 두 개의 완전히 독립된 봇이 필요할 때만 두 번째 게이트웨이를 설치하세요.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### 노드에서 게이트웨이 서비스를 실행하나요

아니요. **하나의 게이트웨이**만 호스트당 실행되어야 하며, 고립된 프로파일을 의도적으로 실행하지 않는 한 그렇습니다 (see [Multiple gateways](/gateway/multiple-gateways)). 노드는 게이트웨이에 연결되는 주변 장치입니다 (iOS/Android 노드, 또는 메뉴바 앱의 macOS "노드 모드"). 헤드리스 노드 호스트와 CLI 제어에 대해서는 [Node host CLI](/cli/node)를 보세요.

`gateway`, `discovery`, 및 `canvasHost` 변경에는 전체 재시작이 필요합니다.

### 설정을 적용하는 API RPC 방법이 있나요

네. `config.apply`는 전체 설정을 유효성 검사하고 작성하며, 게이트웨이를 운영의 일환으로 재시작합니다.

### config.apply로 인해 설정이 사라졌습니다 이를 복구하고 피하려면 어떻게 해야 하나요

`config.apply`는 **전체 설정**을 대체합니다. 부분 개체를 보내면 다른 모든 것이 제거됩니다.

복구:

- 백업에서 복원 (git 또는 복사된 `~/.openclaw/openclaw.json`).
- 백업이 없는 경우, `openclaw doctor`를 다시 실행하여 채널/모델을 다시 설정합니다.
- 예상치 않은 경우, 마지막에 알고 있는 구성이나 백업을 포함하여 버그를 신고하세요.
- 로칼 코딩 에이전트가 종종 로그나 히스토리에서 작동 가능한 구성을 재구성할 수 있습니다.

피하기:

- 작은 변경에는 `openclaw config set`을 사용하세요.
- 대화형 편집에는 `openclaw configure`를 사용하세요.

Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### 첫 설치를 위한 최소한의 깨끗한 설정은 무엇인가요

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

이는 워크스페이스를 설정하고 봇을 트리거할 수 있는 사용자를 제한합니다.

### VPS에서 Tailscale을 설정하고 Mac에서 연결하려면 어떻게 해야 하나요

최소 단계:

1. **VPS에서 설치 및 로그인**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Mac에서 설치 및 로그인**
   - Tailscale 앱을 사용하고 동일한 tailnet에 로그인하세요.
3. **MagicDNS 활성화 (권장)**
   - Tailscale 관리 콘솔에서 MagicDNS를 활성화하여 VPS에 안정적인 이름을 부여하세요.
4. **tailnet 호스트 이름 사용**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

Control UI를 SSH 없이 사용하려면, VPS에서 Tailscale Serve를 사용하세요:

```bash
openclaw gateway --tailscale serve
```

이렇게 하면 게이트웨이는 루프백에 바인드되고 Tailscale을 통해 HTTPS로 노출됩니다. [Tailscale](/gateway/tailscale)을 참조하세요.

### 원격 게이트웨이에 Mac 노드를 어떻게 연결하나요 Tailscale Serve

Serve는 **게이트웨이 제어 UI + WS**를 노출합니다. 노드는 동일한 게이트웨이 WS 엔드포인트를 통해 연결됩니다.

권장 설정:

1. **VPS + Mac이 동일한 tailnet에 있는지 확인하세요**.
2. **macOS 앱을 원격 모드로 사용하세요** (SSH 대상은 tailnet 호스트 이름일 수 있음).
   앱은 게이트웨이 포트를 터널링하고 노드로 연결할 것입니다.
3. **게이트웨이에서 노드를 승인하세요**:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS 원격 모드](/platforms/mac/remote).

## 환경 변수 및 .env 로드

### OpenClaw는 환경 변수를 어떻게 로드하나요

OpenClaw는 상위 프로세스 (셸, launchd/systemd, CI 등)에서 환경 변수를 읽고 추가로 다음을 로드합니다:

- 현재 작업 디렉토리의 `.env`
- `~/.openclaw/.env` (즉, `$OPENCLAW_STATE_DIR/.env`)의 글로벌 폴백 `.env`

어느 `.env` 파일도 기존 환경 변수를 덮어쓰지 않습니다.

또한 설정 내에서 인라인 환경 변수를 정의할 수도 있습니다 (프로세스 환경에서 누락된 경우에만 적용):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

전체 우선순위 및 출처는 [/environment](/help/environment)를 참조하세요.

### 게이트웨이를 서비스로 시작했는데 내 환경 변수가 사라졌습니다. 이제 무엇을 해야 하나요

두 가지 일반적인 해결책:

1. 빠진 키를 `~/.openclaw/.env`에 넣어 서비스가 셸 환경을 상속하지 않을 때도 이를 인식하도록 합니다.
2. 셸 가져오기 기능을 활성화하세요 (선택적 편리함):

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

이는 로그인 셸을 실행하고 빠진 예상 키만 가져오며 (절대 덮어쓰지 않음). 환경 변수 대체:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### COPILOTGITHUBTOKEN을 설정했지만 모델 상태에서 `Shell env`가 꺼져 있다고 나오는 이유는 무엇인가요

`openclaw models status`는 **셸 환경 가져오기**가 활성화되었는지를 보고합니다. "Shell env: off"는
여러분의 환경 변수가 누락되었다는 걸 의미하지 않습니다 - 이는 OpenClaw가 로그인 셸을 자동으로 로드하지 않는다는 의미입니다.

게이트웨이가 서비스로 실행될 때 (launchd/systemd) 셸 환경을 상속받지 못할 수 있습니다. 이는 아래 방법 중 하나로 수정할 수 있습니다:

1. 토큰을 `~/.openclaw/.env`에 넣으세요:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. 또는 셸 가져오기를 활성화하세요 (`env.shellEnv.enabled: true`).
3. 또는 설정 `env` 블록에 추가하시되 (누락된 경우에만 적용됩니다).

그런 다음 게이트웨이를 다시 시작하고 재확인하세요:

```bash
openclaw models status
```

Copilot 토큰은 `COPILOT_GITHUB_TOKEN` (또는 `GH_TOKEN` / `GITHUB_TOKEN`)에서 읽어옵니다.
[/concepts/model-providers](/concepts/model-providers) 및 [/environment](/help/environment)를 참조하세요.

## 세션 및 여러 채팅

### 새로운 대화를 어떻게 시작하나요

`/new` 또는 `/reset`을 별도의 메시지로 보냅니다. [세션 관리](/concepts/session)를 참조하세요.

### 새 메시지를 보내지 않으면 세션이 자동으로 재설정되나요

예. 세션은 `session.idleMinutes`(기본값 **60**) 이후 만료됩니다. **다음** 메시지는 해당 채팅 키에 대한 새 세션 ID를 시작합니다. 이는 대화 기록을 삭제하지 않으며, 단지 새로운 세션을 시작합니다.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### OpenClaw 인스턴스 팀을 한 CEO와 여러 에이전트로 만들 수 있나요

예, **다중 에이전트 라우팅** 및 **하위 에이전트**를 통해 가능합니다. 하나의 조정 에이전트와 자체 워크스페이스 및 모델을 가진 여러 작업자 에이전트를 생성할 수 있습니다.

그러나 이는 **재미있는 실험**으로 간주하는 것이 좋습니다. 토큰이 많이 소모되며, 한 봇을 별도의 세션으로 사용하는 것보다 효율적이지 않을 때가 많습니다. 우리가 꿈꾸는 일반적인 모델은 병렬 작업을 위한 다른 세션과 함께 대화하는 하나의 봇입니다. 이 봇은 필요한 경우 하위 에이전트를 생성할 수도 있습니다.

문서: [다중 에이전트 라우팅](/concepts/multi-agent), [하위 에이전트](/tools/subagents), [에이전트 CLI](/cli/agents).

### 작업 중에 컨텍스트가 잘린 이유와 이를 방지하는 방법은 무엇인가요

세션 컨텍스트는 모델 창에 의해 제한됩니다. 긴 채팅, 큰 도구 출력 또는 많은 파일이 축소 또는 트렁케이션을 일으킬 수 있습니다.

도움이 되는 것들:

- 현재 상태를 요약하여 파일에 기록하도록 봇에게 요청합니다.
- 긴 작업 전에 `/compact`을 사용하고 주제를 전환할 때 `/new`을 사용합니다.
- 중요한 컨텍스트를 워크스페이스에 유지하고 봇에게 다시 읽도록 요청합니다.
- 메인 채팅이 더 작도록 하위 에이전트를 사용해 긴 작업이나 병렬 작업을 처리합니다.
- 이 문제가 자주 발생하면 더 큰 컨텍스트 윈도우를 가진 모델을 선택하십시오.

### OpenClaw를 완전히 재설정하되 설치 상태를 유지하려면 어떻게 하나요

재설정 명령을 사용하세요:

```bash
openclaw reset
```

비대화형 완전 재설정:

```bash
openclaw reset --scope full --yes --non-interactive
```

그런 다음 온보딩을 다시 실행하세요:

```bash
openclaw onboard --install-daemon
```

주의 사항:

- 온보딩 마법사는 기존 설정을 감지하면 **Reset**을 제공합니다. [Wizard](/start/wizard)를 참조하세요.
- 프로필을 사용했다면 (`--profile` / `OPENCLAW_PROFILE`), 각 상태 디렉터리를 재설정하세요 (기본값은 `~/.openclaw-<profile>`입니다).
- 개발자 재설정: `openclaw gateway --dev --reset` (개발자 전용; 개발 설정 + 자격 증명 + 세션 + 워크스페이스를 모두 삭제).

### 컨텍스트가 너무 크다는 오류가 발생할 때 어떻게 재설정하거나 압축하나요

다음 중 하나를 사용하세요:

- **압축** (대화를 유지하면서 오래된 턴을 요약):

  ```
  /compact
  ```

  또는 요약을 유도하기 위한 `/compact <instructions>`를 사용합니다.

- **재설정** (같은 채팅 키에 대한 새 세션 ID):

  ```
  /new
  /reset
  ```

계속 발생하는 경우:

- **세션 트리밍**을 활성화하거나 조정하여 오래된 도구 출력을 다듬습니다 (`agents.defaults.contextPruning`).
- 더 큰 컨텍스트 윈도우를 가진 모델을 사용합니다.

문서: [압축](/concepts/compaction), [세션 트리밍](/concepts/session-pruning), [세션 관리](/concepts/session).

### "LLM 요청 거부됨: messages.content.tool_use.input 필드 필요"가 표시되는 이유는 무엇인가요

이것은 모델이 필수 `input` 없이 `tool_use` 블록을 출력한 경우 발생하는 프로바이더 유효성 검사 오류입니다. 일반적으로 세션 기록이 오래되었거나 손상되었음을 의미합니다 (종종 긴 스레드나 도구/스키마 변경 이후).

수정: `/new` (별도의 메시지)로 새로운 세션을 시작합니다.

### 왜 30분마다 하트비트 메시지가 나타나나요

기본적으로 하트비트는 **30m**마다 실행됩니다. 이를 조정하거나 비활성화하세요:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // 또는 "0m"로 비활성화
      },
    },
  },
}
```

`HEARTBEAT.md`가 존재하지만 콘텐츠가 사실상 비어있다면 (공백 라인 및 Markdown 헤더만), OpenClaw는 API 호출을 절약하기 위해 하트비트 실행을 건너뜁니다. 파일이 누락되어도 하트비트는 실행되며 모델이 수행할 작업을 결정합니다.

각 에이전트 오버라이드는 `agents.list[].heartbeat`를 사용합니다. 문서: [Heartbeat](/gateway/heartbeat).

### WhatsApp 그룹에 봇 계정을 추가해야 하나요

아니요. OpenClaw는 **귀하의 계정**으로 실행됩니다. 따라서 그룹에 여러분이 있다면, OpenClaw도 이를 볼 수 있습니다. 기본적으로 그룹 답장은 발신자가 허용될 때까지 차단됩니다 (`groupPolicy: "allowlist"`).

여러분만 게임을 작동시키고 싶다면:

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

### WhatsApp 그룹의 JID를 어떻게 얻나요

옵션 1 (가장 빠름): 로그를 뒤따라 그룹에 테스트 메시지를 보내세요:

```bash
openclaw logs --follow --json
```

`@g.us`로 끝나는 `chatId`(또는 `from`)를 찾아보세요, 예: `1234567890-1234567890@g.us`.

옵션 2 (이미 구성된/허용되어 있는 경우): 설정에서 그룹 나열:

```bash
openclaw directory groups list --channel whatsapp
```

문서: [WhatsApp](/channels/whatsapp), [디렉토리](/cli/directory), [로그](/cli/logs).

### 왜 OpenClaw가 그룹에서 응답하지 않나요

두 가지 일반적인 원인:

- 멘션 게이팅이 켜져 있습니다 (기본). 봇을 @멘션해야 하거나 `mentionPatterns`와 일치해야 합니다.
- `"*"` 없이 `channels.whatsapp.groups`를 구성했으며 그룹이 허용 목록에 포함되지 않았습니다.

[그룹](/channels/groups) 및 [그룹 메시지](/channels/group-messages)를 참조하세요.

### 그룹/스레드가 다이렉트 메시지와 컨텍스트를 공유하나요

직접 채팅은 기본적으로 메인 세션으로 합쳐집니다. 그룹/채널은 자체 세션 키를 가지고 있으며, Telegram 주제/Discord 스레드는 별도 세션입니다. [그룹](/channels/groups) 및 [그룹 메시지](/channels/group-messages)를 참조하세요.

### 몇 개의 워크스페이스와 에이전트를 만들 수 있나요

엄격한 제한은 없습니다. 수십 개 (심지어 수백 개)도 가능합니다, 그러나 다음을 주의하세요:

- **디스크 증가:** 세션 + 대화록은 `~/.openclaw/agents/<agentId>/sessions/` 폴더 아래에 존재합니다.
- **토큰 비용:** 더 많은 에이전트는 더 많은 동시 모델 사용을 의미합니다.
- **운영 오버헤드:** 에이전트별 인증 프로필, 워크스페이스 및 채널 라우팅.

팁:

- 각 에이전트당 하나의 **활성** 워크스페이스를 유지합니다 (`agents.defaults.workspace`).
- 디스크가 증가하면 오래된 세션(삭제 JSONL 또는 저장 항목)을 정리합니다.
- `openclaw doctor`를 사용하여 잘못된 워크스페이스 및 프로필 불일치를 찾습니다.

### 여러 슬랙 봇이나 채팅을 동시에 실행할 수 있나요? 어떻게 설정해야 하나요

예. **다중 에이전트 라우팅**을 사용하여 여러 격리된 에이전트를 실행하고 수신 메시지를 채널/계정/동료에 따라 라우팅합니다. Slack은 채널로 지원되며 특정 에이전트에 바인딩할 수 있습니다.

브라우저 액세스는 강력하지만 "사람이 할 수 있는 모든 것"은 아닙니다. 봇 차단, 캡챠 및 MFA는 자동화를 여전히 차단할 수 있습니다. 가장 신뢰할 수 있는 브라우저 컨트롤을 위해서는 브라우저가 실행되는 기기에서 Chrome 확장자 릴레이를 사용하세요 (게이트웨이는 어디서든 가능합니다).

모범 사례 설정:

- 상시 켜짐 게이트웨이 호스트 (VPS/Mac mini).
- 역할별 에이전트 1개 (바인딩).
- Slack 채널을 해당 에이전트에 바인딩.
- 필요 시 확장자 릴레이 (또는 노드)를 통해 로컬 브라우저.

문서: [다중 에이전트 라우팅](/concepts/multi-agent), [Slack](/channels/slack),
[브라우저](/tools/browser), [Chrome 확장자](/tools/chrome-extension), [노드](/nodes).

## 모델: 기본값, 선택, 별칭, 전환

### 기본 모델은 무엇인가요

OpenClaw의 기본 모델은 다음과 같이 설정한 것입니다:

```
agents.defaults.model.primary
```

모델은 `provider/model`로 참조됩니다 (예: `anthropic/claude-opus-4-6`). 프로바이더를 생략하면, OpenClaw는 현재 `anthropic`을 일시적 지원 중지 대체로 가정하지만, **명시적으로** `provider/model`을 설정해야 합니다.

### 어떤 모델을 추천하나요

**추천 기본 모델:** `anthropic/claude-opus-4-6`.
**좋은 대안:** `anthropic/claude-sonnet-4-5`.
**안정적 (캐릭터가 적음):** `openai/gpt-5.2` - Opus와 거의 동등하며, 단지 성격이 적습니다.
**예산:** `zai/glm-4.7`.

MiniMax M2.1에 대한 자체 문서: [MiniMax](/providers/minimax) 및
[로컬 모델](/gateway/local-models).

일반적인 규칙: **높은 중요도의 작업**에는 사용 가능한 **최고의 모델**을 사용하고, 일상 채팅이나 요약에는 더 저렴한 모델을 선택하세요. 에이전트별로 모델을 라우팅하고, 하위 에이전트를 사용해 긴 작업을 병렬화할 수 있습니다 (각 하위 에이전트는 토큰을 소비합니다). [모델](/concepts/models) 및 [하위 에이전트](/tools/subagents)를 참조하세요.

강력한 경고: 속성이나 과잉 양자화된 모델은 프롬프트 주입 및 안전하지 않은 동작에 더 취약합니다. [보안](/gateway/security)을 참조하세요.

추가 컨텍스트: [모델](/concepts/models).

### 직접 호스팅된 모델 llamacpp vLLM Ollama를 사용할 수 있나요

예. 로컬 서버가 OpenAI 호환 API를 노출하면, 사용자 지정 프로바이더를 지정할 수 있습니다. Ollama는 직접 지원되며 가장 쉬운 경로입니다.

보안 주의: 작거나 과도하게 양자화된 모델은 프롬프트 주입에 더 취약합니다. 물건을 사용할 수 있는 모든 봇에는 **대형 모델**을 권장합니다. 여전히 작은 모델을 사용하고자 한다면 샌드박스 격리 및 엄격한 도구 허용 목록을 사용하세요.

문서: [Ollama](/providers/ollama), [로컬 모델](/gateway/local-models),
[모델 프로바이더](/concepts/model-providers), [보안](/gateway/security),
[샌드박스 격리](/gateway/sandboxing).

### 설정을 초기화하지 않고 모델을 전환하려면 어떻게 하나요

**모델 명령**을 사용하거나 **모델** 필드만 편집하세요. 전체 설정을 교체하지 마세요.

안전한 옵션:

- 채팅에서 `/model` (빠르고, 세션별)
- `openclaw models set ...` (모델 설정만 업데이트)
- `openclaw configure --section model` (대화형)
- `~/.openclaw/openclaw.json` 안의 `agents.defaults.model` 편집

전체 객체로 `config.apply`를 피하세요, 의도적으로 설정 전체를 교체하려는 경우가 아니라면. 설정을 덮어썼다면, 백업에서 복원하거나 `openclaw doctor`를 다시 실행해 수리하세요.

문서: [모델](/concepts/models), [설정](/cli/configure), [설정](/cli/config), [의사](/gateway/doctor).

### OpenClaw, Flawd, Krill은 어떤 모델을 사용하나요

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - [Anthropic](/providers/anthropic)를 참조하세요.
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - [MiniMax](/providers/minimax)를 참조하세요.

### 재시작 없이 모델을 동적으로 전환하는 방법은 무엇인가요

독립된 메시지로 `/model` 명령을 사용하세요:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

`/model`, `/model list`, 또는 `/model status`로 사용할 수 있는 모델 목록을 확인할 수 있습니다.

`/model` (및 `/model list`)은 간결하고 번호가 매겨진 선택기를 표시합니다. 번호로 선택하세요:

```
/model 3
```

특정 프로바이더의 인증 프로필을 강제 적용할 수도 있습니다 (세션별):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

팁: `/model status`는 어떤 에이전트가 활성 상태인지, 어떤 `auth-profiles.json` 파일을 사용 중인지, 다음에 인증될 프로필을 보여줍니다.
또한 사용 가능한 경우 설정된 프로바이더 엔드포인트 (`baseUrl`) 및 API 모드 (`api`)도 표시합니다.

### 프로필을 설정할 때 설정한 프로필을 어떻게 해제할 수 있나요

프로필 접미사 없이 `/model`을 다시 실행하세요:

```
/model anthropic/claude-opus-4-6
```

기본값으로 돌아가려면 `/model`에서 선택하거나 `/model <기본 프로바이더/모델>`을 전송합니다.
어떤 인증 프로필이 활성 상태인지 확인하려면 `/model status`를 사용하세요.

### 일상적인 작업에는 GPT 5.2를 사용하고 코딩에는 Codex 5.3를 사용할 수 있나요

예. 하나를 기본값으로 설정하고 필요할 때마다 전환하세요:

- **빠른 전환(세션별):** `/model gpt-5.2`로 일상 작업, `/model gpt-5.3-codex`로 코딩.
- **기본값 + 전환:** `agents.defaults.model.primary`를 `openai/gpt-5.2`로 설정한 뒤 코딩 시 `openai-codex/gpt-5.3-codex`로 전환 (또는 그 반대).
- **하위 에이전트:** 코딩 작업을 다른 기본 모델로 하위 에이전트에 라우팅.

[모델](/concepts/models) 및 [슬래시 명령](/tools/slash-commands)를 참조하세요.

### 모델이 허용되지 않았다는 메시지가 나타난 이후 응답이 없는 이유는 무엇인가요

`agents.defaults.models`가 설정된 경우, 이는 `/model` 및 모든 세션 오버라이드의 **허용 목록**이 됩니다. 해당 목록에 없는 모델을 선택하면 다음과 같은 메시지가 반환됩니다:

```
모델 "provider/model"은 허용되지 않습니다. 사용 가능한 모델은 /model로 나열하십시오.
```

이 오류는 일반적인 응답 **대신에** 반환됩니다. 수정: `agents.defaults.models`에 모델을 추가하거나, 허용 목록을 제거하거나 `/model list`에서 모델을 선택하세요.

### Unknown model minimaxMiniMaxM21라는 오류가 왜 나타나나요

이것은 **프로바이더가 구성되지 않음**을 의미합니다 (MiniMax 프로바이더 구성이나 인증 프로필을 찾을 수 없음). 이 탐지 수정을 위해서는 **2026.1.12**가 필요합니다 (이 글을 작성할 당시에는 출시되지 않았습니다).

수정 체크리스트:

1. **2026.1.12**로 업그레이드 (또는 소스 `main`으로 실행), 그런 다음 게이트웨이를 재시작합니다.
2. MiniMax가 구성되어 있는지 확인하세요 (마법사나 JSON), 또는 MiniMax API 키가 env/auth 프로필에 존재하여 프로바이더가 주입될 수 있어야 합니다.
3. 정확한 모델 ID를 사용하세요 (대소문자 구별): `minimax/MiniMax-M2.1` 또는
   `minimax/MiniMax-M2.1-lightning`.
4. 다음을 실행하세요:

   ```bash
   openclaw models list
   ```

   목록에서 선택하고 (또는 채팅에서 `/model list`).

[MiniMax](/providers/minimax) 및 [모델](/concepts/models)을 참조하세요.

### MiniMax를 기본값으로 사용하고 복잡한 작업에는 OpenAI를 사용할 수 있나요

예. **기본값으로 MiniMax**를 사용하고 필요할 때 **세션별로** 모델을 전환하세요.
대체는 **오류**에 대한 것이므로, "어려운 작업"에는 `/model` 또는 별도의 에이전트를 사용하세요.

**옵션 A: 세션별 전환**

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

그런 다음:

```
/model gpt
```

**옵션 B: 별도의 에이전트**

- 에이전트 A 기본값: MiniMax
- 에이전트 B 기본값: OpenAI
- 에이전트별로 라우팅하거나 `/agent`를 사용하여 전환

문서: [모델](/concepts/models), [다중 에이전트 라우팅](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### opus, sonnet, gpt는 내장된 단축어인가요

예. OpenClaw는 여기에 몇 가지 기본 단축어를 제공합니다 (해당 모델이 `agents.defaults.models`에 존재하는 경우에만 적용됩니다):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

동일한 이름으로 자체 별칭을 설정한 경우, 여러분의 값이 우선됩니다.

### 모델 단축어 별칭을 정의/재정의하는 방법은 무엇인가요

별칭은 `agents.defaults.models.<modelId>.alias`에서 생성됩니다. 예:

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

그런 다음 `/model sonnet` (또는 지원되는 경우 `/<alias>`)은 해당 모델 ID로 해석됩니다.

### OpenRouter 또는 ZAI 같은 다른 프로바이더의 모델을 추가하는 방법은 무엇인가요

OpenRouter (토큰 단위 결제; 여러 모델):

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

Z.AI (GLM 모델):

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

프로바이더/모델을 참조하지만 필요한 프로바이더 키가 없는 경우, 실행 시 인증 오류가 발생합니다 (예: `No API key found for provider "zai"`).

**새 에이전트를 추가한 후에 프로바이더에 대한 API 키가 없다는 오류가 발생하는 경우**

이는 일반적으로 **새 에이전트**가 빈 인증 저장소를 가지고 있음을 의미합니다. 인증은 에이전트별로 이루어지며, 다음에 저장됩니다:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

수정 옵션:

- `openclaw agents add <id>`를 실행하고 마법사 중에 인증을 구성하세요.
- 또는 메인 에이전트의 `agentDir`에서 새로운 에이전트의 `agentDir`으로 `auth-profiles.json`을 복사하세요.

에이전트 간에 `agentDir`를 재사용하지 마세요; 인증/세션 충돌을 일으킬 수 있습니다.

## 모델 대체 및 "모든 모델 실패"

### 대체는 어떻게 작동하나요

대체는 두 가지 단계로 이루어집니다:

1. **동일한 프로바이더 내에서의 인증 프로필 회전**.
2. `agents.defaults.model.fallbacks`의 다음 모델로 **모델 대체**.

프로필의 실패에 대한 쿨다운이 적용되므로, OpenClaw는 프로바이더가 제한되거나 일시적 실패인 경우에도 계속 응답할 수 있습니다.

### 이 오류는 무엇을 의미하나요

```
No credentials found for profile "anthropic:default"
```

이는 시스템이 `anthropic:default`라는 인증 프로필 ID를 사용하려 했으나, 기대하는 인증 저장소에서 자격 증명을 찾을 수 없다는 것을 의미합니다.

### No credentials found for profile anthropicdefault에 대한 수정 체크리스트

- **인증 프로필 위치 확인** (새 vs 레거시 경로)
  - 현재: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - 레거시: `~/.openclaw/agent/*` (`openclaw doctor`에 의해 마이그레이션)
- **게이트웨이에서 env var이 로드되었는지 확인**
  - 쉘에 `ANTHROPIC_API_KEY`를 설정했지만 게이트웨이를 systemd/launchd를 통해 실행하는 경우, 이를 상속하지 않을 수 있습니다. `~/.openclaw/.env`에 넣거나 `env.shellEnv`를 활성화하세요.
- **올바른 에이전트를 편집하고 있는지 확인**
  - 다중 에이전트 설정의 경우 여러 `auth-profiles.json` 파일이 존재할 수 있습니다.
- **모델/인증 상태의 무결성 검사**
  - `openclaw models status`를 사용하여 구성된 모델과 프로바이더가 인증되었는지 확인하세요.

**No credentials found for profile anthropic에 대한 수정 체크리스트**

이는 실행이 Anthropic 인증 프로필에 고정되어 있지만, 게이트웨이가 인증 저장소에서 이를 찾을 수 없다는 것을 의미합니다.

- **설정 토큰을 사용하세요**
  - `claude setup-token`를 실행한 다음 `openclaw models auth setup-token --provider anthropic`으로 붙여넣으세요.
  - 다른 머신에서 토큰이 생성된 경우, `openclaw models auth paste-token --provider anthropic`을 사용하세요.
- **API 키를 대신 사용하고 싶으시다면**
  - `ANTHROPIC_API_KEY`를 **게이트웨이 호스트**의 `~/.openclaw/.env`에 넣으세요.
  - 누락된 프로필을 강제하는 고정 순서를 지우세요:

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **게이트웨이 호스트에서 명령을 실행 중인지 확인**
  - 원격 모드에서는 인증 프로필이 게이트웨이 머신에 존재하며, 본인의 랩탑에 있지 않습니다.

### 왜 Google Gemini도 시도했고 실패했나요

모델 구성에 Google Gemini가 대체로 포함되어 있다면 (또는 Gemini 줄임말로 전환했다면), OpenClaw는 모델 대체 중 이를 시도합니다. Google 자격 증명을 구성하지 않은 경우 `No API key found for provider "google"` 오류가 표시됩니다.

수정: Google 인증을 제공하거나 `agents.defaults.model.fallbacks` / 별칭에서 Google 모델을 제거/피해야 대체 라우팅이 거기로 진행되지 않습니다.

## 인증 프로필: 정의와 관리 방법

관련 자료: [/concepts/oauth](/concepts/oauth) (OAuth 플로우, 토큰 저장, 다중 계정 패턴)

### 인증 프로필이란 무엇인가

인증 프로필은 프로바이더에 연결된 이름 있는 자격 증명 기록 (OAuth 또는 API 키)입니다. 프로필은 다음 위치에 저장됩니다:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### 일반적인 프로필 ID는 무엇인가요

OpenClaw는 다음과 같은 프로바이더 접두사가 붙은 ID를 사용합니다:

- `anthropic:default` (이메일 아이덴티티가 없을 때 일반적)
- `anthropic:<email>` OAuth 아이덴티티
- 사용자가 선택한 사용자 지정 ID (예: `anthropic:work`)

### 어떤 인증 프로필을 먼저 시도할지 제어할 수 있나요

예, 가능합니다. 설정은 프로필에 대한 선택적 메타데이터와 프로바이더별 순서를 지원합니다 (`auth.order.<provider>`). 이는 비밀정보를 저장하지 않으며, ID를 프로바이더/모드와 매핑하고 회전 순서를 설정합니다.

OpenClaw는 프로필이 짧은 **쿨다운** 상태 (요금 제한/시간 초과/인증 실패)나 긴 **비활성화** 상태 (청구/충분하지 않은 크레딧)에 있을 경우 임시로 프로필을 건너뛸 수 있습니다. 이를 확인하려면 `openclaw models status --json`을 실행하고 `auth.unusableProfiles`를 확인하세요. 튜닝: `auth.cooldowns.billingBackoffHours*`.

CLI를 통해 **각 에이전트**의 순서 재정의를 설정할 수도 있습니다 (해당 에이전트의 `auth-profiles.json`에 저장됨):

```bash
# 구성된 기본 에이전트로 기본 설정 ( --agent 생략)
openclaw models auth order get --provider anthropic

# 회전을 단일 프로필로 고정 (이것만 시도)
openclaw models auth order set --provider anthropic anthropic:default

# 또는 명시적인 순서를 설정함 (프로바이더 내에서 대체)
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# 재정의 지우기 (구성 auth.order / 라운드 로빈으로 돌아가기)
openclaw models auth order clear --provider anthropic
```

특정 에이전트를 대상으로 하려면:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth와 API 키의 차이점은 무엇인가요

OpenClaw는 둘 다 지원합니다:

- **OAuth**는 종종 구독 액세스를 활용합니다 (가능한 경우).
- **API 키**는 사용한 만큼 비용을 청구합니다.

마법사는 Anthropic 설정 토큰 및 OpenAI Codex OAuth를 명시적으로 지원하며 API 키를 저장할 수 있습니다.

## 게이트웨이: 포트 설정, "이미 실행 중" 문제, 원격 모드

### 게이트웨이는 어떤 포트를 사용하나요

`gateway.port`는 WebSocket + HTTP (컨트롤 UI, 훅 등)를 위한 단일 다중화 포트를 제어합니다.

우선순위:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > 기본값 18789
```

### openclaw 게이트웨이 상태가 런타임이 실행 중이라고 하면서 RPC 프로브가 실패하는 이유는 무엇인가요

"실행 중"이라는 것은 **감독 프로그램**의 관점입니다 (launchd/systemd/schtasks). RPC 프로브는 CLI가 실제로 게이트웨이 WebSocket에 연결하고 `status`를 호출하는 것입니다.

`openclaw gateway status`를 사용하고 다음 줄을 신뢰하세요:

- `Probe target:` (실제로 프로브가 사용한 URL)
- `Listening:` (포트에 실제로 바인딩된 것)
- `Last gateway error:` (프로세스는 살아 있지만 포트가 연결되지 않은 일의 일반적인 원인)

### 왜 openclaw 게이트웨이 상태가 구성된 CLI와 구성된 서비스가 다르다고 하나요

구성 파일을 하나 편집하고 서비스는 다른 파일을 실행 중입니다 (대부분 `--profile` / `OPENCLAW_STATE_DIR` 불일치).

수정:

```bash
openclaw gateway install --force
```

원하는 서비스 프로필/환경에서 동일한 `--profile`로 실행하세요.

### "다른 게이트웨이 인스턴스가 이미 수신 대기 중"이라는 메시지가 나오는 이유는 무엇인가요

OpenClaw는 시작 시 즉시 WebSocket 리스너를 바인딩하여 런타임 잠금을 강제합니다 (기본값 `ws://127.0.0.1:18789`). 바인딩이 `EADDRINUSE`로 실패하면 다른 인스턴스가 이미 수신 대기 중임을 나타내는 `GatewayLockError`가 발생합니다.

수정: 다른 인스턴스를 중지하고 포트를 해제하거나 `openclaw gateway --port <port>`로 실행하세요.

### OpenClaw를 원격 모드로 실행하려면 어떻게 해야 하나요

`gateway.mode: "remote"`로 설정하고 원격 WebSocket URL로 지정합니다. 토큰/비밀번호가 선택적으로 있을 수 있습니다:

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

주의사항:

- `openclaw gateway`는 `gateway.mode`가 `local`일 때만 시작됩니다 (또는 재정의 플래그를 전달할 때).
- macOS 앱은 구성 파일을 감시하며 이 값이 변경될 때 모드를 실시간으로 전환합니다.

### 컨트롤 UI에서 "권한 없음"이라고 표시되거나 계속 재연결하는 경우 어떻게 해야 하나요

게이트웨이는 인증이 활성화된 상태로 실행 중입니다 (`gateway.auth.*`), 그러나 UI는 일치하는 토큰/비밀번호를 보내지 않습니다.

사실 (코드에서):

- 컨트롤 UI는 토큰을 브라우저의 localStorage 키 `openclaw.control.settings.v1`에 저장합니다.

수정:

- 가장 빠른 방법: `openclaw dashboard` (대시보드 URL을 출력 + 복사, 열기를 시도; 헤드리스일 경우 SSH 힌트 표시).
- 아직 토큰이 없는 경우: `openclaw doctor --generate-gateway-token`.
- 원격인 경우, 먼저 터널을 엽니다: `ssh -N -L 18789:127.0.0.1:18789 user@host` 그런 다음 `http://127.0.0.1:18789/`를 엽니다.
- 게이트웨이 호스트에 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)을 설정합니다.
- 컨트롤 UI 설정에 동일한 토큰을 붙여넣습니다.
- 여전히 해결되지 않나요? `openclaw status --all`을 실행하고 [문제 해결](/gateway/troubleshooting)을 참조하세요. 인증 세부 정보는 [대시보드](/web/dashboard)를 확인하세요.

### gatewaybind tailnet을 설정했지만 바인딩할 수 없거나 수신 대기하는 것이 없는 이유는 무엇인가요

`tailnet` 바인드는 네트워크 인터페이스에서 Tailscale IP를 선택합니다 (100.64.0.0/10). 머신이 Tailscale에 연결되어 있지 않거나 인터페이스가 다운되었으면 바인딩할 수 있는 것이 없습니다.

수정:

- 해당 호스트에서 Tailscale을 시작합니다 (그래서 100.x 주소를 가집니다), 또는
- `gateway.bind: "loopback"` / `"lan"`으로 전환하세요.

참고: `tailnet`은 명시적입니다. `auto`는 루프백을 선호합니다; `gateway.bind: "tailnet"`을 사용할 때는 tailnet 전용 바인딩을 원할 때 사용하세요.

### 같은 호스트에서 여러 게이트웨이를 실행할 수 있나요

일반적으로 아니요 - 하나의 게이트웨이는 여러 메시지 채널과 에이전트를 실행할 수 있습니다. 중복성 (예: 구조 봇)이나 강력한 격리가 필요할 때만 여러 게이트웨이를 사용하세요.

예, 하지만 격리해야 합니다:

- `OPENCLAW_CONFIG_PATH` (인스턴스별 구성)
- `OPENCLAW_STATE_DIR` (인스턴스별 상태)
- `agents.defaults.workspace` (작업공간 격리)
- `gateway.port` (고유한 포트)

빠른 설정 (추천):

- 인스턴스당 `openclaw --profile <name> …`을 사용하세요 (자동으로 `~/.openclaw-<name>`을 만듭니다).
- 각 프로필 구성에서 고유한 `gateway.port`를 설정하거나 수동 실행을 위해 `--port`를 전달하세요.
- 프로필별 서비스를 설치합니다: `openclaw --profile <name> gateway install`.

프로필은 서비스 이름에 접미사를 붙입니다 (`bot.molt.<profile>`; 레거시 `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
전체 가이드: [다중 게이트웨이](/gateway/multiple-gateways).

### "Invalid handshake code 1008"은 무슨 의미인가요

게이트웨이는 **WebSocket 서버**로 첫 번째 메시지로 `connect` 프레임을 기대합니다. 다른 메시지를 받으면 **코드 1008** (정책 위반)로 연결을 닫습니다.

일반적인 원인:

- 브라우저에서 **HTTP** URL을 열었습니다 (`http://...`) 대신 WS 클라이언트를 사용했습니다.
- 잘못된 포트 또는 경로를 사용했습니다.
- 프록시 또는 터널이 인증 헤더를 제거하거나 게이트웨이가 아닌 요청을 보냈습니다.

빠른 수정:

1. WS URL을 사용하세요: `ws://<host>:18789` (또는 HTTPS일 경우 `wss://...`).
2. 일반 브라우저 탭에서 WS 포트를 열지 마세요.
3. 인증이 켜져있다면 `connect` 프레임에 토큰/비밀번호를 포함시키세요.

CLI 또는 TUI를 사용하는 경우 URL은 다음과 같이 보일 것입니다:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

프로토콜 세부 정보: [게이트웨이 프로토콜](/gateway/protocol).

## 로깅 및 디버깅

### 로그는 어디에 있나요

파일 로그 (구조적):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file`을 통해 안정적인 경로를 설정할 수 있습니다. 파일 로그 레벨은 `logging.level`로 제어됩니다. 콘솔 상세도는 `--verbose` 및 `logging.consoleLevel`로 제어됩니다.

가장 빠른 로그 추적:

```bash
openclaw logs --follow
```

서비스/슈퍼바이저 로그 (게이트웨이가 launchd/systemd로 실행될 때):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` 및 `gateway.err.log` (기본값: `~/.openclaw/logs/...`; 프로필은 `~/.openclaw-<profile>/logs/...` 사용)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

자세한 내용은 [문제 해결](/gateway/troubleshooting#log-locations)을 참조하세요.

### 게이트웨이 서비스를 시작/중지/재시작하려면

게이트웨이 도우미를 사용하세요:

```bash
openclaw gateway status
openclaw gateway restart
```

게이트웨이를 수동으로 실행중이라면, `openclaw gateway --force`로 포트를 회수할 수 있습니다. [게이트웨이](/gateway)를 참조하세요.

### Windows에서 터미널을 닫았는데 OpenClaw를 재시작하려면 어떻게 해야 하나요

Windows 설치 모드는 **두 가지**가 있습니다:

**1) WSL2 (추천):** 게이트웨이가 Linux 내에서 실행됩니다.

PowerShell을 열고, WSL에 들어가서 재시작하세요:

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

서비스를 설치하지 않은 경우, 전경에서 시작하세요:

```bash
openclaw gateway run
```

**2) 원래 Windows (비추천):** 게이트웨이가 Windows에서 직접 실행됩니다.

PowerShell을 열고 실행하세요:

```powershell
openclaw gateway status
openclaw gateway restart
```

수동으로 (서비스 없이) 실행하는 경우, 사용하세요:

```powershell
openclaw gateway run
```

문서: [Windows (WSL2)](/platforms/windows), [게이트웨이 서비스 운영 안내서](/gateway).

### 게이트웨이가 실행 중인데 응답이 오지 않습니다. 무엇을 확인해야 하나요

빠른 상태 확인을 시작하세요:

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

일반적인 원인:

- 모델 인증이 **게이트웨이 호스트**에서 로드되지 않음 (예: `models status` 확인).
- 채널 페어링/허용리스트가 응답을 차단 (채널 구성 및 로그 확인).
- WebChat/대시보드가 올바른 토큰 없이 열려 있음.

원격인 경우 터널/Tailscale 연결이 활성화되어 있으며 게이트웨이 WebSocket이 도달 가능한지 확인하세요.

문서: [채널](/channels), [문제 해결](/gateway/troubleshooting), [원격 액세스](/gateway/remote).

### "게이트웨이에서 이유 없이 연결이 끊어짐" - 다음 단계는

보통 UI가 WebSocket 연결을 잃은 경우입니다. 다음을 확인하세요:

1. 게이트웨이가 실행 중인가요? `openclaw gateway status`
2. 게이트웨이가 정상인가요? `openclaw status`
3. UI에 올바른 토큰이 있나요? `openclaw dashboard`
4. 원격일 경우 터널/Tailscale 링크가 활성화되었나요?

그런 다음 로그를 실시간으로 확인하세요:

```bash
openclaw logs --follow
```

문서: [대시보드](/web/dashboard), [원격 액세스](/gateway/remote), [문제 해결](/gateway/troubleshooting).

### Telegram setMyCommands에서 네트워크 오류가 발생합니다. 무엇을 확인해야 하나요

로그와 채널 상태로 시작하세요:

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

VPS 또는 프록시 뒤에 있는 경우, 아웃바운드 HTTPS가 허용되고 DNS가 정상 작동하는지 확인하세요.
게이트웨이가 원격이면 게이트웨이 호스트의 로그를 확인하는지 확인하세요.

문서: [Telegram](/channels/telegram), [채널 문제 해결](/channels/troubleshooting).

### TUI에 출력이 없습니다. 무엇을 확인해야 하나요

우선 게이트웨이가 도달 가능하고 에이전트가 실행 가능한지 확인하세요:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

TUI에서 `/status`를 사용하여 현재 상태를 확인하세요. 채팅 채널에서 응답을 기대한다면
전달이 활성화되어 있는지 확인하세요 (`/deliver on`).

문서: [TUI](/web/tui), [슬래시 명령어](/tools/slash-commands).

### 게이트웨이를 완전히 중지한 다음 다시 시작하려면

서비스를 설치한 경우:

```bash
openclaw gateway stop
openclaw gateway start
```

이는 **감독된 서비스** (macOS의 launchd, Linux의 systemd)를 중지/시작합니다.
게이트웨이를 데몬으로 실행할 때 이 방법을 사용하십시오.

전경에서 실행 중이면 Ctrl-C로 중지한 다음:

```bash
openclaw gateway run
```

문서: [게이트웨이 서비스 운영 안내서](/gateway).

### ELI5 openclaw gateway restart와 openclaw gateway의 차이점은

- `openclaw gateway restart`: **백그라운드 서비스** (launchd/systemd)를 재시작합니다.
- `openclaw gateway`: 이 터미널 세션에 대해 게이트웨이를 **전경에서** 실행합니다.

서비스를 설치한 경우, 게이트웨이 명령어를 사용하세요. 일회성 전경 실행을 원할 때 `openclaw gateway`를 사용하세요.

### 문제가 발생하면 가장 빨리 추가 정보를 얻는 방법은 무엇인가요

더 많은 콘솔 세부 정보를 얻기 위해 `--verbose`로 게이트웨이를 시작하세요. 그런 다음 로그 파일을 확인하여 채널 인증, 모델 라우팅 및 RPC 오류를 조사하세요.

## 미디어 및 첨부 파일

### 내 스킬이 이미지/PDF를 생성했지만 아무 것도 전송되지 않았습니다

에이전트로부터의 아웃바운드 첨부 파일에는 반드시 `MEDIA:<path-or-url>` 라인이 포함되어야 합니다 (별도 줄로). [OpenClaw 어시스턴트 설정](/start/openclaw) 및 [에이전트 전송](/tools/agent-send)을 참조하세요.

CLI 전송하기:

```bash
openclaw message send --target +15555550123 --message "여기 있어요" --media /path/to/file.png
```

또한 확인하세요:

- 대상 채널이 아웃바운드 미디어를 지원하고 허용리스트로 차단되지 않은 상태입니다.
- 파일이 프로바이더의 크기 제한 내에 있습니다 (이미지는 최대 2048px로 크기를 조정합니다).

자세한 내용은 [이미지](/nodes/images)를 참조하세요.

## 보안 및 액세스 제어

### OpenClaw를 들어오는 다이렉트 메시지에 노출하는 것이 안전한가요

들어오는 다이렉트 메시지를 신뢰할 수 없는 입력으로 취급하세요. 기본 설정은 위험을 줄이도록 설계되었습니다:

- DM 가능한 채널의 기본 동작은 **페어링**입니다:
  - 알려지지 않은 보낸 사람은 페어링 코드를 받으며, 봇은 메시지를 처리하지 않습니다.
  - 승인 방법: `openclaw pairing approve <channel> <code>`
  - 보류 중인 요청은 **채널당 3개**로 제한됩니다; 코드가 도착하지 않으면 `openclaw pairing list <channel>`를 확인하세요.
- 공개적으로 다이렉트 메시지를 열려면 명시적인 동의가 필요합니다 (`dmPolicy: "open"` 및 허용리스트에 `"*"`).

위험한 DM 정책을 드러내기 위해 `openclaw doctor`를 실행하세요.

### 프롬프트 주입은 공개 봇의 경우에만 문제가 되나요

아닙니다. 프롬프트 주입은 **신뢰할 수 없는 콘텐츠**에 대한 문제이며, 봇에게 DM을 보낼 수 있는 사람에게만 해당하지 않습니다.
도우미가 외부 콘텐츠 (웹 검색/가져오기, 브라우저 페이지, 이메일,
문서, 첨부 파일, 붙여넣은 로그)를 읽는다면, 해당 콘텐츠에 모델을 탈취하려는 지시가 포함될 수 있습니다. 이는 **당신이 유일한 보낸 사람**인 경우에도 발생할 수 있습니다.

가장 큰 위험은 도구가 활성화된 경우입니다: 모델이 컨텍스트를 빼내거나 도구를 대신 호출하도록 속을 수 있습니다. 폭발 반경을 줄이기 위한 방법은:

- 신뢰할 수 없는 콘텐츠를 요약하기 위해 읽기 전용 또는 도구가 비활성화된 "읽기" 에이전트를 사용하는 것
- `web_search` / `web_fetch` / `browser`를 도구가 활성화된 에이전트에 대해 꺼두기
- 샌드박스 격리 및 엄격한 도구 허용리스트 사용

자세한 내용은 [보안](/gateway/security)을 참조하세요.

### 내 봇에게 자체 이메일, GitHub 계정 또는 전화번호를 가져야 하나요

대부분의 설정에서 그렇습니다. 봇을 별도의 계정과 전화번호로 격리하면 문제가 발생했을 때 확산 범위를 줄일 수 있습니다. 이는 또한 개인 계정에 영향을 주지 않고 자격 증명을 회전시키거나 접근을 철회하기 쉽게 만듭니다.

작게 시작하세요. 실제로 필요한 도구 및 계정에만 접근을 부여하고, 필요 시 나중에 확장하세요.

문서: [보안](/gateway/security), [페어링](/channels/pairing).

### 개인 메시지에 대한 자율권을 부여할 수 있고, 안전한가요

개인 메시지에 대한 완전한 자율권을 부여하는 것을 **권장하지 않습니다**. 가장 안전한 패턴은:

- 다이렉트 메시지를 **페어링 모드** 또는 엄격한 허용리스트로 유지하세요.
- 만약 당신을 대신하여 메시지를 전달하길 원한다면, 두 번째 전화번호나 계정을 사용하세요.
- 초안을 작성하게 하고, **전송하기 전에 승인**하세요.

만약 실험하고 싶다면, 전용 계정에서 수행하고 이를 격리된 상태로 유지하세요. [보안](/gateway/security)을 참조하세요.

### 개인 비서 작업에 더 저렴한 모델을 사용할 수 있나요

그렇습니다, 에이전트가 채팅 전용이며 입력이 신뢰할 수 있는 경우에 한해. 작은 크기의 모델은 명령 탈취에 더 취약하므로 도구가 활성화된 에이전트나 신뢰할 수 없는 콘텐츠를 읽을 때는 피하세요. 반드시 작은 모델을 사용해야 한다면, 도구를 잠그고 샌드박스 내에서 실행하세요. [보안](/gateway/security)을 참조하세요.

### Telegram에서 시작 명령을 실행했지만 페어링 코드를 받지 못했습니다

페어링 코드는 **알려지지 않은 보낸 사람이** 봇에게 메시지를 보내고
`dmPolicy: "pairing"`이 활성화되었을 때만 전송됩니다. `/start` 자체로는 코드를 생성하지 않습니다.

보류 중인 요청을 확인하세요:

```bash
openclaw pairing list telegram
```

즉시 접근하고 싶다면, 보낸 사람 ID를 허용리스트에 추가하거나 해당 계정에 대해 `dmPolicy: "open"`을 설정하세요.

### WhatsApp에서는 내 연락처에 메시지를 보낼까요? 페어링은 어떻게 작동하나요

아니요. 기본 WhatsApp DM 정책은 **페어링**입니다. 알려지지 않은 보낸 사람은 페어링 코드만 받고 그들의 메시지는 **처리되지 않습니다**. OpenClaw는 수신한 채팅이나 당신이 명시적으로 보낸 메시지에만 응답합니다.

페어링 승인:

```bash
openclaw pairing approve whatsapp <code>
```

보류 중인 요청 목록 보기:

```bash
openclaw pairing list whatsapp
```

마법사의 전화번호 프롬프트: 이는 **허용리스트/소유자**를 설정하는 데 사용됩니다, 그래서 당신의 다이렉트 메시지가 허용됩니다. 자동 전송에 사용되지는 않습니다. 개인 WhatsApp 번호에서 실행할 경우, 그 번호를 사용하고 `channels.whatsapp.selfChatMode`를 활성화하세요.

## 채팅 명령어, 작업 중단, 및 "멈추지 않음"

### 채팅에서 내부 시스템 메시지가 표시되지 않도록 하려면

대부분의 내부 또는 도구 메시지는 해당 세션에서 **verbose** 또는 **reasoning**이 활성화된 경우에만 표시됩니다.

해당 채팅에서 수정하기:

```
/verbose off
/reasoning off
```

그래도 메시지가 많다면, 컨트롤 UI의 세션 설정을 확인하고 verbose를 **inherit**으로 설정하세요. 또한 봇 프로필 구성에서 `verboseDefault`가 `on`으로 설정되어 있지 않은지 확인하세요.

문서: [생각 및 verbose 출력](/tools/thinking), [보안](/gateway/security#reasoning--verbose-output-in-groups).

### 실행 중인 작업을 중지/취소하려면

다음 중 하나를 **독립된 메시지**로 보내세요 (슬래시 없음):

```
stop
abort
esc
wait
exit
interrupt
```

이들은 중단 트리거입니다 (슬래시 명령어가 아님).

백그라운드 프로세스의 경우 (exec 도구에서), 에이전트에게 다음을 실행하도록 요청할 수 있습니다:

```
process action:kill sessionId:XXX
```

슬래시 명령어 개요는 [슬래시 명령어](/tools/slash-commands)를 참조하세요.

대부분의 명령어는 **독립된** 메시지로 `/`로 시작해야 하지만, 몇 가지 단축어 (예: `/status`)는 허용된 보낸 사람에게 인라인으로도 작동합니다.

### Telegram에서 Discord 메시지를 보내려고 할 때 크로스컨텍스트 메시징이 거부됩니다

OpenClaw는 기본적으로 **크로스 프로바이더** 메시징을 차단합니다. 도구 호출이 Telegram에 바인딩되어 있다면, Discord로 보내지 않습니다.

에이전트에 대해 크로스 프로바이더 메시징을 활성화하세요:

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

구성을 편집한 후 게이트웨이를 다시 시작하세요. 특정 에이전트에 대해서만 원한다면 `agents.list[].tools.message` 아래에 설정하세요.

### 봇이 빠르게 오는 메시지를 무시하는 것처럼 느껴지는 이유는 무엇인가요

큐 모드는 새 메시지가 진행 중인 실행과 어떻게 상호작용하는지를 제어합니다. `/queue`를 사용하여 모드를 변경하세요:

- `steer` - 새 메시지가 현재 작업을 재지정합니다
- `followup` - 메시지를 한 번에 한 개씩 실행
- `collect` - 메시지를 일괄 처리하고 한 번에 응답 (기본값)
- `steer-backlog` - 지금 재지정, 그런 다음 백로그 처리
- `interrupt` - 현재 실행을 중단하고 새로 시작

`followup` 모드에 `debounce:2s cap:25 drop:summarize`와 같은 옵션을 추가할 수 있습니다.

## 스크린샷/채팅 로그에서 정확한 질문에 답변하기

**질문: "Anthropic의 기본 모델은 무엇인가요 (API 키 사용 시)?"**

**답변:** OpenClaw에서 자격 증명과 모델 선택은 별개입니다. `ANTHROPIC_API_KEY`를 설정하거나 인증 프로필에 Anthropic API 키를 저장하면 인증이 가능해지지만, 실제 기본 모델은 `agents.defaults.model.primary`에 구성한 모델입니다 (예: `anthropic/claude-sonnet-4-5` 또는 `anthropic/claude-opus-4-6`). `No credentials found for profile "anthropic:default"`라는 메시지가 보이면, 게이트웨이가 실행 중인 에이전트의 `auth-profiles.json`에서 Anthropic 자격증명을 찾을 수 없음을 의미합니다.

---

여전히 문제를 해결하지 못했나요? [Discord](https://discord.com/invite/clawd)에서 질문하거나 [GitHub 토론](https://github.com/openclaw/openclaw/discussions)을 열어보세요.
