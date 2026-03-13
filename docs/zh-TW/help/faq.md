---
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"
read_when:
  - "Answering common setup, install, onboarding, or runtime support questions"
  - Triaging user-reported issues before deeper debugging
title: FAQ
---

# FAQ

快速解答加上針對實際環境的深入故障排除（本地開發、VPS、多代理、OAuth/API 金鑰、模型故障轉移）。有關執行時診斷，請參見 [Troubleshooting](/gateway/troubleshooting)。有關完整的設定參考，請參見 [Configuration](/gateway/configuration)。

## 目錄

- [快速開始與首次設定]
  - [我卡住了，最快的解決方法是什麼？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [安裝和設置 OpenClaw 的推薦方法是什麼？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [如何在入門後打開儀表板？](#how-do-i-open-the-dashboard-after-onboarding)
  - [如何在本地與遠端之間驗證儀表板 (token)？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [我需要什麼執行時？](#what-runtime-do-i-need)
  - [它可以在 Raspberry Pi 上執行嗎？](#does-it-run-on-raspberry-pi)
  - [有關 Raspberry Pi 安裝的任何建議嗎？](#any-tips-for-raspberry-pi-installs)
  - [它卡在「喚醒我的朋友」/入門無法啟動。現在該怎麼辦？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [我可以將我的設置遷移到新機器 (Mac mini) 而不重新進行入門嗎？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [我在哪裡可以看到最新版本中的新功能？](#where-do-i-see-what-is-new-in-the-latest-version)
  - [我無法訪問 docs.openclaw.ai (SSL 錯誤)。現在該怎麼辦？](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [穩定版和測試版之間有什麼區別？](#whats-the-difference-between-stable-and-beta)
  - [我如何安裝測試版，測試版和開發版之間有什麼區別？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [我如何嘗試最新版本？](#how-do-i-try-the-latest-bits)
  - [安裝和入門通常需要多長時間？](#how-long-does-install-and-onboarding-usually-take)
  - [安裝程序卡住了？我該如何獲取更多反饋？](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows 安裝顯示找不到 git 或 OpenClaw 未被識別](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Windows 執行輸出顯示亂碼中文文本，我該怎麼辦](#windows-exec-output-shows-garbled-chinese-text-what-should-i-do)
  - [文檔沒有回答我的問題 - 我該如何獲得更好的答案？](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [我如何在 Linux 上安裝 OpenClaw？](#how-do-i-install-openclaw-on-linux)
  - [我如何在 VPS 上安裝 OpenClaw？](#how-do-i-install-openclaw-on-a-vps)
  - [雲端/VPS 安裝指南在哪裡？](#where-are-the-cloudvps-install-guides)
  - [我可以要求 OpenClaw 自行更新嗎？](#can-i-ask-openclaw-to-update-itself)
  - [入門精靈實際上做了什麼？](#what-does-the-onboarding-wizard-actually-do)
  - [我需要 Claude 或 OpenAI 訂閱才能執行這個嗎？](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [我可以在沒有 API 金鑰的情況下使用 Claude Max 訂閱嗎？](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic 的「setup-token」驗證是如何工作的？](#how-does-anthropic-setuptoken-auth-work)
  - [我在哪裡可以找到 Anthropic 的 setup-token？](#where-do-i-find-an-anthropic-setuptoken)
  - [你們支援 Claude 訂閱驗證 (Claude Pro 或 Max) 嗎？](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [為什麼我會看到 `HTTP 429: rate_limit_error` 來自 Anthropic？](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock 支援嗎？](#is-aws-bedrock-supported)
  - [Codex 驗證是如何工作的？](#how-does-codex-auth-work)
  - [你們支援 OpenAI 訂閱驗證 (Codex OAuth) 嗎？](#do-you-support-openai-subscription-auth-codex-oauth)
  - [我如何設置 Gemini CLI OAuth？](#how-do-i-set-up-gemini-cli-oauth)
  - [本地模型適合隨意聊天嗎？](#is-a-local-model-ok-for-casual-chats)
  - [我如何保持託管模型流量在特定區域？](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [我必須購買 Mac Mini 才能安裝這個嗎？](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [我需要 Mac mini 來支援 iMessage 嗎？](#do-i-need-a-mac-mini-for-imessage-support)
  - [如果我購買 Mac mini 來執行 OpenClaw，我可以將其連接到我的 MacBook Pro 嗎？](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [我可以使用 Bun 嗎？](#can-i-use-bun)
  - [Telegram: `allowFrom` 裡面應該放什麼？](#telegram-what-goes-in-allowfrom)
  - [多個人可以使用同一 WhatsApp 號碼與不同的 OpenClaw 實例嗎？](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [我可以同時執行「快速聊天」代理和「編碼用的 Opus」代理嗎？](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew 在 Linux 上有效嗎？](#does-homebrew-work-on-linux)
  - [可駭的 (git) 安裝和 npm 安裝之間有什麼區別？](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [我可以在以後在 npm 和 git 安裝之間切換嗎？](#can-i-switch-between-npm-and-git-installs-later)
  - [我應該在我的筆記本電腦上還是 VPS 上執行 Gateway？](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [在專用機器上執行 OpenClaw 有多重要？](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [最低 VPS 要求和推薦的作業系統是什麼？](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [我可以在 VM 中執行 OpenClaw 嗎？要求是什麼？](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [什麼是 OpenClaw？](#what-is-openclaw)
  - [OpenClaw 是什麼，簡單來說？](#what-is-openclaw-in-one-paragraph)
  - [價值主張是什麼？](#whats-the-value-proposition)
  - [我剛設置好，應該先做什麼？](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw 的五大日常使用案例是什麼？](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw 可以幫助進行 SaaS 的潛在客戶開發、廣告和博客嗎？](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [與 Claude Code 在網頁開發方面的優勢是什麼？](#what-are-the-advantages-vs-claude-code-for-web-development)
- [技能與自動化](#skills-and-automation)
  - [我如何自定義技能而不弄髒倉庫？](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [我可以從自定義資料夾加載技能嗎？](#can-i-load-skills-from-a-custom-folder)
  - [我如何為不同的任務使用不同的模型？](#how-can-i-use-different-models-for-different-tasks)
  - [機器人在進行重工作時凍結了。我該如何卸載這些工作？](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron 或提醒未觸發。我該檢查什麼？](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [我如何在 Linux 上安裝技能？](#how-do-i-install-skills-on-linux)
  - [OpenClaw 可以按計劃或持續在背景中執行任務嗎？](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [我可以從 Linux 執行僅限 Apple macOS 的技能嗎？](#can-i-run-apple-macos-only-skills-from-linux)
  - [你們有 Notion 或 HeyGen 整合嗎？](#do-you-have-a-notion-or-heygen-integration)
  - [我如何安裝 Chrome 擴充以進行瀏覽器接管？](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [沙盒與記憶體](#sandboxing-and-memory)
  - [有專門的沙盒文檔嗎？](#is-there-a-dedicated-sandboxing-doc)
  - [我如何將主機資料夾綁定到沙盒中？](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [記憶體是如何運作的？](#how-does-memory-work)
  - [記憶體不斷忘記事情。我該如何讓它記住？](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [記憶體會永遠持久嗎？有什麼限制？](#does-memory-persist-forever-what-are-the-limits)
  - [語義記憶搜索需要 OpenAI API 金鑰嗎？](#does-semantic-memory-search-require-an-openai-api-key)
- [資料在磁碟上的存放位置](#where-things-live-on-disk)
  - [所有與 OpenClaw 使用的資料都保存在本地嗎？](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw 將資料存放在哪裡？](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md 應該放在哪裡？](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [推薦的備份策略是什麼？](#whats-the-recommended-backup-strategy)
  - [我如何完全卸載 OpenClaw？](#how-do-i-completely-uninstall-openclaw)
  - [代理可以在工作區外工作嗎？](#can-agents-work-outside-the-workspace)
  - [我在遠端模式中 - 會話存儲在哪裡？](#im-in-remote-mode-where-is-the-session-store)
- [設定基礎](#config-basics)
  - [設定的格式是什麼？在哪裡？](#what-format-is-the-config-where-is-it)
  - [我設置了 `gateway.bind: "lan"` (或 `"tailnet"`)，現在沒有任何東西在監聽 / UI 顯示未授權](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [為什麼我現在在本地需要 token？](#why-do-i-need-a-token-on-localhost-now)
  - [更改設定後我必須重新啟動嗎？](#do-i-have-to-restart-after-changing-config)
  - [我如何禁用有趣的 CLI 標語？](#how-do-i-disable-funny-cli-taglines)
  - [我如何啟用網頁搜索 (和網頁提取)？](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply 刪除了我的設定。我該如何恢復並避免這種情況？](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [我如何執行一個中央 Gateway，並在各設備之間使用專門的工作者？](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [OpenClaw 瀏覽器可以無頭執行嗎？](#can-the-openclaw-browser-run-headless)
  - [我如何使用 Brave 進行瀏覽器控制？](#how-do-i-use-brave-for-browser-control)
- [遠端網關與節點](#remote-gateways-and-nodes)
  - [命令如何在 Telegram、網關和節點之間傳播？](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [如果 Gateway 遠端託管，我的代理如何訪問我的電腦？](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale 已連接但我沒有收到回覆。現在該怎麼辦？](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [兩個 OpenClaw 實例可以互相通訊嗎 (本地 + VPS)？](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [我需要為多個代理購買單獨的 VPS 嗎？](#do-i-need-separate-vpses-for-multiple-agents)
  - [在我的個人筆記本上使用節點而不是從 VPS SSH 有什麼好處？](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [節點執行網關服務嗎？](#do-nodes-run-a-gateway-service)
  - [有沒有 API / RPC 方法來應用設定？](#is-there-an-api-rpc-way-to-apply-config)
  - [首次安裝的最小「合理」設定是什麼？](#whats-a-minimal-sane-config-for-a-first-install)
  - [我如何在 VPS 上設置 Tailscale 並從我的 Mac 連接？](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [我如何將 Mac 節點連接到遠端 Gateway (Tailscale Serve)？](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [我應該在第二台筆記本上安裝還是僅添加一個節點？](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [環境變數與 .env 加載](#env-vars-and-env-loading)
  - [OpenClaw 如何加載環境變數？](#how-does-openclaw-load-environment-variables)
  - [「我通過服務啟動了 Gateway，但我的環境變數消失了。」現在該怎麼辦？](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [我設置了 `COPILOT_GITHUB_TOKEN`，但模型狀態顯示「Shell env: off。」為什麼？](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [會話與多個聊天](#sessions-and-multiple-chats)
  - [我如何開始一個新的對話？](#how-do-i-start-a-fresh-conversation)
  - [如果我從未發送 `/new`，會話會自動重置嗎？](#do-sessions-reset-automatically-if-i-never-send-new)
  - [有沒有辦法讓一組 OpenClaw 實例成為一個 CEO 和多個代理？](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [為什麼上下文在任務中途被截斷？我該如何防止？](#why-did-context-get-truncated-mid-task-how-do-i-prevent-it)
  - [我如何完全重置 OpenClaw，但保持其安裝？](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [我收到「上下文過大」的錯誤 - 我該如何重置或壓縮？](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [為什麼我會看到「LLM 請求被拒絕：messages.content.tool_use.input 欄位必填」？](#why-am-i-seeing-llm-request-rejected-messagescontenttool_useinput-field-required)
  - [為什麼我每 30 分鐘會收到心跳消息？](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [我需要將「機器人帳戶」添加到 WhatsApp 群組中嗎？](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [我如何獲取 WhatsApp 群組的 JID？](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [為什麼 OpenClaw 不在群組中回覆？](#why-doesnt-openclaw-reply-in-a-group)
  - [群組/線程與 DM 共享上下文嗎？](#do-groupsthreads-share-context-with-dms)
  - [我可以創建多少個工作區和代理？](#how-many-workspaces-and-agents-can-i-create)
  - [我可以同時執行多個機器人或聊天 (Slack)，我應該如何設置？](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [模型：預設、選擇、別名、切換](#models-defaults-selection-aliases-switching)
  - [什麼是「預設模型」？](#what-is-the-default-model)
  - [你推薦什麼模型？](#what-model-do-you-recommend)
  - [我如何在不清除設定的情況下切換模型？](#how-do-i-switch-models-without-wiping-my-config)
  - [我可以使用自託管模型 (llama.cpp, vLLM, Ollama) 嗎？](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw、Flawd 和 Krill 使用什麼模型？](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [我如何在不重新啟動的情況下即時切換模型？](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [我可以將 GPT 5.2 用於日常任務，將 Codex 5.3 用於編碼嗎？](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [為什麼我會看到「模型 … 不被允許」然後沒有回覆？](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [為什麼我會看到「未知模型：minimax/MiniMax-M2.5」？](#why-do-i-see-unknown-model-minimaxminimaxm25)
  - [我可以將 MiniMax 設為我的預設模型，並將 OpenAI 用於複雜任務嗎？](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt 是內建的快捷方式嗎？](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [我如何定義/覆蓋模型快捷方式 (別名)？](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [我如何從其他提供者（如 OpenRouter 或 Z.AI）添加模型？](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [模型故障轉移與「所有模型均失敗」](#model-failover-and-all-models-failed)
  - [故障轉移是如何運作的？](#how-does-failover-work)
  - [這個錯誤意味著什麼？](#what-does-this-error-mean)
  - [修復檢查清單 `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [為什麼它也嘗試了 Google Gemini 並失敗？](#why-did-it-also-try-google-gemini-and-fail)
- [驗證設定：它們是什麼以及如何管理](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [什麼是驗證設定？](#what-is-an-auth-profile)
  - [典型的設定 ID 是什麼？](#what-are-typical-profile-ids)
  - [我可以控制哪個驗證設定優先嘗試嗎？](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth 與 API 金鑰：有什麼區別？](#oauth-vs-api-key-whats-the-difference)
- [網關：端口、「已在執行」和遠端模式](#gateway-ports-already-running-and-remote-mode)
  - [網關使用什麼端口？](#what-port-does-the-gateway-use)
  - [為什麼 `openclaw gateway status` 說 `Runtime: running` 但 `RPC probe: failed`？](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [為什麼 `openclaw gateway status` 顯示 `Config (cli)` 和 `Config (service)` 不同？](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [「另一個網關實例已在監聽」意味著什麼？](#what-does-another-gateway-instance-is-already-listening-mean)
  - [我如何在遠端模式下執行 OpenClaw (用戶端連接到其他地方的 Gateway)？](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [控制 UI 顯示「未授權」(或不斷重新連接)。現在該怎麼辦？](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [我設置了 `gateway.bind: "tailnet"` 但無法綁定 / 沒有東西在監聽](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [我可以在同一主機上執行多個網關嗎？](#can-i-run-multiple-gateways-on-the-same-host)
  - [「無效的握手」/ 程式碼 1008 是什麼意思？](#what-does-invalid-handshake-code-1008-mean)
- [日誌與除錯](#logging-and-debugging)
  - [日誌在哪裡？](#where-are-logs)
  - [我如何啟動/停止/重啟網關服務？](#how-do-i-startstoprestart-the-gateway-service)
  - [我在 Windows 上關閉了終端 - 我如何重新啟動 OpenClaw？](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [網關已啟動，但回覆從未到達。我該檢查什麼？](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [「與網關斷開連接：無原因」 - 現在該怎麼辦？](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands 失敗。我該檢查什麼？](#telegram-setmycommands-fails-what-should-i-check)
  - [TUI 沒有輸出。我該檢查什麼？](#tui-shows-no-output-what-should-i-check)
  - [我如何完全停止然後啟動網關？](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` 與 `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [當某些事情失敗時，獲取更多詳細資訊的最快方法是什麼？](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [媒體與附件](#media-and-attachments)
  - [我的技能生成了一個圖像/PDF，但什麼都沒有發送](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [安全性與訪問控制](#security-and-access-control)
  - [將 OpenClaw 暴露於進入的 DM 是安全的嗎？](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [提示注入僅是公共機器人的問題嗎？](#is-prompt-injection-only-a-concern-for-public-bots)
  - [我的機器人應該有自己的電子郵件 GitHub 帳戶或電話號碼嗎？](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [我可以給它自主權來控制我的簡訊，這樣安全嗎？](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [我可以使用更便宜的模型來執行個人助理任務嗎？](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [我在 Telegram 中執行 `/start` 但沒有獲得配對碼](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp：它會發送消息給我的聯絡人嗎？配對是如何工作的？](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [聊天命令、終止任務和「它不會停止」](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [我如何阻止內部系統消息在聊天中顯示](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [我如何停止/取消正在執行的任務？](#how-do-i-stopcancel-a-running-task)
  - [我如何從 Telegram 發送 Discord 消息？（「跨上下文消息傳遞被拒絕」）](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [為什麼感覺機器人「忽略」快速發送的消息？](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 如果出現問題的前60秒

1. **快速狀態（第一次檢查）**

```bash
   openclaw status
```

快速本地摘要：作業系統 + 更新、網關/服務可達性、代理/會話、提供者設定 + 執行時問題（當網關可達時）。

2. **可貼上報告（安全分享）**

```bash
   openclaw status --all
```

只讀診斷與日誌尾部（已隱藏token）。

3. **守護進程 + 端口狀態**

```bash
   openclaw gateway status
```

顯示監督者執行時與 RPC 可達性、探測目標 URL，以及服務可能使用的設定。

4. **深度探測**

```bash
   openclaw status --deep
```

執行閘道健康檢查 + 提供者探測（需要可達的閘道）。請參見 [Health](/gateway/health)。

5. **尾隨最新日誌**

```bash
   openclaw logs --follow
```

如果 RPC 當機，請回退到：

```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
```

檔案日誌與服務日誌是分開的；請參見 [Logging](/logging) 和 [Troubleshooting](/gateway/troubleshooting)。

6. **執行檢查工具 (修復)**

```bash
   openclaw doctor
```

修復/遷移設定/狀態 + 執行健康檢查。請參見 [Doctor](/gateway/doctor)。

7. **閘道快照**

```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
```

向執行中的網關請求完整快照（僅限 WS）。請參閱 [Health](/gateway/health)。

## 快速開始與首次執行設置

### 我卡住了，最快的解決方法是什麼？

使用可以**查看您機器**的本地 AI 代理。這比在 Discord 上詢問要有效得多，因為大多數「我卡住了」的情況都是**本地設定或環境問題**，遠端的幫助者無法檢查。

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

這些工具可以讀取倉庫、執行命令、檢查日誌，並幫助修復您的機器級設置（PATH、服務、權限、身份驗證檔案）。請通過可修改的 (git) 安裝給予它們 **完整的源碼檢出**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

這是從 git 檢出安裝 OpenClaw \*\*，因此代理可以讀取程式碼和文檔，並推斷您正在執行的確切版本。您可以隨時通過重新執行安裝程式而不帶 `--install-method git` 來切換回穩定版本。

提示：請要求代理人**計劃和監督**修復（逐步進行），然後僅執行必要的命令。這樣可以保持變更小且更容易審核。

如果您發現了真正的錯誤或修正，請提交 GitHub 問題或發送 PR：
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

開始使用這些指令（在尋求幫助時分享輸出）：

```bash
openclaw status
openclaw models status
openclaw doctor
```

[[BLOCK_1]]

- `openclaw status`: 門戶/代理健康狀態的快速快照 + 基本設定。
- `openclaw models status`: 檢查提供者的身份驗證 + 模型可用性。
- `openclaw doctor`: 驗證並修復常見的設定/狀態問題。

其他有用的 CLI 檢查：`openclaw status --all`、`openclaw logs --follow`、`openclaw gateway status`、`openclaw health --verbose`。

快速除錯循環：[前 60 秒如果有問題](#first-60-seconds-if-somethings-broken)。  
安裝文件：[安裝](/install)、[安裝旗標](/install/installer)、[更新](/install/updating)。

### 安裝和設置 OpenClaw 的推薦方法

[[BLOCK_1]]  
要安裝和設置 OpenClaw，建議按照以下步驟進行：

1. **下載 OpenClaw**  
   前往 OpenClaw 的官方網站，下載最新版本的安裝包。

2. **安裝依賴項**  
   確保您的系統已安裝所有必要的依賴項。您可以參考官方文檔中的依賴項列表。

3. **執行安裝程式**  
   解壓下載的安裝包，然後執行安裝程式。根據提示完成安裝過程。

4. **設定環境變數**  
   安裝完成後，根據需要設定環境變數，以便能夠在命令行中輕鬆訪問 OpenClaw。

5. **驗證安裝**  
   打開終端機，輸入 openclaw --version 來確認 OpenClaw 是否正確安裝。

6. **參考文檔**  
   訪問 OpenClaw 的官方文檔，了解如何進一步設定和使用該工具。

[[BLOCK_2]]  
遵循這些步驟，您應該能夠順利安裝和設置 OpenClaw。

該倉庫建議從源碼執行並使用入門向導：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

巫師還可以自動建立 UI 資產。在完成入門後，您通常會在 **18789** 埠上執行 Gateway。

來自來源（貢獻者/開發者）：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw onboard
```

如果你還沒有全域安裝，請透過 `pnpm openclaw onboard` 執行。

### 如何在完成入門後打開儀表板

精靈在您完成註冊後會立即打開一個乾淨的（非標記化的）儀表板 URL，並在摘要中列印該連結。請保持該標籤頁開啟；如果沒有啟動，請在同一台機器上複製/粘貼列印的 URL。

### 如何在本地端與遠端驗證儀表板的 token

**Localhost (同一台機器):**

- 開啟 `http://127.0.0.1:18789/`。
- 如果要求身份驗證，請將 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）中的 token 貼到控制介面設定中。
- 從網關主機取得它：`openclaw config get gateway.auth.token`（或生成一個：`openclaw doctor --generate-gateway-token`）。

**不在本地主機上：**

- **Tailscale Serve**（推薦）：保持綁定回環，執行 `openclaw gateway --tailscale serve`，打開 `https://<magicdns>/`。如果 `gateway.auth.allowTailscale` 是 `true`，身份標頭滿足控制 UI/WebSocket 認證（無需 token，假設為受信任的網關主機）；HTTP API 仍然需要 token/密碼。
- **Tailnet 綁定**：執行 `openclaw gateway --bind tailnet --token "<token>"`，打開 `http://<tailscale-ip>:18789/`，在儀表板設定中粘貼 token。
- **SSH 隧道**：`ssh -N -L 18789:127.0.0.1:18789 user@host` 然後打開 `http://127.0.0.1:18789/` 並在控制 UI 設定中粘貼 token。

請參閱 [Dashboard](/web/dashboard) 和 [Web surfaces](/web) 以獲取綁定模式和認證詳細資訊。

### 我需要什麼執行環境

需要 Node **>= 22**。建議使用 `pnpm`。不建議在 Gateway 上使用 Bun。

### 它可以在 Raspberry Pi 上執行嗎

是的。Gateway 是輕量級的 - 文件列出 **512MB-1GB RAM**、**1 顆核心**，以及約 **500MB** 的磁碟空間作為個人使用的足夠條件，並且注意到 **Raspberry Pi 4 可以執行它**。

如果您需要額外的空間（日誌、媒體、其他服務），**建議使用 2GB**，但這並不是硬性最低要求。

提示：一台小型的 Pi/VPS 可以用來托管 Gateway，您可以在您的筆記型電腦/手機上配對 **nodes** 以進行本地螢幕/相機/畫布或命令執行。請參見 [Nodes](/nodes)。

### Raspberry Pi 安裝的建議

[[BLOCK_1]]

1. **選擇合適的作業系統**：根據你的需求選擇適合的作業系統，例如 Raspberry Pi OS、Ubuntu 或其他輕量級的 Linux 發行版。

2. **使用官方映像檔**：從 Raspberry Pi 官方網站下載最新的映像檔，確保你使用的是最新版本，以獲得最佳的性能和安全性。

3. **準備好必要的硬體**：確保你擁有適當的電源供應器、SD 卡（建議使用 Class 10 或更高速度的卡）、散熱片和外殼等配件。

4. **使用 Etcher 進行燒錄**：使用 Etcher 或其他燒錄工具將映像檔寫入 SD 卡，這樣可以簡化過程並減少錯誤。

5. **定期更新系統**：安裝完成後，記得定期執行系統更新，以確保所有軟體都是最新的。

6. **備份你的系統**：在進行重大更改之前，建議備份你的 SD 卡，以防止資料遺失。

7. **使用 SSH 遠端管理**：如果你不想每次都連接顯示器，可以啟用 SSH 來遠端管理你的 Raspberry Pi。

8. **參考社群資源**：利用 Raspberry Pi 的官方論壇和社群資源，尋找解決方案和靈感。

[[BLOCK_2]]  
這些建議可以幫助你順利安裝和使用 Raspberry Pi，讓你能夠充分發揮其潛力。

簡短版本：它可以運作，但請預期會有一些粗糙的地方。

- 使用 **64 位元** 作業系統，並保持 Node 版本 >= 22。
- 優先選擇 **可修改的 (git) 安裝**，這樣你可以查看日誌並快速更新。
- 開始時不使用頻道/技能，然後逐一添加它們。
- 如果遇到奇怪的二進位問題，通常是 **ARM 相容性** 問題。

Docs: [Linux](/platforms/linux), [安裝](/install).

### 它在「喚醒我的朋友」的入門過程中卡住了，無法完成。現在該怎麼辦？

該螢幕取決於網關是否可達且已通過身份驗證。TUI 在第一次啟動時也會自動發送「醒來吧，我的朋友！」。如果您看到該行且**沒有回覆**，並且 token 保持在 0，則代理從未執行。

1. 重新啟動網關：

```bash
openclaw gateway restart
```

2. 檢查狀態 + 認證:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. 如果仍然無法執行，請執行：

```bash
openclaw doctor
```

如果網關是遠端的，請確保隧道/Tailscale 連線正常，並且使用者介面指向正確的網關。請參閱 [Remote access](/gateway/remote)。

### 我可以將我的設置遷移到新的 Mac mini 而不重新進行入門設定嗎？

是的。複製 **state directory** 和 **workspace**，然後執行一次 Doctor。這樣可以保持您的機器人「完全相同」（記憶、會話歷史、認證和通道狀態），只要您複製 **這兩個** 位置：

1. 在新機器上安裝 OpenClaw。
2. 從舊機器複製 `$OPENCLAW_STATE_DIR` (預設: `~/.openclaw`)。
3. 複製你的工作區 (預設: `~/.openclaw/workspace`)。
4. 執行 `openclaw doctor` 並重新啟動 Gateway 服務。

這樣可以保留設定、身份驗證檔案、WhatsApp 憑證、會話和記憶體。如果您處於遠端模式，請記住網關主機擁有會話存儲和工作區。

**重要：** 如果你只將工作區提交/推送到 GitHub，你只是備份了 **記憶體 + 啟動檔案**，但 **不** 包括會話歷史或認證。這些資料存放在 `~/.openclaw/` （例如 `~/.openclaw/agents/<agentId>/sessions/`）。

相關內容: [遷移](/install/migrating), [檔案在磁碟上的儲存位置](/help/faq#where-does-openclaw-store-its-data),
[代理工作區](/concepts/agent-workspace), [醫生](/gateway/doctor),
[遠端模式](/gateway/remote)。

### 我在哪裡可以查看最新版本的更新內容

[[BLOCK_1]]

最新的條目位於最上方。如果最上面的部分標記為 **Unreleased**，則下一個有日期的部分是最新的已發佈版本。條目依據 **Highlights**、**Changes** 和 **Fixes** 分組（必要時還包括 docs/其他部分）。

### 我無法訪問 docs.openclaw.ai SSL 錯誤，該怎麼辦？

某些 Comcast/Xfinity 連線錯誤地透過 Xfinity 進階安全性阻擋了 `docs.openclaw.ai`。請禁用它或將 `docs.openclaw.ai` 加入允許清單，然後重試。更多詳細資訊請參考：[故障排除](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity)。請透過以下連結幫助我們解除阻擋：[https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status)。

如果您仍然無法訪問該網站，文件已在 GitHub 上鏡像：
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 穩定版與測試版的差異

穩定版（Stable）是指經過充分測試且被認為是可靠的版本，適合用於生產環境。這些版本通常不會有重大錯誤，並且提供了完整的功能。

測試版（Beta）則是尚在測試階段的版本，可能包含新功能和改進，但也可能存在未解決的錯誤或不穩定的情況。測試版通常用於收集用戶反饋，以便在正式發布之前進行調整和修正。

**Stable** 和 **beta** 是 **npm dist-tags**，而不是獨立的程式碼行：

- `latest` = 穩定版
- `beta` = 測試用的早期版本

我們將版本發送到 **beta**，進行測試，當一個版本穩定後，我們會 **將該版本提升至 `latest`**。這就是為什麼 beta 和穩定版可以指向 **相同版本** 的原因。

請查看變更內容：
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 如何安裝測試版，測試版和開發版有什麼不同

**Beta** 是 npm 的發佈標籤 `beta`（可能與 `latest` 匹配）。  
**Dev** 是 `main`（git）的移動頭；當發佈時，它使用 npm 的發佈標籤 `dev`。

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows 安裝程式 (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

更多細節：[[BLOCK_1]] [開發通道](/install/development-channels) 和 [[BLOCK_2]] [安裝器標誌](/install/installer)。[[BLOCK_3]]

### 安裝和上線通常需要多長時間

[[BLOCK_1]]

- **安裝：** 2-5 分鐘
- **上手：** 5-15 分鐘，取決於您設定了多少個頻道/模型

如果安裝程式卡住，請使用 [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback) 以及 [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck) 中的快速除錯迴圈。

### 我該如何嘗試最新版本

[[BLOCK_1]]  
兩個選項：  
[[BLOCK_1]]

1. **開發頻道 (git checkout):**

```bash
openclaw update --channel dev
```

這會切換到 `main` 分支並從來源更新。

2. **可破解的安裝（來自安裝程式網站）：**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

這樣會給你一個可以編輯的本地倉庫，然後透過 git 更新。

如果您偏好手動進行乾淨的克隆，請使用：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [更新](/cli/update), [開發頻道](/install/development-channels), [安裝](/install).

### 安裝程式卡住了，我該如何獲得更多反饋？

重新執行安裝程式並使用 **詳細輸出**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Beta 安裝時顯示詳細資訊：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

對於可破解的 (git) 安裝：

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

更多選項：[安裝程式標誌](/install/installer)。

### Windows 安裝顯示找不到 git 或 openclaw 未被識別

兩個常見的 Windows 問題：

**1) npm 錯誤 spawn git / 找不到 git**

- 安裝 **Git for Windows** 並確保 `git` 在你的 PATH 中。
- 關閉並重新打開 PowerShell，然後重新執行安裝程式。

**2) 安裝後無法識別 openclaw**

- 你的 npm 全域 bin 資料夾不在 PATH 中。
- 檢查路徑：

```powershell
  npm config get prefix
```

- 將該目錄添加到您的使用者 PATH（在 Windows 上不需要 `\bin` 後綴；在大多數系統上是 `%AppData%\npm`）。
- 更新 PATH 後，關閉並重新打開 PowerShell。

如果你想要最順暢的 Windows 設定，請使用 **WSL2** 而不是原生 Windows。  
文件：[Windows](/platforms/windows)。

### Windows 執行輸出顯示亂碼中文文本，我該怎麼做

如果在 Windows 上執行命令時，輸出顯示亂碼的中文文本，可以嘗試以下幾個步驟來解決問題：

1. **檢查控制台編碼**：
   確保你的命令提示字元或 PowerShell 使用正確的編碼。可以使用以下命令來設置編碼為 UTF-8：

   chcp 65001

2. **使用適當的字體**：
   確保你的控制台使用支援中文的字體，例如「新細明體」或「微軟正黑體」。

3. **檢查環境變數**：
   確保你的系統環境變數中，LANG 或 LC_ALL 設置為支援中文的值，例如 zh_TW.UTF-8。

4. **使用 PowerShell**：
   如果你在使用命令提示字元時遇到問題，可以嘗試使用 PowerShell，因為它對 Unicode 的支援更好。

5. **檢查應用程式的輸出**：
   如果是某個特定應用程式的輸出出現亂碼，檢查該應用程式的設定，確保它的輸出編碼設置為 UTF-8。

6. **更新系統**：
   確保你的 Windows 系統和所有相關的應用程式都是最新版本，因為更新可能修復編碼相關的問題。

如果以上步驟無法解決問題，考慮尋求更專業的技術支援。

這通常是原生 Windows 命令提示字元的程式碼頁不匹配。

[[BLOCK_1]]

- `system.run`/`exec` 的輸出顯示中文為亂碼
- 相同的指令在另一個終端機設定中顯示正常

在 PowerShell 中的快速解決方法：

```powershell
chcp 65001
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

然後重新啟動 Gateway 並重試您的命令：

```powershell
openclaw gateway restart
```

如果您在最新的 OpenClaw 上仍然重現此問題，請在以下位置追蹤/報告：

- [Issue #30640](https://github.com/openclaw/openclaw/issues/30640)

### 文件沒有回答我的問題，我該如何獲得更好的答案？

使用 **可駭客的 (git) 安裝**，這樣你就可以在本地擁有完整的源碼和文檔，然後從該資料夾詢問你的機器人（或 Claude/Codex），這樣它就能夠讀取該倉庫並準確回答。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

更多細節： [安裝](/install) 和 [安裝程式標誌](/install/installer)。

### 如何在 Linux 上安裝 OpenClaw

簡短回答：請遵循 Linux 指南，然後執行入門精靈。

- Linux 快速路徑 + 服務安裝: [Linux](/platforms/linux)。
- 完整指南: [開始使用](/start/getting-started)。
- 安裝程式 + 更新: [安裝與更新](/install/updating)。

### 如何在 VPS 上安裝 OpenClaw

任何 Linux VPS 都可以使用。在伺服器上安裝，然後使用 SSH/Tailscale 連接到 Gateway。

指南: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).  
遠端存取: [Gateway remote](/gateway/remote).

### cloudVPS 安裝指南在哪裡

我們維護一個**託管中心**，與常見的供應商合作。選擇一個並遵循指南：

- [VPS 主機](/vps)（所有供應商集中於此）
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

在雲端中的運作方式：**Gateway 執行在伺服器上**，您可以透過控制介面 (Control UI) 或 Tailscale/SSH 從您的筆記型電腦/手機訪問它。您的狀態和工作區都存放在伺服器上，因此請將主機視為真相的來源並進行備份。

您可以將 **節點**（Mac/iOS/Android/無頭）配對到該雲端閘道，以訪問本地螢幕/相機/畫布，或在保持閘道在雲端的同時在您的筆記型電腦上執行命令。

Hub: [Platforms](/platforms)。遠端存取: [Gateway remote](/gateway/remote)。  
節點: [Nodes](/nodes)、[Nodes CLI](/cli/nodes)。

### 我可以請 OpenClaw 自我更新嗎

簡短回答：**可能，但不建議**。更新流程可能會重新啟動 Gateway（這會中斷當前會話），可能需要進行乾淨的 git checkout，並且可能會要求確認。更安全的做法是以操作員身份從 shell 執行更新。

使用 CLI:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

如果您必須從代理進行自動化：

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Docs: [更新](/cli/update), [更新中](/install/updating).

### 上線精靈實際上做了什麼

[[BLOCK_1]]  
上線精靈是一個引導工具，旨在幫助用戶快速設置和設定他們的帳戶或應用程式。它通常會提供一系列的步驟，指導用戶完成必要的設置過程，確保他們能夠順利開始使用服務。

[[BLOCK_2]]  
具體來說，上線精靈可能會執行以下幾個功能：

1. **帳戶創建**：協助用戶創建新帳戶，並提供必要的資訊填寫指引。
2. **設置設定**：引導用戶進行初始設置，例如選擇偏好設定或連接其他服務。
3. **功能介紹**：提供應用程式或服務的功能介紹，幫助用戶了解如何使用各項功能。
4. **測試和驗證**：在設置過程中進行測試，確保所有設定正確無誤，並提供即時反饋。

[[BLOCK_3]]  
總之，上線精靈的目的是簡化用戶的入門過程，讓他們能夠更快地熟悉並使用產品。

`openclaw onboard` 是推薦的設置路徑。在 **本地模式** 下，它會引導您完成：

- **模型/身份驗證設置**（支援提供者 OAuth/設置 token 流程和 API 金鑰，以及本地模型選項如 LM Studio）
- **工作區** 位置 + 啟動檔案
- **閘道設定**（綁定/端口/身份驗證/Tailscale）
- **提供者**（WhatsApp、Telegram、Discord、Mattermost（插件）、Signal、iMessage）
- **守護進程安裝**（macOS 上的 LaunchAgent；Linux/WSL2 上的 systemd 使用者單元）
- **健康檢查** 和 **技能** 選擇

它還會警告您如果設定的模型未知或缺少身份驗證。

### 我需要訂閱 Claude 或 OpenAI 才能執行這個嗎？

不可以。您可以使用 **API 金鑰**（Anthropic/OpenAI/其他）或 **僅限本地模型** 來執行 OpenClaw，這樣您的數據就會保留在您的設備上。訂閱（Claude Pro/Max 或 OpenAI Codex）是驗證這些提供者的可選方式。

如果您選擇使用 Anthropic 訂閱授權，請自行決定是否使用：
Anthropic 過去曾阻止某些訂閱在 Claude Code 之外的使用。
OpenAI Codex OAuth 明確支援像 OpenClaw 這樣的外部工具。

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[本地模型](/gateway/local-models), [模型](/concepts/models).

### 我可以在沒有 API 金鑰的情況下使用 Claude Max 訂閱嗎

是的。您可以使用 **setup-token** 進行身份驗證，而不是使用 API 金鑰。這是訂閱路徑。

Claude Pro/Max 訂閱**不包括 API 金鑰**，因此這是訂閱帳戶的技術路徑。但這是你的決定：Anthropic 在過去已經封鎖了一些訂閱在 Claude Code 之外的使用。如果你想要最清晰且最安全的生產支援路徑，請使用 Anthropic API 金鑰。

### Anthropic 的 setup token 認證是如何運作的？

`claude setup-token` 透過 Claude Code CLI 生成 **token 字串**（在網頁控制台中不可用）。您可以在 **任何機器** 上執行它。在精靈中選擇 **Anthropic token (貼上 setup-token)**，或使用 `openclaw models auth paste-token --provider anthropic` 貼上它。該 token 會作為 **anthropic** 提供者的身份驗證設定檔儲存，並像 API 金鑰一樣使用（不會自動刷新）。更多細節請參見: [OAuth](/concepts/oauth)。

### 我在哪裡可以找到 Anthropic setuptoken

它**不**在 Anthropic 控制台中。setup-token 是由 **Claude Code CLI** 在 **任何機器** 上生成的：

```bash
claude setup-token
```

複製它所印出的 token，然後在精靈中選擇 **Anthropic token (貼上 setup-token)**。如果你想在網關主機上執行它，請使用 `openclaw models auth setup-token --provider anthropic`。如果你在其他地方執行了 `claude setup-token`，請在網關主機上使用 `openclaw models auth paste-token --provider anthropic` 貼上它。請參見 [Anthropic](/providers/anthropic)。

### 您是否支援 Claude 訂閱認證（Claude Pro 或 Max）

是的 - 透過 **setup-token**。OpenClaw 不再重複使用 Claude Code CLI 的 OAuth token；請使用 setup-token 或 Anthropic API 金鑰。您可以在任何地方生成token，然後將其貼上在網關主機上。請參閱 [Anthropic](/providers/anthropic) 和 [OAuth](/concepts/oauth)。

重要：這是技術相容性，而非政策保證。Anthropic 過去曾阻止某些訂閱在 Claude Code 之外的使用。您需要決定是否使用它並驗證 Anthropic 當前的條款。對於生產或多用戶工作負載，使用 Anthropic API 金鑰認證是更安全且推薦的選擇。

### 為什麼我會看到來自 Anthropic 的 HTTP 429 速率限制錯誤？

這意味著您目前的 **Anthropic 配額/速率限制** 已經用盡。如果您使用 **Claude 訂閱**（setup-token），請等待窗口重置或升級您的計劃。如果您使用 **Anthropic API 金鑰**，請檢查 Anthropic 控制台以查看使用情況/計費，並根據需要提高限制。

如果訊息是特別的：
`Extra usage is required for long context requests`，該請求正試圖使用
Anthropic 的 1M 上下文測試版 (`context1m: true`)。這僅在您的
憑證符合長上下文計費資格時有效（API 金鑰計費或啟用額外使用的訂閱）。

提示：設置一個 **備用模型**，以便在提供者受到速率限制時，OpenClaw 仍然可以繼續回覆。請參閱 [Models](/cli/models)、[OAuth](/concepts/oauth)，以及 [/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context](/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context)。

### AWS Bedrock 是否受到支援

是的 - 透過 pi-ai 的 **Amazon Bedrock (Converse)** 提供者，使用 **手動設定**。您必須在網關主機上提供 AWS 憑證/區域，並在您的模型設定中添加 Bedrock 提供者條目。請參閱 [Amazon Bedrock](/providers/bedrock) 和 [模型提供者](/providers/models)。如果您偏好管理的金鑰流程，則在 Bedrock 前面使用與 OpenAI 兼容的代理仍然是一個有效的選擇。

### Codex 認證是如何運作的

OpenClaw 支援 **OpenAI Code (Codex)** 透過 OAuth（ChatGPT 登入）。精靈可以執行 OAuth 流程，並在適當時將預設模型設置為 `openai-codex/gpt-5.4`。請參閱 [模型提供者](/concepts/model-providers) 和 [精靈](/start/wizard)。

### 您是否支援 OpenAI 訂閱認證 Codex OAuth

是的。OpenClaw 完全支援 **OpenAI Code (Codex) 訂閱 OAuth**。OpenAI 明確允許在像 OpenClaw 這樣的外部工具/工作流程中使用訂閱 OAuth。入門精靈可以為您執行 OAuth 流程。

請參閱 [OAuth](/concepts/oauth)、[模型提供者](/concepts/model-providers) 和 [精靈](/start/wizard)。

### 如何設置 Gemini CLI OAuth

Gemini CLI 使用 **插件認證流程**，而不是 `openclaw.json` 中的用戶端 ID 或密鑰。

[[BLOCK_1]]  
Steps:  
[[BLOCK_1]]

1. 啟用插件: `openclaw plugins enable google-gemini-cli-auth`
2. 登入: `openclaw models auth login --provider google-gemini-cli --set-default`

這會在閘道主機上的認證設定檔中儲存 OAuth token。詳細資訊請參見：[Model providers](/concepts/model-providers)。

### 本地模型適合隨意聊天嗎

通常不行。OpenClaw 需要大量的上下文和強大的安全性；小型卡片會被截斷並洩漏。如果你必須這樣做，請在本地執行 **最大的** MiniMax M2.5 版本（LM Studio），並查看 [/gateway/local-models](/gateway/local-models)。較小或量化的模型會增加提示注入的風險 - 請參見 [Security](/gateway/security)。

### 如何將託管模型的流量保持在特定區域

選擇區域固定的端點。OpenRouter 提供 MiniMax、Kimi 和 GLM 的美國託管選項；選擇美國託管的變體以保持數據在區域內。您仍然可以通過使用 `models.mode: "merge"` 列出 Anthropic/OpenAI，這樣在尊重您選擇的區域提供者的同時，備用選項仍然可用。

### 我必須購買 Mac Mini 才能安裝這個嗎？

不，OpenClaw 可以在 macOS 或 Linux 上執行（透過 WSL2 在 Windows 上執行）。Mac mini 是可選的 - 有些人會購買一台作為常開的主機，但小型 VPS、家庭伺服器或 Raspberry Pi 類型的設備也可以使用。

您只需要一台 Mac **來使用僅限 macOS 的工具**。對於 iMessage，建議使用 [BlueBubbles](/channels/bluebubbles) - BlueBubbles 伺服器可以在任何 Mac 上執行，而 Gateway 可以在 Linux 或其他地方執行。如果您想要其他僅限 macOS 的工具，請在 Mac 上執行 Gateway 或配對一個 macOS 節點。

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac 遠端模式](/platforms/mac/remote).

### 我需要 Mac mini 來支援 iMessage 嗎？

您需要一台**登入了 Messages 的 macOS 裝置**。這不一定要是 Mac mini - 任何 Mac 都可以。**使用 [BlueBubbles](/channels/bluebubbles)**（推薦）來進行 iMessage - BlueBubbles 伺服器執行在 macOS 上，而 Gateway 可以執行在 Linux 或其他地方。

[[BLOCK_1]]  
常見設置：  
[[BLOCK_1]]

- 在 Linux/VPS 上執行 Gateway，並在任何登入 Messages 的 Mac 上執行 BlueBubbles 伺服器。
- 如果您想要最簡單的單機設置，可以在 Mac 上執行所有內容。

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),  
[Mac 遠端模式](/platforms/mac/remote).

### 如果我購買一台 Mac mini 來執行 OpenClaw，我可以將它連接到我的 MacBook Pro 嗎？

是的。**Mac mini 可以執行 Gateway**，而你的 MacBook Pro 可以作為 **node**（伴隨設備）連接。節點不執行 Gateway - 它們提供額外的功能，例如螢幕/相機/畫布以及 `system.run` 在該設備上。

[[BLOCK_1]]  
常見模式：  
[[BLOCK_1]]

- Mac mini 上的網關（持續執行）。
- MacBook Pro 執行 macOS 應用程式或節點主機並與網關配對。
- 使用 `openclaw nodes status` / `openclaw nodes list` 來查看。

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### 我可以使用 Bun 嗎

Bun **不建議**使用。我們發現執行時錯誤，特別是在 WhatsApp 和 Telegram 上。請使用 **Node** 來建立穩定的網關。

如果你仍然想要嘗試 Bun，請在沒有 WhatsApp/Telegram 的非生產環境閘道上進行。

### Telegram allowFrom 中的內容是什麼

[[BLOCK_1]]  
在 Telegram 中，allowFrom 是一個用於設定誰可以訪問特定功能或資源的參數。這個參數通常用於限制訪問權限，確保只有授權的用戶或群組能夠使用某些功能。

[[BLOCK_2]]  
allowFrom 可以包含用戶的 ID、用戶名或群組的 ID，這樣可以精確地控制訪問權限。當設置了 allowFrom 之後，只有在這個列表中的用戶或群組才能夠執行相關的操作。

[[BLOCK_3]]  
例如，如果你想要限制某個機器人命令的使用權限，你可以在機器人的設定中使用 allowFrom 來指定哪些用戶可以使用這個命令。這樣可以提高安全性，防止未經授權的訪問。

[[INLINE_1]]  
總之，allowFrom 是一個重要的安全功能，幫助開發者管理用戶訪問權限。

[[BLOCK_4]]  
在實作時，請確保你正確地填寫 allowFrom 的內容，以避免不必要的訪問問題。

`channels.telegram.allowFrom` 是 **人類發送者的 Telegram 使用者 ID**（數字）。這不是機器人的用戶名。

入門精靈接受 `@username` 輸入並將其解析為數字 ID，但 OpenClaw 授權僅使用數字 ID。

Safer (無第三方機器人)：

- 私訊你的機器人，然後執行 `openclaw logs --follow` 並閱讀 `from.id`。

Official Bot API:

- 私訊你的機器人，然後呼叫 `https://api.telegram.org/bot<bot_token>/getUpdates` 並閱讀 `message.from.id`。

第三方（較不私密）：

- DM `@userinfobot` or `@getidsbot`.

請參閱 [/channels/telegram](/channels/telegram#access-control-dms--groups)。

### 是否可以多個人使用同一個 WhatsApp 號碼搭配不同的 OpenClaw 實例

是的，透過 **多代理路由**。將每個發送者的 WhatsApp **DM**（對等 `kind: "direct"`，發送者 E.164 如 `+15551234567`）綁定到不同的 `agentId`，這樣每個人都可以擁有自己的工作區和會話存儲。回覆仍然來自 **相同的 WhatsApp 帳戶**，而 DM 存取控制 (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) 是針對每個 WhatsApp 帳戶的全域設定。請參閱 [多代理路由](/concepts/multi-agent) 和 [WhatsApp](/channels/whatsapp)。

### 我可以執行一個快速聊天代理和一個用於編碼的 Opus 嗎？

是的。使用多代理路由：為每個代理分配自己的預設模型，然後將入站路由（提供者帳戶或特定對等方）綁定到每個代理。範例設定位於 [[MULTI-AGENT ROUTING]](/concepts/multi-agent)。另請參閱 [[MODELS]](/concepts/models) 和 [[CONFIGURATION]](/gateway/configuration)。

### Homebrew 是否可以在 Linux 上執行

是的。Homebrew 支援 Linux（Linuxbrew）。快速設置：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

如果您透過 systemd 執行 OpenClaw，請確保服務的 PATH 包含 `/home/linuxbrew/.linuxbrew/bin`（或您的 brew 前綴），以便 `brew` 安裝的工具能在非登入的 shell 中正確解析。最近的版本還會在 Linux systemd 服務中預先添加常見的使用者 bin 目錄（例如 `~/.local/bin`、`~/.npm-global/bin`、`~/.local/share/pnpm`、`~/.bun/bin`），並在設定時遵循 `PNPM_HOME`、`NPM_CONFIG_PREFIX`、`BUN_INSTALL`、`VOLTA_HOME`、`ASDF_DATA_DIR`、`NVM_DIR` 和 `FNM_DIR`。

### hackable git 安裝和 npm 安裝之間的差異是什麼

hackable git 安裝和 npm 安裝的主要差異在於安裝來源和方式。

1. **來源**：
   - **hackable git 安裝**：這種安裝方式通常是從 Git 儲存庫直接克隆程式碼，這意味著你可以獲得最新的開發版本，並且可以對程式碼進行修改和自定義。
   - **npm 安裝**：這是從 npm 註冊表安裝已發佈的版本，通常是穩定的版本，適合生產環境使用。

2. **安裝方式**：
   - **hackable git 安裝**：使用 git 命令，例如 git clone，然後手動進行構建和安裝，這需要一定的技術知識。
   - **npm 安裝**：使用 npm 命令，例如 npm install，這是一個簡單的過程，通常只需一行命令即可完成安裝。

3. **更新和維護**：
   - **hackable git 安裝**：需要手動拉取最新的程式碼更新，並可能需要手動解決依賴問題。
   - **npm 安裝**：可以輕鬆使用 npm update 來獲取最新的穩定版本，並自動處理依賴。

總結來說，hackable git 安裝適合需要自定義和開發的用戶，而 npm 安裝則更適合需要穩定性和簡便性的用戶。

- **可駭客的 (git) 安裝：** 完整的原始碼檢出，可編輯，最適合貢獻者。  
  您可以在本地執行構建並修補程式碼/文件。
- **npm 安裝：** 全域 CLI 安裝，無需倉庫，最適合「直接執行」。  
  更新來自 npm dist-tags。

Docs: [開始使用](/start/getting-started), [更新](/install/updating).

### 我可以在之後切換 npm 和 git 安裝嗎？

是的。安裝另一個版本，然後執行 Doctor 以便網關服務指向新的入口點。這 **不會刪除您的數據** - 它僅僅改變 OpenClaw 的程式碼安裝。您的狀態 (`~/.openclaw`) 和工作區 (`~/.openclaw/workspace`) 將保持不變。

從 npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

從 git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

醫生檢測到網關服務入口點不匹配，並提供重寫服務設定以符合當前安裝的選項（在自動化中使用 `--repair`）。

備份提示：請參閱 [Backup strategy](/help/faq#whats-the-recommended-backup-strategy)。

### 我應該在我的筆記型電腦上執行 Gateway 還是 VPS？

簡短回答：**如果你想要 24/7 的可靠性，請使用 VPS**。如果你希望操作最簡便，並且可以接受休眠/重啟，則可以在本地執行。

**筆記型電腦（本地閘道）**

- **優點：** 無伺服器成本、直接訪問本地檔案、即時瀏覽器視窗。
- **缺點：** 睡眠/網路中斷 = 斷線、作業系統更新/重啟會中斷、必須保持喚醒狀態。

**VPS / 雲端**

- **優點：** 隨時在線、穩定的網路、沒有筆記型電腦進入睡眠模式的問題、更容易保持執行。
- **缺點：** 通常以無頭模式執行（使用螢幕截圖）、僅能遠端存取檔案、必須透過 SSH 進行更新。

**OpenClaw特定說明：** WhatsApp/Telegram/Slack/Mattermost (插件)/Discord 在 VPS 上執行良好。唯一真正的取捨是 **無頭瀏覽器** 與可見窗口。請參見 [Browser](/tools/browser)。

**建議的預設設定：** 如果您之前有過網關斷線的情況，建議使用 VPS。當您在使用 Mac 並希望進行本地檔案存取或使用可見瀏覽器進行 UI 自動化時，本地環境非常適合。

### 在專用機器上執行 OpenClaw 有多重要

[[BLOCK_1]]

不要求，但**建議以提高可靠性和隔離性**。

- **專用主機 (VPS/Mac mini/Pi)：** 隨時可用，較少的睡眠/重啟中斷，權限更乾淨，更容易保持執行。
- **共享筆記型電腦/桌面電腦：** 完全適合測試和主動使用，但預期在機器進入睡眠或更新時會有暫停。

如果你想要兩全其美，將 Gateway 保留在專用主機上，並將你的筆記型電腦作為 **node** 來使用本地的螢幕/攝影機/執行工具。請參閱 [Nodes](/nodes)。  
有關安全性指導，請閱讀 [Security](/gateway/security)。

### 最低 VPS 要求及推薦的作業系統

[[BLOCK_1]]  
最低 VPS 要求通常包括以下幾個方面：

- **CPU**: 至少 1 顆虛擬 CPU
- **記憶體**: 至少 1 GB RAM
- **儲存空間**: 至少 20 GB SSD 或 HDD
- **網路頻寬**: 每月至少 1 TB 的流量

推薦的作業系統包括：

- **Ubuntu 20.04 LTS**
- **Debian 10 或 11**
- **CentOS 7 或 8**
- **Fedora**

這些作業系統都提供穩定的環境，並且有良好的社群支援。[[BLOCK_1]]

OpenClaw 是輕量級的。對於基本的 Gateway + 一個聊天頻道：

- **絕對最低要求：** 1 vCPU、1GB RAM、約 500MB 磁碟空間。
- **建議設定：** 1-2 vCPU、2GB RAM 或更多以提供額外空間（用於日誌、媒體、多個通道）。節點工具和瀏覽器自動化可能會消耗較多資源。

OS: 使用 **Ubuntu LTS**（或任何現代的 Debian/Ubuntu）。Linux 的安裝路徑在那裡經過最佳測試。

Docs: [Linux](/platforms/linux), [VPS 主機](/vps).

### 我可以在虛擬機中執行 OpenClaw 嗎？有什麼要求？

[[BLOCK_1]]  
是的，您可以在虛擬機 (VM) 中執行 OpenClaw。以下是一些基本要求：

1. **虛擬機軟體**：建議使用 VMware、VirtualBox 或其他支援的虛擬化平台。
2. **作業系統**：OpenClaw 支援的作業系統版本，請參考官方文檔以獲取最新資訊。
3. **硬體要求**：
   - 至少 4 GB 的 RAM。
   - 至少 20 GB 的可用磁碟空間。
   - 支援虛擬化的 CPU。

[[BLOCK_2]]  
確保您的虛擬機設定符合以上要求，以便順利執行 OpenClaw。

是的。將虛擬機（VM）視為虛擬私人伺服器（VPS）：它需要始終開啟、可連接，並且擁有足夠的 RAM 以支援 Gateway 及您啟用的任何通道。

Baseline guidance:

- **絕對最低要求：** 1 vCPU，1GB RAM。
- **建議設定：** 2GB RAM 或更多，如果您執行多個頻道、瀏覽器自動化或媒體工具。
- **作業系統：** Ubuntu LTS 或其他現代的 Debian/Ubuntu。

如果您使用的是 Windows，**WSL2 是最簡單的虛擬機風格設置**，並且具有最佳的工具相容性。請參閱 [Windows](/platforms/windows)、[VPS 主機](/vps)。如果您在虛擬機中執行 macOS，請參閱 [macOS VM](/install/macos-vm)。

## OpenClaw 是什麼？

[[BLOCK_1]] OpenClaw 是一個開源的自動化工具，旨在簡化和加速開發過程。它提供了一個靈活的框架，允許開發者輕鬆地創建、測試和部署應用程式。透過其直觀的介面和強大的功能，OpenClaw 支援多種編程語言和平台，並且能夠與各種 API 和 SDK 整合，讓開發者能夠專注於創造高效能的解決方案。[[BLOCK_1]]

OpenClaw 是一個您可以在自己的設備上執行的個人 AI 助手。它可以在您已經使用的消息平台上回覆（WhatsApp、Telegram、Slack、Mattermost（插件）、Discord、Google Chat、Signal、iMessage、WebChat），並且在支援的平台上還可以進行語音通話和即時畫布。**Gateway** 是始終在線的控制平面；助手則是產品。

### 價值主張是什麼

OpenClaw 不是「僅僅是一個 Claude 的包裝器」。它是一個 **以本地為先的控制平面**，讓你能在 **自己的硬體** 上執行一個功能強大的助手，並且可以從你已經使用的聊天應用程式中訪問，具備有狀態的會話、記憶和工具 - 而不需要將你的工作流程控制權交給託管的 SaaS。

[[BLOCK_1]]

- **您的裝置，您的數據：** 在您想要的地方執行 Gateway（Mac、Linux、VPS），並保持工作區 + 會話歷史在本地。
- **真實的通道，而非網頁沙盒：** WhatsApp/Telegram/Slack/Discord/Signal/iMessage 等，還有支援平台上的行動語音和 Canvas。
- **模型無關：** 使用 Anthropic、OpenAI、MiniMax、OpenRouter 等，並具備每個代理的路由和故障轉移功能。
- **僅限本地選項：** 執行本地模型，這樣 **所有數據都可以保留在您的裝置上**，如果您希望的話。
- **多代理路由：** 每個通道、帳戶或任務分配不同的代理，每個代理都有自己的工作區和預設值。
- **開源且可修改：** 檢查、擴充並自我託管，無需擔心供應商鎖定。

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent), [Memory](/concepts/memory).

### 我剛設定好，應該先做什麼？

[[BLOCK_1]]  
好的初學者專案：  
[[BLOCK_1]]

- 建立一個網站（WordPress、Shopify 或簡單的靜態網站）。
- 原型設計一個行動應用程式（大綱、畫面、API 計畫）。
- 整理檔案和資料夾（清理、命名、標籤）。
- 連接 Gmail 並自動化摘要或後續跟進。

它可以處理大型任務，但當你將任務拆分為階段並使用子代理進行平行工作時，效果最佳。

### OpenClaw 的五大日常使用案例是什麼？

每一天的勝利通常看起來像是：

- **個人簡報：** 您關心的收件箱、日曆和新聞摘要。
- **研究與草擬：** 快速研究、摘要，以及電子郵件或文件的初稿。
- **提醒與跟進：** 基於計時器或心跳驅動的提示和檢查清單。
- **瀏覽器自動化：** 填寫表單、收集數據和重複網頁任務。
- **跨設備協調：** 從您的手機發送任務，讓 Gateway 在伺服器上執行，並在聊天中獲取結果。

### OpenClaw 能否協助進行 SaaS 的潛在客戶開發外展廣告和部落格？

是的，這可以用於 **研究、資格審查和草擬**。它可以掃描網站、建立候選名單、總結潛在客戶，並撰寫外聯或廣告文案草稿。

對於 **外展或廣告活動**，請保持人員參與。避免垃圾郵件，遵循當地法律和平台政策，並在發送之前審核所有內容。最安全的做法是讓 OpenClaw 草擬內容，然後由您進行批准。

Docs: [安全性](/gateway/security).

### 網頁開發中 Claude Code 的優勢與劣勢

[[BLOCK_1]]

[[INLINE_1]]

[[BLOCK_2]]

OpenClaw 是一個 **個人助理** 和協調層，而不是 IDE 的替代品。在一個程式碼庫內，使用 Claude Code 或 Codex 來獲得最快的直接編碼循環。當你需要持久的記憶、跨設備的訪問和工具協調時，請使用 OpenClaw。

優點：

- **持久記憶 + 工作區** 跨會話
- **多平台存取** (WhatsApp、Telegram、TUI、WebChat)
- **工具協調** (瀏覽器、檔案、排程、鉤子)
- **隨時可用的閘道** (在 VPS 上執行，隨時隨地互動)
- **節點** 用於本地瀏覽器/螢幕/相機/執行

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## 技能與自動化

### 如何在不弄髒倉庫的情況下自訂技能

使用管理的覆寫，而不是編輯倉庫副本。將您的更改放在 `~/.openclaw/skills/<name>/SKILL.md`（或通過 `skills.load.extraDirs` 在 `~/.openclaw/openclaw.json` 中添加一個資料夾）。優先順序為 `<workspace>/skills` > `~/.openclaw/skills` > 打包，因此管理的覆寫在不觸碰 git 的情況下獲勝。只有值得上游的編輯應該保留在倉庫中並以 PR 的形式發佈。

### 我可以從自訂資料夾載入技能嗎

是的。透過 `skills.load.extraDirs` 在 `~/.openclaw/openclaw.json` 中添加額外的目錄（最低優先權）。預設的優先權仍然是：`<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`。`clawhub` 預設安裝到 `./skills`，而 OpenClaw 將其視為 `<workspace>/skills`。

### 我該如何為不同的任務使用不同的模型

今天支援的模式有：

- **Cron 工作**：獨立的工作可以為每個工作設置 `model` 覆蓋。
- **子代理**：將任務路由到具有不同預設模型的獨立代理。
- **隨需切換**：隨時使用 `/model` 切換當前會話模型。

請參閱 [Cron jobs](/automation/cron-jobs)、[Multi-Agent Routing](/concepts/multi-agent) 和 [Slash commands](/tools/slash-commands)。

### 當機器人在執行繁重工作時會凍結，我該如何卸載這些工作？

使用 **子代理** 來處理長時間或平行的任務。子代理在自己的會話中執行，返回摘要，並保持您的主要聊天回應靈敏。

請要求您的機器人「為此任務產生一個子代理」或使用 `/subagents`。在聊天中使用 `/status` 來查看 Gateway 目前正在做什麼（以及它是否忙碌）。

Token 提示：長任務和子代理都會消耗 token。如果成本是個問題，請透過 `agents.defaults.subagents.model` 為子代理設定較便宜的模型。

Docs: [子代理](/tools/subagents).

### Discord 上的線程綁定子代理會話是如何運作的

使用線程綁定。您可以將 Discord 線程綁定到子代理或會話目標，以便該線程中的後續消息保持在該綁定的會話中。

[[BLOCK_1]]  
基本流程：  
[[BLOCK_1]]

- 使用 `thread: true` 來以 `sessions_spawn` 產生（並可選擇性地使用 `mode: "session"` 進行持續跟進）。
- 或者手動綁定 `/focus <target>`。
- 使用 `/agents` 來檢查綁定狀態。
- 使用 `/session idle <duration|off>` 和 `/session max-age <duration|off>` 來控制自動失去焦點。
- 使用 `/unfocus` 來分離執行緒。

所需設定：

- 全域預設值: `session.threadBindings.enabled`, `session.threadBindings.idleHours`, `session.threadBindings.maxAgeHours`。
- Discord 覆蓋: `channels.discord.threadBindings.enabled`, `channels.discord.threadBindings.idleHours`, `channels.discord.threadBindings.maxAgeHours`。
- 自動綁定於生成時: 設定 `channels.discord.threadBindings.spawnSubagentSessions: true`。

Docs: [Sub-agents](/tools/subagents), [Discord](/channels/discord), [Configuration Reference](/gateway/configuration-reference), [Slash commands](/tools/slash-commands).

### Cron 或提醒未觸發，我該檢查什麼

1. 確認 Cron 任務是否正確設定。檢查 Cron 表達式是否符合預期的時間安排。
2. 檢查系統時間是否正確。確保伺服器的時區設定正確，並且時間同步。
3. 查看相關的日誌檔案，以找出任何錯誤或警告訊息，這些訊息可能會提供有用的線索。
4. 確認執行的命令或腳本是否存在且可執行。檢查路徑是否正確，並確保所需的權限已設定。
5. 檢查是否有其他進程或服務影響到 Cron 的執行，例如系統資源不足或其他排程衝突。
6. 如果使用的是提醒功能，確認相關的應用程式或服務是否正常執行，並且設定正確。

Cron 在 Gateway 過程中執行。如果 Gateway 沒有持續執行，則排定的工作將不會執行。

Checklist:

- 確認 cron 已啟用 (`cron.enabled`) 且 `OPENCLAW_SKIP_CRON` 未設定。
- 檢查 Gateway 是否 24/7 執行（無休眠/重啟）。
- 驗證工作時區設定 (`--tz` 與主機時區)。

Debug:

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat)。

### 如何在 Linux 上安裝技能

使用 **ClawHub** (CLI) 或將技能拖放到您的工作區。macOS 的技能介面在 Linux 上不可用。  
在 [https://clawhub.com](https://clawhub.com) 瀏覽技能。

安裝 ClawHub CLI（選擇一個套件管理工具）：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw 是否可以按計劃執行任務或在背景中持續執行？

是的。使用 Gateway 排程器：

- **Cron jobs** 用於排程或重複執行的任務（在重啟後仍然持續存在）。
- **Heartbeat** 用於「主要會話」的定期檢查。
- **Isolated jobs** 用於自主代理，負責發佈摘要或傳遞到聊天中。

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),  
[Heartbeat](/gateway/heartbeat).

### 我可以在 Linux 上執行僅限 Apple macOS 的技能嗎？

不直接。macOS 技能受到 `metadata.openclaw.os` 以及所需的二進位檔限制，只有在 **Gateway host** 上符合資格時，技能才會出現在系統提示中。在 Linux 上，只有 `darwin` 的技能（如 `apple-notes`、`apple-reminders`、`things-mac`）不會加載，除非你覆蓋這個限制。

您有三種支援的模式：

**選項 A - 在 Mac 上執行 Gateway（最簡單）。**  
在 macOS 二進位檔存在的地方執行 Gateway，然後從 Linux 以 [遠端模式](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) 連接或透過 Tailscale 連接。技能會正常加載，因為 Gateway 主機是 macOS。

**選項 B - 使用 macOS 節點（無 SSH）。**  
在 Linux 上執行 Gateway，配對一個 macOS 節點（選單欄應用程式），並將 **Node Run Commands** 設定為「始終詢問」或「始終允許」在 Mac 上。OpenClaw 可以將僅限於 macOS 的技能視為合格，當所需的二進位檔存在於該節點上時。代理程式通過 `nodes` 工具執行這些技能。如果您選擇「始終詢問」，在提示中批准「始終允許」會將該命令添加到允許清單中。

**選項 C - 通過 SSH 代理 macOS 二進位檔（進階）。**  
將 Gateway 保留在 Linux 上，但使所需的 CLI 二進位檔解析為在 Mac 上執行的 SSH 包裝器。然後覆蓋技能以允許 Linux，這樣它仍然符合資格。

1. 為二進位檔創建一個 SSH 包裝器（例如：`memo` 用於 Apple Notes）：

```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
```

2. 將包裝器放在 `PATH` 的 Linux 主機上（例如 `~/bin/memo`）。
3. 覆蓋技能元數據（工作區或 `~/.openclaw/skills`）以允許 Linux：

```markdown
---
name: apple-notes
description: Manage Apple Notes via the memo CLI on macOS.
metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
---
```

4. 開始一個新會話，以便技能快照更新。

### 您有 Notion 或 HeyGen 的整合嗎？

目前尚未內建。

Options:

- **自訂技能 / 插件：** 最適合可靠的 API 存取（Notion/HeyGen 都有 API）。
- **瀏覽器自動化：** 無需程式碼即可運作，但速度較慢且較脆弱。

如果您想要為每個客戶（代理商工作流程）保持上下文，一個簡單的模式是：

- 每位客戶一個 Notion 頁面（上下文 + 偏好 + 當前工作）。
- 在會話開始時請代理人提取該頁面。

如果您想要原生整合，請提出功能請求或建立一個針對這些 API 的技能。

[[BLOCK_1]]  
安裝技能：  
[[BLOCK_1]]

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub 安裝在 `./skills` 目錄下（或回退到您設定的 OpenClaw 工作區）；OpenClaw 在下一次會話中將其視為 `<workspace>/skills`。對於跨代理的共享技能，請將它們放在 `~/.openclaw/skills/<name>/SKILL.md` 中。一些技能需要通過 Homebrew 安裝的二進位檔；在 Linux 上則意味著使用 Linuxbrew（請參見上面的 Homebrew Linux FAQ 條目）。請參閱 [Skills](/tools/skills) 和 [ClawHub](/tools/clawhub)。

### 如何安裝瀏覽器接管的 Chrome 擴充功能

使用內建的安裝程式，然後在 Chrome 中載入未打包的擴充功能：

```bash
openclaw browser extension install
openclaw browser extension path
```

然後在 Chrome → `chrome://extensions` → 啟用「開發者模式」→ 「載入未封裝的擴充功能」→ 選擇該資料夾。

完整指南（包括遠端 Gateway + 安全注意事項）：[Chrome 擴充功能](/tools/chrome-extension)

如果 Gateway 與 Chrome 在同一台機器上執行（預設設置），通常**不需要**額外的設定。如果 Gateway 在其他地方執行，請在瀏覽器機器上執行一個節點主機，以便 Gateway 可以代理瀏覽器操作。您仍然需要在您想要控制的標籤上點擊擴充按鈕（它不會自動附加）。

## Sandboxing 和記憶體

### 是否有專門的沙盒文件

是的。請參閱 [Sandboxing](/gateway/sandboxing)。有關 Docker 特定的設置（在 Docker 中的完整網關或沙盒映像），請參閱 [Docker](/install/docker)。

### Docker 感覺有限制 如何啟用完整功能

預設映像以安全為首要考量，並以 `node` 使用者身份執行，因此不包含系統套件、Homebrew 或捆綁的瀏覽器。若要進行更完整的設置：

- 使用 `OPENCLAW_HOME_VOLUME` 持久化 `/home/node`，以便快取能夠存活。
- 使用 `OPENCLAW_DOCKER_APT_PACKAGES` 將系統依賴項打包進映像中。
- 通過捆綁的 CLI 安裝 Playwright 瀏覽器：
  `node /app/node_modules/playwright-core/cli.js install chromium`
- 設定 `PLAYWRIGHT_BROWSERS_PATH` 並確保路徑被持久化。

Docs: [Docker](/install/docker), [Browser](/tools/browser).

**我可以保持私訊為個人，但讓群組公開並與一個代理商進行沙盒測試嗎？**

是的 - 如果你的私人流量是 **DMs**，而你的公共流量是 **groups**。

使用 `agents.defaults.sandbox.mode: "non-main"` 使群組/頻道會話（非主要金鑰）在 Docker 中執行，而主要的 DM 會話則保持在主機上。然後通過 `tools.sandbox.tools` 限制沙盒會話中可用的工具。

設定步驟說明 + 範例設定：[群組：個人私訊 + 公開群組](/channels/groups#pattern-personal-dms-public-groups-single-agent)

關鍵設定參考：[閘道設定](/gateway/configuration#agentsdefaultssandbox)

### 如何將主機資料夾綁定到沙盒中

將 `agents.defaults.sandbox.docker.binds` 設定為 `["host:path:mode"]`（例如，`"/home/user/src:/src:ro"`）。全域 + 每個代理的綁定會合併；當 `scope: "shared"` 時，每個代理的綁定會被忽略。對於任何敏感資訊，請使用 `:ro`，並記住綁定會繞過沙盒檔案系統的牆壁。請參閱 [Sandboxing](/gateway/sandboxing#custom-bind-mounts) 和 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) 以獲取範例和安全注意事項。

### 記憶體是如何運作的

OpenClaw 的記憶體只是代理工作區中的 Markdown 檔案：

- 每日筆記在 `memory/YYYY-MM-DD.md`
- 精選的長期筆記在 `MEMORY.md`（僅限主要/私人會議）

OpenClaw 也會執行 **靜默的預壓縮記憶體清除**，以提醒模型在自動壓縮之前寫入持久的註解。這僅在工作區可寫時執行（只讀沙盒會跳過此步驟）。請參見 [Memory](/concepts/memory)。

### 記憶總是忘東忘西，我該如何讓它牢記？

請求機器人**將事實寫入記憶**。長期筆記應放在 `MEMORY.md`，短期上下文則放入 `memory/YYYY-MM-DD.md`。

這仍然是我們正在改進的領域。提醒模型儲存記憶是有幫助的；它會知道該怎麼做。如果它不斷忘記，請確認 Gateway 在每次執行時都使用相同的工作區。

Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

### 語意記憶搜尋是否需要 OpenAI API 金鑰

僅當您使用 **OpenAI embeddings** 時。Codex OAuth 涵蓋聊天/完成，但並不授予 embeddings 的存取權，因此 **使用 Codex 登入（OAuth 或 Codex CLI 登入）** 對於語意記憶搜尋並沒有幫助。OpenAI embeddings 仍然需要一個真正的 API 金鑰 (`OPENAI_API_KEY` 或 `models.providers.openai.apiKey`).

如果您沒有明確設定提供者，OpenClaw 會在能夠解析 API 金鑰（身份驗證設定檔、`models.providers.*.apiKey` 或環境變數）時自動選擇提供者。它會優先選擇 OpenAI，如果能解析 OpenAI 金鑰，否則會選擇 Gemini，如果能解析 Gemini 金鑰，接著是 Voyage，然後是 Mistral。如果沒有可用的遠端金鑰，記憶體搜尋將保持禁用，直到您進行設定。如果您已設定並存在本地模型路徑，OpenClaw 會優先選擇 `local`。當您明確設定 `memorySearch.provider = "ollama"` 時，Ollama 也受到支援。

如果您更喜歡使用本地設置，請設置 `memorySearch.provider = "local"`（並可選擇性地設置 `memorySearch.fallback = "none"`）。如果您想要使用 Gemini 嵌入，請設置 `memorySearch.provider = "gemini"` 並提供 `GEMINI_API_KEY`（或 `memorySearch.remote.apiKey`）。我們支援 **OpenAI、Gemini、Voyage、Mistral、Ollama 或本地** 嵌入模型 - 詳情請參見 [Memory](/concepts/memory) 的設置說明。

### 記憶是否會永遠持續？有哪些限制？

記憶檔案儲存在磁碟上，並在你刪除之前持續存在。限制在於你的儲存空間，而不是模型。**會話上下文**仍然受到模型上下文窗口的限制，因此長時間的對話可能會被壓縮或截斷。這就是為什麼存在記憶搜尋 - 它僅將相關部分拉回上下文中。

Docs: [Memory](/concepts/memory), [Context](/concepts/context).

## 檔案在磁碟上的位置

### 所有與 OpenClaw 使用的數據都會儲存在本地嗎？

不 - **OpenClaw 的狀態是本地的**，但 **外部服務仍然可以看到你發送給它們的內容**。

- **預設為本地：** 會話、記憶檔案、設定和工作區都存放在 Gateway 主機上 (`~/.openclaw` + 你的工作區目錄)。
- **必要時為遠端：** 你發送給模型提供者（Anthropic/OpenAI 等）的訊息會傳送到他們的 API，而聊天平台（WhatsApp/Telegram/Slack 等）則將訊息數據儲存在他們的伺服器上。
- **你控制足跡：** 使用本地模型可以將提示保留在你的機器上，但通道流量仍然會經過通道的伺服器。

相關：[[BLOCK_N]] [Agent workspace](/concepts/agent-workspace)，[[INLINE_N]] [Memory](/concepts/memory)。[[BLOCK_N]]

### OpenClaw 的數據儲存位置在哪裡

一切都位於 `$OPENCLAW_STATE_DIR`（預設值：`~/.openclaw`）：

| 路徑                                                            | 目的                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | 主要設定 (JSON5)                                             |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | 舊版 OAuth 匯入 (首次使用時複製到認證設定檔中)               |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 認證設定檔 (OAuth、API 金鑰，以及可選的 `keyRef`/`tokenRef`) |
| `$OPENCLAW_STATE_DIR/secrets.json`                              | 可選的檔案備份秘密有效載荷，用於 `file` SecretRef 提供者     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | 舊版相容性檔案 (靜態 `api_key` 專案已清除)                   |
| `$OPENCLAW_STATE_DIR/credentials/`                              | 提供者狀態 (例如 `whatsapp/<accountId>/creds.json`)          |
| `$OPENCLAW_STATE_DIR/agents/`                                   | 每個代理的狀態 (agentDir + 會話)                             |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | 會話歷史與狀態 (每個代理)                                    |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | 會話元數據 (每個代理)                                        |

Legacy single-agent path: `~/.openclaw/agent/*` (由 `openclaw doctor` 遷移)。

您的 **工作區** (AGENTS.md、記憶檔案、技能等) 是獨立的，並透過 `agents.defaults.workspace` 進行設定 (預設: `~/.openclaw/workspace`)。

### AGENTSmd SOULmd USERmd MEMORYmd 應該放在哪裡

這些檔案位於 **agent workspace**，而不是 `~/.openclaw`。

- **工作區 (每個代理)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (或 `memory.md`), `memory/YYYY-MM-DD.md`, 可選的 `HEARTBEAT.md`。
- **狀態目錄 (`~/.openclaw`)**: 設定、憑證、身份驗證設定檔、會話、日誌，
  以及共享技能 (`~/.openclaw/skills`)。

預設工作區是 `~/.openclaw/workspace`，可透過以下方式進行設定：

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

如果機器人在重啟後「忘記」了，請確認每次啟動時 Gateway 都在使用相同的工作區（並且請記住：遠端模式使用的是 **gateway host** 的工作區，而不是您本地的筆記型電腦）。

提示：如果您想要持久的行為或偏好，請要求機器人**將其寫入 AGENTS.md 或 MEMORY.md**，而不是依賴聊天記錄。

請參閱 [Agent workspace](/concepts/agent-workspace) 和 [Memory](/concepts/memory)。

### 建議的備份策略是什麼

將您的 **agent workspace** 放在一個 **private** 的 git 倉庫中，並將其備份到某個私密的地方（例如 GitHub 私有倉庫）。這樣可以捕捉記憶 + AGENTS/SOUL/USER 檔案，並讓您稍後恢復助理的「思維」。

請勿提交任何在 `~/.openclaw` 下的內容（憑證、會話、token或加密的秘密有效載荷）。如果需要完整恢復，請分別備份工作區和狀態目錄（請參見上面的遷移問題）。

Docs: [Agent workspace](/concepts/agent-workspace).

### 如何完全卸載 OpenClaw

請參閱專門的指南：[Uninstall](/install/uninstall)。

### 代理可以在工作區外運作嗎

是的。工作區是 **預設的當前工作目錄** 和記憶錨點，而不是一個嚴格的沙盒。相對路徑在工作區內解析，但絕對路徑可以訪問其他主機位置，除非啟用了沙盒。如果您需要隔離，請使用 `agents.defaults.sandbox`(/gateway/sandboxing) 或每個代理的沙盒設置。如果您希望某個倉庫成為預設的工作目錄，請將該代理的 `workspace` 指向倉庫根目錄。OpenClaw 倉庫僅是源程式碼；除非您故意希望代理在其中工作，否則請保持工作區的獨立性。

範例（repo 作為預設工作目錄）：

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### 我在遠端模式，會話儲存在哪裡？

會話狀態由 **gateway host** 擁有。如果您處於遠端模式，您關心的會話儲存是在遠端機器上，而不是您本地的筆記型電腦。請參見 [Session management](/concepts/session)。

## Config basics

### 設定的格式是什麼？它在哪裡？

OpenClaw 會從 `$OPENCLAW_CONFIG_PATH` 讀取一個可選的 **JSON5** 設定（預設值：`~/.openclaw/openclaw.json`）：

```
$OPENCLAW_CONFIG_PATH
```

如果檔案缺失，它將使用相對安全的預設值（包括預設工作區 `~/.openclaw/workspace`）。

### 我設定了 gatewaybind lan 或 tailnet，現在沒有任何東西在監聽，使用者介面顯示未授權。

非迴圈回路的綁定 **需要驗證**。設定 `gateway.auth.mode` + `gateway.auth.token`（或使用 `OPENCLAW_GATEWAY_TOKEN`）。

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

[[BLOCK_1]]

- `gateway.remote.token` / `.password` 本身**不**會啟用本地閘道認證。
- 本地呼叫路徑僅在 `gateway.auth.*` 未設定時可以使用 `gateway.remote.*` 作為後備。
- 如果 `gateway.auth.token` / `gateway.auth.password` 透過 SecretRef 明確設定且未解析，則解析將失敗並關閉（不會有遠端後備遮罩）。
- 控制 UI 透過 `connect.params.auth.token` 進行身份驗證（儲存在應用程式/UI 設定中）。避免將 token 放在 URL 中。

### 為什麼我現在在 localhost 上需要一個 token

OpenClaw 預設強制執行 token 認證，包括迴圈回路。如果未設定 token，閘道啟動時會自動生成一個並將其保存到 `gateway.auth.token`，因此 **本地 WS 用戶端必須進行身份驗證**。這會阻止其他本地進程調用閘道。

如果你**真的**想要開啟迴路，請在你的設定中明確設置 `gateway.auth.mode: "none"`。Doctor 隨時可以為你生成一個 token：`openclaw doctor --generate-gateway-token`。

### 更改設定後是否需要重新啟動？

Gateway 監控設定並支援熱重載：

- `gateway.reload.mode: "hybrid"` (預設): 熱更新安全變更，關鍵變更需重啟
- `hot`, `restart`, `off` 也受到支援

### 如何禁用有趣的 CLI 標語

在設定中設置 `cli.banner.taglineMode`：

```json5
{
  cli: {
    banner: {
      taglineMode: "off", // random | default | off
    },
  },
}
```

- `off`: 隱藏標語文字，但保留橫幅標題/版本行。
- `default`: 每次都使用 `All your chats, one OpenClaw.`。
- `random`: 旋轉有趣/季節性的標語（預設行為）。
- 如果您想完全不顯示橫幅，請設置環境變數 `OPENCLAW_HIDE_BANNER=1`。

### 如何啟用網頁搜尋和網頁擷取

`web_fetch` 無需 API 金鑰即可運作。`web_search` 需要您所選擇的提供者（Brave、Gemini、Grok、Kimi 或 Perplexity）的金鑰。  
**建議：** 執行 `openclaw configure --section web` 並選擇一個提供者。  
環境替代方案：

- Brave: `BRAVE_API_KEY`
- Gemini: `GEMINI_API_KEY`
- Grok: `XAI_API_KEY`
- Kimi: `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`
- Perplexity: `PERPLEXITY_API_KEY` 或 `OPENROUTER_API_KEY`

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
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

[[BLOCK_1]]

- 如果您使用允許清單，請添加 `web_search`/`web_fetch` 或 `group:web`。
- `web_fetch` 預設為啟用（除非明確禁用）。
- Daemons 從 `~/.openclaw/.env`（或服務環境）讀取環境變數。

Docs: [Web tools](/tools/web).

### 如何在不同設備上執行中央閘道並使用專門的工作者

常見的模式是 **一個閘道**（例如 Raspberry Pi）加上 **節點** 和 **代理**：

- **Gateway (中央):** 擁有通道 (Signal/WhatsApp)、路由和會話。
- **Nodes (設備):** Macs/iOS/Android 作為外圍設備連接並暴露本地工具 (`system.run`, `canvas`, `camera`)。
- **Agents (工作者):** 為特殊角色（例如 "Hetzner ops"、"個人數據"）提供獨立的思維/工作空間。
- **Sub-agents:** 當你想要並行處理時，從主代理產生背景工作。
- **TUI:** 連接到 Gateway 並切換代理/會話。

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### OpenClaw 瀏覽器可以無頭執行嗎

是的。這是一個設定選項：

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

預設為 `false`（有頭模式）。無頭模式在某些網站上更容易觸發反機器人檢查。請參見 [Browser](/tools/browser)。

Headless 使用 **相同的 Chromium 引擎**，並且適用於大多數自動化（表單、點擊、抓取、登入）。主要的差異如下：

- 沒有可見的瀏覽器視窗（如果需要視覺效果，請使用截圖）。
- 某些網站對於無頭模式的自動化要求更嚴格（如 CAPTCHA、反機器人措施）。
  例如，X/Twitter 通常會封鎖無頭會話。

### 如何使用 Brave 進行瀏覽器控制

將 `browser.executablePath` 設定為您的 Brave 二進位檔（或任何基於 Chromium 的瀏覽器），然後重新啟動 Gateway。  
查看完整的設定範例請參考 [Browser](/tools/browser#use-brave-or-another-chromium-based-browser)。

## Remote gateways and nodes

### 指令如何在 Telegram 閘道與節點之間傳遞

Telegram 訊息由 **gateway** 處理。該 gateway 執行代理，然後在需要節點工具時通過 **Gateway WebSocket** 呼叫節點：

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

節點無法看到進來的提供者流量；它們僅接收節點 RPC 調用。

### 如果 Gateway 遠端托管，我的代理如何訪問我的電腦？

簡短回答：**將你的電腦配對為一個節點**。網關執行在其他地方，但它可以通過網關 WebSocket 在你的本地機器上調用 `node.*` 工具（螢幕、相機、系統）。

典型設置：

1. 在始終開啟的主機（VPS/家庭伺服器）上執行 Gateway。
2. 將 Gateway 主機與你的電腦放在同一個 tailnet 中。
3. 確保 Gateway WS 可達（tailnet 綁定或 SSH 隧道）。
4. 在本地開啟 macOS 應用程式並以 **Remote over SSH** 模式（或直接 tailnet）連接，以便它可以註冊為一個節點。
5. 在 Gateway 上批准該節點：

```bash
   openclaw devices list
   openclaw devices approve <requestId>
```

不需要單獨的 TCP 橋接；節點通過 Gateway WebSocket 連接。

安全提醒：將 macOS 節點配對會在該機器上啟用 `system.run`。僅配對您信任的設備，並查看 [安全性](/gateway/security)。

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale 已連接但我沒有收到回覆，該怎麼辦？

[[BLOCK_1]]  
Check the basics:  
[[BLOCK_1]]

- Gateway 正在執行: `openclaw gateway status`
- Gateway 健康狀態: `openclaw status`
- 通道健康狀態: `openclaw channels status`

然後驗證身份驗證和路由：

- 如果您使用 Tailscale Serve，請確保 `gateway.auth.allowTailscale` 設定正確。
- 如果您是透過 SSH 隧道連接，請確認本地隧道已啟動並指向正確的端口。
- 確認您的允許清單（DM 或群組）包含您的帳戶。

Docs: [Tailscale](/gateway/tailscale), [遠端存取](/gateway/remote), [頻道](/channels).

### 兩個 OpenClaw 實例能否在本地 VPS 之間互相通訊

是的。沒有內建的「機器人對機器人」橋接，但你可以透過幾種可靠的方式來連接它：

**最簡單的方式：** 使用兩個機器人都可以訪問的普通聊天頻道（如 Telegram/Slack/WhatsApp）。讓機器人 A 向機器人 B 發送消息，然後讓機器人 B 照常回覆。

**CLI 橋接（通用）：** 執行一個腳本，該腳本調用另一個 Gateway，使用 `openclaw agent --message ... --deliver`，目標是另一個機器人正在監聽的聊天。如果一個機器人在遠端 VPS 上，請通過 SSH/Tailscale 將您的 CLI 指向該遠端 Gateway（請參見 [遠端存取](/gateway/remote)）。

範例模式（從可以到達目標閘道的機器執行）：

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

提示：添加一個防護措施，以防止兩個機器人無限循環（僅提及、頻道允許清單，或是「不回覆機器人訊息」的規則）。

Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### 我需要為多個代理設置獨立的 VPS 嗎？

不可以。一個 Gateway 可以承載多個代理，每個代理都有自己的工作區、模型預設和路由。這是正常的設置，並且比為每個代理執行一個 VPS 更便宜且簡單。

只有在需要強隔離（安全邊界）或非常不同的設定且不想共享的情況下，才使用獨立的 VPS。否則，保持一個 Gateway，並使用多個代理或子代理。

### 在我的個人筆記型電腦上使用節點而不是從 VPS 使用 SSH 有什麼好處？

使用個人筆記型電腦上的節點相較於從 VPS 使用 SSH，有幾個潛在的好處：

1. **性能**：在本地執行節點可以減少延遲，因為所有的計算和數據處理都在本地進行，而不需要通過網路傳輸。

2. **控制**：擁有本地節點意味著你對環境有更大的控制權，包括設定、更新和安全性設置。

3. **成本**：使用個人筆記型電腦可以省去 VPS 的租用費用，特別是如果你只是偶爾需要使用節點的話。

4. **隱私**：在本地執行節點可以減少數據傳輸到第三方伺服器的風險，從而提高隱私保護。

5. **開發和測試**：如果你在開發應用程式或進行測試，使用本地節點可以更方便地進行調試和即時反饋。

然而，使用個人筆記型電腦也有其缺點，例如可能會受到硬體限制、網路不穩定或電源問題的影響。因此，選擇最適合你的需求的方案是很重要的。

是的，節點是從遠端 Gateway 連接到您的筆記型電腦的第一級方式，並且它們解鎖了不僅僅是 shell 存取。Gateway 可以在 macOS/Linux 上執行（Windows 通過 WSL2），並且輕量級（小型 VPS 或 Raspberry Pi 級別的設備都可以；4 GB RAM 足夠），因此常見的設置是持續執行的主機加上您的筆記型電腦作為節點。

- **不需要入站 SSH。** 節點連接到 Gateway WebSocket 並使用設備配對。
- **更安全的執行控制。** `system.run` 受到該筆電的節點白名單/批准的限制。
- **更多設備工具。** 節點除了 `system.run` 外，還提供 `canvas`、`camera` 和 `screen`。
- **本地瀏覽器自動化。** 將 Gateway 保持在 VPS 上，但在本地執行 Chrome，並通過 Chrome 擴充 + 筆電上的節點主機中繼控制。

SSH 適合臨時的 shell 存取，但節點對於持續的代理工作流程和設備自動化來說更為簡單。

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome 擴充功能](/tools/chrome-extension)。

### 我應該在第二台筆記型電腦上安裝還是僅僅添加一個節點？

如果您只需要在第二台筆記型電腦上使用 **本地工具**（螢幕/相機/執行），請將其新增為 **節點**。這樣可以保持單一的 Gateway，並避免重複的設定。本地節點工具目前僅支援 macOS，但我們計劃將其擴充到其他作業系統。

僅在需要 **硬隔離** 或兩個完全獨立的機器人時，才安裝第二個 Gateway。

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### 節點是否執行閘道服務

不可以。每個主機上只能執行 **一個閘道**，除非你故意執行隔離的設定檔（請參見 [Multiple gateways](/gateway/multiple-gateways)）。節點是連接到閘道的外圍設備（iOS/Android 節點，或在選單列應用程式中的 macOS "node mode"）。有關無頭節點主機和 CLI 控制，請參見 [Node host CLI](/cli/node)。

需要對 `gateway`、`discovery` 和 `canvasHost` 的變更進行完全重啟。

### 是否有 API RPC 方式來應用設定

是的。`config.apply` 驗證並寫入完整的設定，並在操作過程中重新啟動 Gateway。

### configapply 擦除我的設定，我該如何恢復並避免這種情況？

如果您在使用 configapply 時不小心擦除了設定，您可以按照以下步驟嘗試恢復：

1. **檢查備份**：首先，查看是否有任何設定的備份。如果您有定期備份的習慣，可以從備份中恢復設定。

2. **版本控制**：如果您的設定檔是使用版本控制系統（如 Git）管理的，您可以檢查提交歷史並恢復到之前的版本。

3. **系統快照**：如果您的系統支援快照功能，您可以恢復到最近的快照，這樣可以找回之前的設定。

4. **查詢日誌**：檢查系統日誌或應用日誌，看看是否有任何記錄可以幫助您找回丟失的設定。

為了避免未來再次發生此問題，您可以考慮以下幾點：

- **定期備份**：定期備份您的設定檔，並確保備份存放在安全的位置。

- **使用版本控制**：將設定檔放入版本控制系統中，這樣可以輕鬆追蹤變更並恢復到先前的版本。

- **測試環境**：在生產環境中應用設定變更之前，先在測試環境中進行測試，以確保不會導致意外的問題。

- **文檔化變更**：對每次設定變更進行詳細記錄，這樣可以在需要時快速查找和恢復。

遵循這些步驟可以幫助您恢復丟失的設定並減少未來發生類似問題的風險。

`config.apply` 會取代 **整個設定**。如果你發送一個部分物件，其他所有內容都會被移除。

Recover:

- 從備份還原 (git 或複製的 `~/.openclaw/openclaw.json`)。
- 如果您沒有備份，請重新執行 `openclaw doctor` 並重新設定通道/模型。
- 如果這是意外發生的，請提交錯誤報告並附上您最後已知的設定或任何備份。
- 本地編碼代理通常可以從日誌或歷史記錄中重建有效的設定。

[[BLOCK_1]]

- 使用 `openclaw config set` 進行小幅修改。
- 使用 `openclaw configure` 進行互動式編輯。

Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### 首次安裝的最小合理設定是什麼

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

這會設置您的工作區並限制誰可以觸發機器人。

### 如何在 VPS 上設置 Tailscale 並從我的 Mac 連接

[[BLOCK_1]]

1. **在 VPS 上安裝 Tailscale**  
   首先，您需要在您的 VPS 上安裝 Tailscale。根據您使用的作業系統，您可以使用以下命令進行安裝：
   - **對於 Ubuntu/Debian**：
     bash
     curl -fsSL https://tailscale.com/install.sh | sh

   - **對於 CentOS/RHEL**：
     bash
     sudo yum install tailscale

   - **對於其他作業系統**，請參考 Tailscale 的官方文檔。

2. **啟動 Tailscale**  
   安裝完成後，您需要啟動 Tailscale 服務：
   bash
   sudo tailscale up

   這將會生成一個連接 URL，您需要在瀏覽器中打開它以進行身份驗證。

3. **在 Mac 上安裝 Tailscale**  
   接下來，您需要在您的 Mac 上安裝 Tailscale。您可以從 [Tailscale 的官方網站](https://tailscale.com/download) 下載適用於 macOS 的安裝包，然後按照指示進行安裝。

4. **啟動 Tailscale 並登入**  
   安裝完成後，啟動 Tailscale 應用程式並使用相同的帳戶登入。

5. **連接到 VPS**  
   一旦您在 Mac 上成功登入，您應該能夠看到您的 VPS 在 Tailscale 網路中。您可以使用 VPS 的 Tailscale IP 地址進行連接。

[[BLOCK_2]]

這樣，您就可以從您的 Mac 連接到 VPS 上的 Tailscale 服務了。

[[BLOCK_1]]  
最小步驟：  
[[BLOCK_1]]

1. **在 VPS 上安裝並登入**

```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
```

2. **在你的 Mac 上安裝 + 登入**
   - 使用 Tailscale 應用程式並登入到相同的 tailnet。
3. **啟用 MagicDNS（建議）**
   - 在 Tailscale 管理控制台中，啟用 MagicDNS，以便 VPS 擁有穩定的名稱。
4. **使用 tailnet 主機名稱**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

如果您想在不使用 SSH 的情況下獲得控制介面，請在 VPS 上使用 Tailscale Serve：

```bash
openclaw gateway --tailscale serve
```

這將使網關綁定到回環並通過 Tailscale 暴露 HTTPS。請參見 [Tailscale](/gateway/tailscale)。

### 如何將 Mac 節點連接到遠端 Gateway Tailscale 伺服器

Serve 提供 **Gateway Control UI + WS**。節點透過相同的 Gateway WS 端點進行連接。

建議的設置：

1. **確保 VPS + Mac 在同一個 tailnet 上**。
2. **在遠端模式下使用 macOS 應用程式**（SSH 目標可以是 tailnet 主機名稱）。該應用程式將隧道 Gateway 端口並作為節點連接。
3. **在 Gateway 上批准該節點**：

```bash
   openclaw devices list
   openclaw devices approve <requestId>
```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## 環境變數與 .env 加載

### OpenClaw 如何載入環境變數

OpenClaw 從父進程（如 shell、launchd/systemd、CI 等）讀取環境變數，並額外加載：

- `.env` 從當前工作目錄
- 一個來自 `~/.openclaw/.env` 的全域備援 `.env` (也就是 `$OPENCLAW_STATE_DIR/.env`)

`.env` 檔案不會覆蓋現有的環境變數。

您也可以在設定中定義內聯環境變數（僅在進程環境中缺失時應用）：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

請參閱 [/environment](/help/environment) 以獲取完整的優先順序和來源。

### 我透過服務啟動了 Gateway，但我的環境變數消失了，該怎麼辦？

兩個常見的修正：

1. 將缺失的金鑰放入 `~/.openclaw/.env`，以便即使服務不繼承您的 shell 環境時也能被識別。
2. 啟用 shell 匯入（選擇性便利）：

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

這會執行您的登入外殼並僅匯入缺失的預期金鑰（從不覆蓋）。環境變數等效：`OPENCLAW_LOAD_SHELL_ENV=1`，`OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`。

### 我設置了 COPILOTGITHUBTOKEN，但模型狀態顯示 Shell 環境關閉，為什麼？

`openclaw models status` 報告 **shell env import** 是否已啟用。"Shell env: off" 並不意味著您的環境變數缺失 - 這只是表示 OpenClaw 不會自動加載您的登入 shell。

如果 Gateway 以服務（launchd/systemd）執行，它將不會繼承你的 shell 環境。請透過以下方式修正：

1. 將 token 放入 `~/.openclaw/.env`:

```
   COPILOT_GITHUB_TOKEN=...
```

2. 或啟用 shell 匯入 (`env.shellEnv.enabled: true`)。
3. 或將其添加到您的設定 `env` 區塊中（僅在缺失時適用）。

然後重新啟動網關並重新檢查：

```bash
openclaw models status
```

Copilot 的 tokens 來自 `COPILOT_GITHUB_TOKEN` (也可以是 `GH_TOKEN` / `GITHUB_TOKEN`)。請參閱 [/concepts/model-providers](/concepts/model-providers) 和 [/environment](/help/environment)。

## Sessions 和多個聊天

### 如何開始一個新的對話

發送 `/new` 或 `/reset` 作為獨立訊息。請參閱 [會話管理](/concepts/session)。

### 如果我從未發送新的請求，會自動重置會話嗎？

是的。會話在 `session.idleMinutes` 後過期（預設為 **60**）。**下一個** 訊息會為該聊天金鑰啟動一個新的會話 ID。這不會刪除記錄 - 只是啟動一個新的會話。

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### 是否有辦法讓一組 OpenClaw 實例中有一位 CEO 和多位代理人？

是的，透過 **多代理路由** 和 **子代理**。您可以創建一個協調代理和幾個擁有自己工作區和模型的工作代理。

這樣說來，這最好被視為一個 **有趣的實驗**。它的 token 使用量很高，並且通常比使用一個具有獨立會話的機器人效率低。我們所構想的典型模型是一個你可以對話的機器人，並為平行工作提供不同的會話。當需要時，該機器人也可以產生子代理。

Docs: [多代理路由](/concepts/multi-agent), [子代理](/tools/subagents), [代理 CLI](/cli/agents).

### 為什麼上下文在任務中途被截斷？我該如何防止這種情況？

Session context 是受到模型窗口的限制。長時間的對話、大量的工具輸出或許多檔案可能會觸發壓縮或截斷。

[[BLOCK_1]]

- 請求機器人總結當前狀態並將其寫入檔案。
- 在長任務之前使用 `/compact`，在切換主題時使用 `/new`。
- 將重要的上下文保留在工作區，並請機器人讀回這些內容。
- 對於長時間或平行的工作，使用子代理以保持主聊天的內容較小。
- 如果這種情況經常發生，請選擇具有更大上下文窗口的模型。

### 如何完全重置 OpenClaw 但保持其安裝狀態

使用重置命令：

```bash
openclaw reset
```

[[BLOCK_1]]  
非互動式完整重置：  
[[BLOCK_1]]

```bash
openclaw reset --scope full --yes --non-interactive
```

然後重新執行入門流程：

```bash
openclaw onboard --install-daemon
```

[[BLOCK_1]]

- 當 onboarding 向導檢測到現有的設定時，還提供 **重置** 功能。請參見 [Wizard](/start/wizard)。
- 如果您使用了設定檔 (`--profile` / `OPENCLAW_PROFILE`)，請重置每個狀態目錄（預設為 `~/.openclaw-<profile>`）。
- 開發重置：`openclaw gateway --dev --reset`（僅限開發；會清除開發設定 + 憑證 + 會話 + 工作區）。

### 我遇到上下文過大錯誤，該如何重置或壓縮？

[[BLOCK_1]]

- **Compact** (保留對話但總結較舊的回合):

```
  /compact
```

or `/compact <instructions>` 以指導摘要。

- **重置**（為相同的聊天金鑰生成新的會話 ID）：

```
  /new
  /reset
```

如果這種情況持續發生：

- 啟用或調整 **會話修剪** (`agents.defaults.contextPruning`) 以修剪舊的工具輸出。
- 使用具有更大上下文窗口的模型。

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### 為什麼我會看到 "LLM request rejected: messages.content.tool_use.input field required"?

這是一個提供者驗證錯誤：模型發出了 `tool_use` 區塊，但缺少所需的 `input`。這通常意味著會話歷史已過時或損壞（通常發生在長時間的線程或工具/架構變更之後）。

修正：使用 `/new` 開始一個全新的會話（獨立訊息）。

### 為什麼我每 30 分鐘會收到心跳訊息

心跳預設每 **30 分鐘** 執行一次。您可以調整或禁用它們：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // or "0m" to disable
      },
    },
  },
}
```

如果 `HEARTBEAT.md` 存在但實際上是空的（只有空白行和像 `# Heading` 的 Markdown 標題），OpenClaw 會跳過心跳執行以節省 API 呼叫。如果該檔案缺失，心跳仍然會執行，模型會決定該怎麼做。

Per-agent overrides 使用 `agents.list[].heartbeat`。文件：[Heartbeat](/gateway/heartbeat)。

### 我需要將機器人帳號加入 WhatsApp 群組嗎？

不，OpenClaw 執行在 **您的帳戶** 上，因此如果您在該群組中，OpenClaw 可以看到它。預設情況下，群組回覆會被阻擋，直到您允許發送者 (`groupPolicy: "allowlist"`)。

如果你只希望 **你** 能夠觸發群組回覆：

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

### 如何獲取 WhatsApp 群組的 JID

選項 1（最快）：尾隨日誌並在群組中發送測試訊息：

```bash
openclaw logs --follow --json
```

Look for `chatId` (or `from`) ending in `@g.us`, like: `1234567890-1234567890@g.us`.

選項 2（如果已經設定/允許清單）：從設定中列出群組：

```bash
openclaw directory groups list --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [目錄](/cli/directory), [日誌](/cli/logs)。

### 為什麼 OpenClaw 在群組中不回覆

兩個常見原因：

- 提及閘道已開啟（預設）。您必須 @提及機器人（或符合 `mentionPatterns`）。
- 您已設定 `channels.whatsapp.groups` 而未使用 `"*"`，且該群組未被允許。

請參閱 [Groups](/channels/groups) 和 [Group messages](/channels/group-messages)。

### 群組/線程是否與直接訊息共享上下文

直接聊天預設會折疊回主會話。群組/頻道擁有自己的會話金鑰，而 Telegram 主題 / Discord 線程則是獨立的會話。請參見 [Groups](/channels/groups) 和 [Group messages](/channels/group-messages)。

### 我可以創建多少個工作區和代理？

沒有硬性限制。數十個（甚至數百個）都可以，但請注意：

- **磁碟增長：** 會話 + 逐字稿位於 `~/.openclaw/agents/<agentId>/sessions/`。
- **Token 成本：** 更多的代理意味著更多的同時模型使用。
- **操作開銷：** 每個代理的身份驗證設定檔、工作區和通道路由。

Tips:

- 每個代理保持一個 **活躍** 的工作區 (`agents.defaults.workspace`)。
- 如果磁碟空間增長，則修剪舊的會話（刪除 JSONL 或儲存條目）。
- 使用 `openclaw doctor` 來檢查多餘的工作區和設定不匹配的情況。

### 我可以在 Slack 上同時執行多個機器人或聊天嗎？我該如何設置？

是的，您可以在 Slack 上同時執行多個機器人或聊天。要設置這些機器人，您可以按照以下步驟進行：

1. **創建多個應用**：在 Slack 的 API 網站上，為每個機器人創建一個新的應用。每個應用都可以擁有自己的 token 和設定。

2. **設定 OAuth 設定**：為每個應用設定 OAuth 設定，以便它們可以獲取所需的權限來訪問 Slack 的功能。

3. **使用不同的 token**：確保每個機器人使用其各自的 token 進行身份驗證，這樣它們就可以獨立執行。

4. **設置事件訂閱**：如果您的機器人需要響應 Slack 中的事件，請為每個應用設置事件訂閱，並確保它們能夠接收和處理事件。

5. **測試和部署**：在開發環境中測試每個機器人的功能，確保它們能夠正常執行，然後再將它們部署到生產環境中。

這樣，您就可以在 Slack 上同時執行多個機器人或聊天，並根據需要進行管理。

是的。使用 **Multi-Agent Routing** 來執行多個獨立的代理並根據通道/帳戶/對等體路由入站消息。Slack 被支援作為一個通道，並可以綁定到特定的代理。

瀏覽器訪問功能強大，但並不是「可以做任何人類能做的事情」——反機器人技術、CAPTCHA 和多重身份驗證仍然可以阻止自動化。為了獲得最可靠的瀏覽器控制，請在執行瀏覽器的機器上使用 Chrome 擴充程式中繼（並將 Gateway 保持在任何地方）。

最佳實踐設置：

- 始終在線的 Gateway 主機 (VPS/Mac mini)。
- 每個角色 (bindings) 一個代理。
- 與這些代理綁定的 Slack 頻道。
- 當需要時，通過擴充功能中繼 (或節點) 使用本地瀏覽器。

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),  
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## Models: defaults, selection, aliases, switching

### 預設模型是什麼

OpenClaw 的預設模型是您所設定的：

```
agents.defaults.model.primary
```

模型被引用為 `provider/model`（範例：`anthropic/claude-opus-4-6`）。如果您省略提供者，OpenClaw 目前假設 `anthropic` 作為臨時棄用的回退選項 - 但您仍然應該 **明確** 設定 `provider/model`。

### 你推薦哪個模型

**建議的預設值：** 使用您提供者堆疊中可用的最強最新一代模型。  
**對於啟用工具或不受信任輸入的代理：** 優先考慮模型的強度而非成本。  
**對於例行/低風險的聊天：** 使用較便宜的備用模型並根據代理角色進行路由。

MiniMax M2.5 擁有自己的文件：[MiniMax](/providers/minimax) 和 [本地模型](/gateway/local-models)。

經驗法則：對於高風險的工作，使用**你能負擔的最佳模型**，而對於日常聊天或摘要則使用較便宜的模型。你可以根據代理人來路由模型，並使用子代理來平行處理長任務（每個子代理會消耗 token）。請參閱 [Models](/concepts/models) 和 [Sub-agents](/tools/subagents)。

強烈警告：較弱或過度量化的模型對於提示注入和不安全行為更為脆弱。請參見 [Security](/gateway/security)。

更多上下文：[Models](/concepts/models)。

### 我可以使用自架設的模型 llamacpp vLLM Ollama 嗎？

是的。Ollama 是本地模型最簡單的途徑。

[[BLOCK_1]]  
最快的設置：  
[[BLOCK_1]]

1. 從 `https://ollama.com/download` 安裝 Ollama
2. 拉取本地模型，例如 `ollama pull glm-4.7-flash`
3. 如果你也想要 Ollama Cloud，請執行 `ollama signin`
4. 執行 `openclaw onboard` 並選擇 `Ollama`
5. 選擇 `Local` 或 `Cloud + Local`

[[BLOCK_1]]

- `Cloud + Local` 提供你 Ollama Cloud 模型以及你本地的 Ollama 模型
- 像 `kimi-k2.5:cloud` 這樣的雲端模型不需要本地拉取
- 若要手動切換，請使用 `openclaw models list` 和 `openclaw models set ollama/<model>`

安全提示：較小或高度量化的模型對於提示注入更為脆弱。我們強烈建議對於任何可以使用工具的機器人使用**大型模型**。如果您仍然想使用小型模型，請啟用沙盒和嚴格的工具允許清單。

Docs: [Ollama](/providers/ollama), [本地模型](/gateway/local-models),
[模型提供者](/concepts/model-providers), [安全性](/gateway/security),
[沙盒環境](/gateway/sandboxing).

### 如何在不清除設定的情況下切換模型

使用 **模型指令** 或僅編輯 **模型** 欄位。避免完全替換設定。

[[BLOCK_1]]  
安全選項：  
[[BLOCK_1]]

- `/model` 在聊天中（快速，每次會話）
- `openclaw models set ...` （僅更新模型設定）
- `openclaw configure --section model` （互動式）
- 編輯 `agents.defaults.model` 在 `~/.openclaw/openclaw.json`

避免使用 `config.apply` 來處理部分物件，除非你打算替換整個設定。如果你已經覆蓋了設定，請從備份中恢復或重新執行 `openclaw doctor` 以進行修復。

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### OpenClaw、Flawd 和 Krill 使用什麼模型

- 這些部署可能會有所不同，並且可能會隨著時間而改變；沒有固定的供應商建議。
- 使用 `openclaw models status` 檢查每個網關的當前執行時設置。
- 對於安全敏感/工具啟用的代理，請使用可用的最強最新一代模型。

### 如何在不重啟的情況下即時切換模型

`/model`

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

`/model` (和 `/model list`) 顯示一個緊湊的編號選擇器。請按編號選擇：

```
/model 3
```

您也可以強制為提供者指定特定的身份驗證設定檔（每個會話）：

```
/model opus@anthropic:default
/model opus@anthropic:work
```

提示：`/model status` 顯示哪個代理正在執行、正在使用哪個 `auth-profiles.json` 檔案，以及下一個將嘗試的身份驗證設定檔。它還會顯示已設定的提供者端點 (`baseUrl`) 和 API 模式 (`api`)，如果可用的話。

**如何取消我用 profile 設定的固定檔案**

重新執行 `/model` **不帶** `@profile` 後綴：

```
/model anthropic/claude-opus-4-6
```

如果您想返回預設值，請從 `/model` 中選擇（或發送 `/model <default provider/model>`）。使用 `/model status` 確認哪個身份驗證設定檔是活動的。

### 我可以使用 GPT 5.2 來處理日常任務，並使用 Codex 5.3 來編碼嗎？

是的。設置一個為預設，並根據需要切換：

- **快速切換（每個會話）：** `/model gpt-5.2` 用於日常任務，`/model openai-codex/gpt-5.4` 用於使用 Codex OAuth 進行編碼。
- **預設 + 切換：** 將 `agents.defaults.model.primary` 設定為 `openai/gpt-5.2`，然後在編碼時切換到 `openai-codex/gpt-5.4`（或反之亦然）。
- **子代理：** 將編碼任務路由到使用不同預設模型的子代理。

請參閱 [Models](/concepts/models) 和 [Slash commands](/tools/slash-commands)。

### 為什麼我會看到「模型不被允許」然後沒有回覆

如果 `agents.defaults.models` 被設定，它將成為 `/model` 的 **允許清單** 以及任何會話覆蓋。選擇不在該清單中的模型將返回：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

該錯誤會被返回 **而不是** 正常的回覆。修正方法：將模型添加到 `agents.defaults.models`，移除允許清單，或從 `/model list` 中選擇一個模型。

### 為什麼我會看到 Unknown model minimaxMiniMaxM25

這意味著 **提供者尚未設定**（未找到 MiniMax 提供者設定或身份驗證檔案），因此無法解析模型。此檢測的修正將在 **2026.1.12** 中提供（在撰寫時尚未發布）。

[[BLOCK_1]]

1. 升級到 **2026.1.12**（或從源碼執行 `main`），然後重新啟動網關。
2. 確保 MiniMax 已設定（使用精靈或 JSON），或在 env/auth 設定檔中存在 MiniMax API 金鑰，以便可以注入提供者。
3. 使用精確的模型 ID（區分大小寫）：`minimax/MiniMax-M2.5` 或 `minimax/MiniMax-M2.5-highspeed`。
4. 執行：

```bash
   openclaw models list
```

並從列表中選擇（或在聊天中 `/model list`）。

請參閱 [MiniMax](/providers/minimax) 和 [Models](/concepts/models)。

### 我可以將 MiniMax 設為預設，並將 OpenAI 用於複雜任務嗎？

是的。使用 **MiniMax 作為預設**，並在需要時 **每個會話切換模型**。回退是為了 **錯誤**，而不是「困難任務」，因此請使用 `/model` 或單獨的代理。

**選項 A：每個會話切換**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.5" },
      models: {
        "minimax/MiniMax-M2.5": { alias: "minimax" },
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

**選項 B：分開代理**

- 代理 A 預設：MiniMax
- 代理 B 預設：OpenAI
- 按代理路由或使用 `/agent` 來切換

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### 是否有內建的 Opus Sonnet GPT 快捷方式

是的。OpenClaw 提供了一些預設的簡寫（僅在模型存在於 `agents.defaults.models` 時適用）：

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-6`
- `gpt` → `openai/gpt-5.4`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3.1-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`
- `gemini-flash-lite` → `google/gemini-3.1-flash-lite-preview`

如果您設置了與相同名稱的別名，則您的值將優先。

### 如何定義或覆寫模型快捷方式別名

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

然後 `/model sonnet` （或在支援時使用 `/<alias>`）解析為該模型 ID。

### 如何從其他提供者如 OpenRouter 或 ZAI 添加模型

OpenRouter (按 token 收費；多種模型)：

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

Z.AI (GLM 模型):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-5" },
      models: { "zai/glm-5": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

如果您引用了一個提供者/模型，但缺少所需的提供者金鑰，您將會遇到執行時授權錯誤（例如 `No API key found for provider "zai"`）。

**未找到提供者的 API 金鑰，因為新增了代理**

這通常意味著 **新代理** 擁有一個空的認證存儲。認證是針對每個代理的，並儲存在：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

[[BLOCK_1]]  
修正選項：  
[[BLOCK_1]]

- 在精靈中執行 `openclaw agents add <id>` 並設定身份驗證。
- 或者將主代理的 `agentDir` 中的 `auth-profiles.json` 複製到新代理的 `agentDir` 中。

請勿在不同的代理之間重複使用 `agentDir`；這會導致身份驗證/會話衝突。

## 模型故障轉移與「所有模型均失敗」

### 故障轉移是如何運作的

故障轉移分為兩個階段：

1. **同一提供者內的認證設定輪換**。
2. **模型回退**至 `agents.defaults.model.fallbacks` 中的下一個模型。

冷卻時間適用於失敗的設定檔（指數退避），因此 OpenClaw 即使在提供者受到速率限制或暫時失敗的情況下，仍然可以持續回應。

### 這個錯誤代表什麼意思

```
No credentials found for profile "anthropic:default"
```

這表示系統嘗試使用認證設定檔 ID `anthropic:default`，但在預期的認證儲存中找不到相應的憑證。

### 修正清單：未找到檔案 anthropicdefault 的憑證

[[BLOCK_1]]

1. 確認 AWS CLI 已正確安裝並設定。
2. 檢查 ~/.aws/config 和 ~/.aws/credentials 檔案，確保檔案中包含 anthropicdefault 的設定。
3. 確保使用的 AWS 憑證是有效的，並且擁有適當的權限。
4. 如果使用環境變數，請確認 AWS_PROFILE 是否設置為 anthropicdefault。
5. 嘗試重新啟動終端機或命令提示字元，並再次執行相關命令。

[[BLOCK_2]]

- **確認認證設定檔的位置**（新路徑與舊路徑）
  - 當前: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - 舊版: `~/.openclaw/agent/*`（由 `openclaw doctor` 遷移）
- **確認您的環境變數已被 Gateway 載入**
  - 如果您在 shell 中設置了 `ANTHROPIC_API_KEY` 但通過 systemd/launchd 執行 Gateway，則可能不會繼承它。請將其放入 `~/.openclaw/.env` 或啟用 `env.shellEnv`。
- **確保您正在編輯正確的代理**
  - 多代理設置意味著可能會有多個 `auth-profiles.json` 檔案。
- **檢查模型/認證狀態**
  - 使用 `openclaw models status` 查看已設定的模型以及提供者是否已通過認證。

**修正清單：未找到設定檔案 anthropic 的憑證**

這意味著該執行被固定在一個 Anthropic 認證設定檔上，但 Gateway 無法在其認證存儲中找到它。

- **使用設定token**
  - 執行 `claude setup-token`，然後將其與 `openclaw models auth setup-token --provider anthropic` 一起貼上。
  - 如果token是在另一台機器上創建的，請使用 `openclaw models auth paste-token --provider anthropic`。
- **如果您想改用 API 金鑰**
  - 將 `ANTHROPIC_API_KEY` 放入 `~/.openclaw/.env` 在 **網關主機** 上。
  - 清除任何強制缺少設定檔的固定順序：

````bash
    openclaw models auth order clear --provider anthropic
    ```

- **確認您正在網關主機上執行命令**
  - 在遠端模式下，身份驗證設定檔位於網關機器上，而不是您的筆記型電腦上。

### 為什麼它也嘗試了 Google Gemini 並失敗了

如果您的模型設定中包含 Google Gemini 作為備援（或您切換到 Gemini 簡稱），OpenClaw 將在模型備援期間嘗試使用它。如果您尚未設定 Google 憑證，您將看到 `No API key found for provider "google"`。

修正：要麼提供 Google 認證，要麼在 `agents.defaults.model.fallbacks` / 別名中移除/避免使用 Google 模型，以便回退不會路由到那裡。

**LLM 請求被拒絕的訊息，思考簽名要求 Google 反重力**

原因：會話歷史中包含 **沒有簽名的思考區塊**（通常來自中止/部分的串流）。Google Antigravity 需要思考區塊的簽名。

修正：OpenClaw 現在會為 Google Antigravity Claude 移除無符號思考區塊。如果它仍然出現，請開始一個 **新會話** 或為該代理設定 `/thinking off`。

## Auth profiles: 什麼是它們以及如何管理它們

相關內容：[/concepts/oauth](/concepts/oauth) (OAuth 流程、token 儲存、多帳戶模式)

### 什麼是身份驗證設定檔

一個認證設定檔是與提供者相關聯的命名憑證記錄（OAuth 或 API 金鑰）。設定檔位於：

````

~/.openclaw/agents/<agentId>/agent/auth-profiles.json

````

### 典型的個人檔案 ID 是什麼？

OpenClaw 使用供應商前綴的 ID，例如：

- `anthropic:default` （當不存在電子郵件身份時常見）
- `anthropic:<email>` 用於 OAuth 身份
- 您選擇的自訂 ID（例如 `anthropic:work`）

### 我可以控制哪個認證設定檔優先嘗試嗎

是的。設定支援為每個設定檔提供可選的元資料，以及每個提供者的排序 (`auth.order.<provider>`). 這**不**會儲存秘密；它將 ID 對應到提供者/模式並設置輪換順序。

OpenClaw 可能會暫時跳過一個設定檔，如果它處於短暫的 **冷卻** 狀態（速率限制/超時/授權失敗）或較長的 **禁用** 狀態（計費/餘額不足）。要檢查這一點，請執行 `openclaw models status --json` 並檢查 `auth.unusableProfiles`。調整：`auth.cooldowns.billingBackoffHours*`。

您也可以透過 CLI 設定 **每個代理** 的訂單覆蓋（儲存在該代理的 `auth-profiles.json`）:

bash
# 預設使用已設定的預設代理（省略 --agent）
openclaw models auth order get --provider anthropic


# 鎖定旋轉至單一設定檔（僅嘗試這一個）
openclaw models auth order set --provider anthropic anthropic:default

# 或設定明確的順序（在提供者內的後備）
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# 清除覆蓋（回退至設定的 auth.order / 迴圈）
openclaw models auth order clear --provider anthropic


要針對特定代理：

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
````

### OAuth 與 API 金鑰的差異

OAuth 和 API 金鑰都是用於身份驗證和授權的技術，但它們在使用方式和安全性上有顯著的不同。

1. **身份驗證方式**：
   - **API 金鑰**：通常是靜態的，開發者在應用程式中嵌入一個唯一的金鑰，這個金鑰用於識別應用程式並授權其訪問 API。這種方式相對簡單，但如果金鑰洩露，可能會導致安全風險。
   - **OAuth**：是一種更為複雜的授權框架，允許應用程式在不直接暴露用戶憑證的情況下，獲取對資源的訪問權限。OAuth 通常涉及多個步驟，包括用戶授權和token交換，這使得它在安全性上更具優勢。

2. **安全性**：
   - **API 金鑰**：因為金鑰是靜態的，若被盜取，攻擊者可以無限制地使用該金鑰訪問 API，這使得 API 金鑰的安全性較低。
   - **OAuth**：使用短期的訪問token，並且可以設置權限範圍，這樣即使token被盜取，攻擊者的行動也會受到限制。此外，OAuth 允許用戶隨時撤銷授權。

3. **使用場景**：
   - **API 金鑰**：適合用於簡單的應用程式或內部服務，當安全性要求不高時，可以快速實現。
   - **OAuth**：適合用於需要用戶授權的應用程式，特別是當應用程式需要訪問用戶的私人數據時，如社交媒體或雲端服務。

總結來說，選擇 OAuth 還是 API 金鑰取決於應用程式的需求和安全性考量。

OpenClaw 同時支援：

- **OAuth** 通常利用訂閱訪問（如適用）。
- **API 金鑰** 採用按 token 計費。

該精靈明確支援 Anthropic 的 setup-token 和 OpenAI Codex 的 OAuth，並且可以為您儲存 API 金鑰。

## Gateway: 端口、"已經執行" 和遠端模式

### Gateway 使用哪個埠口

`gateway.port` 控制 WebSocket + HTTP 的單一多路復用端口（控制 UI、hooks 等）。

[[BLOCK_1]]

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
```

### 為什麼 openclaw 閘道狀態顯示執行時正在執行但 RPC 探測失敗？

因為「執行」是 **監督者** 的視角（launchd/systemd/schtasks）。RPC 探針實際上是 CLI 連接到網關 WebSocket 並調用 `status`。

使用 `openclaw gateway status` 並信任這些行：

- `Probe target:` (探測器實際使用的 URL)
- `Listening:` (實際綁定在端口上的內容)
- `Last gateway error:` (當進程仍在執行但端口未在監聽時的常見根本原因)

### 為什麼 openclaw 閘道狀態顯示 Config cli 和 Config service 不同

您正在編輯一個設定檔案，而服務正在執行另一個（通常是 `--profile` / `OPENCLAW_STATE_DIR` 不匹配）。

[[BLOCK_1]]

```bash
openclaw gateway install --force
```

從您希望服務使用的相同 `--profile` / 環境中執行該操作。

### 另一個網關實例已經在監聽是什麼意思

這個錯誤訊息表示在同一個端口上已經有另一個網關實例正在執行，導致新的實例無法啟動。這通常發生在以下情況：

1. **端口衝突**：您嘗試啟動的網關實例使用的端口已經被其他應用程式或服務佔用。
2. **重複啟動**：您可能不小心啟動了多個相同的網關實例，導致它們嘗試在同一端口上執行。
3. **服務未正確關閉**：之前的網關實例可能未正確關閉，仍然在佔用該端口。

要解決此問題，您可以：

- 檢查正在執行的服務，確保沒有其他實例在使用相同的端口。
- 如果需要，終止佔用該端口的進程。
- 確保在啟動新的網關實例之前，所有舊的實例都已正確關閉。

OpenClaw 透過在啟動時立即綁定 WebSocket 監聽器來強制執行執行時鎖定（預設 `ws://127.0.0.1:18789`）。如果綁定失敗，則會顯示 `EADDRINUSE`，並拋出 `GatewayLockError`，表示另一個實例已經在監聽。

修正：停止其他實例，釋放端口，或使用 `openclaw gateway --port <port>` 執行。

### 如何在遠端模式下執行 OpenClaw，用戶端連接到其他地方的 Gateway

設定 `gateway.mode: "remote"` 並指向一個遠端的 WebSocket URL，選擇性地附上 token/密碼：

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

[[BLOCK_1]]

- `openclaw gateway` 只有在 `gateway.mode` 為 `local` 時才會啟動（或當你傳遞覆蓋標誌時）。
- macOS 應用程式會監控設定檔，並在這些值變更時即時切換模式。

### 控制介面顯示未授權或不斷重新連接，該怎麼辦？

您的閘道正在啟用身份驗證 (`gateway.auth.*`)，但使用者介面並未發送匹配的 token/密碼。

[[BLOCK_1]]  
Facts (from code):  
[[BLOCK_1]]

- 控制介面將 token 保存在 `sessionStorage` 中，以便於當前瀏覽器標籤頁的會話和選定的網關 URL，因此同一標籤頁的刷新可以正常運作，而無需恢復長期存在的 localStorage token 持久性。
- 在 `AUTH_TOKEN_MISMATCH` 上，受信任的用戶端可以在網關返回重試提示時，使用快取的設備 token 嘗試一次有限的重試 (`canRetryWithDeviceToken=true`, `recommendedNextStep=retry_with_device_token`)。

[[BLOCK_1]]

- 最快的方式：`openclaw dashboard`（列印並複製儀表板 URL，嘗試開啟；如果是無頭模式則顯示 SSH 提示）。
- 如果你還沒有 token：`openclaw doctor --generate-gateway-token`。
- 如果是遠端，先建立隧道：`ssh -N -L 18789:127.0.0.1:18789 user@host` 然後開啟 `http://127.0.0.1:18789/`。
- 在閘道主機上設定 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 在控制 UI 設定中，貼上相同的 token。
- 如果在重試一次後仍然不匹配，請旋轉/重新批准配對設備的 token：
  - `openclaw devices list`
  - `openclaw devices rotate --device <id> --role operator`
- 還是卡住了嗎？執行 `openclaw status --all` 並遵循 [故障排除](/gateway/troubleshooting)。查看 [儀表板](/web/dashboard) 獲取認證詳細資訊。

### 我設定了 gatewaybind tailnet，但它無法綁定，沒有任何東西在監聽。

`tailnet` bind 會從您的網路介面中選擇一個 Tailscale IP（100.64.0.0/10）。如果該機器不在 Tailscale 上（或介面已關閉），則沒有任何可綁定的對象。

[[BLOCK_1]]

- 在該主機上啟動 Tailscale（以便它擁有 100.x 地址），或
- 切換到 `gateway.bind: "loopback"` / `"lan"`。

注意：`tailnet` 是明確的。`auto` 偏好迴路；當你想要僅限於 tailnet 的綁定時，請使用 `gateway.bind: "tailnet"`。

### 我可以在同一主機上執行多個 Gateway 嗎

通常不需要 - 一個 Gateway 可以執行多個消息通道和代理。只有在需要冗餘（例如：救援機器人）或嚴格隔離的情況下，才使用多個 Gateways。

是的，但你必須隔離：

- `OPENCLAW_CONFIG_PATH` (每個實例的設定)
- `OPENCLAW_STATE_DIR` (每個實例的狀態)
- `agents.defaults.workspace` (工作區隔離)
- `gateway.port` (唯一的端口)

快速設定（建議）：

- 每個實例使用 `openclaw --profile <name> …`（自動創建 `~/.openclaw-<name>`）。
- 在每個設定檔中設置唯一的 `gateway.port`（或傳遞 `--port` 以進行手動執行）。
- 安裝每個設定檔的服務：`openclaw --profile <name> gateway install`。

Profiles 也會為服務名稱添加後綴 (`ai.openclaw.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`)。  
完整指南： [多個網關](/gateway/multiple-gateways)。

### 無效握手程式碼 1008 代表什麼意思

無效握手程式碼 1008 通常表示在進行網路連接時出現了問題，這可能是由於協議不匹配、認證失敗或其他連接問題所導致的。當用戶端和伺服器之間的握手過程未能成功完成時，就會出現此錯誤。這可能需要檢查網路設定、API 金鑰或其他相關的連接參數，以確保它們正確無誤。

Gateway 是一個 **WebSocket 伺服器**，它期望第一條消息是 `connect` 幀。如果接收到其他任何內容，它將以 **程式碼 1008**（政策違規）關閉連接。

常見原因：

- 你在瀏覽器中打開了 **HTTP** URL (`http://...`) 而不是 WS 用戶端。
- 你使用了錯誤的埠或路徑。
- 代理或隧道刪除了認證標頭或發送了非 Gateway 請求。

快速修正：

1. 使用 WS URL: `ws://<host>:18789`（如果是 HTTPS，則使用 `wss://...`）。
2. 不要在普通的瀏覽器標籤中打開 WS 端口。
3. 如果啟用了身份驗證，請在 `connect` 框架中包含 token/密碼。

如果您正在使用 CLI 或 TUI，URL 應該看起來像是：

```
openclaw tui --url ws://<host>:18789 --token <token>
```

協議詳情：[Gateway protocol](/gateway/protocol)。

## Logging and debugging

### 日誌在哪裡

File logs (structured):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

您可以透過 `logging.file` 設定穩定的路徑。檔案日誌等級由 `logging.level` 控制。控制台的詳細程度由 `--verbose` 和 `logging.consoleLevel` 控制。

最快的日誌尾部：

```bash
openclaw logs --follow
```

Service/supervisor 日誌（當網關通過 launchd/systemd 執行時）：

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` 和 `gateway.err.log` (預設: `~/.openclaw/logs/...`; 設定檔使用 `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

請參閱 [Troubleshooting](/gateway/troubleshooting#log-locations) 以獲取更多資訊。

### 如何啟動/停止/重啟 Gateway 服務

使用網關輔助工具：

```bash
openclaw gateway status
openclaw gateway restart
```

如果您手動執行網關，`openclaw gateway --force` 可以重新佔用該端口。請參閱 [Gateway](/gateway)。

### 我在 Windows 上關閉了終端機，該如何重新啟動 OpenClaw？

有 **兩種 Windows 安裝模式**：

**1) WSL2 (推薦)：** Gateway 在 Linux 內部執行。

開啟 PowerShell，進入 WSL，然後重啟：

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

如果您從未安裝過該服務，請在前景中啟動它：

```bash
openclaw gateway run
```

**2) 原生 Windows（不建議）：** Gateway 直接在 Windows 上執行。

打開 PowerShell 並執行：

```powershell
openclaw gateway status
openclaw gateway restart
```

如果您手動執行（不使用服務），請使用：

```powershell
openclaw gateway run
```

Docs: [Windows (WSL2)](/platforms/windows), [Gateway 服務執行手冊](/gateway).

### Gateway 已啟動但回覆從未到達，我應該檢查什麼？

[[BLOCK_1]]  
開始進行快速健康檢查：  
[[BLOCK_1]]

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

常見原因：

- 模型認證未在 **網關主機** 上加載 (請檢查 `models status`)。
- 通道配對/允許清單阻擋回覆 (請檢查通道設定 + 日誌)。
- WebChat/儀表板在沒有正確 token 的情況下開放。

如果您是遠端使用者，請確認隧道/Tailscale 連線已啟動，並且 Gateway WebSocket 可達。

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### 斷開與網關的連接，沒有原因，現在該怎麼辦

這通常表示 UI 失去了 WebSocket 連線。請檢查：

1. Gateway 是否正在執行？ `openclaw gateway status`
2. Gateway 是否健康？ `openclaw status`
3. UI 是否擁有正確的 token？ `openclaw dashboard`
4. 如果是遠端，隧道/Tailscale 連結是否正常？

然後查看日誌：

```bash
openclaw logs --follow
```

Docs: [儀表板](/web/dashboard), [遠端存取](/gateway/remote), [故障排除](/gateway/troubleshooting)。

### Telegram setMyCommands 失敗時應檢查什麼

1. **API Token**: 確保您使用的 API token 是正確的，並且該 token 具有足夠的權限來設置命令。

2. **Bot Permissions**: 檢查您的機器人是否擁有設置命令的權限。某些機器人可能需要特定的權限才能執行此操作。

3. **Command Format**: 確保您傳遞的命令格式正確。命令應該是 JSON 格式，並且每個命令都應包含 command 和 description 字段。

4. **Telegram API Status**: 檢查 Telegram API 的狀態，確保沒有服務中斷或故障。

5. **Rate Limits**: 確認您沒有超過 Telegram API 的速率限制。過於頻繁的請求可能會導致失敗。

6. **Error Messages**: 檢查 API 返回的錯誤消息，這些消息通常會提供有關問題的具體資訊。

7. **Bot Updates**: 確保您的機器人已經更新到最新版本，因為舊版本可能不支援某些功能。

8. **Network Issues**: 檢查您的網路連接，確保可以正常訪問 Telegram 伺服器。

開始於日誌和頻道狀態：

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

然後匹配錯誤：

- `BOT_COMMANDS_TOO_MUCH`: Telegram 選單的專案過多。OpenClaw 已經修剪到 Telegram 的限制並嘗試使用更少的指令，但仍需刪除某些選單專案。減少插件/技能/自定義指令，或如果不需要選單，請禁用 `channels.telegram.commands.native`。
- `TypeError: fetch failed`、`Network request for 'setMyCommands' failed!` 或類似的網路錯誤：如果您在 VPS 上或位於代理後面，請確認允許外發的 HTTPS 並且 DNS 對 `api.telegram.org` 正常運作。

如果網關是遠端的，請確保您正在查看網關主機上的日誌。

Docs: [Telegram](/channels/telegram), [頻道故障排除](/channels/troubleshooting).

### TUI 沒有輸出，我應該檢查什麼

[[BLOCK_1]]

1. 確認 TUI 是否正確安裝並且已啟動。
2. 檢查終端機的顯示設置，確保它支援 TUI。
3. 確認是否有任何錯誤訊息或警告顯示在終端機中。
4. 檢查應用程式的日誌檔案，以尋找可能的錯誤或異常。
5. 確保相關的依賴項和庫已正確安裝。
6. 嘗試重新啟動應用程式或終端機。  
   [[BLOCK_1]]

首先確認 Gateway 是否可達，並且代理程式可以執行：

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

在 TUI 中，使用 `/status` 來查看當前狀態。如果您期望在聊天頻道中收到回覆，請確保已啟用傳送 (`/deliver on`)。

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### 如何完全停止然後啟動 Gateway

如果您已安裝該服務：

```bash
openclaw gateway stop
openclaw gateway start
```

這會停止/啟動 **受監督的服務**（macOS 上的 launchd，Linux 上的 systemd）。當 Gateway 在背景作為守護進程執行時，請使用此功能。

如果您正在前景執行，請使用 Ctrl-C 停止，然後：

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway restart vs openclaw gateway

[[BLOCK_1]]  
openclaw gateway 是一個用於管理和處理請求的系統，而 openclaw gateway restart 則是重新啟動這個系統的過程。當你執行 openclaw gateway restart 時，系統會關閉並重新啟動，這通常用於解決問題或應用更新。

[[BLOCK_2]]  
簡單來說，openclaw gateway 是正在執行的系統，而 openclaw gateway restart 是讓這個系統重新開始的指令。

- `openclaw gateway restart`: 重新啟動 **背景服務** (launchd/systemd)。
- `openclaw gateway`: 在此終端會話中 **以前景模式** 執行網關。

如果您已安裝該服務，請使用網關命令。當您想要一次性、前景執行時，請使用 `openclaw gateway`。

### 當某件事情失敗時，獲取更多細節的最快方法是什麼

使用 `--verbose` 啟動 Gateway 以獲取更多控制台詳細資訊。然後檢查日誌文件以查看通道驗證、模型路由和 RPC 錯誤。

## 媒體與附件

### 我的技能生成了一個 imagePDF，但沒有發送任何內容。

代理發送的附件必須包含一個 `MEDIA:<path-or-url>` 行（單獨一行）。請參閱 [OpenClaw 助手設置](/start/openclaw) 和 [代理發送](/tools/agent-send)。

CLI 發送：

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

也請檢查：

- 目標頻道支援外發媒體，且不受允許清單的限制。
- 檔案在提供者的大小限制內（圖片最大調整為 2048px）。

請參見 [Images](/nodes/images)。

## 安全性與存取控制

### 將 OpenClaw 暴露於進入的 DM 是否安全

將進來的私訊視為不受信任的輸入。預設設置旨在降低風險：

- DM 能夠的頻道的預設行為是 **配對**：
  - 不明發送者會收到一個配對碼；機器人不會處理他們的訊息。
  - 批准請求使用：`openclaw pairing approve --channel <channel> [--account <id>] <code>`
  - 每個頻道的待處理請求上限為 **3**；如果沒有收到碼，請檢查 `openclaw pairing list --channel <channel> [--account <id>]`。
- 公開開啟 DM 需要明確的選擇加入 (`dmPolicy: "open"` 和允許清單 `"*"`).

執行 `openclaw doctor` 以顯示風險較高的 DM 政策。

### 提示注入僅僅是公共機器人的一個問題嗎

不，提示注入是關於 **不受信任的內容**，而不僅僅是誰可以私訊機器人。如果您的助手讀取外部內容（網頁搜尋/擷取、瀏覽器頁面、電子郵件、文件、附件、貼上的日誌），這些內容可能包含試圖劫持模型的指令。即使 **您是唯一的發送者**，這種情況也可能發生。

最大的風險在於當工具被啟用時：模型可能會被欺騙以外洩上下文或代表您調用工具。透過以下方式減少影響範圍：

- 使用只讀或工具禁用的「讀取」代理來總結不受信任的內容
- 對於啟用工具的代理，保持 `web_search` / `web_fetch` / `browser` 關閉
- 沙盒化和嚴格的工具允許清單

細節: [安全性](/gateway/security)。

### 我的機器人應該擁有自己的電子郵件 GitHub 帳號或電話號碼嗎？

是的，對於大多數設置來說，使用不同的帳戶和電話號碼來隔離機器人可以減少如果出現問題時的影響範圍。這樣也更容易輪換憑證或撤銷訪問權限，而不會影響到您的個人帳戶。

從小開始。僅提供您實際需要的工具和帳戶的存取權限，必要時再擴充。

Docs: [安全性](/gateway/security), [配對](/channels/pairing).

### 我可以讓它自主處理我的簡訊嗎？這樣安全嗎？

我們**不**建議對您的個人訊息完全自動化。最安全的模式是：

- 將私訊保持在 **配對模式** 或嚴格的允許清單中。
- 如果希望它代表你發送訊息，請使用 **單獨的號碼或帳號**。
- 讓它草擬，然後 **在發送前批准**。

如果你想進行實驗，請在專用帳戶上進行並保持其隔離。請參見 [Security](/gateway/security)。

### 我可以使用較便宜的模型來執行個人助理任務嗎？

是的，**如果**代理是僅限聊天且輸入是可信的。較小的層級更容易受到指令劫持，因此應避免在工具啟用的代理或閱讀不可信內容時使用它們。如果必須使用較小的模型，請鎖定工具並在沙盒中執行。請參閱 [Security](/gateway/security)。

### 我在 Telegram 中執行了 start，但沒有收到配對碼。

配對程式碼僅在未知發件人發送訊息給機器人且 `dmPolicy: "pairing"` 已啟用時發送。 `/start` 本身不會產生程式碼。

檢查待處理的請求：

```bash
openclaw pairing list telegram
```

如果您想要立即訪問，請將您的發件人 ID 加入白名單或為該帳戶設置 `dmPolicy: "open"`。

### WhatsApp 會不會發送訊息給我的聯絡人？配對是如何運作的？

不。預設的 WhatsApp 直接訊息政策是 **配對**。未知的發送者僅會收到一個配對碼，他們的訊息 **不會被處理**。OpenClaw 只會回覆它收到的聊天訊息或是你觸發的明確發送。

批准配對與：

```bash
openclaw pairing approve whatsapp <code>
```

列出待處理的請求：

```bash
openclaw pairing list whatsapp
```

Wizard 電話號碼提示：它用於設置您的 **允許清單/擁有者**，以便允許您的私人訊息。它不會用於自動發送。如果您使用的是個人 WhatsApp 號碼，請使用該號碼並啟用 `channels.whatsapp.selfChatMode`。

## 聊天指令、終止任務及「它不會停止」

### 如何停止內部系統訊息在聊天中顯示

大多數內部或工具訊息僅在該會話啟用 **verbose** 或 **reasoning** 時顯示。

[[BLOCK_1]]

```
/verbose off
/reasoning off
```

如果仍然有噪音，請檢查控制介面的會話設定，並將詳細程度設為 **inherit**。同時確認您沒有在設定中使用設定為 `on` 的機器人設定檔 `verboseDefault`。

Docs: [思考與詳細說明](/tools/thinking), [安全性](/gateway/security#reasoning--verbose-output-in-groups).

### 如何停止或取消正在執行的任務

請將這些 **作為獨立訊息發送**（不使用斜線）：

```
stop
stop action
stop current action
stop run
stop current run
stop agent
stop the agent
stop openclaw
openclaw stop
stop don't do anything
stop do not do anything
stop doing anything
please stop
stop please
abort
esc
wait
exit
interrupt
```

這些是中止觸發器（不是斜線指令）。

對於背景程序（來自 exec 工具），您可以要求代理執行：

```
process action:kill sessionId:XXX
```

Slash 指令概述：請參見 [Slash commands](/tools/slash-commands)。

大多數指令必須作為獨立的訊息發送，並以 `/` 開頭，但少數快捷方式（如 `/status`）也可以對允許的發送者進行內嵌使用。

### 如何從 Telegram 發送 Discord 訊息 跨上下文訊息被拒絕

OpenClaw 預設會阻止 **跨提供者** 的訊息傳遞。如果一個工具呼叫綁定到 Telegram，則不會發送到 Discord，除非您明確允許。

啟用代理的跨供應商消息傳遞：

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

在編輯設定後，請重新啟動網關。如果您只想針對單一代理進行此操作，請將其設置在 `agents.list[].tools.message` 之下。

### 為什麼感覺機器人忽略快速發送的訊息

佇列模式控制新消息如何與正在進行的執行互動。使用 `/queue` 來更改模式：

- `steer` - 新訊息會重新導向當前任務
- `followup` - 一次執行一條訊息
- `collect` - 批次處理訊息並一次回覆（預設）
- `steer-backlog` - 立即引導，然後處理積壓
- `interrupt` - 中止當前執行並重新開始

您可以添加選項，例如 `debounce:2s cap:25 drop:summarize` 以用於後續模式。

抱歉，我無法查看或分析截圖或聊天記錄。如果您能提供具體的問題或內容，我將很樂意幫助您。

**Q: "Anthropic 的預設模型是什麼，使用 API 金鑰時？"**

**A:** 在 OpenClaw 中，憑證和模型選擇是分開的。設定 `ANTHROPIC_API_KEY`（或將 Anthropic API 金鑰儲存在認證檔案中）可以啟用身份驗證，但實際的預設模型是您在 `agents.defaults.model.primary` 中設定的任何模型（例如，`anthropic/claude-sonnet-4-5` 或 `anthropic/claude-opus-4-6`）。如果您看到 `No credentials found for profile "anthropic:default"`，這意味著 Gateway 無法在預期的 `auth-profiles.json` 中找到正在執行的代理的 Anthropic 憑證。

---

還是卡住了嗎？可以在 [Discord](https://discord.com/invite/clawd) 上詢問或開啟 [GitHub 討論](https://github.com/openclaw/openclaw/discussions)。
