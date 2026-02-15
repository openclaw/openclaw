---
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"
title: "常見問題"
---

# 常見問題

快速解答及針對實際安裝（本機開發、VPS、多智慧代理、OAuth/API 密鑰、模型故障轉移）的深入疑難排解。有關執行階段診斷，請參閱 [Troubleshooting](/gateway/troubleshooting)。有關完整的設定參考資料，請參閱 [Configuration](/gateway/configuration)。

## 目錄

- [快速開始和首次執行設定]
  - [我遇到問題了，最快解決問題的方法是什麼？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [安裝和設定 OpenClaw 的建議方法是什麼？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [新手導覽後如何開啟儀表板？](#how-do-i-open-the-dashboard-after-onboarding)
  - [如何在 localhost 與遠端驗證儀表板（權杖）？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [我需要什麼執行階段？](#what-runtime-do-i-need)
  - [它可以在 Raspberry Pi 上執行嗎？](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi 安裝有什麼提示嗎？](#any-tips-for-raspberry-pi-installs)
  - [它卡在「喚醒我的朋友」/新手導覽無法開始。現在怎麼辦？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [我可以在不重新進行新手導覽的情況下，將設定遷移到新機器 (Mac mini) 嗎？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [在哪裡查看最新版本的新功能？](#where-do-i-see-what-is-new-in-the-latest-version)
  - [我無法存取 docs.openclaw.ai (SSL 錯誤)。現在怎麼辦？](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [穩定版和 Beta 版有什麼區別？](#whats-the-difference-between-stable-and-beta)
  - [如何安裝 Beta 版，以及 Beta 版和開發版有什麼區別？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [如何嘗試最新版本？](#how-do-i-try-the-latest-bits)
  - [安裝和新手導覽通常需要多長時間？](#how-long-does-install-and-onboarding-usually-take)
  - [安裝程式卡住了？如何獲得更多回饋？](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows 安裝說找不到 git 或無法識別 openclaw](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [文件沒有回答我的問題——如何獲得更好的答案？](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [如何在 Linux 上安裝 OpenClaw？](#how-do-i-install-openclaw-on-linux)
  - [如何在 VPS 上安裝 OpenClaw？](#how-do-i-install-openclaw-on-a-vps)
  - [雲端/VPS 安裝指南在哪裡？](#where-are-the-cloudvps-install-guides)
  - [我可以要求 OpenClaw 自動更新嗎？](#can-i-ask-openclaw-to-update-itself)
  - [新手導覽精靈實際上做了什麼？](#what-does-the-onboarding-wizard-actually-do)
  - [我需要 Claude 或 OpenAI 訂閱才能執行此程式嗎？](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [我可以在沒有 API 密鑰的情況下使用 Claude Max 訂閱嗎？](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic 的「setup-token」驗證是如何運作的？](#how-does-anthropic-setuptoken-auth-work)
  - [我在哪裡可以找到 Anthropic setup-token？](#where-do-i-find-an-anthropic-setuptoken)
  - [您支援 Claude 訂閱驗證 (Claude Pro 或 Max) 嗎？](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [為什麼我看到 Anthropic 傳回 `HTTP 429: rate_limit_error`？](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [是否支援 AWS Bedrock？](#is-aws-bedrock-supported)
  - [Codex 驗證是如何運作的？](#how-does-codex-auth-work)
  - [您支援 OpenAI 訂閱驗證 (Codex OAuth) 嗎？](#do-you-support-openai-subscription-auth-codex-oauth)
  - [如何設定 Gemini CLI OAuth？](#how-do-i-set-up-gemini-cli-oauth)
  - [本機模型適合休閒聊天嗎？](#is-a-local-model-ok-for-casual-chats)
  - [如何將託管模型流量保持在特定區域？](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [我必須購買 Mac Mini 才能安裝此程式嗎？](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [我需要 Mac mini 才能支援 iMessage 嗎？](#do-i-need-a-mac-mini-for-imessage-support)
  - [如果我購買 Mac mini 來執行 OpenClaw，可以將它連接到我的 MacBook Pro 嗎？](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [我可以使用 Bun 嗎？](#can-i-use-bun)
  - [Telegram: `allowFrom` 中填寫什麼？](#telegram-what-goes-in-allowfrom)
  - [多個人可以使用一個 WhatsApp 號碼與不同的 OpenClaw 實例嗎？](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [我可以執行一個「快速聊天」智慧代理和一個「用於編碼的 Opus」智慧代理嗎？](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew 在 Linux 上能運作嗎？](#does-homebrew-work-on-linux)
  - [可破解 (git) 安裝與 npm 安裝有什麼區別？](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [稍後我可以切換 npm 和 git 安裝嗎？](#can-i-switch-between-npm-and-git-installs-later)
  - [我應該在筆記型電腦還是 VPS 上執行 Gateway？](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [在專用機器上執行 OpenClaw 有多重要？](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [最低 VPS 需求和建議的作業系統是什麼？](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [我可以在 VM 中執行 OpenClaw 嗎？需求是什麼？](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [什麼是 OpenClaw？](#what-is-openclaw)
  - [什麼是 OpenClaw (一段話說明)？](#what-is-openclaw-in-one-paragraph)
  - [價值主張是什麼？](#whats-the-value-proposition)
  - [我剛設定好，我應該先做什麼？](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw 的五大日常使用案例是什麼？](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw 可以協助 SaaS 的潛在客戶開發、外展廣告和部落格嗎？](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [與用於 Web 開發的 Claude Code 相比，有何優勢？](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills 和自動化](#skills-and-automation)
  - [如何在不弄髒儲存庫的情況下自訂 Skills？](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [我可以從自訂檔案夾載入 Skills 嗎？](#can-i-load-skills-from-a-custom-folder)
  - [如何針對不同的任務使用不同的模型？](#how-can-i-use-different-models-for-different-tasks)
  - [智慧代理在執行繁重工作時凍結了。我該如何分擔？](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron 或提醒未觸發。我應該檢查什麼？](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [如何在 Linux 上安裝 Skills？](#how-do-i-install-skills-on-linux)
  - [OpenClaw 可以按排程或在背景持續執行任務嗎？](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [我可以在 Linux 上執行 Apple macOS 專用 Skills 嗎？](#can-i-run-apple-macos-only-skills-from-linux)
  - [您有 Notion 或 HeyGen 整合嗎？](#do-you-have-a-notion-or-heygen-integration)
  - [如何安裝 Chrome 擴充功能以進行瀏覽器接管？](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [沙箱隔離和記憶體](#sandboxing-and-memory)
  - [是否有專用的沙箱隔離文件？](#is-there-a-dedicated-sandboxing-doc)
  - [Docker 感覺很受限。如何啟用完整功能？](#docker-feels-limited-how-do-i-enable-full-features)
  - [我可以讓私訊保持個人化，但群組在沙箱隔離模式下與單一智慧代理公開嗎？](#can-i-keep-dms-personal-but-make-groups-public-sandboxed-with-one-agent)
  - [如何將主機檔案夾繫結到沙箱中？](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [記憶體是如何運作的？](#how-does-memory-work)
  - [記憶體一直忘記東西。我該如何讓它記住？](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [語義記憶體搜尋需要 OpenAI API 密鑰嗎？](#does-semantic-memory-search-require-an-openai-api-key)
  - [記憶體會永遠存在嗎？限制是什麼？](#does-memory-persist-forever-what-are-the-limits)
- [檔案在磁碟上的位置](#where-things-live-on-disk)
  - [OpenClaw 使用的所有資料都儲存在本機嗎？](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw 將其資料儲存在哪裡？](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md 應該放在哪裡？](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [建議的備份策略是什麼？](#whats-the-recommended-backup-strategy)
  - [如何完全解除安裝 OpenClaw？](#how-do-i-completely-uninstall-openclaw)
  - [智慧代理可以在工作區外運作嗎？](#can-agents-work-outside-the-workspace)
  - [我處於遠端模式——工作階段儲存區在哪裡？](#im-in-remote-mode-where-is-the-session-store)
- [設定基礎知識](#config-basics)
  - [設定的格式是什麼？它在哪裡？](#what-format-is-the-config-where-is-it)
  - [我設定了 `gateway.bind: "lan"`（或 `"tailnet"`），現在沒有任何東西在監聽 / UI 顯示未經授權](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [為什麼我現在在 localhost 上需要權杖？](#why-do-i-need-a-token-on-localhost-now)
  - [變更設定後我必須重新啟動嗎？](#do-i-have-to-restart-after-changing-config)
  - [如何啟用網路搜尋 (和網路擷取)？](#how-do-i-enable-web-search-and-web-fetch)
  - [`config.apply` 清除了我的設定。我該如何復原並避免這種情況？](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [如何執行中央 Gateway 並在不同裝置上執行專門的工作者？](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [OpenClaw 瀏覽器可以無頭模式執行嗎？](#can-the-openclaw-browser-run-headless)
  - [如何使用 Brave 進行瀏覽器控制？](#how-do-i-use-brave-for-browser-control)
- [遠端 Gateway 和節點](#remote-gateways-and-nodes)
  - [指令如何在 Telegram、Gateway 和節點之間傳播？](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [如果 Gateway 託管在遠端，我的智慧代理如何存取我的電腦？](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale 已連線但我沒有收到回覆。現在怎麼辦？](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [兩個 OpenClaw 實例可以互相通訊嗎 (本機 + VPS)？](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [我需要為多個智慧代理使用單獨的 VPS 嗎？](#do-i-need-separate-vpses-for-multiple-agents)
  - [在我的個人筆記型電腦上使用節點而不是從 VPS 進行 SSH 有什麼好處？](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [節點會執行 Gateway 服務嗎？](#do-nodes-run-a-gateway-service)
  - [是否有 API / RPC 方法來應用設定？](#is-there-an-api-rpc-way-to-apply-config)
  - [第一次安裝的最小「健全」設定是什麼？](#whats-a-minimal-sane-config-for-a-first-install)
  - [如何在 VPS 上設定 Tailscale 並從我的 Mac 連接？](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [如何將 Mac 節點連接到遠端 Gateway (Tailscale Serve)？](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [我應該在第二台筆記型電腦上安裝還是只新增一個節點？](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [環境變數和 .env 載入](#env-vars-and-env-loading)
  - [OpenClaw 如何載入環境變數？](#how-does-openclaw-load-environment-variables)
  - [我透過服務啟動了 Gateway，我的環境變數消失了。現在怎麼辦？](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [我設定了 `COPILOT_GITHUB_TOKEN`，但模型狀態顯示「Shell env: off」。為什麼？](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [工作階段和多重聊天](#sessions-and-multiple-chats)
  - [如何開始新的對話？](#how-do-i-start-a-fresh-conversation)
  - [如果我從不傳送 `/new`，工作階段會自動重置嗎？](#do-sessions-reset-automatically-if-i-never-send-new)
  - [有沒有辦法讓 OpenClaw 實例團隊成為一個 CEO 和許多智慧代理？](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [為什麼上下文在任務中途被截斷了？我該如何防止它？](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [如何完全重置 OpenClaw 但保持已安裝狀態？](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [我收到「上下文太大」的錯誤——我該如何重置或壓縮？](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [為什麼我看到「LLM request rejected: messages.N.content.X.tool_use.input: Field required」？](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [為什麼我每 30 分鐘收到一次心跳訊息？](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [我需要將「智慧代理帳戶」新增到 WhatsApp 群組嗎？](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [如何取得 WhatsApp 群組的 JID？](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [為什麼 OpenClaw 在群組中不回覆？](#why-doesnt-openclaw-reply-in-a-group)
  - [群組/主題與私訊共享上下文嗎？](#do-groupsthreads-share-context-with-dms)
  - [我可以建立多少個工作區和智慧代理？](#how-frequently-do-i-create-workspaces-and-agents)
  - [我可以在 Slack 上同時執行多個智慧代理或聊天嗎？我該如何設定？](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [模型：預設值、選擇、別名、切換](#models-defaults-selection-aliases-switching)
  - [什麼是「預設模型」？](#what-is-the-default-model)
  - [您推薦哪個模型？](#what-model-do-you-recommend)
  - [如何在不清除設定的情況下切換模型？](#how-do-i-switch-models-without-wiping-my-config)
  - [我可以使用自託管模型 (llama.cpp、vLLM、Ollama) 嗎？](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw、Flawd 和 Krill 使用什麼模型？](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [如何在不重新啟動的情況下即時切換模型？](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [如何解除固定我用 profile 設定的設定檔？](#how-do-i-unpin-a-profile-i-set-with-profile)
  - [我可以將 GPT 5.2 用於日常任務，將 Codex 5.3 用於編碼嗎？](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [為什麼我看到「Model … is not allowed」然後沒有回覆？](#why-am-i-seeing-model-is-not-allowed-and-then-no-reply)
  - [為什麼我看到「Unknown model: minimax/MiniMax-M2.1」？](#why-am-i-seeing-unknown-model-minimaxminimaxm21)
  - [我可以將 MiniMax 作為我的預設模型，將 OpenAI 用於複雜任務嗎？](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt 是內建快捷方式嗎？](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [如何定義/覆寫模型快捷方式 (別名)？](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [如何新增來自 OpenRouter 或 Z.AI 等其他供應商的模型？](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
  - [新增智慧代理後找不到供應商的 API 密鑰](#no-api-key-found-for-provider-after-adding-a-new-agent)
- [模型故障轉移和「所有模型都失敗了」](#model-failover-and-all-models-failed)
  - [故障轉移是如何運作的？](#how-does-failover-work)
  - [這個錯誤是什麼意思？](#what-does-this-error-mean)
  - [「No credentials found for profile "anthropic:default"」的修復清單](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [為什麼它也嘗試了 Google Gemini 並失敗了？](#why-did-it-also-try-google-gemini-and-fail)
  - [LLM request rejected 訊息思考簽名需要 google antigravity](#llm-request-rejected-message-thinking-signature-required-google-antigravity)
- [驗證設定檔：它們是什麼以及如何管理](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [什麼是驗證設定檔？](#what-is-an-auth-profile)
  - [典型的設定檔 ID 是什麼？](#what-are-typical-profile-ids)
  - [我可以控制哪個驗證設定檔先被嘗試嗎？](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth 與 API 密鑰：有什麼區別？](#oauth-vs-api-key-whats-the-difference)
- [Gateway：連接埠、「已在執行」和遠端模式](#gateway-ports-already-running-and-remote-mode)
  - [Gateway 使用哪個連接埠？](#what-port-does-the-gateway-use)
  - [為什麼 `openclaw gateway status` 顯示 `Runtime: running` 但 `RPC probe: failed`？](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [為什麼 `openclaw gateway status` 顯示 `Config (cli)` 和 `Config (service)` 不同？](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [「another gateway instance is already listening」是什麼意思？](#what-does-another-gateway-instance-is-already-listening-mean)
  - [如何以遠端模式執行 OpenClaw (用戶端連接到其他地方的 Gateway)？](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [控制 UI 顯示「unauthorized」（或持續重新連接）。現在怎麼辦？](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [我設定了 `gateway.bind: "tailnet"` 但無法繫結 / 沒有任何東西在監聽](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [我可以在同一主機上執行多個 Gateway 嗎？](#can-i-run-multiple-gateways-on-the-same-host)
  - [「invalid handshake」/ 代碼 1008 是什麼意思？](#what-does-invalid-handshake-code-1008-mean)
- [日誌記錄和偵錯](#logging-and-debugging)
  - [日誌在哪裡？](#where-are-logs)
  - [如何啟動/停止/重新啟動 Gateway 服務？](#how-do-i-startstoprestart-the-gateway-service)
  - [我關閉了 Windows 終端機——我該如何重新啟動 OpenClaw？](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway 已啟動但沒有收到回覆。我應該檢查什麼？](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [「Disconnected from gateway: no reason」——現在怎麼辦？](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands 失敗並出現網路錯誤。我應該檢查什麼？](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI 沒有輸出。我應該檢查什麼？](#tui-shows-no-output-what-should-i-check)
  - [如何完全停止然後啟動 Gateway？](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [當某些東西失敗時，最快獲得更多詳細資訊的方法是什麼？](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [媒體和附件](#media-and-attachments)
  - [我的 skill 生成了圖片/PDF，但沒有傳送](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [安全和存取控制](#security-and-access-control)
  - [將 OpenClaw 暴露給傳入私訊安全嗎？](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [提示注入只對公開智慧代理構成威脅嗎？](#is-prompt-injection-only-a-concern-for-public-bots)
  - [我的智慧代理應該有自己的電子郵件 GitHub 帳戶或電話號碼嗎？](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [我可以賦予它對我的簡訊的自主權嗎？這安全嗎？](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [我可以用更便宜的模型來執行個人助理任務嗎？](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [我在 Telegram 中執行 `/start` 但沒有收到配對碼](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp：它會傳送訊息給我的聯絡人嗎？配對是如何運作的？](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [聊天指令、中止任務和「它停不下來」](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [如何阻止內部系統訊息顯示在聊天中？](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [如何停止/取消正在執行的任務？](#how-do-i-stopcancel-a-running-task)
  - [如何從 Telegram 傳送 Discord 訊息？(「不允許跨上下文訊息」)](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [為什麼感覺智慧代理「忽略」了快速傳送的訊息？](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 如果出現問題，最初的六十秒

1. **快速狀態 (首次檢查)**

   ```bash
   openclaw status
   ```

   快速本機摘要：作業系統 + 更新、Gateway/服務可達性、智慧代理/工作階段、供應商設定 + 執行階段問題 (當 Gateway 可達時)。

2. **可貼上的報告 (可安全分享)**

   ```bash
   openclaw status --all
   ```

   唯讀診斷，帶日誌尾部 (權杖已遮蔽)。

3. **守護程式 + 連接埠狀態**

   ```bash
   openclaw gateway status
   ```

   顯示監管程式執行階段與 RPC 可達性、探測目標 URL，以及服務可能使用的設定。

4. **深度探測**

   ```bash
   openclaw status --deep
   ```

   執行 Gateway 健康檢查 + 供應商探測 (需要可達的 Gateway)。請參閱 [Health](/gateway/health)。

5. **追蹤最新日誌**

   ```bash
   openclaw logs --follow
   ```

   如果 RPC 關閉，則改用：

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   檔案日誌與服務日誌是分開的；請參閱 [Logging](/logging) 和 [Troubleshooting](/gateway/troubleshooting)。

6. **執行醫生 (修復)**

   ```bash
   openclaw doctor
   ```

   修復/遷移設定/狀態 + 執行健康檢查。請參閱 [Doctor](/gateway/doctor)。

7. **Gateway 快照**

   ```bash
   openclaw health --json
   openclaw health --verbose   # 錯誤時顯示目標 URL + 設定路徑
   ```

   要求正在執行的 Gateway 提供完整快照 (僅限 WS)。請參閱 [Health](/gateway/health)。

## 快速開始和首次執行設定

### 我遇到問題了，最快解決問題的方法是什麼？

使用可以**查看您的機器**的本機 AI 智慧代理。這比在 Discord 中詢問有效得多，因為大多數「我遇到問題了」的情況是**本機設定或環境問題**，遠端協助者無法檢查。

- **Claude Code**：[https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**：[https://openai.com/codex/](https://openai.com/codex/)

這些工具可以讀取儲存庫、執行指令、檢查日誌並協助修復您的機器層級設定 (PATH、服務、權限、驗證檔案)。透過可破解 (git) 安裝提供**完整原始碼檢出**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

這會從 **git 檢出** 安裝 OpenClaw，因此智慧代理可以讀取程式碼 + 文件並推斷您正在執行的確切版本。您可以隨時透過重新執行安裝程式而不使用 `--install-method git` 來切換回穩定版。

提示：要求智慧代理**規劃和監督**修復 (逐步)，然後只執行必要的指令。這可以保持變更小且更容易稽核。

如果您發現真正的錯誤或修復，請提交 GitHub 問題或傳送 PR：
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

從這些指令開始 (尋求協助時分享輸出)：

```bash
openclaw status
openclaw models status
openclaw doctor
```

它們的作用：

- `openclaw status`：Gateway/智慧代理健康狀況 + 基本設定的快速快照。
- `openclaw models status`：檢查供應商驗證 + 模型可用性。
- `openclaw doctor`：驗證和修復常見的設定/狀態問題。

其他有用的 CLI 檢查：`openclaw status --all`、`openclaw logs --follow`、
`openclaw gateway status`、`openclaw health --verbose`。

快速偵錯循環：[如果出現問題，最初的六十秒](#first-60-seconds-if-somethings-broken)。
安裝文件：[Install](/install)、[Installer flags](/install/installer)、[Updating](/install/updating)。

### 安裝和設定 OpenClaw 的建議方法是什麼？

儲存庫建議從原始碼執行並使用新手導覽精靈：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

精靈還可以自動建置 UI 資源。新手導覽後，您通常會在連接埠 **18789** 上執行 Gateway。

從原始碼 (貢獻者/開發人員)：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # 首次執行時自動安裝 UI 依賴項
openclaw onboard
```

如果您尚未全域安裝，請透過 `pnpm openclaw onboard` 執行。

### 新手導覽後如何開啟儀表板？

精靈會在新手導覽後立即開啟您的瀏覽器，並顯示一個乾淨 (未權杖化) 的儀表板 URL，也會在摘要中列印連結。保持該分頁開啟；如果沒有啟動，請複製/貼上在同一機器上列印的 URL。

### 如何在 localhost 與遠端驗證儀表板（權杖）？

**Localhost (同一機器)：**

- 開啟 `http://127.0.0.1:18789/`。
- 如果它要求驗證，請將 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`) 中的權杖貼到控制 UI 設定中。
- 從 Gateway 主機中檢索它：`openclaw config get gateway.auth.token` (或產生一個：`openclaw doctor --generate-gateway-token`)。

**不在 localhost 上：**

- **Tailscale Serve** (建議)：保持繫結回環，執行 `openclaw gateway --tailscale serve`，開啟 `https://<magicdns>/`。如果 `gateway.auth.allowTailscale` 為 `true`，則身分標頭滿足驗證 (無權杖)。
- **Tailnet 繫結**：執行 `openclaw gateway --bind tailnet --token "<token>"`，開啟 `http://<tailscale-ip>:18789/`，在儀表板設定中貼上權杖。
- **SSH 通道**：`ssh -N -L 18789:127.0.0.1:18789 user @host` 然後開啟 `http://127.0.0.1:18789/` 並將權杖貼到控制 UI 設定中。

請參閱 [Dashboard](/web/dashboard) 和 [Web surfaces](/web) 以了解繫結模式和驗證詳細資訊。

### 我需要什麼執行階段？

需要 Node **>= 22**。建議使用 `pnpm`。**不建議**將 Bun 用於 Gateway。

### 它可以在 Raspberry Pi 上執行嗎？

可以。Gateway 很輕巧——文件列出 **512MB-1GB RAM**、**1 個核心**和約 **500MB** 磁碟空間足以供個人使用，並指出 **Raspberry Pi 4 可以執行它**。

如果您需要額外的空間 (日誌、媒體、其他服務)，**建議使用 2GB**，但這不是硬性最低要求。

提示：小型 Pi/VPS 可以託管 Gateway，您可以將筆記型電腦/手機上的**節點**配對，以用於本機螢幕/相機/畫布或指令執行。請參閱 [Nodes](/nodes)。

### Raspberry Pi 安裝有什麼提示嗎？

簡短版本：它可以運作，但預期會有粗糙之處。

- 使用 **64 位元**作業系統並保持 Node >= 22。
- 優先選擇**可破解 (git) 安裝**，以便您可以快速查看日誌和更新。
- 從不帶頻道/Skills 開始，然後一個一個新增。
- 如果您遇到奇怪的二進位問題，通常是 **ARM 相容性**問題。

文件：[Linux](/platforms/linux)、[Install](/install)。

### 它卡在「喚醒我的朋友」/新手導覽無法開始。現在怎麼辦？

該畫面取決於 Gateway 是否可達並經過驗證。TUI 也會在首次開啟時自動傳送「喚醒，我的朋友！」。如果您看到該行但**沒有回覆**且權杖保持為 0，則表示智慧代理從未執行。

1. 重新啟動 Gateway：

```bash
openclaw gateway restart
```

2. 檢查狀態 + 驗證：

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. 如果仍然掛起，請執行：

```bash
openclaw doctor
```

如果 Gateway 是遠端的，請確保通道/Tailscale 連線已啟動且 UI 指向正確的 Gateway。請參閱 [Remote access](/gateway/remote)。

### 我可以在不重新進行新手導覽的情況下，將設定遷移到新機器 (Mac mini) 嗎？

可以。複製**狀態目錄**和**工作區**，然後執行 Doctor 一次。這可以讓您的智慧代理「完全相同」(記憶體、工作階段歷史記錄、驗證和頻道狀態)，只要您複製**兩個**位置：

1. 在新機器上安裝 OpenClaw。
2. 從舊機器複製 `$OPENCLAW_STATE_DIR` (預設值：`~/.openclaw`)。
3. 複製您的工作區 (預設值：`~/.openclaw/workspace`)。
4. 執行 `openclaw doctor` 並重新啟動 Gateway 服務。

這會保留設定、驗證設定檔、WhatsApp 憑證、工作階段和記憶體。如果您處於遠端模式，請記住 Gateway 主機擁有工作階段儲存區和工作區。

**重要**：如果您只將工作區提交/推送至 GitHub，您是在備份**記憶體 + 啟動檔案**，但**不包括**工作階段歷史記錄或驗證。這些儲存在 `~/.openclaw/` 下 (例如 `~/.openclaw/agents/<agentId>/sessions/`)。

相關：[Migrating](/install/migrating)、[檔案在磁碟上的位置](#where-does-openclaw-store-its-data)、
[Agent workspace](/concepts/agent-workspace)、[Doctor](/gateway/doctor)、
[Remote mode](/gateway/remote)。

### 在哪裡查看最新版本的新功能？

查看 GitHub 變更日誌：
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

最新條目位於頂部。如果頂部部分標記為 **Unreleased**，則下一個帶日期的部分是最新發布的版本。條目按**亮點**、**變更**和**修復** (以及需要時的 docs/其他部分) 分組。

### 我無法存取 docs.openclaw.ai (SSL 錯誤)。現在怎麼辦？

某些 Comcast/Xfinity 連線會透過 Xfinity 進階安全性錯誤地封鎖 `docs.openclaw.ai`。停用它或將 `docs.openclaw.ai` 加入白名單，然後重試。更多詳細資訊：[Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity)。請在此協助我們解除封鎖：[https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status)。

如果您仍然無法訪問該網站，文件已鏡像到 GitHub：
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 穩定版和 Beta 版有什麼區別？

**穩定版**和 **Beta 版**是 **npm dist-tags**，而不是獨立的程式碼行：

- `latest` = 穩定版
- `beta` = 用於測試的早期建置

我們將建置發佈到 **beta**，進行測試，一旦建置穩定，我們就會將**同一版本提升到 `latest`**。這就是為什麼 Beta 版和穩定版可以指向**同一版本**。

查看變更內容：
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 如何安裝 Beta 版，以及 Beta 版和開發版有什麼區別？

**Beta** 版是 npm dist-tag `beta` (可能與 `latest` 相符)。
**開發**版是 `main` (git) 的移動頭；發佈時，它使用 npm dist-tag `dev`。

單行指令 (macOS/Linux)：

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows 安裝程式 (PowerShell)：
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

更多詳細資訊：[Development channels](/install/development-channels) 和 [Installer flags](/install/installer)。

### 安裝和新手導覽通常需要多長時間？

大致指南：

- **安裝**：2-5 分鐘
- **新手導覽**：5-15 分鐘，取決於您設定的頻道/模型數量

如果掛起，請使用 [安裝程式卡住了](#installer-stuck-how-do-i-get-more-feedback)
和 [我遇到問題了](#im-stuck-whats-the-fastest-way-to-get-unstuck) 中的快速偵錯循環。

### 如何嘗試最新版本？

兩個選項：

1. **開發頻道 (git 檢出)：**

```bash
openclaw update --channel dev
```

這會切換到 `main` 分支並從原始碼更新。

2. **可破解安裝 (來自安裝程式網站)：**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

這會為您提供一個可以編輯的本機儲存庫，然後透過 git 更新。

如果您喜歡手動進行乾淨的複製，請使用：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

文件：[Update](/cli/update)、[Development channels](/install/development-channels)、
[Install](/install)。

### 安裝程式卡住了？如何獲得更多回饋？

重新執行安裝程式並輸出**詳細資訊**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

帶詳細資訊的 Beta 安裝：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

對於可破解 (git) 安裝：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Windows (PowerShell) 等效：

```powershell
# install.ps1 has no dedicated -Verbose flag yet.
Set-PSDebug -Trace 1
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
Set-PSDebug -Trace 0
```

更多選項：[Installer flags](/install/installer)。

### Windows 安裝說找不到 git 或無法識別 openclaw

兩個常見的 Windows 問題：

**1) npm 錯誤 spawn git / 找不到 git**

- 安裝 **Git for Windows** 並確保 `git` 在您的 PATH 中。
- 關閉並重新開啟 PowerShell，然後重新執行安裝程式。

**2) 安裝後無法識別 openclaw**

- 您的 npm 全域 bin 檔案夾不在 PATH 中。
- 檢查路徑：

  ```powershell
  npm config get prefix
  ```

- 確保 `<prefix>\\bin` 在 PATH 中 (在大多數系統上是 `%AppData%\\npm`)。
- 更新 PATH 後關閉並重新開啟 PowerShell。

如果您想要最流暢的 Windows 設定，請使用 **WSL2** 而不是原生 Windows。
文件：[Windows](/platforms/windows)。

### 文件沒有回答我的問題——如何獲得更好的答案？

使用**可破解 (git) 安裝**，這樣您就可以在本機擁有完整的原始碼和文件，然後**從該檔案夾**向您的智慧代理 (或 Claude/Codex) 提問，這樣它就可以讀取儲存庫並精確地回答。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

更多詳細資訊：[Install](/install) 和 [Installer flags](/install/installer)。

### 如何在 Linux 上安裝 OpenClaw？

簡短回答：遵循 Linux 指南，然後執行新手導覽精靈。

- Linux 快速路徑 + 服務安裝：[Linux](/platforms/linux)。
- 完整教學：[入門指南](/start/getting-started)。
- 安裝程式 + 更新：[Install & updates](/install/updating)。

### 如何在 VPS 上安裝 OpenClaw？

任何 Linux VPS 都可以。在伺服器上安裝，然後使用 SSH/Tailscale 連接 Gateway。

指南：[exe.dev](/install/exe-dev)、[Hetzner](/install/hetzner)、[Fly.io](/install/fly)。
遠端存取：[Gateway remote](/gateway/remote)。

### 雲端/VPS 安裝指南在哪裡？

我們維護一個包含常用供應商的**託管中心**。選擇一個並按照指南進行操作：

- [VPS hosting](/vps) (所有供應商集中在一處)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

在雲端中如何運作：**Gateway 在伺服器上執行**，您透過控制 UI (或 Tailscale/SSH) 從筆記型電腦/手機存取它。您的狀態 + 工作區儲存在伺服器上，因此將主機視為真相來源並進行備份。

您可以將筆記型電腦/手機上的**節點**(Mac/iOS/Android/無頭模式) 與該雲端 Gateway 配對，以存取本機螢幕/相機/畫布或在筆記型電腦上執行指令，同時將 Gateway 保留在雲端中。

中心：[Platforms](/platforms)。遠端存取：[Gateway remote](/gateway/remote)。
節點：[Nodes](/nodes)、[Nodes CLI](/cli/nodes)。

### 我可以要求 OpenClaw 自動更新嗎？

簡短回答：**可能，但不建議**。更新流程可能會重新啟動 Gateway (這會中斷活動工作階段)，可能需要乾淨的 git 檢出，並且可能會提示確認。更安全的方式：以操作員身分從 shell 執行更新。

使用 CLI：

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

如果您必須從智慧代理自動化：

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

文件：[Update](/cli/update)、[Updating](/install/updating)。

### 新手導覽精靈實際上做了什麼？

`openclaw onboard` 是建議的設定路徑。在**本機模式**下，它會引導您完成：

- **模型/驗證設定** (建議使用 Anthropic **setup-token** 進行 Claude 訂閱，支援 OpenAI Codex OAuth，API 密鑰可選，支援 LM Studio 本機模型)
- **工作區**位置 + 啟動檔案
- **Gateway 設定** (繫結/連接埠/驗證/tailscale)
- **供應商** (WhatsApp、Telegram、Discord、Mattermost (外掛程式)、Signal、iMessage)
- **守護程式安裝** (macOS 上的 LaunchAgent；Linux/WSL2 上的 systemd 使用者單元)
- **健康檢查**和 **Skills** 選擇

如果您的設定模型未知或缺少驗證，它也會發出警告。

### 我需要 Claude 或 OpenAI 訂閱才能執行此程式嗎？

不需要。您可以使用 **API 密鑰** (Anthropic/OpenAI/其他) 或**僅限本機的模型**來執行 OpenClaw，這樣您的資料就可以保留在您的裝置上。訂閱 (Claude Pro/Max 或 OpenAI Codex) 是驗證這些供應商的可選方式。

文件：[Anthropic](/providers/anthropic)、[OpenAI](/providers/openai)、
[Local models](/gateway/local-models)、[Models](/concepts/models)。

### 我可以在沒有 API 密鑰的情況下使用 Claude Max 訂閱嗎？

可以。您可以使用 **setup-token** 而不是 API 密鑰進行驗證。這是訂閱路徑。

Claude Pro/Max 訂閱**不包含 API 密鑰**，因此這是訂閱帳戶的正確方法。重要：您必須向 Anthropic 驗證此使用是否在其訂閱政策和條款下允許。如果您想要最明確、支援的路徑，請使用 Anthropic API 密鑰。

### Anthropic 的「setup-token」驗證是如何運作的？

`claude setup-token` 透過 Claude Code CLI 生成一個**權杖字串** (它在網路控制台中不可用)。您可以在**任何機器上**執行它。在精靈中選擇**Anthropic 權杖 (貼上 setup-token)** 或使用 `openclaw models auth paste-token --provider anthropic` 貼上它。該權杖作為 **anthropic** 供應商的驗證設定檔儲存，並像 API 密鑰一樣使用 (不會自動重新整理)。更多詳細資訊：[OAuth](/concepts/oauth)。

### 我在哪裡可以找到 Anthropic setup-token？

它**不**在 Anthropic Console 中。setup-token 由**任何機器上的 Claude Code CLI** 生成：

```bash
claude setup-token
```

複製它列印的權杖，然後在精靈中選擇**Anthropic 權杖 (貼上 setup-token)**。如果您想在 Gateway 主機上執行它，請使用 `openclaw models auth setup-token --provider anthropic`。如果您在其他地方執行 `claude setup-token`，請使用 `openclaw models auth paste-token --provider anthropic` 將其貼在 Gateway 主機上。請參閱 [Anthropic](/providers/anthropic)。

### 您支援 Claude 訂閱驗證 (Claude Pro 或 Max) 嗎？

是 - 透過 **setup-token**。OpenClaw 不再重複使用 Claude Code CLI OAuth 權杖；請使用 setup-token 或 Anthropic API 密鑰。在任何地方生成權杖並將其貼在 Gateway 主機上。請參閱 [Anthropic](/providers/anthropic) 和 [OAuth](/concepts/oauth)。

注意：Claude 訂閱存取受 Anthropic 條款約束。對於生產或多使用者工作負載，API 密鑰通常是更安全的選擇。

### 為什麼我看到 Anthropic 傳回 `HTTP 429: rate_limit_error`？

這表示您目前的視窗的 **Anthropic 配額/速率限制**已用盡。如果您使用 **Claude 訂閱** (setup-token 或 Claude Code OAuth)，請等待視窗重設或升級您的方案。如果您使用 **Anthropic API 密鑰**，請檢查 Anthropic Console 以了解使用情況/計費，並根據需要提高限制。

提示：設定**備援模型**，以便 OpenClaw 可以在供應商受到速率限制時繼續回覆。
請參閱 [Models](/cli/models) 和 [OAuth](/concepts/oauth)。

### 是否支援 AWS Bedrock？

是 - 透過 pi-ai 的 **Amazon Bedrock (Converse)** 供應商並附帶**手動設定**。您必須在 Gateway 主機上提供 AWS 憑證/區域，並在您的模型設定中新增 Bedrock 供應商條目。請參閱 [Amazon Bedrock](/providers/bedrock) 和 [Model providers](/providers/models)。如果您偏好受管理密鑰流程，則在 Bedrock 前面使用與 OpenAI 相容的代理仍然是一個有效的選擇。

### Codex 驗證是如何運作的？

OpenClaw 透過 OAuth (ChatGPT 登入) 支援 **OpenAI Code (Codex)**。精靈可以執行 OAuth 流程，並在適當時將預設模型設定為 `openai-codex/gpt-5.3-codex`。請參閱 [Model providers](/concepts/model-providers) 和 [Wizard](/start/wizard)。

### 您支援 OpenAI 訂閱驗證 (Codex OAuth) 嗎？

可以。OpenClaw 完全支援 **OpenAI Code (Codex) 訂閱 OAuth**。新手導覽精靈可以為您執行 OAuth 流程。

請參閱 [OAuth](/concepts/oauth)、[Model providers](/concepts/model-providers) 和 [Wizard](/start/wizard)。

### 如何設定 Gemini CLI OAuth？

Gemini CLI 使用**外掛程式驗證流程**，而不是 `openclaw.json` 中的用戶端 ID 或密鑰。

步驟：

1. 啟用外掛程式：`openclaw plugins enable google-gemini-cli-auth`
2. 登入：`openclaw models auth login --provider google-gemini-cli --set-default`

這會將 OAuth 權杖儲存在 Gateway 主機上的驗證設定檔中。詳細資訊：[Model providers](/concepts/model-providers)。

### 本機模型適合休閒聊天嗎？

通常不適合。OpenClaw 需要大上下文 + 強大的安全性；小卡片會截斷和洩漏。如果您必須使用，請在本機執行您可以執行的**最大** MiniMax M2.1 版本 (LM Studio)，並參閱 [/gateway/local-models](/gateway/local-models)。較小/量化的模型會增加提示注入的風險 - 請參閱 [Security](/gateway/security)。

### 如何將託管模型流量保持在特定區域？

選擇區域鎖定的端點。OpenRouter 為 MiniMax、Kimi 和 GLM 公開了美國託管選項；選擇美國託管版本以將資料保留在該區域。您仍然可以使用 `models.mode: "merge"` 將 Anthropic/OpenAI 與這些模型一起列出，這樣在您選擇的區域供應商可用時，備援仍然可用。

### 我必須購買 Mac Mini 才能安裝此程式嗎？

不需要。OpenClaw 在 macOS 或 Linux (透過 WSL2 的 Windows) 上執行。Mac mini 是可選的——有些人購買它作為永遠開啟的主機，但小型 VPS、家用伺服器或 Raspberry Pi 級別的裝置也可以運作。

您只需要 Mac **才能使用 macOS 專用工具**。對於 iMessage，請使用 [BlueBubbles](/channels/bluebubbles) (建議)——BlueBubbles 伺服器在任何 Mac 上執行，Gateway 可以在 Linux 或其他地方執行。如果您想要其他 macOS 專用工具，請在 Mac 上執行 Gateway 或配對 macOS 節點。

文件：[BlueBubbles](/channels/bluebubbles)、[Nodes](/nodes)、[Mac remote mode](/platforms/mac/remote)。

### 我需要 Mac mini 才能支援 iMessage 嗎？

您需要**某個已登入訊息的 macOS 裝置**。它**不**必是 Mac mini——任何 Mac 都可以。**使用 [BlueBubbles](/channels/bluebubbles)** (建議) 進行 iMessage——BlueBubbles 伺服器在 macOS 上執行，而 Gateway 可以在 Linux 或其他地方執行。

常見設定：

- 在 Linux/VPS 上執行 Gateway，並在任何已登入訊息的 Mac 上執行 BlueBubbles 伺服器。
- 如果您想要最簡單的單機設定，請在 Mac 上執行所有程式。

文件：[BlueBubbles](/channels/bluebubbles)、[Nodes](/nodes)、
[Mac remote mode](/platforms/mac/remote)。

### 如果我購買 Mac mini 來執行 OpenClaw，可以將它連接到我的 MacBook Pro 嗎？

可以。**Mac mini 可以執行 Gateway**，而您的 MacBook Pro 可以作為**節點** (配套裝置) 連接。節點不執行 Gateway——它們提供額外的功能，例如該裝置上的螢幕/相機/畫布和 `system.run`。

常見模式：

- Gateway 在 Mac mini 上 (永遠開啟)。
- MacBook Pro 執行 macOS 應用程式或節點主機並配對到 Gateway。
- 使用 `openclaw nodes status` / `openclaw nodes list` 查看它。

文件：[Nodes](/nodes)、[Nodes CLI](/cli/nodes)。

### 我可以使用 Bun 嗎？

**不建議使用** Bun。我們看到執行階段錯誤，尤其是在 WhatsApp 和 Telegram 上。
使用 **Node** 來維護穩定的 Gateway。

如果您仍然想嘗試使用 Bun，請在非生產 Gateway 上執行，不要使用 WhatsApp/Telegram。

### Telegram: `allowFrom` 中填寫什麼？

`channels.telegram.allowFrom` 是**人類傳送者的 Telegram 使用者 ID** (數字，建議) 或 `@username`。它不是智慧代理使用者名稱。

更安全 (沒有第三方智慧代理)：

- 私訊您的智慧代理，然後執行 `openclaw logs --follow` 並讀取 `from.id`。

官方 Bot API：

- 私訊您的智慧代理，然後呼叫 `https://api.telegram.org/bot<bot_token>/getUpdates` 並讀取 `message.from.id`。

第三方 (隱私較低)：

- 私訊 `@userinfobot` 或 `@getidsbot`。

請參閱 [/channels/telegram](/channels/telegram#access-control-dms--groups)。

### 多個人可以使用一個 WhatsApp 號碼與不同的 OpenClaw 實例嗎？

可以，透過**多智慧代理路由**。將每個傳送者的 WhatsApp **私訊** (對等 `kind: "direct"`，傳送者 E.164，例如 `+15551234567`) 繫結到不同的 `agentId`，這樣每個人都可以擁有自己的工作區和工作階段儲存區。回覆仍然來自**同一個 WhatsApp 帳戶**，並且私訊存取控制 (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) 對每個 WhatsApp 帳戶都是全域的。請參閱 [Multi-Agent Routing](/concepts/multi-agent) 和 [WhatsApp](/channels/whatsapp)。

### 我可以執行一個「快速聊天」智慧代理和一個「用於編碼的 Opus」智慧代理嗎？

可以。使用多智慧代理路由：為每個智慧代理設定自己的預設模型，然後將傳入路由 (供應商帳戶或特定對等) 繫結到每個智慧代理。範例設定位於 [Multi-Agent Routing](/concepts/multi-agent)。另請參閱 [Models](/concepts/models) 和 [Configuration](/gateway/configuration)。

### Homebrew 在 Linux 上能運作嗎？

可以。Homebrew 支援 Linux (Linuxbrew)。快速設定：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

如果您透過 systemd 執行 OpenClaw，請確保服務 PATH 包含 `/home/linuxbrew/.linuxbrew/bin` (或您的 brew 前綴)，這樣 `brew` 安裝的工具才能在非登入 shell 中解析。
最近的版本也會在 Linux systemd 服務上預置常見的使用者 bin 目錄 (例如 `~/.local/bin`、`~/.npm-global/bin`、`~/.local/share/pnpm`、`~/.bun/bin`)，並在設定時遵守 `PNPM_HOME`、`NPM_CONFIG_PREFIX`、`BUN_INSTALL`、`VOLTA_HOME`、`ASDF_DATA_DIR`、`NVM_DIR` 和 `FNM_DIR`。

### 可破解 (git) 安裝與 npm 安裝有什麼區別？

- **可破解 (git) 安裝**：完整的原始碼檢出，可編輯，最適合貢獻者。
  您可以在本機執行建置並修補程式碼/文件。
- **npm 安裝**：全域 CLI 安裝，沒有儲存庫，最適合「 just run it」。
  更新來自 npm dist-tags。

文件：[入門指南](/start/getting-started)、[Updating](/install/updating)。

### 稍後我可以切換 npm 和 git 安裝嗎？

可以。安裝其他類型，然後執行 Doctor，使 Gateway 服務指向新的進入點。
這**不會刪除您的資料**——它只會變更 OpenClaw 程式碼安裝。您的狀態
(`~/.openclaw`) 和工作區 (`~/.openclaw/workspace`) 保持不變。

從 npm → git：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

從 git → npm：

```bash
npm install -g openclaw @skills/stock-analysis/cache/hot_scan_latest.json
openclaw doctor
openclaw gateway restart
```

Doctor 會偵測到 Gateway 服務進入點不符，並提供重寫服務設定以符合目前安裝 (在自動化中使用 `--repair`)。

備份提示：請參閱 [Backup strategy](/help/faq#whats-the-recommended-backup-strategy)。

### 我應該在筆記型電腦還是 VPS 上執行 Gateway？

簡短回答：**如果您想要 24/7 的可靠性，請使用 VPS**。如果您想要最低限度的麻煩，並且可以接受休眠/重新啟動，請在本機執行。

**筆記型電腦 (本機 Gateway)**

- **優點**：無需伺服器費用，直接存取本機檔案，即時瀏覽器視窗。
- **缺點**：休眠/網路中斷 = 斷線，作業系統更新/重新啟動會中斷，必須保持清醒。

**VPS / 雲端**

- **優點**：永遠開啟，網路穩定，沒有筆記型電腦休眠問題，更容易保持執行。
- **缺點**：通常以無頭模式執行 (使用螢幕截圖)，只能遠端存取檔案，您必須透過 SSH 進行更新。

**OpenClaw 特定說明**：WhatsApp/Telegram/Slack/Mattermost (外掛程式)/Discord 都可以從 VPS 正常運作。唯一真正的權衡是**無頭瀏覽器**與可見視窗。請參閱 [Browser](/tools/browser)。

**建議的預設值**：如果您之前遇到 Gateway 斷線問題，請使用 VPS。當您積極使用 Mac 並想要本機檔案存取或使用可見瀏覽器進行 UI 自動化時，本機非常棒。

### 在專用機器上執行 OpenClaw 有多重要？

不要求，但**建議用於可靠性和隔離**。

- **專用主機 (VPS/Mac mini/Pi)**：永遠開啟，較少的休眠/重新啟動中斷，更清晰的權限，更容易保持執行。
- **共用筆記型電腦/桌機**：非常適合測試和主動使用，但當機器休眠或更新時，預期會暫停。

如果您想要兩全其美，請將 Gateway 保留在專用主機上，並將您的筆記型電腦配對為**節點**，以用於本機螢幕/相機/執行工具。請參閱 [Nodes](/nodes)。
有關安全指南，請閱讀 [Security](/gateway/security)。

### 最低 VPS 需求和建議的作業系統是什麼？

OpenClaw 很輕巧。對於基本的 Gateway + 一個聊天頻道：

- **絕對最低**：1 vCPU，1GB RAM，約 500MB 磁碟。
- **建議**：1-2 vCPU，2GB RAM 或更多以用於餘裕 (日誌、媒體、多個頻道)。Node 工具和瀏覽器自動化可能會耗費資源。

作業系統：使用 **Ubuntu LTS** (或任何現代 Debian/Ubuntu)。Linux 安裝路徑在那裡經過最佳測試。

文件：[Linux](/platforms/linux)、[VPS hosting](/vps)。

### 我可以在 VM 中執行 OpenClaw 嗎？需求是什麼？

可以。將 VM 視為 VPS：它需要永遠開啟、可達，並為 Gateway 和您啟用的任何頻道提供足夠的 RAM。

基準指南：

- **絕對最低**：1 vCPU，1GB RAM。
- **建議**：如果您執行多個頻道、瀏覽器自動化或媒體工具，則為 2GB RAM 或更多。
- **作業系統**：Ubuntu LTS 或另一個現代 Debian/Ubuntu。

如果您使用 Windows，**WSL2 是最簡單的 VM 風格設定**，並且具有最佳的工具相容性。請參閱 [Windows](/platforms/windows)、[VPS hosting](/vps)。
如果您在 VM 中執行 macOS，請參閱 [macOS VM](/install/macos-vm)。

## 什麼是 OpenClaw？

### 什麼是 OpenClaw (一段話說明)？

OpenClaw 是一個您在自己的裝置上執行的個人 AI 助理。它會在您已經使用的訊息平台 (WhatsApp、Telegram、Slack、Mattermost (外掛程式)、Discord、Google Chat、Signal、iMessage、WebChat) 上回覆，並且還可以在支援的平台上執行語音 + 即時畫布。**Gateway** 是永遠開啟的控制平面；助理是產品。

### 價值主張是什麼？

OpenClaw 不僅僅是「一個 Claude 包裝器」。它是一個**本機優先的控制平面**，讓您可以在**自己的硬體上**執行一個功能強大的助理，透過您已經使用的聊天應用程式存取，具有有狀態的工作階段、記憶體和工具——而無需將您的工作流程控制權交給託管的 SaaS。

亮點：

- **您的裝置，您的資料**：在您想要的任何地方 (Mac、Linux、VPS) 執行 Gateway，並將工作區 + 工作階段歷史記錄保留在本機。
- **真實頻道，而不是網路沙箱**：WhatsApp/Telegram/Slack/Discord/Signal/iMessage 等，以及支援平台上的行動語音和畫布。
- **模型無關**：使用 Anthropic、OpenAI、MiniMax、OpenRouter 等，並具有每個智慧代理的路由和故障轉移。
- **僅限本機選項**：執行本機模型，以便如果您想要，**所有資料都可以保留在您的裝置上**。
- **多智慧代理路由**：每個頻道、帳戶或任務的獨立智慧代理，每個智慧代理都有自己的工作區和預設值。
- **開源和可破解**：無需供應商鎖定即可檢查、擴展和自託管。

文件：[Gateway](/gateway)、[Channels](/channels)、[Multi-agent](/concepts/multi-agent)、
[Memory](/concepts/memory)。

### 我剛設定好，我應該先做什麼？

很好的第一個專案：

- 建置一個網站 (WordPress、Shopify 或簡單的靜態網站)。
- 製作行動應用程式原型 (大綱、畫面、API 規劃)。
- 組織檔案和檔案夾 (清理、命名、標記)。
- 連接 Gmail 並自動化摘要或追蹤。

它可以處理大型任務，但當您將它們分成階段並使用子智慧代理進行平行工作時，效果最佳。

### OpenClaw 的五大日常使用案例是什麼？

日常勝利通常是這樣的：

- **個人簡報**：收件匣、行事曆和您關心的新聞摘要。
- **研究和草擬**：快速研究、摘要以及電子郵件或文件的初稿。
- **提醒和追蹤**：由 cron 或心跳驅動的提醒和檢查清單。
- **瀏覽器自動化**：填寫表單、收集資料和重複網路任務。
- **跨裝置協調**：從手機傳送任務，讓 Gateway 在伺服器上執行，並在聊天中取回結果。

### OpenClaw 可以協助 SaaS 的潛在客戶開發、外展廣告和部落格嗎？

是，用於**研究、資格審查和草擬**。它可以掃描網站、建立候選名單、摘要潛在客戶，並撰寫外展或廣告文案草稿。

對於**外展或廣告活動**，請保持人工參與。避免垃圾郵件，遵循當地法律和平台政策，並在傳送前審查任何內容。最安全的模式是讓 OpenClaw 草擬，然後您批准。

文件：[Security](/gateway/security)。

### 與用於 Web 開發的 Claude Code 相比，有何優勢？

OpenClaw 是一個**個人助理**和協調層，而不是 IDE 替代品。在儲存庫內部使用 Claude Code 或 Codex 進行最快的直接編碼循環。當您想要持久記憶體、跨裝置存取和工具編排時，請使用 OpenClaw。

優勢：

- **跨工作階段的持久記憶體 + 工作區**
- **多平台存取** (WhatsApp、Telegram、TUI、WebChat)
- **工具編排** (瀏覽器、檔案、排程、掛鉤)
- **永遠開啟的 Gateway** (在 VPS 上執行，從任何地方互動)
- **節點** 用於本機瀏覽器/螢幕/相機/執行

展示：[https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Skills 和自動化

### 如何在不弄髒儲存庫的情況下自訂 Skills？

使用受管理的覆寫，而不是編輯儲存庫副本。將您的變更放在 `~/.openclaw/skills/<name>/SKILL.md` 中 (或透過 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 新增檔案夾)。優先順序是 `<workspace>/skills` > `~/.openclaw/skills` > 綑綁，因此受管理的覆寫會贏，而無需觸摸 git。只有值得上游的編輯才應該保留在儲存庫中並作為 PR 發出。

### 我可以從自訂檔案夾載入 Skills 嗎？

可以。透過 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 新增額外目錄 (優先順序最低)。預設優先順序仍為：`<workspace>/skills` → `~/.openclaw/skills` → 綑綁 → `skills.load.extraDirs`。`clawhub` 預設安裝到 `./skills`，OpenClaw 會將其視為 `<workspace>/skills`。

### 如何針對不同的任務使用不同的模型？

目前支援的模式是：

- **Cron 工作**：獨立的工作可以為每個工作設定一個 `model` 覆寫。
- **子智慧代理**：將任務路由到具有不同預設模型的分離智慧代理。
- **隨需切換**：隨時使用 `/model` 切換當前工作階段模型。

請參閱 [Cron jobs](/automation/cron-jobs)、[Multi-Agent Routing](/concepts/multi-agent) 和 [Slash commands](/tools/slash-commands)。

### 智慧代理在執行繁重工作時凍結了。我該如何分擔？

對於長時間或平行任務，請使用**子智慧代理**。子智慧代理會在自己的工作階段中執行，
傳回摘要，並保持您的主要聊天回應。

要求您的智慧代理「為此任務生成一個子智慧代理」或使用 `/subagents`。
在聊天中使用 `/status` 查看 Gateway 當前正在做什麼 (以及它是否忙碌)。

權杖提示：長時間任務和子智慧代理都會消耗權杖。如果成本是個問題，請為子智慧代理設定
更便宜的模型，透過 `agents.defaults.subagents.model`。

文件：[Sub-agents](/tools/subagents)。

### Cron 或提醒未觸發。我應該檢查什麼？

Cron 在 Gateway 程序內部執行。如果 Gateway 未持續執行，則排程的工作將不會執行。

檢查清單：

- 確認 cron 已啟用 (`cron.enabled`) 且未設定 `OPENCLAW_SKIP_CRON`。
- 檢查 Gateway 是否 24/7 執行 (無休眠/重新啟動)。
- 驗證工作的時區設定 (`--tz` 與主機時區)。

偵錯：

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

文件：[Cron jobs](/automation/cron-jobs)、[Cron vs Heartbeat](/automation/cron-vs-heartbeat)。

### 如何在 Linux 上安裝 Skills？

使用 **ClawHub** (CLI) 或將 Skills 放入您的工作區。macOS Skills UI 在 Linux 上不可用。
在 [https://clawhub.com](https://clawhub.com) 瀏覽 Skills。

安裝 ClawHub CLI (選擇一個套件管理員)：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw 可以按排程或在背景持續執行任務嗎？

可以。使用 Gateway 排程器：

- **Cron 工作** 用於排程或重複任務 (跨重新啟動保留)。
- **心跳** 用於「主要工作階段」定期檢查。
- **獨立工作** 用於發佈摘要或傳送至聊天的自主智慧代理。

文件：[Cron jobs](/automation/cron-jobs)、[Cron vs Heartbeat](/automation/cron-vs-heartbeat)、
[Heartbeat](/gateway/heartbeat)。

### 我可以在 Linux 上執行 Apple macOS 專用 Skills 嗎？

無法直接執行。macOS Skills 受 `metadata.openclaw.os` 和所需二進位檔案的限制，並且 Skills 只有在 **Gateway 主機**上符合資格時才會出現在系統提示中。在 Linux 上，`darwin` 專用 Skills (例如 `apple-notes`、`apple-reminders`、`things-mac`) 將不會載入，除非您覆寫門控。

您有三種支援的模式：

**選項 A - 在 Mac 上執行 Gateway (最簡單)。**
在存在 macOS 二進位檔案的地方執行 Gateway，然後在 [遠端模式](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) 或透過 Tailscale 從 Linux 連接。Skills 會正常載入，因為 Gateway 主機是 macOS。

**選項 B - 使用 macOS 節點 (無需 SSH)。**
在 Linux 上執行 Gateway，配對 macOS 節點 (選單列應用程式)，並在 Mac 上將**節點執行指令**設定為「始終詢問」或「始終允許」。當節點上存在所需二進位檔案時，OpenClaw 可以將 macOS 專用 Skills 視為符合資格。智慧代理會透過 `nodes` 工具執行這些 Skills。如果您選擇「始終詢問」，在提示中批准「始終允許」會將該指令新增到允許清單。

**選項 C - 透過 SSH 代理 macOS 二進位檔案 (進階)。**
將 Gateway 保留在 Linux 上，但使所需 CLI 二進位檔案解析為在 Mac 上執行的 SSH 包裝器。然後覆寫 skill 以允許 Linux，使其保持符合資格。

1. 為二進位檔案建立 SSH 包裝器 (範例：Apple Notes 的 `memo`)：

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user @mac-host /opt/homebrew/bin/memo "$ @"
   ```

2. 將包裝器放在 Linux 主機上的 `PATH` 中 (例如 `~/bin/memo`)。
3. 覆寫 skill 中繼資料 (工作區或 `~/.openclaw/skills`) 以允許 Linux：

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. 啟動新工作階段以重新整理 Skills 快照。

### 您有 Notion 或 HeyGen 整合嗎？

目前沒有內建。

選項：

- **自訂 Skill / 外掛程式**：最適合可靠的 API 存取 (Notion/HeyGen 都有 API)。
- **瀏覽器自動化**：無需程式碼即可運作，但速度較慢且較脆弱。

如果您想為每個客戶 (代理工作流程) 保留上下文，一個簡單的模式是：

- 每個客戶一個 Notion 頁面 (上下文 + 偏好設定 + 活動工作)。
- 在工作階段開始時要求智慧代理擷取該頁面。

如果您想要原生整合，請提出功能請求或建置針對這些 API 的 Skill。

安裝 Skills：

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub 會將 Skills 安裝到您目前目錄下的 `./skills` 中 (或退回您設定的 OpenClaw 工作區)；OpenClaw 會在下一個工作階段將其視為 `<workspace>/skills`。對於跨智慧代理共用的 Skills，請將它們放在 `~/.openclaw/skills/<name>/SKILL.md` 中。某些 Skills 需要透過 Homebrew 安裝的二進位檔案；在 Linux 上，這意味著 Linuxbrew (請參閱上面 Homebrew Linux 常見問題條目)。請參閱 [Skills](/tools/skills) 和 [ClawHub](/tools/clawhub)。

### 如何安裝 Chrome 擴充功能以進行瀏覽器接管？

使用內建安裝程式，然後在 Chrome 中載入未打包的擴充功能：

```bash
openclaw browser extension install
openclaw browser extension path
```

然後 Chrome → `chrome://extensions` → 啟用「開發人員模式」→「載入未打包擴充功能」→ 選擇該檔案夾。

完整指南 (包括遠端 Gateway + 安全注意事項)：[Chrome extension](/tools/chrome-extension)

如果 Gateway 在與 Chrome 相同的機器上執行 (預設設定)，您通常**不需要**任何額外設定。
如果 Gateway 在其他地方執行，請在瀏覽器機器上執行節點主機，以便 Gateway 可以代理瀏覽器操作。
您仍然需要點擊要控制的分頁上的擴充功能按鈕 (它不會自動附加)。

## 沙箱隔離和記憶體

### 是否有專用的沙箱隔離文件？

是。請參閱 [Sandboxing](/gateway/sandboxing)。有關 Docker 特定設定 (Docker 中的完整 Gateway 或沙箱映像)，請參閱 [Docker](/install/docker)。

### Docker 感覺很受限。如何啟用完整功能？

預設映像是安全性優先的，並以 `node` 使用者身分執行，因此它不包含系統套件、Homebrew 或綑綁的瀏覽器。為了獲得更完整的設定：

- 使用 `OPENCLAW_HOME_VOLUME` 持續化 `/home/node`，以便快取存活。
- 使用 `OPENCLAW_DOCKER_APT_PACKAGES` 將系統依賴項烘焙到映像中。
- 透過綑綁的 CLI 安裝 Playwright 瀏覽器：
  `node /app/node_modules/playwright-core/cli.js install chromium`
- 設定 `PLAYWRIGHT_BROWSERS_PATH` 並確保路徑持續化。

文件：[Docker](/install/docker)、[Browser](/tools/browser)。

### 我可以讓私訊保持個人化，但群組在沙箱隔離模式下與單一智慧代理公開嗎？

可以——如果您的私人流量是**私訊**，而您的公共流量是**群組**。

使用 `agents.defaults.sandbox.mode: "non-main"`，這樣群組/頻道工作階段 (非主要密鑰) 在 Docker 中執行，而主要私訊工作階段則保留在主機上。然後透過 `tools.sandbox.tools` 限制沙箱隔離工作階段中可用的工具。

設定教學 + 範例設定：[Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

主要設定參考：[Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### 如何將主機檔案夾繫結到沙箱中？

將 `agents.defaults.sandbox.docker.binds` 設定為 `["host:path:mode"]` (例如 `"/home/user/src:/src:ro"`)。全域 + 每個智慧代理的繫結會合併；當 `scope: "shared"` 時，每個智慧代理的繫結會被忽略。對於任何敏感內容使用 `:ro`，並記住繫結會繞過沙箱檔案系統壁壘。請參閱 [Sandboxing](/gateway/sandboxing#custom-bind-mounts) 和 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) 以取得範例和安全注意事項。

### 記憶體是如何運作的？

OpenClaw 記憶體只是智慧代理工作區中的 Markdown 檔案：

- `memory/YYYY-MM-DD.md` 中的每日筆記
- `MEMORY.md` 中的策劃長期筆記 (僅限主要/私人工作階段)

OpenClaw 還會執行**無聲的預壓縮記憶體刷新**，以提醒模型在自動壓縮之前寫入持久筆記。這只有在工作區可寫入時才會執行 (唯讀沙箱會跳過它)。請參閱 [Memory](/concepts/memory)。

### 記憶體一直忘記東西。我該如何讓它記住？

要求智慧代理**將事實寫入記憶體**。長期筆記屬於 `MEMORY.md`，短期上下文則進入 `memory/YYYY-MM-DD.md`。

這仍然是我們正在改進的領域。提醒模型儲存記憶體會有所幫助；它會知道該怎麼做。如果它一直忘記，請驗證 Gateway 在每次執行時都使用相同的工作區。

文件：[Memory](/concepts/memory)、[Agent workspace](/concepts/agent-workspace)。

### 語義記憶體搜尋需要 OpenAI API 密鑰嗎？

僅當您使用 **OpenAI 嵌入**時。Codex OAuth 涵蓋聊天/完成，且**不**授予嵌入存取權，因此**使用 Codex 登入 (OAuth 或 Codex CLI 登入)** 對於語義記憶體搜尋沒有幫助。OpenAI 嵌入仍然需要真正的 API 密鑰 (`OPENAI_API_KEY` 或 `models.providers.openai.apiKey`)。

如果您未明確設定供應商，OpenClaw 會在可以解析 API 密鑰時自動選擇供應商 (驗證設定檔、`models.providers.*.apiKey` 或環境變數)。如果 OpenAI 密鑰解析成功，它會優先選擇 OpenAI；否則，如果 Gemini 密鑰解析成功，則選擇 Gemini。如果這兩個密鑰都不可用，則記憶體搜尋會保持停用狀態，直到您設定為止。如果您已設定並存在本機模型路徑，OpenClaw 會優先選擇 `local`。

如果您寧願保持本機，請設定 `memorySearch.provider = "local"` (可選地 `memorySearch.fallback = "none"`)。如果您想要 Gemini 嵌入，請設定 `memorySearch.provider = "gemini"` 並提供 `GEMINI_API_KEY` (或 `memorySearch.remote.apiKey`)。我們支援 **OpenAI、Gemini 或本機**嵌入模型——請參閱 [Memory](/concepts/memory) 以了解設定詳細資訊。

### 記憶體會永遠存在嗎？限制是什麼？

記憶體檔案存在於磁碟上，並在您刪除它們之前持續存在。限制是您的儲存空間，而不是模型。**工作階段上下文**仍然受模型上下文視窗的限制，因此長時間對話可能會壓縮或截斷。這就是為什麼存在記憶體搜尋——它只將相關部分拉回上下文。

文件：[Memory](/concepts/memory)、[Context](/concepts/context)。

## 檔案在磁碟上的位置

### OpenClaw 使用的所有資料都儲存在本機嗎？

否 - **OpenClaw 的狀態是本機的**，但**外部服務仍會看到您傳送給它們的內容**。

- **預設為本機**：工作階段、記憶體檔案、設定和工作區儲存在 Gateway 主機上
  (`~/.openclaw` + 您的工作區目錄)。
- **必要時遠端**：您傳送給模型供應商 (Anthropic/OpenAI 等) 的訊息會傳送到
  他們的 API，聊天平台 (WhatsApp/Telegram/Slack 等) 會將訊息資料儲存在
  他們的伺服器上。
- **您控制足跡**：使用本機模型會將提示保留在您的機器上，但頻道
  流量仍會透過頻道的伺服器。

相關：[Agent workspace](/concepts/agent-workspace)、[Memory](/concepts/memory)。

### OpenClaw 將其資料儲存在哪裡？

所有內容都位於 `$OPENCLAW_STATE_DIR` 下 (預設值：`~/.openclaw`)：

| 路徑                                                            | 用途                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | 主要設定 (JSON5)                                          |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | 舊版 OAuth 匯入 (首次使用時複製到驗證設定檔中) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 驗證設定檔 (OAuth + API 密鑰)                             |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | 執行階段驗證快取 (自動管理)                   |
| `$OPENCLAW_STATE_DIR/credentials/`                              | 供應商狀態 (例如 `whatsapp/<accountId>/creds.json`)      |
| `$OPENCLAW_STATE_DIR/agents/`                                   | 每個智慧代理的狀態 (agentDir + 工作階段)                     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | 對話歷史記錄和狀態 (每個智慧代理)                     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | 工作階段中繼資料 (每個智慧代理)                                 |

舊版單一智慧代理路徑：`~/.openclaw/agent/*` (由 `openclaw doctor` 遷移)。

您的**工作區** (AGENTS.md、記憶體檔案、Skills 等) 是獨立的，並透過 `agents.defaults.workspace` 設定 (預設值：`~/.openclaw/workspace`)。

### AGENTS.md / SOUL.md / USER.md / MEMORY.md 應該放在哪裡？

這些檔案位於**智慧代理工作區**中，而不是 `~/.openclaw`。

- **工作區 (每個智慧代理)**：`AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、
  `MEMORY.md` (或 `memory.md`)、`memory/YYYY-MM-DD.md`、可選的 `HEARTBEAT.md`。
- **狀態目錄 (`~/.openclaw`)**：設定、憑證、驗證設定檔、工作階段、日誌、
  和共用 Skills (`~/.openclaw/skills`)。

預設工作區為 `~/.openclaw/workspace`，可透過以下方式設定：

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

如果智慧代理在重新啟動後「忘記」了，請確認 Gateway 在每次啟動時都使用相同的工作區
(並記住：遠端模式使用**Gateway 主機的**工作區，而不是您本機筆記型電腦的)。

提示：如果您想要持久的行為或偏好，請要求智慧代理**將其寫入
AGENTS.md 或 MEMORY.md**，而不是依賴聊天歷史記錄。

請參閱 [Agent workspace](/concepts/agent-workspace) 和 [Memory](/concepts/memory)。

### 建議的備份策略是什麼？

將您的**智慧代理工作區**放在**私人**git 儲存庫中，並將其備份到私人位置
(例如 GitHub 私人儲存庫)。這會擷取記憶體 + AGENTS/SOUL/USER
檔案，並讓您稍後還原助理的「心智」。

**不要**提交 `~/.openclaw` 下的任何內容 (憑證、工作階段、權杖)。
如果您需要完全還原，請分別備份工作區和狀態目錄
(請參閱上面的遷移問題)。

文件：[Agent workspace](/concepts/agent-workspace)。

### 如何完全解除安裝 OpenClaw？

請參閱專用指南：[Uninstall](/install/uninstall)。

### 智慧代理可以在工作區外運作嗎？

可以。工作區是**預設 cwd** 和記憶體錨點，而不是硬性沙箱。
相對路徑在工作區內解析，但除非啟用沙箱隔離，否則絕對路徑可以存取其他主機位置。如果您需要隔離，請使用
[`agents.defaults.sandbox`](/gateway/sandboxing) 或每個智慧代理的沙箱設定。如果您
想要將儲存庫作為預設工作目錄，請將該智慧代理的
`workspace` 指向儲存庫根目錄。OpenClaw 儲存庫只是原始碼；請將
工作區分開，除非您有意讓智慧代理在其中工作。

範例 (儲存庫作為預設 cwd)：

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### 我處於遠端模式——工作階段儲存區在哪裡？

工作階段狀態由**Gateway 主機**擁有。如果您處於遠端模式，您關心的工作階段儲存區位於遠端機器上，而不是您的本機筆記型電腦。請參閱 [Session management](/concepts/session)。

## 設定基礎知識

### 設定的格式是什麼？它在哪裡？

OpenClaw 從 `$OPENCLAW_CONFIG_PATH` (預設值：`~/.openclaw/openclaw.json`) 讀取可選的 **JSON5** 設定：

```
$OPENCLAW_CONFIG_PATH
```

如果檔案遺失，它會使用相對安全的預設值 (包括 `~/.openclaw/workspace` 的預設工作區)。

### 我設定了 `gateway.bind: "lan"`（或 `"tailnet"`），現在沒有任何東西在監聽 / UI 顯示未經授權

非回環繫結**需要驗證**。設定 `gateway.auth.mode` + `gateway.auth.token` (或使用 `OPENCLAW_GATEWAY_TOKEN`)。

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

注意事項：

- `gateway.remote.token` 僅用於**遠端 CLI 呼叫**；它不會啟用本機 Gateway 驗證。
- 控制 UI 透過 `connect.params.auth.token` (儲存在應用程式/UI 設定中) 進行驗證。避免將權杖放在 URL 中。

### 為什麼我現在在 localhost 上需要權杖？

精靈預設會生成一個 Gateway 權杖 (即使在回環上)，因此**本機 WS 用戶端必須進行驗證**。這會阻止其他本機進程呼叫 Gateway。將權杖貼到控制 UI 設定 (或您的用戶端設定) 中以進行連接。

如果您**真的**想要開放回環，請從您的設定中移除 `gateway.auth`。Doctor 可以隨時為您生成權杖：`openclaw doctor --generate-gateway-token`。

### 變更設定後我必須重新啟動嗎？

Gateway 會監控設定並支援熱重載：

- `gateway.reload.mode: "hybrid"` (預設)：熱應用安全變更，對於關鍵變更重新啟動
- 也支援 `hot`、`restart`、`off`

### 如何啟用網路搜尋 (和網路擷取)？

`web_fetch` 無需 API 密鑰即可運作。`web_search` 需要 Brave Search API 密鑰。**建議**：執行 `openclaw configure --section web` 將其儲存在
`tools.web.search.apiKey` 中。環境替代方案：為 Gateway 進程設定 `BRAVE_API_KEY`。

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

注意事項：

- 如果您使用允許清單，請新增 `web_search`/`web_fetch` 或 `group:web`。
- `web_fetch` 預設為啟用 (除非明確停用)。
- 守護程式從 `~/.openclaw/.env` (或服務環境) 讀取環境變數。

文件：[Web tools](/tools/web)。

### `config.apply` 清除了我的設定。我該如何復原並避免這種情況？

`config.apply` 會取代**整個設定**。如果您傳送部分物件，則所有其他內容都將被移除。

復原：

- 從備份中還原 (git 或複製的 `~/.openclaw/openclaw.json`)。
- 如果您沒有備份，請重新執行 `openclaw doctor` 並重新設定頻道/模型。
- 如果這是意外情況，請提交錯誤並附上您上次已知的設定或任何備份。
- 本機編碼智慧代理通常可以從日誌或歷史記錄重建可用的設定。

避免：

- 使用 `openclaw config set` 進行小幅變更。
- 使用 `openclaw configure` 進行互動式編輯。

文件：[Config](/cli/config)、[Configure](/cli/configure)、[Doctor](/gateway/doctor)。

### 如何執行中央 Gateway 並在不同裝置上執行專門的工作者？

常見的模式是**一個 Gateway** (例如 Raspberry Pi) 加上**節點**和**智慧代理**：

- **Gateway (中央)**：擁有頻道 (Signal/WhatsApp)、路由和工作階段。
- **節點 (裝置)**：Mac/iOS/Android 作為週邊設備連接，並公開本機工具 (`system.run`、`canvas`、`camera`)。
- **智慧代理 (工作者)**：具有專門角色 (例如「Hetzner 操作」、「個人資料」) 的獨立大腦/工作區。
- **子智慧代理**：當您想要平行處理時，從主要智慧代理產生背景工作。
- **TUI**：連接到 Gateway 並切換智慧代理/工作階段。

文件：[Nodes](/nodes)、[Remote access](/gateway/remote)、[Multi-Agent Routing](/concepts/multi-agent)、[Sub-agents](/tools/subagents)、[TUI](/web/tui)。

### OpenClaw 瀏覽器可以無頭模式執行嗎？

可以。這是一個設定選項：

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

預設為 `false` (有頭模式)。無頭模式更有可能觸發某些網站上的反機器人檢查。請參閱 [Browser](/tools/browser)。

無頭模式使用**相同的 Chromium 引擎**，並適用於大多數自動化 (表單、點擊、抓取、登入)。主要區別：

- 沒有可見的瀏覽器視窗 (如果您需要視覺效果，請使用螢幕截圖)。
- 某些網站對無頭模式下的自動化更嚴格 (CAPTCHA、反機器人)。
  例如，X/Twitter 經常封鎖無頭工作階段。

### 如何使用 Brave 進行瀏覽器控制？

將 `browser.executablePath` 設定為您的 Brave 二進位檔案 (或任何基於 Chromium 的瀏覽器) 並重新啟動 Gateway。
請參閱 [Browser](/tools/browser#use-brave-or-another-chromium-based-browser) 中的完整設定範例。

## 遠端 Gateway 和節點

### 指令如何在 Telegram、Gateway 和節點之間傳播？

Telegram 訊息由 **Gateway** 處理。Gateway 執行智慧代理，然後在需要節點工具時才透過 **Gateway WebSocket** 呼叫節點：

Telegram → Gateway → 智慧代理 → `node.*` → 節點 → Gateway → Telegram

節點看不到傳入的供應商流量；它們只接收節點 RPC 呼叫。

### 如果 Gateway 託管在遠端，我的智慧代理如何存取我的電腦？

簡短回答：**將您的電腦配對為節點**。Gateway 在其他地方執行，但它可以在您的本機機器上透過 Gateway WebSocket 呼叫 `node.*` 工具 (螢幕、相機、系統)。

典型設定：

1. 在永遠開啟的主機 (VPS/家用伺服器) 上執行 Gateway。
2. 將 Gateway 主機 + 您的電腦放在同一個 tailnet 上。
3. 確保 Gateway WS 可達 (tailnet 繫結或 SSH 通道)。
4. 在本機開啟 macOS 應用程式並以**遠端 SSH** 模式連接 (或直接 tailnet)，
   這樣它就可以註冊為節點。
5. 在 Gateway 上批准節點：

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

不需要單獨的 TCP 橋接；節點透過 Gateway WebSocket 連接。

安全提醒：配對 macOS 節點允許在該機器上執行 `system.run`。僅
配對您信任的裝置，並檢閱 [Security](/gateway/security)。

文件：[Nodes](/nodes)、[Gateway protocol](/gateway/protocol)、[macOS remote mode](/platforms/mac/remote)、[Security](/gateway/security)。

### Tailscale 已連線但我沒有收到回覆。現在怎麼辦？

檢查基礎知識：

- Gateway 正在執行：`openclaw gateway status`
- Gateway 健康狀況：`openclaw status`
- 頻道健康狀況：`openclaw channels status`

然後驗證驗證和路由：

- 如果您使用 Tailscale Serve，請確保 `gateway.auth.allowTailscale` 設定正確。
- 如果您透過 SSH 通道連接，請確認本機通道已啟動並指向正確的連接埠。
- 確認您的允許清單 (私訊或群組) 包含您的帳戶。

文件：[Tailscale](/gateway/tailscale)、[Remote access](/gateway/remote)、[Channels](/channels)。

### 兩個 OpenClaw 實例可以互相通訊嗎 (本機 + VPS)？

可以。沒有內建的「智慧代理對智慧代理」橋接，但您可以用幾種
可靠的方式將其連接起來：

**最簡單**：使用兩個智慧代理都可以存取的普通聊天頻道 (Telegram/Slack/WhatsApp)。
讓智慧代理 A 傳送訊息給智慧代理 B，然後讓智慧代理 B 像往常一樣回覆。

**CLI 橋接 (通用)**：執行一個腳本，該腳本透過
`openclaw agent --message ... --deliver` 呼叫另一個 Gateway，
目標是另一個智慧代理監聽的聊天。如果其中一個智慧代理在遠端 VPS 上，
請將您的 CLI 指向該遠端 Gateway 透過 SSH/Tailscale (請參閱 [Remote access](/gateway/remote))。

範例模式 (從可以連接目標 Gateway 的機器執行)：

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

提示：新增一個防護措施，以免兩個智慧代理無限循環 (僅提及、頻道
允許清單或「不回覆智慧代理訊息」規則)。

文件：[Remote access](/gateway/remote)、[Agent CLI](/cli/agent)、[Agent send](/tools/agent-send)。

### 我需要為多個智慧代理使用單獨的 VPS 嗎？

不需要。一個 Gateway 可以託管多個智慧代理，每個智慧代理都有自己的工作區、模型預設值和路由。這是正常的設定，比為每個智慧代理執行一個 VPS 更便宜、更簡單。

只有當您需要硬性隔離 (安全邊界) 或非常不同的設定而您不想共用時，才使用單獨的 VPS。否則，請保留一個 Gateway 並使用多個智慧代理或子智慧代理。

### 在我的個人筆記型電腦上使用節點而不是從 VPS 進行 SSH 有什麼好處？

有——節點是從遠端 Gateway 連接您筆記型電腦的一等方式，它們解鎖了不止 shell 存取。Gateway 在 macOS/Linux (Windows 透過 WSL2) 上執行且輕巧 (小型 VPS 或 Raspberry Pi 級別的裝置都可以；4 GB RAM 足夠了)，因此常見的設定是永遠開啟的主機加上您的筆記型電腦作為節點。

- **不需要傳入 SSH。** 節點連接到 Gateway WebSocket 並使用裝置配對。
- **更安全的執行控制。** `system.run` 受該筆記型電腦上的節點允許清單/批准限制。
- **更多裝置工具。** 節點除了 `system.run` 之外還公開了 `canvas`、`camera` 和 `screen`。
- **本機瀏覽器自動化。** 將 Gateway 保留在 VPS 上，但在本機執行 Chrome，並使用 Chrome 擴充功能 + 筆記型電腦上的節點主機來中繼控制。

SSH 適用於臨時 shell 存取，但節點對於持續的智慧代理工作流程和裝置自動化來說更簡單。

文件：[Nodes](/nodes)、[Nodes CLI](/cli/nodes)、[Chrome extension](/tools/chrome-extension)。

### 我應該在第二台筆記型電腦上安裝還是只新增一個節點？

如果您只需要第二台筆記型電腦上的**本機工具** (螢幕/相機/執行)，請將其新增為**節點**。這可以保持單一 Gateway 並避免重複設定。本機節點工具目前僅限 macOS，但我們計劃將其擴展到其他作業系統。

僅當您需要**硬性隔離**或兩個完全獨立的智慧代理時，才安裝第二個 Gateway。

文件：[Nodes](/nodes)、[Nodes CLI](/cli/nodes)、[Multiple gateways](/gateway/multiple-gateways)。

### 節點會執行 Gateway 服務嗎？

不會。每個主機上應只執行**一個 Gateway**，除非您有意執行隔離的設定檔 (請參閱 [Multiple gateways](/gateway/multiple-gateways))。節點是連接到 Gateway 的週邊設備 (iOS/Android 節點，或選單列應用程式中的 macOS「節點模式」)。對於無頭節點主機和 CLI 控制，請參閱 [Node host CLI](/cli/node)。

Gateway、discovery 和 canvasHost 變更需要完整重新啟動。

### 是否有 API / RPC 方法來應用設定？

有。`config.apply` 會驗證 + 寫入完整設定，並作為操作的一部分重新啟動 Gateway。

### `config.apply` 清除了我的設定。我該如何復原並避免這種情況？

`config.apply` 會取代**整個設定**。如果您傳送部分物件，則所有其他內容都將被移除。

復原：

- 從備份中還原 (git 或複製的 `~/.openclaw/openclaw.json`)。
- 如果您沒有備份，請重新執行 `openclaw doctor` 並重新設定頻道/模型。
- 如果這是意外情況，請提交錯誤並附上您上次已知的設定或任何備份。
- 本機編碼智慧代理通常可以從日誌或歷史記錄重建可用的設定。

避免：

- 使用 `openclaw config set` 進行小幅變更。
- 使用 `openclaw configure` 進行互動式編輯。

文件：[Config](/cli/config)、[Configure](/cli/configure)、[Doctor](/gateway/doctor)。

### 第一次安裝的最小「健全」設定是什麼？

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

這會設定您的工作區並限制誰可以觸發智慧代理。

### 如何在 VPS 上設定 Tailscale 並從我的 Mac 連接？

最少步驟：

1. **在 VPS 上安裝 + 登入**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **在您的 Mac 上安裝 + 登入**
   - 使用 Tailscale 應用程式並登入相同的 tailnet。
3. **啟用 MagicDNS (建議)**
   - 在 Tailscale 管理控制台中，啟用 MagicDNS，以便 VPS 擁有穩定的名稱。
4. **使用 tailnet 主機名**
   - SSH：`ssh user @your-vps.tailnet-xxxx.ts.net`
   - Gateway WS：`ws://your-vps.tailnet-xxxx.ts.net:18789`

如果您想要無需 SSH 的控制 UI，請在 VPS 上使用 Tailscale Serve：

```bash
openclaw gateway --tailscale serve
```

這會將 Gateway 繫結到回環並透過 Tailscale 公開 HTTPS。請參閱 [Tailscale](/gateway/tailscale)。

### 如何將 Mac 節點連接到遠端 Gateway (Tailscale Serve)？

Serve 會公開 **Gateway 控制 UI + WS**。節點會透過相同的 Gateway WS 端點連接。

建議的設定：

1. **確保 VPS + Mac 位於相同的 tailnet 上**。
2. **在遠端模式下使用 macOS 應用程式** (SSH 目標可以是 tailnet 主機名)。
   應用程式將會透過通道連接 Gateway 連接埠並作為節點連接。
3. **在 Gateway 上批准節點**：

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

文件：[Gateway protocol](/gateway/protocol)、[Discovery](/gateway/discovery)、[macOS remote mode](/platforms/mac/remote)。

## 環境變數和 .env 載入

### OpenClaw 如何載入環境變數？

OpenClaw 從父進程 (shell、launchd/systemd、CI 等) 讀取環境變數，並額外載入：

- 當前工作目錄中的 `.env`
- `~/.openclaw/.env` (即 `$OPENCLAW_STATE_DIR/.env`) 中的全域備援 `.env`

這兩個 `.env` 檔案都不會覆寫現有的環境變數。

您還可以在設定中定義內嵌環境變數 (僅在進程環境中遺失時才適用)：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

請參閱 [/environment](/help/environment) 以了解完整的優先順序和來源。

### 我透過服務啟動了 Gateway，我的環境變數消失了。現在怎麼辦？

兩個常見的修復方法：

1. 將遺失的密鑰放入 `~/.openclaw/.env` 中，這樣即使服務沒有繼承您的 shell 環境，它們也會被選取。
2. 啟用 shell 匯入 (可選的便利功能)：

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

這會執行您的登入 shell 並僅匯入遺失的預期密鑰 (絕不覆寫)。環境變數等效：
`OPENCLAW_LOAD_SHELL_ENV=1`、`OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`。

### 我設定了 `COPILOT_GITHUB_TOKEN`，但模型狀態顯示「Shell env: off」。為什麼？

`openclaw models status` 報告是否啟用了**shell 環境匯入**。「Shell env: off」
**不**表示您的環境變數遺失——它只表示 OpenClaw 不會自動載入
您的登入 shell。

如果 Gateway 作為服務 (launchd/systemd) 執行，它將不會繼承您的 shell
環境。透過執行以下操作之一來修復：

1. 將權杖放入 `~/.openclaw/.env` 中：

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. 或啟用 shell 匯入 (`env.shellEnv.enabled: true`)。
3. 或將其新增到您的設定 `env` 區塊中 (僅在遺失時才適用)。

然後重新啟動 Gateway 並重新檢查：

```bash
openclaw models status
```

Copilot 權杖從 `COPILOT_GITHUB_TOKEN` (也包括 `GH_TOKEN` / `GITHUB_TOKEN`) 讀取。
請參閱 [/concepts/model-providers](/concepts/model-providers) 和 [/environment](/help/environment)。

## 工作階段和多重聊天

### 如何開始新的對話？

傳送 `/new` 或 `/reset` 作為獨立訊息。請參閱 [Session management](/concepts/session)。

### 如果我從不傳送 `/new`，工作階段會自動重置嗎？

會。工作階段會在 `session.idleMinutes` (預設為 **60**) 後過期。
**下一個**訊息會為該聊天密鑰啟動一個新的工作階段 ID。這不會刪除
對話記錄——它只是啟動一個新的工作階段。

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### 有沒有辦法讓 OpenClaw 實例團隊成為一個 CEO 和許多智慧代理？

有，透過**多智慧代理路由**和**子智慧代理**。您可以建立一個協調智慧代理和多個工作智慧代理，每個智慧代理都有自己的工作區和模型。

話雖如此，這最好被視為一個**有趣的實驗**。它會耗費大量權杖，而且通常效率不如使用一個具有獨立工作階段的智慧代理。我們設想的典型模型是您與之交談的一個智慧代理，具有用於平行工作的不同工作階段。該智慧代理還可以在需要時產生子智慧代理。

文件：[Multi-agent routing](/concepts/multi-agent)、[Sub-agents](/tools/subagents)、[Agents CLI](/cli/agents)。

### 為什麼上下文在任務中途被截斷了？我該如何防止它？

工作階段上下文受模型視窗的限制。長時間的聊天、大型工具輸出或許多
檔案可能會觸發壓縮或截斷。

有幫助的方法：

- 要求智慧代理摘要當前狀態並將其寫入檔案。
- 在長時間任務之前使用 `/compact`，並在切換主題時使用 `/new`。
- 將重要上下文保留在工作區中，並要求智慧代理將其讀回。
- 對於長時間或平行工作，請使用子智慧代理，這樣主聊天會保持較小。
- 如果這種情況經常發生，請選擇具有較大上下文視窗的模型。

### 如何完全重置 OpenClaw 但保持已安裝狀態？

使用重置指令：

```bash
openclaw reset
```

非互動式完全重置：

```bash
openclaw reset --scope full --yes --non-interactive
```

然後重新執行新手導覽：

```bash
openclaw onboard --install-daemon
```

注意事項：

- 新手導覽精靈如果看到現有的設定，也會提供**重置**。請參閱 [Wizard](/start/wizard)。
- 如果您使用了設定檔 (`--profile` / `OPENCLAW_PROFILE`)，請重置每個狀態目錄 (預設為 `~/.openclaw-<profile>`)。
- 開發重置：`openclaw gateway --dev --reset` (僅限開發；清除開發設定 + 憑證 + 工作階段 + 工作區)。

### 我收到「上下文太大」的錯誤——我該如何重置或壓縮？

使用以下其中一種：

- **壓縮** (保留對話但摘要較舊的回合)：

  ```
  /compact
  ```

  或 `/compact <instructions>` 以引導摘要。

- **重置** (為相同的聊天密鑰建立新的工作階段 ID)：

  ```
  /new
  /reset
  ```

如果它繼續發生：

- 啟用或調整**工作階段修剪** (`agents.defaults.contextPruning`) 以修剪舊的工具輸出。
- 使用具有較大上下文視窗的模型。

文件：[Compaction](/concepts/compaction)、[Session pruning](/concepts/session-pruning)、[Session management](/concepts/session)。

### 為什麼我看到「LLM request rejected: messages.N.content.X.tool_use.input: Field required」？

這是供應商驗證錯誤：模型發出了一個不含所需 `input` 的 `tool_use` 區塊。這通常表示工作階段歷史記錄過時或損壞 (通常發生在長時間對話或工具/架構變更之後)。

修復：使用 `/new` (獨立訊息) 啟動一個新的工作階段。

### 為什麼我每 30 分鐘收到一次心跳訊息？

心跳預設每 **30 分鐘**執行一次。調整或停用它們：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // 或 "0m" 以停用
      },
    },
  },
}
```

如果 `HEARTBEAT.md` 存在但實際上是空的 (只有空白行和像 `# Heading` 這樣的 Markdown
標題)，OpenClaw 會跳過心跳執行以節省 API 呼叫。
如果檔案遺失，心跳仍然會執行，模型會決定該怎麼做。

每個智慧代理的覆寫使用 `agents.list[].heartbeat`。文件：[Heartbeat](/gateway/heartbeat)。

### 我需要將「智慧代理帳戶」新增到 WhatsApp 群組嗎？

不需要。OpenClaw 在**您自己的帳戶**上執行，所以如果您在群組中，OpenClaw 就可以看到它。
預設情況下，群組回覆會被封鎖，直到您允許傳送者 (`groupPolicy: "allowlist"`)。

如果您只希望**您**能夠觸發群組回覆：

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

### 如何取得 WhatsApp 群組的 JID？

選項 1 (最快)：追蹤日誌並在群組中傳送測試訊息：

```bash
openclaw logs --follow --json
```

尋找以 ` @g.us` 結尾的 `chatId` (或 `from`)，例如：
`1234567890-1234567890 @g.us`。

選項 2 (如果已設定/允許清單)：從設定中列出群組：

```bash
openclaw directory groups list --channel whatsapp
```

文件：[WhatsApp](/channels/whatsapp)、[Directory](/cli/directory)、[Logs](/cli/logs)。

### 為什麼 OpenClaw 在群組中不回覆？

兩個常見原因：

- 提及限制已開啟 (預設)。您必須 @提及智慧代理 (或符合 `mentionPatterns`)。
- 您設定了 `channels.whatsapp.groups` 而沒有 `"*"`，並且群組未在允許清單中。

請參閱 [Groups](/channels/groups) 和 [Group messages](/channels/group-messages)。

### 群組/主題與私訊共享上下文嗎？

直接聊天預設會合併到主要工作階段。群組/頻道有自己的工作階段密鑰，而 Telegram 主題 / Discord 討論串是獨立的工作階段。請參閱 [Groups](/channels/groups) 和 [Group messages](/channels/group-messages)。

### 我可以建立多少個工作區和智慧代理？

沒有硬性限制。數十個 (甚至數百個) 都沒問題，但要注意：

- **磁碟成長**：工作階段 + 對話記錄儲存在 `~/.openclaw/agents/<agentId>/sessions/` 下。
- **權杖成本**：更多智慧代理意味著更多並行模型使用。
- **操作開銷**：每個智慧代理的驗證設定檔、工作區和頻道路由。

提示：

- 每個智慧代理保留一個**活動**工作區 (`agents.defaults.workspace`)。
- 如果磁碟成長，請修剪舊工作階段 (刪除 JSONL 或儲存條目)。
- 使用 `openclaw doctor` 找出遺失的工作區和設定檔不符。

### 我可以在 Slack 上同時執行多個智慧代理或聊天嗎？我該如何設定？

可以。使用**多智慧代理路由**來執行多個獨立智慧代理，並根據
頻道/帳戶/對等路由傳入訊息。Slack 作為頻道受到支援，並且可以繫結到特定的智慧代理。

瀏覽器存取功能強大，但並非「人類可以做的一切」——反機器人、CAPTCHA 和 MFA 仍然可以
阻止自動化。為了最可靠的瀏覽器控制，請使用運行瀏覽器的機器上的 Chrome 擴充功能中繼
(並將 Gateway 放在任何地方)。

最佳實踐設定：

- 永遠開啟的 Gateway 主機 (VPS/Mac mini)。
- 每個角色一個智慧代理 (繫結)。
- 繫結到這些智慧代理的 Slack 頻道。
- 需要時透過擴充功能中繼 (或節點) 進行本機瀏覽器存取。

文件：[Multi-Agent Routing](/concepts/multi-agent)、[Slack](/channels/slack)、
[Browser](/tools/browser)、[Chrome extension](/tools/chrome-extension)、[Nodes](/nodes)。

## 模型：預設值、選擇、別名、切換

### 什麼是「預設模型」？

OpenClaw 的預設模型是您設定的任何內容：

```
agents.defaults.model.primary
```

模型以 `供應商/模型` (範例：`anthropic/claude-opus-4-6`) 引用。如果您省略供應商，OpenClaw 目前暫時會將 `anthropic` 作為淘汰備援——但您仍然應該**明確地**設定 `供應商/模型`。

### 您推薦哪個模型？

**建議的預設值**：`anthropic/claude-opus-4-6`。
**不錯的替代方案**：`anthropic/claude-sonnet-4-5`。
**可靠 (較少個性)**：`openai/gpt-5.2` - 幾乎與 Opus 一樣好，只是個性較少。
**預算**：`zai/glm-4.7`。

MiniMax M2.1 有自己的文件：[MiniMax](/providers/minimax) 和
[Local models](/gateway/local-models)。

經驗法則：對於高風險工作，使用**您能負擔得起最好的模型**，對於例行聊天或摘要，則使用更便宜的模型。您可以為每個智慧代理路由模型，並使用子智慧代理來平行處理長時間任務 (每個子智慧代理都會消耗權杖)。請參閱 [Models](/concepts/models) 和
[Sub-agents](/tools/subagents)。

強烈警告：較弱/過度量化的模型更容易受到提示注入和不安全行為的影響。請參閱 [Security](/gateway/security)。

更多上下文：[Models](/concepts/models)。

### 如何在不清除設定的情況下切換模型？

使用**模型指令**或僅編輯**模型**欄位。避免完全替換設定。

安全選項：

- 聊天中的 `/model` (快速、每個工作階段)
- `openclaw models set ...` (僅更新模型設定)
- `openclaw configure --section model` (互動式)
- 編輯 `~/.openclaw/openclaw.json` 中的 `agents.defaults.model`

除非您打算替換整個設定，否則請避免使用部分物件執行 `config.apply`。
如果您確實覆寫了設定，請從備份中還原或重新執行 `openclaw doctor` 進行修復。

文件：[Models](/concepts/models)、[Configure](/cli/configure)、[Config](/cli/config)、[Doctor](/gateway/doctor)。

### 我可以使用自託管模型 (llama.cpp、vLLM、Ollama) 嗎？

可以。如果您的本機伺服器公開了與 OpenAI 相容的 API，您可以將自訂供應商指向它。Ollama 直接受到支援，並且是最簡單的路徑。

安全注意事項：較小或大量量化的模型更容易受到提示注入的影響。我們強烈建議**大型模型**用於任何可以使用工具的智慧代理。如果您仍然想要小型模型，請鎖定工具並在沙箱隔離中執行。

文件：[Ollama](/providers/ollama)、[Local models](/gateway/local-models)、
[Model providers](/concepts/model-providers)、[Security](/gateway/security)、
[Sandboxing](/gateway/sandboxing)。

### OpenClaw、Flawd 和 Krill 使用什麼模型？

- **OpenClaw + Flawd**：Anthropic Opus (`anthropic/claude-opus-4-6`) - 請參閱 [Anthropic](/providers/anthropic)。
- **Krill**：MiniMax M2.1 (`minimax/MiniMax-M2.1`) - 請參閱 [MiniMax](/providers/minimax)。

### 如何在不重新啟動的情況下即時切換模型？

將 `/model` 指令作為獨立訊息傳送：

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

您可以使用 `/model`、`/model list` 或 `/model status` 列出可用的模型。

`/model` (和 `/model list`) 會顯示一個簡潔、編號的選擇器。按數字選擇：

```
/model 3
```

您也可以為供應商強制指定特定的驗證設定檔 (每個工作階段)：

```
/model opus @anthropic:default
/model opus @anthropic:work
```

提示：`/model status` 會顯示哪些智慧代理處於活動狀態，正在使用哪些 `auth-profiles.json` 檔案，以及接下來將嘗試哪個驗證設定檔。
它還會顯示設定的供應商端點 (`baseUrl`) 和 API 模式 (`api`)(如果可用)。

### 如何解除固定我用 profile 設定的設定檔？

重新執行 `/model` **不帶** `@profile` 後綴：

```
/model anthropic/claude-opus-4-6
```

如果您想返回預設值，請從 `/model` 中選擇 (或傳送 `/model <default provider/model>`)。
使用 `/model status` 確認哪個驗證設定檔處於活動狀態。

### 我可以將 GPT 5.2 用於日常任務，將 Codex 5.3 用於編碼嗎？

可以。將一個設定為預設值，並根據需要切換：

- **快速切換 (每個工作階段)**：日常任務使用 `/model gpt-5.2`，編碼使用 `/model gpt-5.3-codex`。
- **預設 + 切換**：將 `agents.defaults.model.primary` 設定為 `openai/gpt-5.2`，然後在編碼時切換到 `openai-codex/gpt-5.3-codex` (或反過來)。
- **子智慧代理**：將編碼任務路由到具有不同預設模型的子智慧代理。

請參閱 [Models](/concepts/models) 和 [Slash commands](/tools/slash-commands)。

### 為什麼我看到「Model … is not allowed」然後沒有回覆？

如果設定了 `agents.defaults.models`，它就會成為 `/model` 和任何
工作階段覆寫的**允許清單**。選擇不在該清單中的模型會傳回：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

該錯誤會**代替**正常回覆傳回。修復：將模型新增到
`agents.defaults.models`、移除允許清單或從 `/model list` 中選擇模型。

### 為什麼我看到「Unknown model: minimax/MiniMax-M2.1」？

這表示**供應商未設定** (未找到 MiniMax 供應商設定或驗證設定檔)，因此無法解析模型。此偵測的修復程式位於 **2026.1.12** (撰寫本文時尚未發佈)。

修復檢查清單：

1. 升級到 **2026.1.12** (或從原始碼 `main` 執行)，然後重新啟動 Gateway。
2. 確保 MiniMax 已設定 (精靈或 JSON)，或者在 env/驗證設定檔中存在 MiniMax API 密鑰，以便可以注入供應商。
3. 使用確切的模型 ID (區分大小寫)：`minimax/MiniMax-M2.1` 或
   `minimax/MiniMax-M2.1-lightning`。
4. 執行：

   ```bash
   openclaw models list
   ```

   並從清單中選擇 (或在聊天中 `/model list`)。

請參閱 [MiniMax](/providers/minimax) 和 [Models](/concepts/models)。

### 我可以將 MiniMax 作為我的預設模型，將 OpenAI 用於複雜任務嗎？

可以。將 **MiniMax 作為預設值**，並在需要時**每個工作階段**切換模型。
備援是針對**錯誤**，而不是「困難任務」，因此請使用 `/model` 或單獨的智慧代理。

**選項 A：每個工作階段切換**

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

然後：

```
/model gpt
```

**選項 B：單獨的智慧代理**

- 智慧代理 A 預設：MiniMax
- 智慧代理 B 預設：OpenAI
- 透過智慧代理路由或使用 `/agent` 切換

文件：[Models](/concepts/models)、[Multi-Agent Routing](/concepts/multi-agent)、[MiniMax](/providers/minimax)、[OpenAI](/providers/openai)。

### opus sonnet gpt 是內建快捷方式嗎？

可以。OpenClaw 附帶一些預設的簡寫 (僅在模型存在於 `agents.defaults.models` 中時才適用)：

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

如果您設定自己的同名別名，您的值會勝出。

### 如何定義/覆寫模型快捷方式 (別名)？

別名來自 `agents.defaults.models.<modelId>.alias`。範例：

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

然後 `/model sonnet` (或在支援時 `/<alias>`) 會解析為該模型 ID。

### 如何新增來自 OpenRouter 或 Z.AI 等其他供應商的模型？

OpenRouter (按權杖計費；許多模型)：

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

Z.AI (GLM 模型)：

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

如果您引用供應商/模型但缺少所需的供應商密鑰，您將收到執行階段驗證錯誤 (例如 `No API key found for provider "zai"`)。

### 新增智慧代理後找不到供應商的 API 密鑰

這通常表示**新智慧代理**的驗證儲存區為空。驗證是每個智慧代理的，
儲存在：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

修復選項：

- 執行 `openclaw agents add <id>` 並在精靈期間設定驗證。
- 或將 `auth-profiles.json` 從主要智慧代理的 `agentDir` 複製到新智慧代理的 `agentDir`。

**不要**在智慧代理之間重複使用 `agentDir`；這會導致驗證/工作階段衝突。

## 模型故障轉移和「所有模型都失敗了」

### 故障轉移是如何運作的？

故障轉移分為兩個階段：

1. 同一供應商內的**驗證設定檔輪換**。
2. **模型備援**到 `agents.defaults.model.fallbacks` 中的下一個模型。

冷卻期適用於故障的設定檔 (指數退避)，因此 OpenClaw 即使在供應商受到速率限制或暫時故障時也能持續回應。

### 這個錯誤是什麼意思？

```
No credentials found for profile "anthropic:default"
```

這表示系統嘗試使用驗證設定檔 ID `anthropic:default`，但在預期的驗證儲存區中找不到其憑證。

### 「No credentials found for profile anthropic:default」的修復清單

- **確認驗證設定檔儲存位置** (新路徑與舊路徑)
  - 目前：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - 舊版：`~/.openclaw/agent/*` (由 `openclaw doctor` 遷移)
- **確認您的環境變數已由 Gateway 載入**
  - 如果您在 shell 中設定 `ANTHROPIC_API_KEY`，但透過 systemd/launchd 執行 Gateway，它可能不會繼承它。將其放入 `~/.openclaw/.env` 或啟用 `env.shellEnv`。
- **確保您正在編輯正確的智慧代理**
  - 多智慧代理設定意味著可能有多個 `auth-profiles.json` 檔案。
- **健全檢查模型/驗證狀態**
  - 使用 `openclaw models status` 查看設定的模型以及供應商是否已驗證。

**「No credentials found for profile anthropic」的修復清單**

這表示執行已固定到 Anthropic 驗證設定檔，但 Gateway
在其驗證儲存區中找不到它。

- **使用 setup-token**
  - 執行 `claude setup-token`，然後使用 `openclaw models auth setup-token --provider anthropic` 貼上它。
  - 如果權杖是在另一台機器上建立的，請使用 `openclaw models auth paste-token --provider anthropic`。
- **如果您想改用 API 密鑰**
  - 在 **Gateway 主機**上的 `~/.openclaw/.env` 中放置 `ANTHROPIC_API_KEY`。
  - 清除任何強制遺失設定檔的固定順序：

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **確認您正在 Gateway 主機上執行指令**
  - 在遠端模式下，驗證設定檔位於 Gateway 機器上，而不是您的筆記型電腦。

### 為什麼它也嘗試了 Google Gemini 並失敗了？

如果您的模型設定包含 Google Gemini 作為備援 (或您切換到 Gemini 簡寫)，OpenClaw 將在模型備援期間嘗試它。如果您尚未設定 Google 憑證，您將看到 `No API key found for provider "google"`。

修復：要麼提供 Google 驗證，要麼從 `agents.defaults.model.fallbacks` / 別名中移除/避免 Google 模型，這樣備援就不會路由到那裡。

### LLM request rejected 訊息思考簽名需要 google antigravity

原因：工作階段歷史記錄包含**沒有簽名**的思考區塊 (通常來自中止/部分串流)。Google Antigravity 要求思考區塊具有簽名。

修復：OpenClaw 現在會為 Google Antigravity Claude 剝離未簽名的思考區塊。如果它仍然出現，請啟動**新工作階段**或為該智慧代理設定 `/thinking off`。

## 驗證設定檔：它們是什麼以及如何管理

相關：[/concepts/oauth](/concepts/oauth) (OAuth 流程、權杖儲存、多帳戶模式)

### 什麼是驗證設定檔？

驗證設定檔是綁定到供應商的命名憑證記錄 (OAuth 或 API 密鑰)。設定檔儲存在：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### 典型的設定檔 ID 是什麼？

OpenClaw 使用供應商前綴的 ID，例如：

- `anthropic:default` (通常在沒有電子郵件身份時使用)
- `anthropic:<email>` 用於 OAuth 身份
- 您選擇的自訂 ID (例如 `anthropic:work`)

### 我可以控制哪個驗證設定檔先被嘗試嗎？

可以。設定支援設定檔的可選中繼資料和每個供應商的排序 (`auth.order.<provider>`)。這**不會**儲存密鑰；它會將 ID 對應到供應商/模式並設定輪換順序。

如果設定檔在短暫的**冷卻期** (速率限制/逾時/驗證失敗) 或較長的**停用**狀態 (計費/信用不足) 中，OpenClaw 可能會暫時跳過它。要檢查此情況，請執行 `openclaw models status --json` 並檢查 `auth.unusableProfiles`。調整：`auth.cooldowns.billingBackoffHours*`。

您還可以透過 CLI 設定**每個智慧代理**的排序覆寫 (儲存在該智慧代理的 `auth-profiles.json` 中)：

```bash
# 預設為設定的預設智慧代理 (省略 --agent)
openclaw models auth order get --provider anthropic

# 將輪換鎖定到單一設定檔 (僅嘗試此設定檔)
openclaw models auth order set --provider anthropic anthropic:default

# 或設定明確的順序 (供應商內的備援)
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# 清除覆寫 (退回設定 auth.order / 循環)
openclaw models auth order clear --provider anthropic
```

要指定特定的智慧代理：

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth 與 API 密鑰：有什麼區別？

OpenClaw 兩者都支援：

- **OAuth** 通常利用訂閱存取 (在適用情況下)。
- **API 密鑰** 使用按權杖計費。

精靈明確支援 Anthropic setup-token 和 OpenAI Codex OAuth，並可以為您儲存 API 密鑰。

## Gateway：連接埠、「已在執行」和遠端模式

### Gateway 使用哪個連接埠？

`gateway.port` 控制 WebSocket + HTTP (控制 UI、掛鉤等) 的單一多工連接埠。

優先順序：

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > 預設 18789
```

### 為什麼 `openclaw gateway status` 顯示 `Runtime: running` 但 `RPC probe: failed`？

因為「running」是**監管程式**的視圖 (launchd/systemd/schtasks)。RPC 探測是 CLI 實際連接到 Gateway WebSocket 並呼叫 `status`。

使用 `openclaw gateway status` 並信任這些行：

- `Probe target:` (探測實際使用的 URL)
- `Listening:` (連接埠上實際繫結的內容)
- `Last gateway error:` (當進程存活但連接埠未監聽時的常見根本原因)

### 為什麼 `openclaw gateway status` 顯示 `Config (cli)` 和 `Config (service)` 不同？

您正在編輯一個設定檔案，而服務正在執行另一個 (通常是 `--profile` / `OPENCLAW_STATE_DIR` 不符)。

修復：

```bash
openclaw gateway install --force
```

從您希望服務使用的相同 `--profile` / 環境執行此命令。

### 「another gateway instance is already listening」是什麼意思？

OpenClaw 透過在啟動時立即繫結 WebSocket 監聽器 (預設 `ws://127.0.0.1:18789`) 來強制執行執行階段鎖定。如果繫結失敗並出現 `EADDRINUSE`，它會拋出 `GatewayLockError`，表示另一個實例已在監聽。

修復：停止另一個實例、釋放連接埠，或使用 `openclaw gateway --port <連接埠>` 執行。

### 如何以遠端模式執行 OpenClaw (用戶端連接到其他地方的 Gateway)？

將 `gateway.mode: "remote"` 設定為指向遠端 WebSocket URL，可選地帶有權杖/密碼：

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "您的權杖",
      password: "您的密碼",
    },
  },
}
```

注意事項：

- `openclaw gateway` 僅在 `gateway.mode` 為 `local` (或您傳遞覆寫標誌) 時啟動。
- macOS 應用程式會監控設定檔案，並在這些值變更時即時切換模式。

### 控制 UI 顯示「unauthorized」（或持續重新連接）。現在怎麼辦？

您的 Gateway 已啟用驗證 (`gateway.auth.*`)，但 UI 未傳送匹配的權杖/密碼。

事實 (來自程式碼)：

- 控制 UI 將權杖儲存在瀏覽器 localStorage 密鑰 `openclaw.control.settings.v1` 中。

修復：

- 最快：`openclaw dashboard` (列印並複製儀表板 URL，嘗試開啟；如果無頭模式則顯示 SSH 提示)。
- 如果您還沒有權杖：`openclaw doctor --generate-gateway-token`。
- 如果是遠端，請先進行通道：`ssh -N -L 18789:127.0.0.1:18789 user @host` 然後開啟 `http://127.0.0.1:18789/`。
- 在 Gateway 主機上設定 `gateway.auth.token` (或 `OPENCLAW_GATEWAY_TOKEN`)。
- 在控制 UI 設定中，貼上相同的權杖。
- 仍然卡住？執行 `openclaw status --all` 並遵循 [Troubleshooting](/gateway/troubleshooting)。請參閱 [Dashboard](/web/dashboard) 以了解驗證詳細資訊。

### 我設定了 `gateway.bind: "tailnet"` 但無法繫結 / 沒有任何東西在監聽

`tailnet` 繫結會從您的網路介面中選取一個 Tailscale IP (100.64.0.0/10)。如果機器不在 Tailscale 上 (或介面已關閉)，則沒有任何東西可以繫結。

修復：

- 在該主機上啟動 Tailscale (以便它具有 100.x 位址)，或
- 切換到 `gateway.bind: "loopback"` / `"lan"`。

注意：`tailnet` 是明確的。`auto` 偏好回環；當您想要僅限 tailnet 的繫結時，請使用 `gateway.bind: "tailnet"`。

### 我可以在同一主機上執行多個 Gateway 嗎？

通常不行——一個 Gateway 可以執行多個訊息頻道和智慧代理。只有當您需要冗餘 (例如：救援智慧代理) 或硬性隔離時才使用多個 Gateway。

可以，但您必須隔離：

- `OPENCLAW_CONFIG_PATH` (每個實例的設定)
- `OPENCLAW_STATE_DIR` (每個實例的狀態)
- `agents.defaults.workspace` (工作區隔離)
- `gateway.port` (唯一連接埠)

快速設定 (建議)：

- 每個實例使用 `openclaw --profile <name> …` (自動建立 `~/.openclaw-<name>`)。
- 在每個設定檔設定中設定唯一的 `gateway.port` (或傳遞 `--port` 進行手動執行)。
- 安裝每個設定檔的服務：`openclaw --profile <name> gateway install`。

設定檔也會附加服務名稱 (`bot.molt.<profile>`；舊版 `com.openclaw.*`、`openclaw-gateway-<profile>.service`、`OpenClaw Gateway (<profile>)`)。
完整指南：[Multiple gateways](/gateway/multiple-gateways)。

### 「invalid handshake」/ 代碼 1008 是什麼意思？

Gateway 是一個 **WebSocket 伺服器**，它期望第一條訊息是一個 `connect` 訊框。如果它收到任何其他內容，它會以**代碼 1008** (策略違規) 關閉連接。

常見原因：

- 您在瀏覽器中開啟了 **HTTP** URL (`http://...`) 而不是 WS 用戶端。
- 您使用了錯誤的連接埠或路徑。
- 代理或通道剝離了驗證標頭或傳送了非 Gateway 請求。

快速修復：

1. 使用 WS URL：`ws://<主機>:18789` (或如果 HTTPS 則為 `wss://...`)。
2. 不要在普通瀏覽器分頁中開啟 WS 連接埠。
3. 如果驗證已開啟，請在 `connect` 訊框中包含權杖/密碼。

如果您正在使用 CLI 或 TUI，URL 應該看起來像：

```
openclaw tui --url ws://<主機>:18789 --token <權杖>
```

協議詳細資訊：[Gateway protocol](/gateway/protocol)。

## 日誌記錄和偵錯

### 日誌在哪裡？

檔案日誌 (結構化)：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

您可以透過 `logging.file` 設定一個穩定路徑。檔案日誌層級由 `logging.level` 控制。控制台詳細程度由 `--verbose` 和 `logging.consoleLevel` 控制。

最快的日誌追蹤：

```bash
openclaw logs --follow
```

服務/監管程式日誌 (當 Gateway 透過 launchd/systemd 執行時)：

- macOS：`$OPENCLAW_STATE_DIR/logs/gateway.log` 和 `gateway.err.log` (預設：`~/.openclaw/logs/...`；設定檔使用 `~/.openclaw-<profile>/logs/...`)
- Linux：`journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows：`schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

更多資訊請參閱 [Troubleshooting](/gateway/troubleshooting#log-locations)。

### 如何啟動/停止/重新啟動 Gateway 服務？

使用 Gateway 輔助程式：

```bash
openclaw gateway status
openclaw gateway restart
```

如果您手動執行 Gateway，`openclaw gateway --force` 可以回收連接埠。請參閱 [Gateway](/gateway)。

### 我關閉了 Windows 終端機——我該如何重新啟動 OpenClaw？

有**兩種 Windows 安裝模式**：

**1) WSL2 (建議)**：Gateway 在 Linux 內部執行。

開啟 PowerShell，進入 WSL，然後重新啟動：

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

如果您從未安裝服務，請在前台啟動它：

```bash
openclaw gateway run
```

**2) 原生 Windows (不建議)**：Gateway 直接在 Windows 中執行。

開啟 PowerShell 並執行：

```powershell
openclaw gateway status
openclaw gateway restart
```

如果您手動執行它 (沒有服務)，請使用：

```powershell
openclaw gateway run
```

文件：[Windows (WSL2)](/platforms/windows)、[Gateway service runbook](/gateway)。

### Gateway 已啟動但沒有收到回覆。我應該檢查什麼？

從快速健康掃描開始：

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

常見原因：

- 模型驗證未載入到 **Gateway 主機**上 (檢查 `models status`)。
- 頻道配對/允許清單阻止回覆 (檢查頻道設定 + 日誌)。
- WebChat/儀表板已開啟但沒有正確的權杖。

如果您是遠端，請確認通道/Tailscale 連線已啟動且
Gateway WebSocket 可達。

文件：[Channels](/channels)、[Troubleshooting](/gateway/troubleshooting)、[Remote access](/gateway/remote)。

### 「Disconnected from gateway: no reason」——現在怎麼辦？

這通常表示 UI 失去了 WebSocket 連線。請檢查：

1. Gateway 是否正在執行？`openclaw gateway status`
2. Gateway 是否健康？`openclaw status`
3. UI 是否有正確的權杖？`openclaw dashboard`
4. 如果是遠端，通道/Tailscale 連線是否已啟動？

然後追蹤日誌：

```bash
openclaw logs --follow
```

文件：[Dashboard](/web/dashboard)、[Remote access](/gateway/remote)、[Troubleshooting](/gateway/troubleshooting)。

### Telegram setMyCommands 失敗並出現網路錯誤。我應該檢查什麼？

從日誌和頻道狀態開始：

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

如果您在 VPS 上或代理後面，請確認允許出站 HTTPS 且 DNS 正常運作。
如果 Gateway 是遠端的，請確保您正在查看 Gateway 主機上的日誌。

文件：[Telegram](/channels/telegram)、[Channel troubleshooting](/channels/troubleshooting)。

### TUI 沒有輸出。我應該檢查什麼？

首先確認 Gateway 可達且智慧代理可以執行：

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

在 TUI 中，使用 `/status` 查看當前狀態。如果您期望在聊天中收到回覆，請確保已啟用傳遞 (`/deliver on`)。

文件：[TUI](/web/tui)、[Slash commands](/tools/slash-commands)。

### 如何完全停止然後啟動 Gateway？

如果您安裝了服務：

```bash
openclaw gateway stop
openclaw gateway start
```

這會停止/啟動**受監管的服務** (macOS 上的 launchd，Linux 上的 systemd)。
當 Gateway 在背景作為守護程式執行時，請使用此命令。

如果您在前台執行，請使用 Ctrl-C 停止，然後：

```bash
openclaw gateway run
```

文件：[Gateway service runbook](/gateway)。

### ELI5: `openclaw gateway restart` vs `openclaw gateway`

- `openclaw gateway restart`：重新啟動**背景服務** (launchd/systemd)。
- `openclaw gateway`：**在前台**執行 Gateway，用於此終端機工作階段。

如果您安裝了服務，請使用 Gateway 指令。當您想要一次性、前台執行時，請使用 `openclaw gateway`。

### 當某些東西失敗時，最快獲得更多詳細資訊的方法是什麼？

使用 `--verbose` 啟動 Gateway 以取得更多控制台詳細資訊。然後檢查日誌檔案以了解頻道驗證、模型路由和 RPC 錯誤。

## 媒體和附件

### 我的 skill 生成了圖片/PDF，但沒有傳送

來自智慧代理的出站附件必須包含 `MEDIA:<path-or-url>` 行 (獨立一行)。請參閱 [OpenClaw assistant setup](/start/openclaw) 和 [Agent send](/tools/agent-send)。

CLI 傳送：

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

另請檢查：

- 目標頻道是否支援出站媒體且未被允許清單封鎖。
- 檔案是否在供應商的尺寸限制內 (圖片會調整為最大 2048px)。

請參閱 [Images](/nodes/images)。

## 安全和存取控制

### 將 OpenClaw 暴露給傳入私訊安全嗎？

將傳入私訊視為不可信任的輸入。預設設定旨在降低風險：

- 在支援私訊的頻道上，預設行為是**配對**：
  - 未知傳送者會收到配對碼；智慧代理不會處理他們的訊息。
  - 透過以下方式批准：`openclaw pairing approve <channel> <code>`
  - 待處理請求每個頻道最多**3 個**；如果沒有收到配對碼，請檢查 `openclaw pairing list <channel>`。
- 公開私訊需要明確選擇加入 (`dmPolicy: "open"` 並允許 `"*"`)。

執行 `openclaw doctor` 以顯示有風險的私訊政策。

### 提示注入只對公開智慧代理構成威脅嗎？

不是。提示注入與**不可信任的內容**有關，而不僅僅是誰可以私訊智慧代理。
如果您的助理讀取外部內容 (網路搜尋/擷取、瀏覽器頁面、電子郵件、
文件、附件、貼上的日誌)，該內容可能包含試圖劫持模型的指令。這甚至可能發生在**您是唯一傳送者**時。

最大的風險是當工具啟用時：模型可能被欺騙以竊取上下文或代表您呼叫工具。透過以下方式降低影響範圍：

- 使用唯讀或禁用工具的「閱讀器」智慧代理來摘要不可信任的內容
- 保持 `web_search` / `web_fetch` / `browser` 對於啟用工具的智慧代理為關閉狀態
- 沙箱隔離和嚴格的工具允許清單

詳細資訊：[Security](/gateway/security)。

### 我的智慧代理應該有自己的電子郵件 GitHub 帳戶或電話號碼嗎？

是的，對於大多數設定來說。將智慧代理與單獨的帳戶和電話號碼隔離可以降低萬一出現問題時的影響範圍。這也使得輪換憑證或撤銷存取權限更容易，而不會影響您的個人帳戶。

從小處著手。僅提供對您實際需要的工具和帳戶的存取權限，如果需要，稍後再擴展。

文件：[Security](/gateway/security)、[Pairing](/channels/pairing)。

### 我可以賦予它對我的簡訊的自主權嗎？這安全嗎？

我們**不**建議對您的個人訊息擁有完全自主權。最安全的模式是：

- 讓私訊處於**配對模式**或嚴格的允許清單中。
- 如果您希望它代表您傳送訊息，請使用**單獨的號碼或帳戶**。
- 讓它起草，然後**在傳送前批准**。

如果您想進行實驗，請在專用帳戶上進行並保持隔離。請參閱
[Security](/gateway/security)。

### 我可以用更便宜的模型來執行個人助理任務嗎？

可以，**如果**智慧代理僅限聊天且輸入受信任。較小的層級更容易受到指令劫持，因此請避免將它們用於啟用工具的智慧代理或在讀取不可信任內容時使用。如果您必須使用較小的模型，請鎖定工具並在沙箱隔離中執行。請參閱 [Security](/gateway/security)。

### 我在 Telegram 中執行 `/start` 但沒有收到配對碼

配對碼僅在未知傳送者向智慧代理傳送訊息且
`dmPolicy: "pairing"` 已啟用時傳送。單獨的 `/start` 不會生成配對碼。

檢查待處理請求：

```bash
openclaw pairing list telegram
```

如果您想立即存取，請將您的傳送者 ID 加入白名單或將該帳戶的 `dmPolicy` 設定為 `"open"`。

### WhatsApp：它會傳送訊息給我的聯絡人嗎？配對是如何運作的？

不會。WhatsApp 私訊的預設策略是**配對**。未知傳送者只會收到一個配對碼，他們的訊息**不會被處理**。OpenClaw 只會回覆它收到的聊天訊息或您明確觸發的傳送。

透過以下方式批准配對：

```bash
openclaw pairing approve whatsapp <code>
```

列出待處理請求：

```bash
openclaw pairing list whatsapp
```

精靈電話號碼提示：它用於設定您的**允許清單/擁有者**，以便允許您自己的私訊。它不適用於自動傳送。如果您在個人 WhatsApp 號碼上執行，請使用該號碼並啟用 `channels.whatsapp.selfChatMode`。

## 聊天指令、中止任務和「它停不下來」

### 如何阻止內部系統訊息顯示在聊天中？

大多數內部或工具訊息僅在該工作階段啟用**詳細資訊**或**推理**時才會出現。

在您看到它的聊天中修復：

```
/verbose off
/reasoning off
```

如果仍然很吵雜，請檢查控制 UI 中的工作階段設定，並將詳細資訊設定為**繼承**。同時確認您沒有在設定中使用 `verboseDefault` 設定為 `on` 的智慧代理設定檔。

文件：[Thinking and verbose](/tools/thinking)、[Security](/gateway/security#reasoning--verbose-output-in-groups)。

### 如何停止/取消正在執行的任務？

將以下任何一個**作為獨立訊息**傳送 (沒有斜線)：

```
stop
abort
esc
wait
exit
interrupt
```

這些是中止觸發器 (不是斜線指令)。

對於背景進程 (來自執行工具)，您可以要求智慧代理執行：

```
process action:kill sessionId:XXX
```

斜線指令概述：請參閱 [Slash commands](/tools/slash-commands)。

大多數指令必須作為以 `/` 開頭的**獨立**訊息傳送，但少數快捷方式 (例如 `/status`) 也可以內嵌用於允許清單中的傳送者。

### 如何從 Telegram 傳送 Discord 訊息？(「不允許跨上下文訊息」)

OpenClaw 預設會封鎖**跨供應商**訊息傳送。如果工具呼叫繫結到 Telegram，
除非您明確允許，否則它不會傳送到 Discord。

為智慧代理啟用跨供應商訊息傳送：

```json5
{
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marker: { enabled: true, prefix: "[來自 {channel}] " },
          },
        },
      },
    },
  },
}
```

編輯設定後重新啟動 Gateway。如果您只希望單一
智慧代理使用此功能，請改為在 `agents.list[].tools.message` 下設定。

### 為什麼感覺智慧代理「忽略」了快速傳送的訊息？

佇列模式控制新訊息如何與正在執行的執行互動。使用 `/queue` 更改模式：

- `steer` - 新訊息重新導向當前任務
- `followup` - 一次執行一條訊息
- `collect` - 批次處理訊息並回覆一次 (預設)
- `steer-backlog` - 現在引導，然後處理積壓工作
- `interrupt` - 中止當前執行並重新開始

您可以新增選項，例如 `debounce:2s cap:25 drop:summarize`，用於後續模式。

## 回答螢幕截圖/聊天日誌中的確切問題

**問：「Anthropic 與 API 密鑰的預設模型是什麼？」**

**答**：在 OpenClaw 中，憑證和模型選擇是分開的。設定 `ANTHROPIC_API_KEY` (或在驗證設定檔中儲存 Anthropic API 密鑰) 可啟用驗證，但實際的預設模型是您在 `agents.defaults.model.primary` 中設定的任何內容 (例如 `anthropic/claude-sonnet-4-5` 或 `anthropic/claude-opus-4-6`)。如果您看到 `No credentials found for profile "anthropic:default"`，這表示 Gateway 在正在執行的智慧代理的預期 `auth-profiles.json` 中找不到 Anthropic 憑證。

---

仍然遇到問題？在 [Discord](https://discord.com/invite/clawd) 中提問或開啟 [GitHub 討論](https://github.com/openclaw/openclaw/discussions)。
