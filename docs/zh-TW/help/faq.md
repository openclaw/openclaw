---
summary: "關於 OpenClaw 安裝、設定與使用的常見問題"
title: "FAQ"
---

<!-- markdownlint-disable MD051 -->

# FAQ

快速回答以及針對實際設置（本地開發、VPS、多智慧代理、OAuth/API 金鑰、模型故障轉移）的深度疑難排解。關於執行階段診斷，請參閱 [疑難排解](/gateway/troubleshooting)。完整的設定參考，請參閱 [設定](/gateway/configuration)。

## 目錄

- [快速開始與首次執行設定]
  - [我卡住了，解決問題最快的方法是什麼？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [推薦的 OpenClaw 安裝與設定方式是什麼？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [完成新手導覽後如何開啟儀表板？](#how-do-i-open-the-dashboard-after-onboarding)
  - [如何驗證 localhost 與遠端儀表板的憑證 (token)？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [我需要什麼執行環境？](#what-runtime-do-i-need)
  - [它可以在 Raspberry Pi 上執行嗎？](#does-it-run-on-raspberry-pi)
  - [有任何關於 Raspberry Pi 安裝的建議嗎？](#any-tips-for-raspberry-pi-installs)
  - [它卡在 "wake up my friend" / 新手導覽無法完成，該怎麼辦？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [我可以將設定遷移到新機器 (Mac mini) 而不必重新進行新手導覽嗎？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [在哪裡可以看到最新版本的更新內容？](#where-do-i-see-what-is-new-in-the-latest-version)
  - [我無法存取 docs.openclaw.ai (SSL 錯誤)，該怎麼辦？](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Stable 與 Beta 版本有什麼區別？](#whats-the-difference-between-stable-and-beta)
  - [如何安裝 Beta 版本，Beta 與 Dev 有什麼不同？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [如何試用最新的功能？](#how-do-i-try-the-latest-bits)
  - [安裝與新手導覽通常需要多久時間？](#how-long-does-install-and-onboarding-usually-take)
  - [安裝程式卡住了？如何獲得更多回饋資訊？](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows 安裝顯示找不到 git 或無法辨識 openclaw](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [文件沒有解決我的問題 - 如何獲得更好的答案？](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [如何在 Linux 上安裝 OpenClaw？](#how-do-i-install-openclaw-on-linux)
  - [如何在 VPS 上安裝 OpenClaw？](#how-do-i-install-openclaw-on-a-vps)
  - [雲端/VPS 安裝指南在哪裡？](#where-are-the-cloudvps-install-guides)
  - [我可以要求 OpenClaw 自行更新嗎？](#can-i-ask-openclaw-to-update-itself)
  - [新手導覽精靈實際上做了什麼？](#what-does-the-onboarding-wizard-actually-do)
  - [我需要 Claude 或 OpenAI 訂閱才能執行嗎？](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [我可以在沒有 API 金鑰的情況下使用 Claude Max 訂閱嗎？](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic "setup-token" 驗證如何運作？](#how-does-anthropic-setuptoken-auth-work)
  - [在哪裡可以找到 Anthropic setup-token？](#where-do-i-find-an-anthropic-setuptoken)
  - [你們支援 Claude 訂閱驗證 (Claude Pro 或 Max) 嗎？](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [為什麼我會看到 Anthropic 的 `HTTP 429: rate_limit_error`？](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [支援 AWS Bedrock 嗎？](#is-aws-bedrock-supported)
  - [Codex 驗證如何運作？](#how-does-codex-auth-work)
  - [你們支援 OpenAI 訂閱驗證 (Codex OAuth) 嗎？](#do-you-support-openai-subscription-auth-codex-oauth)
  - [如何設定 Gemini CLI OAuth？](#how-do-i-set-up-gemini-cli-oauth)
  - [本地模型適合日常聊天嗎？](#is-a-local-model-ok-for-casual-chats)
  - [如何將託管模型流量保持在特定區域？](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [我必須購買 Mac Mini 才能安裝嗎？](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [我需要 Mac mini 才能支援 iMessage 嗎？](#do-i-need-a-mac-mini-for-imessage-support)
  - [如果我買了 Mac mini 來執行 OpenClaw，可以連線到我的 MacBook Pro 嗎？](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [我可以使用 Bun 嗎？](#can-i-use-bun)
  - [Telegram：`allowFrom` 欄位填什麼？](#telegram-what-goes-in-allowfrom)
  - [多人可以使用不同的 OpenClaw 執行個體共用同一個 WhatsApp 號碼嗎？](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [我可以同時執行一個「快速聊天」智慧代理和一個「用於編碼的 Opus」智慧代理嗎？](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew 可以在 Linux 上運作嗎？](#does-homebrew-work-on-linux)
  - [「可開發 (git)」安裝與 npm 安裝有什麼區別？](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [稍後可以在 npm 與 git 安裝之間切換嗎？](#can-i-switch-between-npm-and-git-installs-later)
  - [我應該在筆記型電腦還是 VPS 上執行 Gateway？](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [在專用機器上執行 OpenClaw 有多重要？](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [VPS 的最低需求與推薦作業系統是什麼？](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [我可以在虛擬機器 (VM) 中執行 OpenClaw 嗎？需求是什麼？](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [什麼是 OpenClaw？](#what-is-openclaw)
  - [用一段話說明什麼是 OpenClaw？](#what-is-openclaw-in-one-paragraph)
  - [它的價值主張是什麼？](#whats-the-value-proposition)
  - [我剛設定好，第一步應該做什麼？](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw 的五個日常使用場景是什麼？](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw 可以協助 SaaS 的潛在客戶開發、廣告與部落格嗎？](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [相較於 Claude Code，在網頁開發方面有哪些優勢？](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills 與自動化](#skills-and-automation)
  - [如何在不更動 repo 的情況下自訂 Skills？](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [我可以從自訂資料夾載入 Skills 嗎？](#can-i-load-skills-from-custom-folder)
  - [如何針對不同任務使用不同的模型？](#how-can-i-use-different-models-for-different-tasks)
  - [智慧代理在執行繁重工作時會凍結，該如何卸載？](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron 或提醒沒有觸發，我該檢查什麼？](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [如何在 Linux 上安裝 Skills？](#how-do-i-install-skills-on-linux)
  - [OpenClaw 可以按排程或在背景持續執行任務嗎？](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [我可以從 Linux 執行僅限 Apple macOS 的 Skills 嗎？](#can-i-run-apple-macos-only-skills-from-linux)
  - [你們有 Notion 或 HeyGen 整合嗎？](#you-have-a-notion-or-heygen-integration)
  - [如何安裝用於瀏覽器接管的 Chrome 擴充功能？](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [沙箱與記憶體](#sandboxing-and-memory)
  - [有專門的沙箱文件嗎？](#is-there-a-dedicated-sandboxing-doc)
  - [如何將主機資料夾掛載到沙箱中？](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [記憶體是如何運作的？](#how-does-memory-work)
  - [記憶體一直遺忘事情，該如何讓它記住？](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [記憶體會永久保存嗎？限制是什麼？](#does-memory-persist-forever-what-are-the-limits)
  - [語義記憶體搜尋需要 OpenAI API 金鑰嗎？](#does-semantic-memory-search-require-an-openai-api-key)
- [檔案在硬碟上的位置](#where-things-live-on-disk)
  - [OpenClaw 使用的所有資料都儲存在本地嗎？](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw 將資料儲存在哪裡？](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md 應該放在哪裡？](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [推薦的備份策略是什麼？](#whats-the-recommended-backup-strategy)
  - [如何完全解除安裝 OpenClaw？](#how-do-i-completely-uninstall-openclaw)
  - [智慧代理可以在工作空間之外運作嗎？](#can-agents-work-outside-the-workspace)
  - [我處於遠端模式 - 工作階段儲存在哪裡？](#im-in-remote-mode-where-is-the-session-store)
- [設定基礎](#config-basics)
  - [設定檔是什麼格式？在哪裡？](#what-format-is-the-config-where-is-it)
  - [我設定了 `gateway.bind: "lan"` (或 `"tailnet"`)，現在沒有任何反應 / UI 顯示未授權](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [為什麼我現在在 localhost 也需要憑證 (token)？](#why-do-i-need-a-token-on-localhost-now)
  - [更改設定後需要重新啟動嗎？](#do-i-have-to-restart-after-changing-config)
  - [如何啟用網頁搜尋（與網頁擷取）？](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply 清除了我的設定，該如何恢復並避免這種情況？](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [如何執行一個中央 Gateway，並跨裝置使用專業的工作智慧代理？](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [OpenClaw 瀏覽器 can the OpenClaw browser run headless](#can-the-openclaw-browser-run-headless)
  - [如何使用 Brave 進行瀏覽器控制？](#how-do-i-use-brave-for-browser-control)
- [遠端 Gateway 與 Nodes](#remote-gateways-and-nodes)
  - [指令如何在 Telegram、Gateway 與 Nodes 之間傳遞？](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [如果 Gateway 是遠端託管的，我的智慧代理如何存取我的電腦？](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale 已連線但沒有回應，該怎麼辦？](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [兩個 OpenClaw 執行個體可以互相通訊嗎 (本地 + VPS)？](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [多個智慧代理需要個別的 VPS 嗎？](#do-i-need-separate-vpses-for-multiple-agents)
  - [在個人筆電上使用 Node 比起從 VPS 使用 SSH 有什麼好處嗎？](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Nodes 會執行 Gateway 服務嗎？](#do-nodes-run-a-gateway-service)
  - [是否有 API / RPC 方式來套用設定？](#is-there-an-api-rpc-way-to-apply-config)
  - [首次安裝最基本的「健全」設定是什麼？](#whats-the-minimal-sane-config-for-a-first-install)
  - [如何在 VPS 上設定 Tailscale 並從我的 Mac 連線？](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [如何將 Mac Node 連線到遠端 Gateway (Tailscale Serve)？](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [我應該在第二台筆電上安裝，還是只增加一個 Node？](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [環境變數與 .env 載入](#env-vars-and-env-loading)
  - [OpenClaw 如何載入環境變數？](#how-does-openclaw-load-environment-variables)
  - [「我透過服務啟動了 Gateway，結果環境變數消失了。」該怎麼辦？](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [我設定了 `COPILOT_GITHUB_TOKEN`，但模型狀態顯示 "Shell env: off"，為什麼？](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [工作階段與多重對話](#sessions-and-multiple-chats)
  - [如何開啟新對話？](#how-do-i-start-a-fresh-conversation)
  - [如果我從未發送 `/new`，工作階段會自動重設嗎？](#do-sessions-reset-automatically-if-i-never-send-new)
  - [有沒有辦法建立一個 OpenClaw 團隊，由一位 CEO 和多位智慧代理組成？](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [為什麼上下文在任務途中被截斷？該如何防止？](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [如何完全重設 OpenClaw 但保留安裝狀態？](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [我收到「上下文過大」錯誤 - 如何重設或壓縮？](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [為什麼我看到 "LLM request rejected: messages.N.content.X.tool_use.input: Field required"？](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [為什麼我每 30 分鐘收到一次心跳訊息？](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [我需要將「智慧代理帳號」加入 WhatsApp 群組嗎？](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [如何取得 WhatsApp 群組的 JID？](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [為什麼 OpenClaw 不在群組中回覆？](#why-doesnt-openclaw-reply-in-a-group)
  - [群組/討論串是否與私訊 (DMs) 共用上下文？](#do-groupsthreads-share-context-with-dms)
  - [我可以建立多少個工作空間與智慧代理？](#how-many-workspaces-and-agents-can-i-create)
  - [我可以同時執行多個機器人或對話 (Slack) 嗎？我應該如何設定？](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [模型：預設、選擇、別名、切換](#models-defaults-selection-aliases-switching)
  - [什麼是「預設模型」？](#what-is-the-default-model)
  - [你們推薦什麼模型？](#what-model-do-you-recommend)
  - [如何在不清除設定的情況下切換模型？](#how-do-i-switch-models-without-wiping-my-config)
  - [我可以使用自行託管的模型嗎 (llama.cpp, vLLM, Ollama)？](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw、Flawd 與 Krill 使用什麼模型？](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [如何即時切換模型（無需重啟）？](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [我可以將 GPT 5.2 用於日常任務，將 Codex 5.3 用於編碼嗎？](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [為什麼我看到 "Model … is not allowed" 然後沒有回覆？](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [為什麼我看到 "Unknown model: minimax/MiniMax-M2.1"？](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [我可以使用 MiniMax 作為預設，並將 OpenAI 用於複雜任務嗎？](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt 是內建捷徑嗎？](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [如何定義/覆寫模型捷徑 (別名)？](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [如何加入來自 OpenRouter 或 Z.AI 等其他供應商的模型？](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [模型故障轉移與「所有模型均失敗」](#model-failover-and-all-models-failed)
  - [故障轉移如何運作？](#how-does-failover-work)
  - [這個錯誤是什麼意思？](#what-does-this-error-mean)
  - [針對 `No credentials found for profile "anthropic:default"` 的修復清單](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [為什麼它也嘗試了 Google Gemini 並且失敗了？](#why-did-it-also-try-google-gemini-and-fail)
- [驗證設定檔：它們是什麼以及如何管理](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [什麼是驗證設定檔 (auth profile)？](#what-is-an-auth-profile)
  - [典型的設定檔 ID 有哪些？](#what-are-typical-profile-ids)
  - [我可以控制優先嘗試哪個驗證設定檔嗎？](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth 與 API 金鑰：有什麼區別？](#oauth-vs-api-key-whats-the-difference)
- [Gateway：連接埠、「已在執行」與遠端模式](#gateway-ports-already-running-and-remote-mode)
  - [Gateway 使用哪個連接埠？](#what-port-does-the-gateway-use)
  - [為什麼 `openclaw gateway status` 顯示 `Runtime: running` 但 `RPC probe: failed`？](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [為什麼 `openclaw gateway status` 顯示 `Config (cli)` 與 `Config (service)` 不同？](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [「另一個 Gateway 執行個體已在監聽」是什麼意思？](#what-does-another-gateway-instance-is-already-listening-mean)
  - [如何以遠端模式執行 OpenClaw（用戶端連線到他處的 Gateway）？](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [Control UI 顯示「未授權」（或一直重新連線），該怎麼辦？](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [我設定了 `gateway.bind: "tailnet"` 但它無法綁定 / 沒人在監聽](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [我可以在同一台主機上執行多個 Gateway 嗎？](#can-i-run-multiple-gateways-on-the-same-host)
  - [「無效握手」 (invalid handshake) / 代碼 1008 是什麼意思？](#what-does-invalid-handshake-code-1008-mean)
- [記錄與偵錯](#logging-and-debugging)
  - [記錄檔在哪裡？](#where-are-logs)
  - [如何啟動/停止/重啟 Gateway 服務？](#how-do-i-startstoprestart-the-gateway-service)
  - [我在 Windows 上關閉了終端機 - 如何重啟 OpenClaw？](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway 已啟動但回覆從未送達，我該檢查什麼？](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [「與 Gateway 斷開連線：無原因」 - 該怎麼辦？](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands 因網路錯誤而失敗，我該檢查什麼？](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI 沒有顯示任何輸出，我該檢查什麼？](#tui-shows-no-output-what-should-i-check)
  - [如何完全停止然後啟動 Gateway？](#how-do-i-completely-stop-then-start-the-gateway)
  - [簡單解釋：`openclaw gateway restart` 與 `openclaw gateway` 的區別](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [出錯時獲取更多詳細資訊最快的方法是什麼？](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [媒體與附件](#media-and-attachments)
  - [我的 Skill 產生了圖片/PDF，但沒有發送任何內容](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [安全與存取控制](#security-and-access-control)
  - [將 OpenClaw 暴露於傳入的私訊 (DMs) 安全嗎？](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [提示詞注入 (prompt injection) 只對公開機器人有影響嗎？](#is-prompt-injection-only-a-concern-for-public-bots)
  - [我的機器人應該有自己的電子郵件、GitHub 帳號或電話號碼嗎？](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [我可以賦予它處理我的簡訊的自主權嗎？這樣安全嗎？](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [我可以將較便宜的模型用於個人助理任務嗎？](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [我在 Telegram 中執行了 `/start` 但沒有收到配對碼](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp：它會傳送訊息給我的聯絡人嗎？配對如何運作？](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [聊天指令、中止任務以及「它停不下來」](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [如何停止聊天中顯示的內部系統訊息？](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [如何停止/取消執行中的任務？](#how-do-i-stopcancel-a-running-task)
  - [如何從 Telegram 發送 Discord 訊息？（「拒絕跨上下文傳訊」）](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [為什麼感覺機器人會「忽略」連珠炮般的訊息？](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 如果出錯了，最初的六十秒該做什麼

1. **快速狀態（首要檢查）**

   ```bash
   openclaw status
   ```

   快速本地摘要：作業系統 + 更新、Gateway/服務可達性、智慧代理/工作階段、供應商設定 + 執行階段問題（當 Gateway 可達時）。

2. **可貼上的報告（分享安全）**

   ```bash
   openclaw status --all
   ```

   唯讀診斷與記錄結尾（憑證已遮蔽）。

3. **守護程式 + 連接埠狀態**

   ```bash
   openclaw gateway status
   ```

   顯示管理程式執行階段 vs RPC 可達性、探測目標 URL，以及服務可能使用的設定。

4. **深度探測**

   ```bash
   openclaw status --deep
   ```

   執行 Gateway 健全狀況檢查 + 供應商探測（需要可達的 Gateway）。請參閱 [健全狀況](/gateway/health)。

5. **追蹤最新記錄**

   ```bash
   openclaw logs --follow
   ```

   如果 RPC 關閉，請退而求其次：

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   檔案記錄與服務記錄是分開的；請參閱 [記錄](/logging) 與 [疑難排解](/gateway/troubleshooting)。

6. **執行 Doctor（修復）**

   ```bash
   openclaw doctor
   ```

   修復/遷移設定/狀態 + 執行健全狀況檢查。請參閱 [Doctor](/gateway/doctor)。

7. **Gateway 快照**

   ```bash
   openclaw health --json
   openclaw health --verbose   # 出錯時顯示目標 URL + 設定路徑
   ```

   向執行中的 Gateway 要求完整快照（僅限 WS）。請參閱 [健全狀況](/gateway/health)。

## 快速開始與首次執行設定

### 我卡住了，解決問題最快的方法是什麼？

使用可以 **檢視您機器** 的本地 AI 智慧代理。這比在 Discord 中詢問有效得多，因為大多數「卡住」的情況都是 **本地設定或環境問題**，遠端協助者無法檢查。

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

這些工具可以讀取 repo、執行指令、檢查記錄，並協助修復機器層級的設定（PATH、服務、權限、驗證檔案）。透過可開發 (git) 安裝，將 **完整的原始碼檢出 (checkout)** 提供給它們：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

這會 **從 git 檢出** 安裝 OpenClaw，因此智慧代理可以讀取程式碼 + 文件，並針對您執行的確切版本進行推理。您隨時可以稍後不帶 `--install-method git` 重新執行安裝程式，切換回穩定版本。

提示：要求智慧代理 **規劃並監督** 修復過程（逐步進行），然後僅執行必要的指令。這可以保持變更範圍較小且易於稽核。

如果您發現真正的錯誤或修復方法，請提交 GitHub issue 或發送 PR：
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

從這些指令開始（尋求協助時分享輸出結果）：

```bash
openclaw status
openclaw models status
openclaw doctor
```

它們的功能：

- `openclaw status`：Gateway/智慧代理健全狀況 + 基礎設定的快速快照。
- `openclaw models status`：檢查供應商驗證 + 模型可用性。
- `openclaw doctor`：驗證並修復常見的設定/狀態問題。

其他有用的 CLI 檢查：`openclaw status --all`、`openclaw logs --follow`、`openclaw gateway status`、`openclaw health --verbose`。

快速除錯循環：[如果出錯了，最初的六十秒該做什麼](#first-60-seconds-if-somethings-broken)。
安裝文件：[安裝](/install)、[安裝程式旗標](/install/installer)、[更新](/install/updating)。

### 推薦的 OpenClaw 安裝與設定方式是什麼？

Repo 推薦從原始碼執行並使用新手導覽精靈：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

該精靈還可以自動構建 UI 資產。新手導覽後，您通常會在連接埠 **18789** 上執行 Gateway。

從原始碼（貢獻者/開發者）：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # 首次執行時自動安裝 UI 依賴項
openclaw onboard
```

如果您尚未進行全域安裝，請透過 `pnpm openclaw onboard` 執行。

### 完成新手導覽後如何開啟儀表板？

精靈會在新手導覽後立即使用乾淨的（非凭证化）儀表板 URL 開啟您的瀏覽器，並在摘要中印出連結。保留該分頁；如果沒有啟動，請在同一台機器上複製/貼上印出的 URL。

### 如何驗證 localhost 與遠端儀表板的憑證 (token)？

**Localhost (同一台機器)：**

- 開啟 `http://127.0.0.1:18789/`。
- If it asks for auth, paste the token from `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) into Control UI settings.
- Retrieve it from the gateway host: `openclaw config get gateway.auth.token` (or generate one: `openclaw doctor --generate-gateway-token`).

**Not on localhost:**

- **Tailscale Serve** (recommended): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. If `gateway.auth.allowTailscale` is `true`, identity headers satisfy auth (no token).
- **Tailnet bind**: run `openclaw gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, paste token in dashboard settings.
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user @host` then open `http://127.0.0.1:18789/` and paste the token in Control UI settings.

請參閱 [儀表板](/web/dashboard) 與 [網頁介面](/web) 了解綁定模式與驗證詳情。

### 我需要什麼執行環境？

需要 Node **>= 22**。推薦使用 `pnpm`。**不推薦** 在 Gateway 使用 Bun。

### 它可以在 Raspberry Pi 上執行嗎？

是的。Gateway 非常輕量 - 文件列出 **512MB-1GB RAM**、**1 核心**與約 **500MB** 硬碟空間足以供個人使用，並指出 **Raspberry Pi 4 即可執行**。

如果您想要額外的餘裕（記錄、媒體、其他服務），**推薦 2GB**，但這不是硬性最低需求。

提示：小型 Pi/VPS 可以託管 Gateway，您可以在筆電/手機上配對 **Nodes** 以使用本地螢幕/相機/畫布或執行指令。請參閱 [Nodes](/nodes)。

### 有任何關於 Raspberry Pi 安裝的建議嗎？

簡短版本：它可以運作，但預期會有一些粗糙的地方。

- 使用 **64 位元** 作業系統並保持 Node >= 22。
- 優先使用 **可開發 (git) 安裝**，以便您可以查看記錄並快速更新。
- 從不含頻道/Skills 的狀態開始，然後一個一個加入。
- 如果遇到奇怪的二進位檔案問題，通常是 **ARM 相容性** 問題。

文件：[Linux](/platforms/linux)、[安裝](/install)。

### 它卡在 "wake up my friend" / 新手導覽無法完成，該怎麼辦？

該畫面取決於 Gateway 是否可連線且已驗證。TUI 在首次啟動時也會自動發送 "Wake up, my friend!"。如果您看到該行但 **沒有回覆**，且憑證數量維持在 0，則智慧代理從未執行。

1. 重啟 Gateway：

```bash
openclaw gateway restart
```

2. 檢查狀態 + 驗證：

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. 如果仍然掛起，執行：

```bash
openclaw doctor
```

如果 Gateway 是遠端的，請確保通道/Tailscale 連線已建立，且 UI 指向正確的 Gateway。請參閱 [遠端存取](/gateway/remote)。

### 我可以將設定遷移到新機器 (Mac mini) 而不必重新進行新手導覽嗎？

是的。複製 **狀態目錄** 與 **工作空間**，然後執行一次 Doctor 即可。這可以讓您的機器人保持「完全相同」（記憶體、工作階段歷史記錄、驗證與頻道狀態），只要您複製了 **這兩個** 位置：

1. 在新機器上安裝 OpenClaw。
2. 從舊機器複製 `$OPENCLAW_STATE_DIR` (預設：`~/.openclaw`)。
3. 複製您的工作空間 (預設：`~/.openclaw/workspace`)。
4. 執行 `openclaw doctor` 並重啟 Gateway 服務。

這會保留設定、驗證設定檔、WhatsApp 認證、工作階段與記憶體。如果您處於遠端模式，請記住 Gateway 主機擁有工作階段儲存空間與工作空間。

**重要提示：** 如果您只將工作空間 commit/push 到 GitHub，您備份的是 **記憶體 + 引導檔案**，而 **非** 工作階段歷史記錄或驗證。這些檔案位於 `~/.openclaw/` 下（例如 `~/.openclaw/agents/<agentId>/sessions/`）。

相關資訊：[遷移](/install/migrating)、[檔案在硬碟上的位置](/help/faq#where-does-openclaw-store-its-data)、
[智慧代理工作空間](/concepts/agent-workspace)、[Doctor](/gateway/doctor)、
[遠端模式](/gateway/remote)。

### 在哪裡可以看到最新版本的更新內容？

請查看 GitHub 變更日誌：
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

最新項目位於頂部。如果頂部區段標記為 **Unreleased**，則下一個帶日期的區段是最新發佈的版本。項目按 **Highlights (亮點)**、**Changes (變更)** 與 **Fixes (修復)** 分組（需要時還有文件/其他區段）。

### 我無法存取 docs.openclaw.ai (SSL 錯誤)，該怎麼辦？

某些 Comcast/Xfinity 連線會透過 Xfinity Advanced Security 錯誤地封鎖 `docs.openclaw.ai`。請停用它或將 `docs.openclaw.ai` 加入允許清單，然後重試。更多詳情：[疑難排解](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity)。請在此處報告以協助我們解除封鎖：[https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status)。

如果您仍然無法存取該網站，文件在 GitHub 上有鏡像：
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### Stable 與 Beta 版本有什麼區別？

**Stable (穩定版)** 與 **beta (測試版)** 是 **npm dist-tags**，而非獨立的程式碼線：

- `latest` = 穩定版
- `beta` = 用於測試的早期構建版本

我們會將構建版本發佈到 **beta**，進行測試，一旦構建版本穩定，我們就會將 **該相同版本提升至 `latest`**。這就是為什麼 beta 與 stable 可能指向 **同一個版本** 的原因。

查看變更內容：
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 如何安裝 Beta 版本，Beta 與 Dev 有什麼不同？

**Beta** 是 npm dist-tag `beta`（可能與 `latest` 相同）。
**Dev** 是 `main` (git) 的動態指標；發佈時使用 npm dist-tag `dev`。

單行指令 (macOS/Linux)：

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows 安裝程式 (PowerShell)：
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

更多詳情：[開發管道](/install/development-channels) 與 [安裝程式旗標](/install/installer)。

### 安裝與新手導覽通常需要多久時間？

大致指南：

- **安裝：** 2-5 分鐘
- **新手導覽：** 5-15 分鐘，取決於您設定的模型與頻道數量

如果卡住了，請參考 [安裝程式卡住了](/help/faq#installer-stuck-how-do-i-get-more-feedback) 與 [我卡住了](#im-stuck--whats-the-fastest-way-to-get-unstuck) 中的快速除錯循環。

### 如何試用最新的功能？

兩個選項：

1. **Dev 管道 (git 檢出)：**

```bash
openclaw update --channel dev
```

這會切換到 `main` 分支並從原始碼更新。

2. **可開發安裝 (從安裝程式網站)：**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

這會為您提供一個可以編輯的本地 repo，然後透過 git 更新。

如果您偏好手動進行乾淨的 clone，請使用：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

文件：[更新](/cli/update)、[開發管道](/install/development-channels)、
[安裝](/install)。

### 安裝程式卡住了？如何獲得更多回饋資訊？

帶 **verbose 輸出** 重新執行安裝程式：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

帶 verbose 進行 Beta 安裝：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

對於可開發 (git) 安裝：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Windows (PowerShell) 等效操作：

```powershell
# install.ps1 目前尚無專用的 -Verbose 旗標
Set-PSDebug -Trace 1
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
Set-PSDebug -Trace 0
```

更多選項：[安裝程式旗標](/install/installer)。

### Windows 安裝顯示找不到 git 或無法辨識 openclaw

兩個常見的 Windows 問題：

**1) npm error spawn git / 找不到 git**

- 安裝 **Git for Windows** 並確保 `git` 已加入您的 PATH。
- 關閉並重新開啟 PowerShell，然後重新執行安裝程式。

**2) 安裝後無法辨識 openclaw**

- 您的 npm 全域 bin 資料夾不在 PATH 中。
- 檢查路徑：

  ```powershell
  npm config get prefix
  ```

- Ensure `<prefix>\\bin` is on PATH (on most systems it is `%AppData%\\npm`).
- 更新 PATH 後，關閉並重新開啟 PowerShell。

如果您想要最順暢的 Windows 設定，請使用 **WSL2** 而非原生 Windows。
文件：[Windows](/platforms/windows)。

### 文件沒有解決我的問題 - 如何獲得更好的答案？

使用 **可開發 (git) 安裝**，以便您在本地擁有完整的原始碼與文件，然後 _在該資料夾中_ 詢問您的機器人（或 Claude/Codex），這樣它就能讀取 repo 並精確回答。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

更多詳情：[安裝](/install) 與 [安裝程式旗標](/install/installer)。

### 如何在 Linux 上安裝 OpenClaw？

簡短回答：遵循 Linux 指南，然後執行新手導覽精靈。

- Linux 快速路徑 + 服務安裝：[Linux](/platforms/linux)。
- 完整導覽：[入門指南](/start/getting-started)。
- 安裝程式 + 更新：[安裝與更新](/install/updating)。

### 如何在 VPS 上安裝 OpenClaw？

任何 Linux VPS 都可以運作。在伺服器上安裝，然後使用 SSH/Tailscale 連線到 Gateway。

指南：[exe.dev](/install/exe-dev)、[Hetzner](/install/hetzner)、[Fly.io](/install/fly)。
遠端存取：[Gateway 遠端](/gateway/remote)。

### 雲端/VPS 安裝指南在哪裡？

我們維護了一個 **託管中心 (hosting hub)**，涵蓋常見的供應商。選擇一個並遵循指南：

- [VPS 託管](/vps) (所有供應商都在這裡)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

雲端運作方式：**Gateway 在伺服器上執行**，您透過 Control UI (或 Tailscale/SSH) 從筆電/手機存取它。您的狀態 + 工作空間位於伺服器上，因此請將主機視為單一事實來源並進行備份。

您可以將 **Nodes** (Mac/iOS/Android/headless) 配對到該雲端 Gateway，以存取本地螢幕/相機/畫布，或在筆電上執行指令，同時將 Gateway 保留在雲端。

中心：[平台](/platforms)。遠端存取：[Gateway 遠端](/gateway/remote)。
Nodes：[Nodes](/nodes)、[Nodes CLI](/cli/nodes)。

### 我可以要求 OpenClaw 自行更新嗎？

簡短回答：**可行，但不推薦**。更新流程可能會重啟 Gateway（這會中斷活動中的工作階段），可能需要乾淨的 git 檢出，並且可能會提示確認。更安全的做法：由操作員從 shell 執行更新。

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

文件：[更新](/cli/update)、[更新](/install/updating)。

### 新手導覽精靈實際上做了什麼？

`openclaw onboard` 是推薦的設定路徑。在 **本地模式** 下，它會引導您完成：

- **模型/驗證設定** (推薦將 Anthropic **setup-token** 用於 Claude 訂閱，支援 OpenAI Codex OAuth，API 金鑰可選，支援 LM Studio 本地模型)
- **工作空間** 位置 + 引導檔案
- **Gateway 設定** (綁定/連接埠/驗證/Tailscale)
- **供應商** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **守護程式安裝** (macOS 為 LaunchAgent；Linux/WSL2 為 systemd user unit)
- **健全狀況檢查** 與 **Skills** 選擇

如果配置的模型未知或遺失驗證，它也會發出警告。

### 我需要 Claude 或 OpenAI 訂閱才能執行嗎？

不需要。您可以使用 **API 金鑰** (Anthropic/OpenAI/其他) 或 **僅限本地的模型** 來執行 OpenClaw，這樣您的資料就會保留在您的裝置上。訂閱 (Claude Pro/Max 或 OpenAI Codex) 是驗證這些供應商的可選方式。

文件：[Anthropic](/providers/anthropic)、[OpenAI](/providers/openai)、
[本地模型](/gateway/local-models)、[模型](/concepts/models)。

### 我可以在沒有 API 金鑰的情況下使用 Claude Max 訂閱嗎？

可以。您可以使用 **setup-token** 進行驗證
而非 API 金鑰。這是訂閱路徑。

Claude Pro/Max 訂閱 **不包含 API 金鑰**，因此這是訂閱帳號的正確方法。重要提示：您必須向 Anthropic 確認此用法符合其訂閱政策與條款。如果您想要最明確、受支援的路徑，請使用 Anthropic API 金鑰。

### Anthropic "setup-token" 驗證如何運作？

`claude setup-token` 透過 Claude Code CLI 產生一個 **憑證字串** (無法在網頁主控台中取得)。您可以在 **任何機器** 上執行它。在精靈中選擇 **Anthropic token (貼上 setup-token)**，或使用 `openclaw models auth paste-token --provider anthropic` 貼上它。該憑證將作為 **anthropic** 供應商的驗證設定檔儲存，並像 API 金鑰一樣使用（不會自動重新整理）。更多詳情：[OAuth](/concepts/oauth)。

### 在哪裡可以找到 Anthropic setup-token？

它 **不在** Anthropic Console 中。setup-token 是由 **Claude Code CLI** 在 **任何機器** 上產生的：

```bash
claude setup-token
```

複製它印出的憑證，然後在精靈中選擇 **Anthropic token (貼上 setup-token)**。如果您想在 Gateway 主機上執行它，請使用 `openclaw models auth setup-token --provider anthropic`。如果您在其他地方執行了 `claude setup-token`，請使用 `openclaw models auth paste-token --provider anthropic` 在 Gateway 主機上貼上它。請參閱 [Anthropic](/providers/anthropic)。

### Kalian 支援 Claude 訂閱驗證 (Claude Pro 或 Max) 嗎？

支援 - 透過 **setup-token**。OpenClaw 不再重複使用 Claude Code CLI OAuth 凭证；請使用 setup-token 或 Anthropic API 金鑰。在任何地方產生憑證並將其貼到 Gateway 主機。請參閱 [Anthropic](/providers/anthropic) 與 [OAuth](/concepts/oauth)。

注意：Claude 訂閱存取受 Anthropic 條款約束。對於生產或多使用者工作負載，API 金鑰通常是更安全的選擇。

### 為什麼我會看到 Anthropic 的 HTTP 429 ratelimiterror？

這意味著您的 **Anthropic 配額/速率限制** 在目前時間視窗內已耗盡。如果您使用 **Claude 訂閱** (setup-token 或 Claude Code OAuth)，請等待時間視窗重設或升級您的方案。如果您使用 **Anthropic API 金鑰**，請檢查 Anthropic Console 以了解使用情況/計費，並根據需要提高限制。

提示：設定一個 **回退模型**，以便 OpenClaw 在供應商受限時仍能繼續回覆。請參閱 [模型](/cli/models) 與 [OAuth](/concepts/oauth)。

### 支援 AWS Bedrock 嗎？

支援 - 透過 pi-ai 的 **Amazon Bedrock (Converse)** 供應商進行 **手動設定**。您必須在 Gateway 主機上提供 AWS 認證/區域，並在模型設定中加入 Bedrock 供應商分項。請參閱 [Amazon Bedrock](/providers/bedrock) 與 [模型供應商](/providers/models)。如果您偏好受管理的金鑰流程，在 Bedrock 前端使用 OpenAI 相容的代理仍是有效的選項。

### Codex 驗證如何運作？

OpenClaw 透過 OAuth (ChatGPT 登入) 支援 **OpenAI Code (Codex)**。精靈可以執行 OAuth 流程，並在適當時將預設模型設定為 `openai-codex/gpt-5.3-codex`。請參閱 [模型供應商](/concepts/model-providers) 與 [精靈](/start/wizard)。

### Kalian 支援 OpenAI 訂閱驗證 Codex OAuth 嗎？

支援。OpenClaw 完整支援 **OpenAI Code (Codex) 訂閱 OAuth**。新手導覽精靈可以為您執行 OAuth 流程。

請參閱 [OAuth](/concepts/oauth)、[模型供應商](/concepts/model-providers) 與 [精靈](/start/wizard)。

### 如何設定 Gemini CLI OAuth？

Gemini CLI 使用 **外掛程式驗證流程**，而非 `openclaw.json` 中的 client id 或 secret。

步驟：

1. 啟用外掛程式：`openclaw plugins enable google-gemini-cli-auth`
2. Login: `openclaw models auth login --provider google-gemini-cli --set-default`

這會將 OAuth 凭证儲存在 Gateway 主機上的驗證設定檔中。詳情：[模型供應商](/concepts/model-providers)。

### 本地模型適合日常聊天嗎？

通常不適合。OpenClaw 需要大的上下文 + 強大的安全性；小型模型會截斷內容並外洩資訊。如果您必須執行，請在本地 (LM Studio) 執行 **最大的** MiniMax M2.1 構建版本，並參閱 [/gateway/local-models](/gateway/local-models)。較小/量化的模型會增加提示詞注入風險 - 請參閱 [安全](/gateway/security)。

### 如何將託管模型流量保持在特定區域？

選擇區域釘選的端點。OpenRouter 提供 MiniMax、Kimi 與 GLM 的美國託管選項；選擇美國託管變體以保持資料在該區域內。您仍可以透過將 `models.mode` 設為 `"merge"` 來並列 Anthropic/OpenAI，這樣在尊重所選區域供應商的同時，回退模型仍可使用。

### 我必須購買 Mac Mini 才能安裝嗎？

不需要。OpenClaw 可以在 macOS 或 Linux 上執行 (Windows 透過 WSL2)。Mac mini 是可選的 - 有些人買一台作為全時運作的主機，但小型 VPS、家用伺服器或 Raspberry Pi 等級的裝置也行。

您只有在需要 **僅限 macOS 的工具** 時才需要 Mac。對於 iMessage，請使用 [BlueBubbles](/channels/bluebubbles) (推薦) - BlueBubbles 伺服器在任何 Mac 上執行，而 Gateway 可以執行在 Linux 或其他地方。如果您需要其他僅限 macOS 的工具，請在 Mac 上執行 Gateway 或配對一個 macOS Node。

文件：[BlueBubbles](/channels/bluebubbles)、[Nodes](/nodes)、[Mac 遠端模式](/platforms/mac/remote)。

### 我需要 Mac mini 才能支援 iMessage 嗎？

您需要 **某台已登入訊息 (Messages) 的 macOS 裝置**。它 **不一定** 要是 Mac mini - 任何 Mac 都可以。**使用 [BlueBubbles](/channels/bluebubbles)** (推薦) 來支援 iMessage - BlueBubbles 伺服器在 macOS 上執行，而 Gateway 可以執行在 Linux 或其他地方。

常見配置：

- 在 Linux/VPS 上執行 Gateway，並在任何已登入訊息的 Mac 上執行 BlueBubbles 伺服器。
- 如果您想要最簡單的單機設定，請在 Mac 上執行所有內容。

文件：[BlueBubbles](/channels/bluebubbles)、[Nodes](/nodes)、
[Mac 遠端模式](/platforms/mac/remote)。

### 如果我買了 Mac mini 來執行 OpenClaw，可以連線到我的 MacBook Pro 嗎？

可以。**Mac mini 可以執行 Gateway**，您的 MacBook Pro 可以作為 **Node**（配套裝置）連線。Nodes 不執行 Gateway - 它們提供額外的功能，例如在該裝置上使用螢幕/相機/畫布與 `system.run`。

常見模式：

- Gateway 在 Mac mini 上執行 (全時開啟)。
- MacBook Pro 執行 macOS 應用程式或 Node 主機並配對到 Gateway。
- 使用 `openclaw nodes status` / `openclaw nodes list` 查看。

文件：[Nodes](/nodes)、[Nodes CLI](/cli/nodes)。

### 我可以使用 Bun 嗎？

**不推薦**。我們發現了執行階段錯誤，特別是在 WhatsApp 與 Telegram 方面。
請使用 **Node** 以獲得穩定的 Gateway。

如果您仍想試用 Bun，請在沒有 WhatsApp/Telegram 的非生產環境 Gateway 上進行。

### Telegram：allowFrom 欄位填什麼？

`channels.telegram.allowFrom` 是 **人類發送者的 Telegram 使用者 ID** (推薦數值) 或 `@username`。它不是機器人的使用者名稱。

更安全的方法 (不使用第三方機器人)：

- 私訊您的機器人，然後執行 `openclaw logs --follow` 並讀取 `from.id`。

官方 Bot API：

- DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.

第三方 (較不私密)：

- DM `@userinfobot` or `@getidsbot`.

請參閱 [/channels/telegram](/channels/telegram#access-control-dms--groups)。

### 多人可以使用不同的 OpenClaw 執行個體共用同一個 WhatsApp 號碼嗎？

可以，透過 **多智慧代理路由**。將每個發送者的 WhatsApp **私訊 (DM)**（對等點 `kind: "direct"`，發送者 E.164 格式如 `+15551234567`）綁定到不同的 `agentId`，這樣每個人都有自己的工作空間與工作階段儲存空間。回覆仍來自 **同一個 WhatsApp 帳號**，且私訊存取控制 (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) 是每個 WhatsApp 帳號全域共享的。請參閱 [多智慧代理路由](/concepts/multi-agent) 與 [WhatsApp](/channels/whatsapp)。

### 我可以同時執行一個「快速聊天」智慧代理和一個「用於編碼的 Opus」智慧代理嗎？

可以。使用多智慧代理路由：為每個智慧代理提供自己的預設模型，然後將傳入路由（供應商帳號或特定對等點）綁定到各個智慧代理。範例設定請見 [多智慧代理路由](/concepts/multi-agent)。另請參閱 [模型](/concepts/models) 與 [設定](/gateway/configuration)。

### Homebrew 可以在 Linux 上運作嗎？

可以。Homebrew 支援 Linux (Linuxbrew)。快速設定：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

如果您透過 systemd 執行 OpenClaw，請確保服務 PATH 包含 `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non-login shells.
最近的構建版本還會在 Linux systemd 服務上預先掛載常見的使用者 bin 目錄（例如 `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`）並在設定時尊重 `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR` 與 `FNM_DIR`。

### 「可開發 (git)」安裝與 npm 安裝有什麼區別？

- **可開發 (git) 安裝：** 完整的原始碼檢出，可編輯，最適合貢獻者。
  您在本地執行構建，並可以修補程式碼/文件。
- **npm 安裝：** 全域 CLI 安裝，無 repo，最適合「直接執行」。
  更新來自 npm dist-tags。

文件：[入門指南](/start/getting-started)、[更新](/install/updating)。

### 稍後可以在 npm 與 git 安裝之間切換嗎？

可以。安裝另一種形式，然後執行 Doctor，使 Gateway 服務指向新的進入點。
這 **不會刪除您的資料** - 它只會變更 OpenClaw 程式碼的安裝。您的狀態
(`~/.openclaw`) 與工作空間 (`~/.openclaw/workspace`) 將保持不變。

從 npm → git：

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
npm install -g openclaw @latest
openclaw doctor
openclaw gateway restart
```

Doctor 偵測到 Gateway 服務進入點是否不符，並提供重寫服務設定以匹配當前安裝的選項（在自動化中使用 `--repair`）。

備份提示：請參閱 [備份策略](/help/faq#whats-the-recommended-backup-strategy)。

### 我應該在筆記型電腦還是 VPS 上執行 Gateway？

簡短回答：**如果您想要 24/7 的可靠性，請使用 VPS**。如果您想要最低的阻力且不介意休眠/重啟，請在本地執行。

**筆記型電腦 (本地 Gateway)**

- **優點：** 無伺服器成本、直接存取本地檔案、即時瀏覽器視窗。
- **缺點：** 休眠/網路斷線 = 斷開連線、作業系統更新/重啟會中斷、機器必須保持喚醒。

**VPS / 雲端**

- **優點：** 全時開啟、穩定的網路、無筆電休眠問題、更容易保持執行。
- **缺點：** 通常以無頭模式執行（需使用螢幕截圖）、僅能遠端存取檔案、必須透過 SSH 進行更新。

**OpenClaw 特有注意事項：** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord 都可以從 VPS 正常運作。唯一真正的權衡是 **無頭瀏覽器** vs 可見視窗。請參閱 [瀏覽器](/tools/browser)。

**推薦預設：** 如果您之前遇到過 Gateway 斷連問題，請選 VPS。如果您正積極使用 Mac 並希望存取本地檔案或使用具有可見瀏覽器的 UI 自動化，則本地端非常合適。

### 在專用機器上執行 OpenClaw 有多重要？

不是必須的，但 **為了可靠性與隔離性，推薦這樣做**。

- **專用主機 (VPS/Mac mini/Pi)：** 全時開啟、較少的休眠/重啟中斷、更乾淨的權限、更容易保持執行。
- **共享筆電/桌機：** 對於測試與積極使用完全沒問題，但當機器休眠或更新時預期會暫停。

如果您想兼顧兩者，請將 Gateway 放在專用主機上，並將您的筆電配對為 **Node** 以使用本地螢幕/相機/執行工具。請參閱 [Nodes](/nodes)。
關於安全指南，請閱讀 [安全](/gateway/security)。

### VPS 的最低需求與推薦作業系統是什麼？

OpenClaw 非常輕量。對於基礎 Gateway + 一個聊天頻道：

- **絕對最低需求：** 1 vCPU, 1GB RAM, ~500MB 硬碟。
- **推薦：** 1-2 vCPU, 2GB RAM 或更多餘裕（記錄、媒體、多個頻道）。Node 工具與瀏覽器自動化可能非常耗費資源。

作業系統：使用 **Ubuntu LTS** (或任何現代 Debian/Ubuntu)。Linux 安裝路徑在該系統上測試最完整。

文件：[Linux](/platforms/linux)、[VPS 託管](/vps)。

### 我可以在虛擬機器 (VM) 中執行 OpenClaw 嗎？需求是什麼？

可以。將 VM 視同 VPS：它需要全時開啟、可達，並有足夠的
RAM 供 Gateway 與您啟用的任何頻道使用。

基準指南：

- **絕對最低需求：** 1 vCPU, 1GB RAM。
- **推薦：** 2GB RAM 或更多，如果您執行多個頻道、瀏覽器自動化或媒體工具。
- **作業系統：** Ubuntu LTS 或其他現代 Debian/Ubuntu。

如果您使用 Windows，**WSL2 是最簡單的 VM 風格設定**，且具有最佳的工具相容性。請參閱 [Windows](/platforms/windows)、[VPS 託管](/vps)。
如果您在 VM 中執行 macOS，請參閱 [macOS VM](/install/macos-vm)。

## 什麼是 OpenClaw？

### 用一段話說明什麼是 OpenClaw？

OpenClaw 是一個您在自己裝置上執行的個人 AI 助理。它在您已使用的傳訊介面（WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat）上回覆，並且可以在受支援的平台上進行語音 + 即時畫布 (Canvas)。**Gateway** 是全時開啟的控制平面；助理則是核心產品。

### 它的價值主張是什麼？

OpenClaw 不僅僅是一個「Claude 外殼」。它是一個 **本地優先的控制平面**，讓您可以在 **自己的硬體** 上執行功能強大的智慧代理，透過您已使用的聊天應用程式即可觸達，具有狀態化的工作階段、記憶體與工具 - 而無需將工作流程的控制權交給託管的 SaaS。

亮點：

- **您的裝置，您的資料：** 在您想要的任何地方（Mac, Linux, VPS）執行 Gateway，並將工作空間與工作階段歷史記錄保留在本地。
- **真實頻道，而非網頁沙箱：** WhatsApp/Telegram/Slack/Discord/Signal/iMessage 等，以及受支援平台上的行動語音與畫布。
- **模型無關：** 使用 Anthropic, OpenAI, MiniMax, OpenRouter 等，具備智慧代理路由與故障轉移功能。
- **僅限本地選項：** 執行本地模型，如果您願意，**所有資料都可以保留在您的裝置上**。
- **多智慧代理路由：** 每個頻道、帳號或任務都有獨立的智慧代理，具備各自的工作空間與預設值。
- **開源且可開發：** 可檢查、擴展並自行託管，無供應商鎖定。

文件：[Gateway](/gateway)、[頻道](/channels)、[多智慧代理](/concepts/multi-agent)、
[記憶體](/concepts/memory)。

### 我剛設定好，第一步應該做什麼？

適合的入門專案：

- Build a website (WordPress, Shopify, or a simple static site).
- Prototype a mobile app (outline, screens, API plan).
- Organize files and folders (cleanup, naming, tagging).
- Connect Gmail and automate summaries or follow ups.

它可以處理大型任務，但最好將其拆分為多個階段，並使用子智慧代理進行並行工作。

### OpenClaw 的五個日常使用場景是什麼？

日常的優勢通常在於：

- **個人簡報：** 您關注的收件匣、行事曆與新聞摘要。
- **研究與起草：** 電子郵件或文件的快速研究、摘要與初稿。
- **提醒與後續追蹤：** 由 Cron 或心跳驅動的提醒與清單。
- **瀏覽器自動化：** 填寫表單、收集資料與重複性網頁任務。
- **跨裝置協調：** 送出任務從您的手機，讓 Gateway 在伺服器上執行，並在聊天中獲取結果。

### OpenClaw 可以協助 SaaS 的潛在客戶開發、廣告與部落格嗎？

在 **研究、資格審查與起草** 方面是可以的。它可以掃描網站、建立候選名單、總結潛在客戶，並撰寫開發信或廣告文案初稿。

對於 **開發或廣告執行**，請保持人工參與。避免垃圾郵件，遵守當地法律與平台政策，並在發送前審查任何內容。最安全的模式是讓 OpenClaw 起草，由您核准。

文件：[安全](/gateway/security)。

### 相較於 Claude Code，在網頁開發方面有哪些優勢？

OpenClaw 是一個 **個人助理** 與協調層，而非 IDE 的替代品。在 repo 中進行最快速的直接編碼循環請使用 Claude Code 或 Codex。當您需要持久記憶體、跨裝置存取與工具編排時，請使用 OpenClaw。

優勢：

- **持久記憶體 + 工作空間** 跨工作階段保留
- **多平台存取** (WhatsApp, Telegram, TUI, WebChat)
- **工具編排** (瀏覽器、檔案、排程、hooks)
- **全時開啟 Gateway** (在 VPS 上執行，隨處互動)
- **Nodes** 支援本地瀏覽器/螢幕/相機/執行

展示： [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Skills 與自動化

### 如何在不更動 repo 的情況下自訂 Skills？

使用受管理的覆寫而非編輯 repo 複本。將您的變更放在 `~/.openclaw/skills/<name>/SKILL.md` 中（或透過 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 加入資料夾）。優先順序為 `<workspace>/skills` > `~/.openclaw/skills` > 內建，因此受管理的覆寫會勝出而不影響 git。只有值得上游化的編輯才應該留在 repo 中並以 PR 形式發佈。

### 我可以從自訂資料夾載入 Skills 嗎？

可以。透過 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 加入額外目錄（優先順序最低）。預設優先順序仍為：`<workspace>/skills` → `~/.openclaw/skills` → 內建 → `skills.load.extraDirs`。`clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills`.

### 如何針對不同任務使用不同的模型？

目前受支援的模式如下：

- **Cron 任務**：隔離的任務可以為每個任務設定 `model` 覆寫。
- **子智慧代理**：將任務路由到具有不同預設模型的獨立智慧代理。
- **隨選切換**：隨時使用 `/model` 切換當前工作階段的模型。

請參閱 [Cron 任務](/automation/cron-jobs)、[多智慧代理路由](/concepts/multi-agent) 與 [斜線指令](/tools/slash-commands)。

### 智慧代理在執行繁重工作時會凍結，該如何卸載？

使用 **子智慧代理** 處理長時間或並行任務。子智慧代理在自己的工作階段中執行，返回摘要，並保持您的主聊天回應迅速。

要求您的智慧代理「為此任務生成一個子智慧代理」或使用 `/subagents`。
在聊天中使用 `/status` 查看 Gateway 目前正在做什麼（以及它是否忙碌）。

凭证提示：長任務與子智慧代理都會消耗凭证。如果擔心成本，請透過 `agents.defaults.subagents.model` 為子智慧代理設定較便宜的模型。

文件：[子智慧代理](/tools/subagents)。

### Cron 或提醒沒有觸發，我該檢查什麼？

Cron 在 Gateway 程序內執行。如果 Gateway 未持續執行，排程任務將不會執行。

檢查清單：

- 確認 cron 已啟用 (`cron.enabled`) 且未設定 `OPENCLAW_SKIP_CRON`。
- 檢查 Gateway 是否 24/7 執行（無休眠/重啟）。
- Verify timezone settings for the job (`--tz` vs host timezone).

除錯：

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

文件：[Cron 任務](/automation/cron-jobs)、[Cron vs 心跳](/automation/cron-vs-heartbeat)。

### 如何在 Linux 上安裝 Skills？

使用 **ClawHub** (CLI) 或將 Skills 放入您的工作空間。Linux 上不提供 macOS Skills UI。
在 [https://clawhub.com](https://clawhub.com) 瀏覽 Skills。

安裝 ClawHub CLI（選擇一個套件管理員）：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw 可以按排程或在背景持續執行任務嗎？

可以。使用 Gateway 排程器：

- **Cron 任務** 用於排程或重複性任務（重啟後仍保留）。
- **心跳** 用於「主工作階段」定期檢查。
- **隔離任務** 用於自主智慧代理，發送摘要或遞送到聊天。

文件：[Cron 任務](/automation/cron-jobs)、[Cron vs 心跳](/automation/cron-vs-heartbeat)、
[心跳](/gateway/heartbeat)。

### 我可以從 Linux 執行僅限 Apple macOS 的 Skills 嗎？

無法直接執行。macOS Skills 受 `metadata.openclaw.os` 與所需的二進位檔案限制，且 Skills 僅在 **Gateway 主機** 符合資格時才會出現在系統提示中。在 Linux 上，除非您覆寫限制，否則 `darwin` 專用 Skills（如 `apple-notes`、`apple-reminders`、`things-mac`）將不會載入。

您有三種受支援的模式：

**選項 A - 在 Mac 上執行 Gateway (最簡單)。**
Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) or over Tailscale. The skills load normally because the Gateway host is macOS.

**Option B - use a macOS node (no SSH).**
Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. OpenClaw can treat macOS-only skills as eligible when the required binaries exist on the node. The agent runs those skills via the `nodes` tool. If you choose "Always Ask", approving "Always Allow" in the prompt adds that command to the allowlist.

**Option C - proxy macOS binaries over SSH (advanced).**
Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac. Then override the skill to allow Linux so it stays eligible.

1. Create an SSH wrapper for the binary (example: `memo` for Apple Notes):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user @mac-host /opt/homebrew/bin/memo "$ @"
   ```

2. Put the wrapper on `PATH` on the Linux host (for example `~/bin/memo`).
3. Override the skill metadata (workspace or `~/.openclaw/skills`) to allow Linux:

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. Start a new session so the skills snapshot refreshes.

### Kalian 有 Notion 或 HeyGen 整合嗎？

目前沒有內建。

選項：

- **自訂 Skill / 外掛程式：** 對於可靠的 API 存取（Notion/HeyGen 都有 API）這是最佳選擇。
- **瀏覽器自動化：** 無需程式碼即可運作，但較慢且較不穩定。

如果您想為每個客戶保留上下文（代理商工作流程），一個簡單的模式是：

- 每個客戶一個 Notion 頁面（上下文 + 偏好設定 + 活動中的工作）。
- 要求智慧代理在工作階段開始時擷取該頁面。

如果您想要原生整合，請提交功能請求或針對這些 API 建立一個 Skill。

安裝 Skills：

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub will install into `./skills` under your current directory (or falls back to your configured OpenClaw workspace); OpenClaw treats that as `<workspace>/skills` on the next session. For shared skills across agents, place them in `~/.openclaw/skills/<name>/SKILL.md`. Some skills expect binaries installed via Homebrew; on Linux that means Linuxbrew (see the Homebrew Linux FAQ entry above). 請參閱 [Skills](/tools/skills) 與 [ClawHub](/tools/clawhub)。

### 如何安裝用於瀏覽器接管的 Chrome 擴充功能？

使用內建安裝程式，然後在 Chrome 中載入未封裝的擴充功能：

```bash
openclaw browser extension install
openclaw browser extension path
```

Then Chrome → `chrome://extensions` → enable "Developer mode" → "Load unpacked" → pick that folder.

Full guide (including remote Gateway + security notes): [Chrome 擴充功能](/tools/chrome-extension)

If the Gateway runs on the same machine as Chrome (default setup), you usually **do not** need anything extra.
If the Gateway runs elsewhere, run a node host on the browser machine so the Gateway can proxy browser actions.
You still need to click the extension button on the tab you want to control (it doesn't auto-attach).

## 沙箱與記憶體

### 有專門的沙箱文件嗎？

有的。請參閱 [沙箱隔離](/gateway/sandboxing)。關於 Docker 特定設定（完整 Gateway 在 Docker 中或沙箱映像檔），請參閱 [Docker](/install/docker)。

### 如何將主機資料夾掛載到沙箱中？

Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls. 請參閱 [沙箱隔離](/gateway/sandboxing#custom-bind-mounts) 與 [沙箱 vs 工具政策 vs 提升權限](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) 獲取範例與安全注意事項。

### 記憶體是如何運作的？

OpenClaw 記憶體只是智慧代理工作空間中的 Markdown 檔案：

- Daily notes in `memory/YYYY-MM-DD.md`
- Curated long-term notes in `MEMORY.md` (main/private sessions only)

OpenClaw also runs a **silent pre-compaction memory flush** to remind the model
to write durable notes before auto-compaction. This only runs when the workspace
is writable (read-only sandboxes skip it). 請參閱 [記憶體](/concepts/memory)。

### 記憶體一直遺忘事情，該如何讓它記住？

要求機器人 **將事實寫入記憶體**。長期筆記屬於 `MEMORY.md`，短期上下文屬於 `memory/YYYY-MM-DD.md`。

這是我們仍在改進的領域。提醒模型儲存記憶體會有幫助；它知道該怎麼做。如果它一直遺忘，請驗證 Gateway 在每次執行時是否使用同一個工作空間。

文件：[記憶體](/concepts/memory)、[智慧代理工作空間](/concepts/agent-workspace)。

### 語義記憶體搜尋需要 OpenAI API 金鑰嗎？

Only if you use **OpenAI embeddings**. Codex OAuth covers chat/completions and
does **not** grant embeddings access, so **signing in with Codex (OAuth or the
Codex CLI login)** does not help for semantic memory search. OpenAI embeddings
still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

If you don't set a provider explicitly, OpenClaw auto-selects a provider when it
can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).
It prefers OpenAI if an OpenAI key resolves, otherwise Gemini if a Gemini key
resolves. If neither key is available, memory search stays disabled until you
configure it. If you have a local model path configured and present, OpenClaw
prefers `local`.

If you'd rather stay local, set `memorySearch.provider = "local"` (and optionally
`memorySearch.fallback = "none"`). If you want Gemini embeddings, set
`memorySearch.provider = "gemini"` and provide `GEMINI_API_KEY` (or
`memorySearch.remote.apiKey`). We support **OpenAI, Gemini, or local** embedding
models - see [記憶體](/concepts/memory) for the setup details.

### 記憶體會永久保存嗎？限制是什麼？

Memory files live on disk and persist until you delete them. The limit is your
storage, not the model. The **session context** is still limited by the model
context window, so long conversations can compact or truncate. That is why
memory search exists - it pulls only the relevant parts back into context.

文件：[記憶體](/concepts/memory)、[上下文](/concepts/context)。

## 檔案在硬碟上的位置

### OpenClaw 使用的所有資料都儲存在本地嗎？

並非如此 - **OpenClaw 的狀態是本地的**，但 **外部服務仍會看到您發送給它們的內容**。

- **預設為本地：** 工作階段、記憶體檔案、設定與工作空間位於 Gateway 主機 (`~/.openclaw` + 您的工作空間目錄)。
- **遠端是必須的：** 您發送給模型供應商 (Anthropic/OpenAI/等) 的訊息會傳送到它們的 API，且聊天平台 (WhatsApp/Telegram/Slack/等) 會將訊息資料儲存在其伺服器上。
- **您可以控制規模：** 使用本地模型可以將提示詞保留在您的機器上，但頻道流量仍會通過頻道的伺服器。

相關資訊：[智慧代理工作空間](/concepts/agent-workspace)、[記憶體](/concepts/memory
