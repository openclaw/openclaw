---
summary: "關於 OpenClaw 設定、設定與使用的常見問題"
title: "常見問題"
---

# help/faq.md

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). 14. 如需執行期診斷，請參閱 [Troubleshooting](/gateway/troubleshooting)。 15. 完整的設定參考請參閱 [Configuration](/gateway/configuration)。

## 目錄

- [快速開始與首次執行設定]
  - [我卡住了，最快脫困的方法是什麼？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [安裝與設定 OpenClaw 的建議方式是什麼？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [完成入門引導後，如何開啟儀表板？](#how-do-i-open-the-dashboard-after-onboarding)
  - [在 localhost 與遠端時，如何驗證儀表板（權杖）？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [需要什麼執行環境？](#what-runtime-do-i-need)
  - [可以在 Raspberry Pi 上執行嗎？](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi 安裝有什麼建議？](#any-tips-for-raspberry-pi-installs)
  - [It is stuck on "wake up my friend" / onboarding will not hatch. 19. 我無法存取 docs.openclaw.ai（SSL 錯誤）。
    20. 接下來該怎麼做？
  - [可以在不重做入門引導的情況下，遷移到新機器（Mac mini）嗎？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [在哪裡查看最新版本的新內容？](#where-do-i-see-what-is-new-in-the-latest-version)
  - [I can't access docs.openclaw.ai (SSL error). 現在該怎麼辦？](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable 與 beta 的差異是什麼？](#whats-the-difference-between-stable-and-beta)
  - [如何安裝 beta 版？beta 與 dev 有何不同？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [如何試用最新版本？](#how-do-i-try-the-latest-bits)
  - [安裝與入門引導通常需要多久？](#how-long-does-install-and-onboarding-usually-take)
  - [安裝程式卡住？ How do I get more feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows 安裝顯示找不到 git 或無法辨識 openclaw](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [文件沒有回答我的問題，如何取得更好的答案？](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [如何在 Linux 上安裝 OpenClaw？](#how-do-i-install-openclaw-on-linux)
  - [如何在 VPS 上安裝 OpenClaw？](#how-do-i-install-openclaw-on-a-vps)
  - [雲端 / VPS 安裝指南在哪裡？](#where-are-the-cloudvps-install-guides)
  - [可以請 OpenClaw 自行更新嗎？](#can-i-ask-openclaw-to-update-itself)
  - [入門引導精靈實際上做了什麼？](#what-does-the-onboarding-wizard-actually-do)
  - [需要 Claude 或 OpenAI 的訂閱才能執行嗎？](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [可以在沒有 API 金鑰的情況下使用 Claude Max 訂閱嗎](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic 的「setup-token」驗證如何運作？](#how-does-anthropic-setuptoken-auth-work)
  - [在哪裡取得 Anthropic setup-token？](#where-do-i-find-an-anthropic-setuptoken)
  - [是否支援 Claude 訂閱驗證（Claude Pro 或 Max）？](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [為什麼我會看到來自 Anthropic 的 `HTTP 429: rate_limit_error`？](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [是否支援 AWS Bedrock？](#is-aws-bedrock-supported)
  - [Codex 驗證如何運作？](#how-does-codex-auth-work)
  - [是否支援 OpenAI 訂閱驗證（Codex OAuth）？](#do-you-support-openai-subscription-auth-codex-oauth)
  - [如何設定 Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)
  - [本機模型適合輕鬆聊天嗎？](#is-a-local-model-ok-for-casual-chats)
  - [如何讓託管模型流量留在特定區域？](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [一定要買 Mac Mini 才能安裝嗎？](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage 支援一定需要 Mac mini 嗎？](#do-i-need-a-mac-mini-for-imessage-support)
  - [如果我買 Mac mini 來執行 OpenClaw，可以連接我的 MacBook Pro 嗎？](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [可以使用 Bun 嗎？](#can-i-use-bun)
  - [Telegram：`allowFrom` 要填什麼？](#telegram-what-goes-in-allowfrom)
  - [是否可以讓多人使用同一個 WhatsApp 號碼搭配不同的 OpenClaw 實例？](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [可以同時執行「快速聊天」代理與「用 Opus 進行程式開發」的代理嗎？](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew 可以在 Linux 上運作嗎？](#does-homebrew-work-on-linux)
  - [hackable（git）安裝與 npm 安裝有什麼不同？](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [之後可以在 npm 與 git 安裝之間切換嗎？](#can-i-switch-between-npm-and-git-installs-later)
  - [應該在筆電或 VPS 上執行 Gateway 閘道器？](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [在專用機器上執行 OpenClaw 有多重要？](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [VPS 的最低需求與建議的作業系統是什麼？](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [可以在 VM 中執行 OpenClaw 嗎？需求是什麼？](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [什麼是 OpenClaw？](#what-is-openclaw)
  - [用一段話介紹 OpenClaw](#what-is-openclaw-in-one-paragraph)
  - [價值主張是什麼？](#whats-the-value-proposition)
  - [剛設定好，第一步該做什麼？](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw 的五大日常使用情境是什麼？](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw 能協助 SaaS 的潛在客戶開發、廣告與部落格嗎？](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [與 Claude Code 相比，做網頁開發的優勢是什麼？](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills 與自動化](#skills-and-automation)
  - [How do I customize skills without keeping the repo dirty?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Can I load skills from a custom folder?](#can-i-load-skills-from-a-custom-folder)
  - [我如何為不同任務使用不同模型？](#how-can-i-use-different-models-for-different-tasks)
  - [The bot freezes while doing heavy work. How do I offload that?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron 或提醒未觸發。 我該檢查什麼？](#cron-or-reminders-do-not-fire-what-should-i-check)
  - 35. [是否有專門的沙箱文件？](#is-there-a-dedicated-sandboxing-doc)
  - [OpenClaw 可以排程或在背景中持續執行任務嗎？](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [我可以在 Linux 上執行僅限 Apple macOS 的技能嗎？](#can-i-run-apple-macos-only-skills-from-linux)
  - [是否有 Notion 或 HeyGen 的整合？](#do-you-have-a-notion-or-heygen-integration)
  - [How do I install the Chrome extension for browser takeover?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [沙箱與記憶](#sandboxing-and-memory)
  - [Is there a dedicated sandboxing doc?](#is-there-a-dedicated-sandboxing-doc)
  - [How do I bind a host folder into the sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [記憶體是如何運作的？](#how-does-memory-work)
  - [記憶體一直忘記事情。 我該如何讓它記住？](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [記憶體會永久保存嗎？ 限制是什麼？](#does-memory-persist-forever-what-are-the-limits)
  - [語意記憶搜尋需要 OpenAI API 金鑰嗎？](#does-semantic-memory-search-require-an-openai-api-key)
- [磁碟上的資料位置](#where-things-live-on-disk)
  - 3. [所有在 OpenClaw 中使用的資料都是本機儲存嗎？](#is-all-data-used-with-openclaw-saved-locally)
  - [Where does OpenClaw store its data?](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md 應該放在哪裡？](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [建議的備份策略是什麼？](#whats-the-recommended-backup-strategy)
  - [如何完全解除安裝 OpenClaw？](#how-do-i-completely-uninstall-openclaw)
  - [代理可以在工作區之外運作嗎？](#can-agents-work-outside-the-workspace)
  - [我在遠端模式中——工作階段儲存在哪裡？](#im-in-remote-mode-where-is-the-session-store)
- [設定基礎](#config-basics)
  - [設定檔是什麼格式？在哪裡？](#what-format-is-the-config-where-is-it) [我設定了 `gateway.bind: "lan"`（或 `"tailnet"`），現在卻沒有任何服務在監聽／UI 顯示未授權](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [為什麼現在在 localhost 也需要權杖（token）？](#why-do-i-need-a-token-on-localhost-now)
  - [修改設定後需要重新啟動嗎？](#do-i-have-to-restart-after-changing-config)
  - [如何啟用網頁搜尋（以及網頁抓取）？](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply 把我的設定清空了。我要如何復原並避免再次發生？](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [如何在多個裝置上執行一個中央 Gateway，並搭配專用的工作節點？](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices) [OpenClaw 瀏覽器可以以無頭（headless）模式執行嗎？](#can-the-openclaw-browser-run-headless)
  - [如何使用 Brave 來進行瀏覽器控制？](#how-do-i-use-brave-for-browser-control)
  - [指令是如何在 Telegram、Gateway 與節點之間傳遞的？](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [How do I use Brave for browser control?](#how-do-i-use-brave-for-browser-control)
- [遠端 Gateway 閘道器與節點](#remote-gateways-and-nodes)
  - [Tailscale 已連線，但我沒有收到任何回應。接下來該怎麼辦？](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [兩個 OpenClaw 實例可以彼此通訊嗎（本地 + VPS）？](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [多個代理需要各自獨立的 VPS 嗎？](#do-i-need-separate-vpses-for-multiple-agents) [在個人筆電上執行一個節點，相較於從 VPS 透過 SSH，有什麼好處嗎？](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [節點會執行 Gateway 服務嗎？](#do-nodes-run-a-gateway-service)
  - [Do I need separate VPSes for multiple agents](#do-i-need-separate-vpses-for-multiple-agents)
  - 29. [第一次安裝時，有沒有一個最小但「合理」的設定範例？](#whats-a-minimal-sane-config-for-a-first-install)
  - 30. [我要如何在 VPS 上設定 Tailscale，並從我的 Mac 連線？](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [如何將 Mac 節點連接到遠端 Gateway（Tailscale Serve）？](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [我應該在第二台筆電上安裝，還是只新增一個節點？](#should-i-install-on-a-second-laptop-or-just-add-a-node)
  - [OpenClaw 是如何載入環境變數的？](#how-does-openclaw-load-environment-variables)
  - [「我透過服務啟動了 Gateway，結果環境變數不見了。」現在該怎麼辦？](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - 36. [我設定了 `COPILOT_GITHUB_TOKEN`，但模型狀態顯示「Shell env: off」。
    37. 為什麼？](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [環境變數與 .env 載入](#env-vars-and-env-loading)
  - [OpenClaw 是如何載入環境變數的？](#how-does-openclaw-load-environment-variables)
  - 「我透過服務啟動了 Gateway，但我的環境變數消失了。」
    7. 現在該怎麼辦？ [是否有辦法讓一組 OpenClaw 實例形成「一個 CEO、多個代理」的架構？](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [為什麼在任務進行到一半時脈絡被截斷？我要如何避免？](#why-did-context-get-truncated-midtask-how-do-i-prevent-it) [如何在保留安裝的情況下，完全重置 OpenClaw？](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
- [工作階段與多重聊天](#sessions-and-multiple-chats)
  - [我遇到「context too large」錯誤——要如何重置或壓縮？](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [為什麼我會看到「LLM request rejected: messages.N.content.X.tool_use.input: Field required」？](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [為什麼我每 30 分鐘會收到一次心跳訊息？](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [我需要把「機器人帳號」加入 WhatsApp 群組嗎？](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group) [如何取得 WhatsApp 群組的 JID？](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [為什麼我每 30 分鐘會收到一次心跳訊息？](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [我需要把一個「機器人帳號」加入 WhatsApp 群組嗎？](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [我可以建立多少個工作區與代理？](#how-many-workspaces-and-agents-can-i-create)
  - [為什麼 OpenClaw 在群組中不回覆？](#why-doesnt-openclaw-reply-in-a-group)
  - [群組／執行緒會和私訊共享上下文嗎？](#do-groupsthreads-share-context-with-dms)
  - [你建議使用哪個模型？](#what-model-do-you-recommend)
  - [我可以同時執行多個機器人或聊天（Slack）嗎？以及該如何設定？](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
  - [Do groups/threads share context with DMs?](#do-groupsthreads-share-context-with-dms)
  - [你推薦使用什麼模型？](#what-model-do-you-recommend)
  - [我要如何在不清除設定的情況下切換模型？](#how-do-i-switch-models-without-wiping-my-config)
- [模型：預設、選擇、別名與切換](#models-defaults-selection-aliases-switching)
  - [我可以使用自架模型（llama.cpp、vLLM、Ollama）嗎？](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [What model do you recommend?](#what-model-do-you-recommend)
  - [How do I switch models without wiping my config?](#how-do-i-switch-models-without-wiping-my-config)
  - [我可以在日常任務中使用 GPT 5.2，在程式開發時使用 Codex 5.3 嗎？](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - 3. [OpenClaw、Flawd 與 Krill 使用的是哪些模型？](#what-do-openclaw-flawd-and-krill-use-for-models)
  - 4. [如何在執行中即時切換模型（不需重新啟動）？](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [我可以把 MiniMax 作為預設，並在複雜任務時使用 OpenAI 嗎？](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - 6. [為什麼我會看到「Model … is not allowed" and then no reply?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [我要如何新增來自其他供應商（如 OpenRouter 或 Z.AI）的模型？](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
  - [Can I use MiniMax as my default and OpenAI for complex tasks?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [這個錯誤代表什麼意思？](#what-does-this-error-mean)
  - [修復清單：`No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [How do I add models from other providers like OpenRouter or Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [模型容錯與「All models failed」](#model-failover-and-all-models-failed)
  - [什麼是驗證設定檔（auth profile）？](#what-is-an-auth-profile)
  - [常見的設定檔 ID 有哪些？](#what-are-typical-profile-ids)
  - [Fix checklist for `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Why did it also try Google Gemini and fail?](#why-did-it-also-try-google-gemini-and-fail)
- [驗證設定檔：是什麼以及如何管理](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Gateway 使用的是哪個連接埠？](#what-port-does-the-gateway-use)
  - [為什麼 `openclaw gateway status` 顯示 `Runtime: running`，但 `RPC probe: failed`？](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Can I control which auth profile is tried first?](#can-i-control-which-auth-profile-is-tried-first)
  - 20. [OAuth 與 API 金鑰：有什麼差別？](#oauth-vs-api-key-whats-the-difference)
- [Gateway：連接埠、「already running」與遠端模式](#gateway-ports-already-running-and-remote-mode)
  - 21. [Gateway 使用的是哪個連接埠？](#what-port-does-the-gateway-use)
  - [Why does `openclaw gateway status` say `Runtime: running` but `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - 23. [為什麼 `openclaw gateway status` 會顯示 `Config (cli)` 與 `Config (service)` 不一致？](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [What does "another gateway instance is already listening" mean?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [How do I run OpenClaw in remote mode (client connects to a Gateway elsewhere)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [The Control UI says "unauthorized" (or keeps reconnecting). 27. 接下來該怎麼辦？](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - 2. [我設定了 `gateway.bind: "tailnet"`，但無法綁定／沒有任何服務在監聽](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - 29. [我可以在同一台主機上執行多個 Gateway 嗎？](#can-i-run-multiple-gateways-on-the-same-host)
  - 4. [「invalid handshake」／代碼 1008 是什麼意思？](#what-does-invalid-handshake-code-1008-mean)
- [記錄與除錯](#logging-and-debugging)
  - 5. [日誌在哪裡？](#where-are-logs)
  - 6. [我要如何啟動／停止／重新啟動 Gateway 服務？](#how-do-i-startstoprestart-the-gateway-service)
  - 7. [我在 Windows 上關閉了終端機——要如何重新啟動 OpenClaw？](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - 8. [Gateway 已啟動，但回覆一直沒有到達。 9. 我該檢查什麼？](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - 10. [「Disconnected from gateway: no reason」——現在怎麼辦？](#disconnected-from-gateway-no-reason-what-now)
  - 11. [Telegram 的 setMyCommands 因網路錯誤而失敗。 38. 我應該檢查什麼？](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - 13. [TUI 沒有顯示任何輸出。 14. 我該檢查什麼？](#tui-shows-no-output-what-should-i-check)
  - 15. [我要如何完全停止後再啟動 Gateway？](#how-do-i-completely-stop-then-start-the-gateway)
  - 16. [ELI5：`openclaw gateway restart` 與 `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - 17. [當發生失敗時，取得更多細節的最快方式是什麼？](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [媒體與附件](#media-and-attachments)
  - 44. [我的技能產生了圖片／PDF，但沒有任何內容被送出](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [安全性與存取控制](#security-and-access-control)
  - 45. [將 OpenClaw 暴露給外部私訊是否安全？](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - 20. [提示注入只會是公開機器人的問題嗎？](#is-prompt-injection-only-a-concern-for-public-bots)
  - 47. [我的機器人是否應該有自己的電子郵件、GitHub 帳號或電話號碼](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - 48. [我可以讓它自主處理我的簡訊嗎？這樣安全嗎](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - 49. [我可以在個人助理任務中使用較便宜的模型嗎？](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - 24. [我在 Telegram 執行了 `/start`，但沒有收到配對碼](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - 25. [WhatsApp：它會傳訊給我的聯絡人嗎？ How does pairing work?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [聊天指令、終止任務與「停不下來」](#chat-commands-aborting-tasks-and-it-wont-stop)
  - 27. [我要如何阻止內部系統訊息顯示在聊天中](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [How do I stop/cancel a running task?](#how-do-i-stopcancel-a-running-task)
  - 29. [我要如何從 Telegram 傳送 Discord 訊息？ ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - 31. [為什麼感覺機器人會「忽略」連續快速傳送的訊息？](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 32. 若有問題時的前 60 秒

1. **Quick status (first check)**

   ```bash
   openclaw status
   ```

   34. 快速本機摘要：OS 與更新、gateway／服務可達性、agents／sessions、供應商設定與執行期問題（當 gateway 可達時）。

2. **Pasteable report (safe to share)**

   ```bash
   openclaw status --all
   ```

   37. 含日誌尾端的唯讀診斷（權杖已遮蔽）。

3. 38. **Daemon 與連接埠狀態**

   ```bash
   openclaw gateway status
   ```

   39. 顯示監督器的執行期與 RPC 可達性、探測目標 URL，以及服務可能使用的設定。

4. 40. **深度探測**

   ```bash
   openclaw status --deep
   ```

   Runs gateway health checks + provider probes (requires a reachable gateway). See [Health](/gateway/health).

5. **Tail the latest log**

   ```bash
   openclaw logs --follow
   ```

   If RPC is down, fall back to:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).

6. **Run the doctor (repairs)**

   ```bash
   openclaw doctor
   ```

   修復/遷移設定與狀態，並執行健康檢查。 See [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).

## 快速開始與首次執行設定

### Im stuck whats the fastest way to get unstuck

使用一個能 **看見你的機器** 的本地 AI 代理。 這比在 Discord 詢問有效得多，因為多數「我卡住了」的情況是 **本地設定或環境問題**，
遠端協助者無法檢視。

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

These tools can read the repo, run commands, inspect logs, and help fix your machine-level
setup (PATH, services, permissions, auth files). Give them the **full source checkout** via
the hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

This installs OpenClaw **from a git checkout**, so the agent can read the code + docs and
reason about the exact version you are running. You can always switch back to stable later
by re-running the installer without `--install-method git`.

Tip: ask the agent to **plan and supervise** the fix (step-by-step), then execute only the
necessary commands. That keeps changes small and easier to audit.

還是卡住了嗎？歡迎到 [Discord](https://discord.com/invite/clawd) 詢問，或在 [GitHub 討論區](https://github.com/openclaw/openclaw/discussions) 發起討論。

Start with these commands (share outputs when asking for help):

```bash
openclaw status
openclaw models status
openclaw doctor
```

What they do:

- `openclaw status`: quick snapshot of gateway/agent health + basic config.
- `openclaw models status`: checks provider auth + model availability.
- `openclaw doctor`: validates and repairs common config/state issues.

Other useful CLI checks: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Quick debug loop: [First 60 seconds if something's broken](#first-60-seconds-if-somethings-broken).
Install docs: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### What's the recommended way to install and set up OpenClaw

The repo recommends running from source and using the onboarding wizard:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

從原始碼（貢獻者/開發者）：

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
- 從 gateway 主機取得：`openclaw config get gateway.auth.token`（或產生一個：`openclaw doctor --generate-gateway-token`）。

**Not on localhost:**

- **Tailscale Serve** (recommended): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. 如果 `gateway.auth.allowTailscale` 為 `true`，身分識別標頭即可滿足驗證（不需要權杖）。
- **Tailnet bind**: run `openclaw gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, paste token in dashboard settings.
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/` and paste the token in Control UI settings.

See [Dashboard](/web/dashboard) and [Web surfaces](/web) for bind modes and auth details.

### What runtime do I need

Node **>= 22** is required. `pnpm` is recommended. Bun is **not recommended** for the Gateway.

### 它能在 Raspberry Pi 上執行嗎

是. The Gateway is lightweight - docs list **512MB-1GB RAM**, **1 core**, and about **500MB**
disk as enough for personal use, and note that a **Raspberry Pi 4 can run it**.

If you want extra headroom (logs, media, other services), **2GB is recommended**, but it's
not a hard minimum.

提示：小型的 Pi/VPS 可以託管 Gateway，而你可以在筆電/手機上配對 **節點**，用於
本地螢幕/相機/畫布或指令執行。 See [Nodes](/nodes).

### Any tips for Raspberry Pi installs

Short version: it works, but expect rough edges.

- Use a **64-bit** OS and keep Node >= 22.
- Prefer the **hackable (git) install** so you can see logs and update fast.
- Start without channels/skills, then add them one by one.
- If you hit weird binary issues, it is usually an **ARM compatibility** problem.

Docs: [Linux](/platforms/linux), [Install](/install).

### [卡在「wake up my friend」/ 入門引導無法孵化，該怎麼辦？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)

That screen depends on the Gateway being reachable and authenticated. The TUI also sends
"Wake up, my friend!" automatically on first hatch. If you see that line with **no reply**
and tokens stay at 0, the agent never ran.

1. Restart the Gateway:

```bash
openclaw gateway restart
```

2. Check status + auth:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. If it still hangs, run:

```bash
openclaw doctor
```

If the Gateway is remote, ensure the tunnel/Tailscale connection is up and that the UI
is pointed at the right Gateway. 請參見 [Remote access](/gateway/remote)。

### Can I migrate my setup to a new machine Mac mini without redoing onboarding

是. Copy the **state directory** and **workspace**, then run Doctor once. This
keeps your bot "exactly the same" (memory, session history, auth, and channel
state) as long as you copy **both** locations:

1. Install OpenClaw on the new machine.
2. Copy `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) from the old machine.
3. Copy your workspace (default: `~/.openclaw/workspace`).
4. Run `openclaw doctor` and restart the Gateway service.

That preserves config, auth profiles, WhatsApp creds, sessions, and memory. If you're in
remote mode, remember the gateway host owns the session store and workspace.

**Important:** if you only commit/push your workspace to GitHub, you're backing
up **memory + bootstrap files**, but **not** session history or auth. Those live
under `~/.openclaw/` (for example `~/.openclaw/agents/<agentId>/sessions/`).

Related: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),
[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Remote mode](/gateway/remote).

### Where do I see what is new in the latest version

Check the GitHub changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Newest entries are at the top. If the top section is marked **Unreleased**, the next dated
section is the latest shipped version. Entries are grouped by **Highlights**, **Changes**, and
**Fixes** (plus docs/other sections when needed).

### [無法存取 docs.openclaw.ai（SSL 錯誤），該怎麼辦？](#i-cant-access-docsopenclawai-ssl-error-what-now)

Some Comcast/Xfinity connections incorrectly block `docs.openclaw.ai` via Xfinity
Advanced Security. 將其停用或把 `docs.openclaw.ai` 加入允許清單，然後再試一次。 More
detail: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Please help us unblock it by reporting here: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

If you still can't reach the site, the docs are mirrored on GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### What's the difference between stable and beta

**Stable** and **beta** are **npm dist-tags**, not separate code lines:

- `latest` = stable
- `beta` = early build for testing

We ship builds to **beta**, test them, and once a build is solid we **promote
that same version to `latest`**. That's why beta and stable can point at the
**same version**.

查看有哪些變更：
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### How do I install the beta version and whats the difference between beta and dev

**Beta** is the npm dist-tag `beta` (may match `latest`).
**Dev** is the moving head of `main` (git); when published, it uses the npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows installer (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

More detail: [Development channels](/install/development-channels) and [Installer flags](/install/installer).

### How long does install and onboarding usually take

Rough guide:

- **Install:** 2-5 minutes
- **Onboarding:** 5-15 minutes depending on how many channels/models you configure

If it hangs, use [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
and the fast debug loop in [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### How do I try the latest bits

Two options:

1. **Dev channel (git checkout):**

```bash
openclaw update --channel dev
```

This switches to the `main` branch and updates from source.

2. **Hackable install (from the installer site):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

That gives you a local repo you can edit, then update via git.

If you prefer a clean clone manually, use:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Development channels](/install/development-channels),
[Install](/install).

### [安裝程式卡住了？如何取得更多回饋？](#installer-stuck-how-do-i-get-more-feedback)

Re-run the installer with **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Beta install with verbose:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

For a hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

More options: [Installer flags](/install/installer).

### Windows install says git not found or openclaw not recognized

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

如果你想要最順暢的 Windows 設定，請使用 **WSL2** 而非原生 Windows。
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

- [VPS hosting](/vps) (all providers in one place)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

How it works in the cloud: the **Gateway runs on the server**, and you access it
from your laptop/phone via the Control UI (or Tailscale/SSH). Your state + workspace
live on the server, so treat the host as the source of truth and back it up.

You can pair **nodes** (Mac/iOS/Android/headless) to that cloud Gateway to access
local screen/camera/canvas or run commands on your laptop while keeping the
Gateway in the cloud.

18. Hub：[Platforms](/platforms)。 Remote access: [Gateway remote](/gateway/remote).
    Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I ask OpenClaw to update itself

22. 簡短回答：**可以，但不建議**。 The update flow can restart the
    Gateway (which drops the active session), may need a clean git checkout, and
    can prompt for confirmation. Safer: run updates from a shell as the operator.

25. 使用 CLI：

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

If you must automate from an agent:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Docs: [Update](/cli/update), [Updating](/install/updating).

### What does the onboarding wizard actually do

`openclaw onboard` is the recommended setup path. 32. 在 **本機模式** 下，它會引導你完成：

- 33. **模型／驗證設定**（Claude 訂閱建議使用 Anthropic **setup-token**，支援 OpenAI Codex OAuth，API 金鑰為選用，支援 LM Studio 本機模型）
- **Workspace** location + bootstrap files
- **Gateway settings** (bind/port/auth/tailscale)
- 36. **Providers**（WhatsApp、Telegram、Discord、Mattermost（外掛）、Signal、iMessage）
- 37. **常駐程式安裝**（macOS 為 LaunchAgent；Linux/WSL2 為 systemd 使用者單元）
- 38. **健康檢查** 與 **skills** 選擇

It also warns if your configured model is unknown or missing auth.

### Do I need a Claude or OpenAI subscription to run this

否. You can run OpenClaw with **API keys** (Anthropic/OpenAI/others) or with
**local-only models** so your data stays on your device. Subscriptions (Claude
Pro/Max or OpenAI Codex) are optional ways to authenticate those providers.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Local models](/gateway/local-models), [Models](/concepts/models).

### Can I use Claude Max subscription without an API key

是. You can authenticate with a **setup-token**
instead of an API key. 這是訂閱路徑。

Claude Pro/Max subscriptions **do not include an API key**, so this is the
correct approach for subscription accounts. Important: you must verify with
Anthropic that this usage is allowed under their subscription policy and terms.
If you want the most explicit, supported path, use an Anthropic API key.

### How does Anthropic setuptoken auth work

15. `claude setup-token` 會透過 Claude Code CLI 產生一個 **權杖字串**（它不在網頁主控台中提供）。 16. 你可以在 **任何機器** 上執行它。 Choose **Anthropic token (paste setup-token)** in the wizard or paste it with `openclaw models auth paste-token --provider anthropic`. 18. 該權杖會以 **anthropic** 供應商的驗證設定檔儲存，並像 API 金鑰一樣使用（不會自動重新整理）。 More detail: [OAuth](/concepts/oauth).

### Where do I find an Anthropic setuptoken

It is **not** in the Anthropic Console. The setup-token is generated by the **Claude Code CLI** on **any machine**:

```bash
claude setup-token
```

Copy the token it prints, then choose **Anthropic token (paste setup-token)** in the wizard. 24. 如果你想在 gateway 主機上執行它，請使用 `openclaw models auth setup-token --provider anthropic`。 If you ran `claude setup-token` elsewhere, paste it on the gateway host with `openclaw models auth paste-token --provider anthropic`. See [Anthropic](/providers/anthropic).

### Do you support Claude subscription auth (Claude Pro or Max)

Yes - via **setup-token**. OpenClaw no longer reuses Claude Code CLI OAuth tokens; use a setup-token or an Anthropic API key. Generate the token anywhere and paste it on the gateway host. 31. 請參閱 [Anthropic](/providers/anthropic) 與 [OAuth](/concepts/oauth)。

32. 注意：Claude 訂閱存取受 Anthropic 條款所規範。 For production or multi-user workloads, API keys are usually the safer choice.

### 34. 為什麼我會看到來自 Anthropic 的 HTTP 429 ratelimiterror

35. 這表示你在目前時間窗口內的 **Anthropic 配額／速率限制** 已用盡。 If you
    use a **Claude subscription** (setup-token or Claude Code OAuth), wait for the window to
    reset or upgrade your plan. If you use an **Anthropic API key**, check the Anthropic Console
    for usage/billing and raise limits as needed.

Tip: set a **fallback model** so OpenClaw can keep replying while a provider is rate-limited.
39. 請參閱 [Models](/cli/models) 與 [OAuth](/concepts/oauth)。

### Is AWS Bedrock supported

41. 是的 —— 透過 pi-ai 的 **Amazon Bedrock（Converse）** 供應商，並使用 **手動設定**。 You must supply AWS credentials/region on the gateway host and add a Bedrock provider entry in your models config. 43. 請參閱 [Amazon Bedrock](/providers/bedrock) 與 [Model providers](/providers/models)。 44. 如果你偏好受管理的金鑰流程，在 Bedrock 前方使用 OpenAI 相容的代理仍然是可行的選項。

### Codex 的驗證是如何運作的

OpenClaw supports **OpenAI Code (Codex)** via OAuth (ChatGPT sign-in). The wizard can run the OAuth flow and will set the default model to `openai-codex/gpt-5.3-codex` when appropriate. 請參閱 [Model providers](/concepts/model-providers) 與 [Wizard](/start/wizard)。

### Do you support OpenAI subscription auth Codex OAuth

是. OpenClaw fully supports **OpenAI Code (Codex) subscription OAuth**. 上線引導精靈
可以替你執行 OAuth 流程。

See [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), and [Wizard](/start/wizard).

### How do I set up Gemini CLI OAuth

Gemini CLI uses a **plugin auth flow**, not a client id or secret in `openclaw.json`.

11. 步驟：

1. 6. 啟用外掛：`openclaw plugins enable google-gemini-cli-auth`
2. 登入：`openclaw models auth login --provider google-gemini-cli --set-default`

這會將 OAuth 權杖儲存在 gateway 主機上的驗證設定檔中。 Details: [Model providers](/concepts/model-providers).

### Is a local model OK for casual chats

16. 通常不適合。 OpenClaw needs large context + strong safety; small cards truncate and leak. If you must, run the **largest** MiniMax M2.1 build you can locally (LM Studio) and see [/gateway/local-models](/gateway/local-models). Smaller/quantized models increase prompt-injection risk - see [Security](/gateway/security).

### How do I keep hosted model traffic in a specific region

21. 選擇區域鎖定的端點。 16. OpenRouter 提供 MiniMax、Kimi 與 GLM 的美國託管選項；選擇美國託管的變體即可讓資料留在該地區。 23. 你仍可透過設定 `models.mode: "merge"` 同時列出 Anthropic/OpenAI，讓備援模型可用，同時遵守你選擇的區域化供應商。

### 4. 我一定要買一台 Mac Mini 才能安裝這個嗎

否. 5. OpenClaw 可在 macOS 或 Linux 上執行（Windows 可透過 WSL2）。 6. Mac mini 並非必須——有些人會買來作為 24/7 開機的主機，但小型 VPS、家用伺服器或 Raspberry Pi 等級的裝置也都可以。

7. 只有在需要 **僅限 macOS 的工具** 時，你才需要一台 Mac。 28. iMessage 請使用 [BlueBubbles](/channels/bluebubbles)（推薦）——BlueBubbles 伺服器在任何 Mac 上執行，而 Gateway 可在 Linux 或其他地方執行。 如果你需要其他僅限 macOS 的工具，請在 Mac 上執行 Gateway，或配對一個 macOS 節點。

30. 文件：[BlueBubbles](/channels/bluebubbles)、[Nodes](/nodes)、[Mac remote mode](/platforms/mac/remote)。

### 25. 我需要 Mac mini 才能支援 iMessage 嗎

12. 你需要 **某一台已登入 Messages 的 macOS 裝置**。 27. 它 **不一定** 要是 Mac mini——任何 Mac 都可以。 28. **使用 [BlueBubbles](/channels/bluebubbles)**（推薦）來支援 iMessage——BlueBubbles 伺服器在 macOS 上執行，而 Gateway 可在 Linux 或其他地方執行。

15. 常見架構：

- 30. 在 Linux/VPS 上執行 Gateway，並在任何已登入 Messages 的 Mac 上執行 BlueBubbles 伺服器。
- 17. 如果你想要最簡單的單機設定，也可以把所有東西都跑在同一台 Mac 上。

32. 文件：[BlueBubbles](/channels/bluebubbles)、[Nodes](/nodes)、
    [Mac remote mode](/platforms/mac/remote)。

### 33. 如果我買 Mac mini 來執行 OpenClaw，可以連接到我的 MacBook Pro 嗎

是. 40. **Mac mini 可以執行 Gateway**，而你的 MacBook Pro 可以作為 **節點**（陪伴裝置）連接。 35. 節點不會執行 Gateway——它們提供額外功能，例如該裝置上的螢幕／相機／畫布，以及 `system.run`。

22. 常見模式：

- 37. Gateway 跑在 Mac mini（全天候運作）。
- 24. MacBook Pro 執行 macOS App 或節點主機，並配對到 Gateway。
- 25. 使用 `openclaw nodes status` / `openclaw nodes list` 來查看狀態。

文件：[Nodes](/nodes)，[Nodes CLI](/cli/nodes).

### 26. 我可以使用 Bun 嗎

41. **不建議** 使用 Bun。 28. 我們觀察到執行期錯誤，特別是在 WhatsApp 與 Telegram 上。
42. 請使用 **Node** 以獲得穩定的 Gateway。

If you still want to experiment with Bun, do it on a non-production gateway
without WhatsApp/Telegram.

### 45. Telegram 的 allowFrom 要填什麼

46. `channels.telegram.allowFrom` 是 **人類發送者的 Telegram 使用者 ID**（數字，建議）或 `@username`。 47. 這不是機器人的使用者名稱。

較安全（無第三方機器人）：

- 私訊你的機器人，然後執行 `openclaw logs --follow` 並讀取 `from.id`。

49. 官方 Bot API：

- 50. 私訊你的機器人，接著呼叫 `https://api.telegram.org/bot<bot_token>/getUpdates` 並讀取 `message.from.id`。

第三方（隱私較低）：

- DM `@userinfobot` or `@getidsbot`.

38. 請參閱 [/channels/telegram](/channels/telegram#access-control-dms--groups)。

### Can multiple people use one WhatsApp number with different OpenClaw instances

Yes, via **multi-agent routing**. Bind each sender's WhatsApp **DM** (peer `kind: "dm"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. 42. 回覆仍會來自 **同一個 WhatsApp 帳號**，而 DM 的存取控制（`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`）是以 WhatsApp 帳號為單位的全域設定。 See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).

### 44. 我可以同時跑一個快速聊天代理，以及一個用於寫程式的 Opus 代理嗎

是. Use multi-agent routing: give each agent its own default model, then bind inbound routes (provider account or specific peers) to each agent. 範例設定位於 [Multi-Agent Routing](/concepts/multi-agent)。 47. 另請參閱 [Models](/concepts/models) 與 [Configuration](/gateway/configuration)。

### 48. Homebrew 能在 Linux 上使用嗎

是. 49. Homebrew 支援 Linux（Linuxbrew）。 快速開始:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

If you run OpenClaw via systemd, ensure the service PATH includes `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non-login shells.
Recent builds also prepend common user bin dirs on Linux systemd services (for example `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.

### What's the difference between the hackable git install and npm install

- **可駭（git）安裝：** 完整原始碼檢出、可編輯，最適合貢獻者。
  You run builds locally and can patch code/docs.
- **npm install:** global CLI install, no repo, best for "just run it."
  Updates come from npm dist-tags.

Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

### 之後可以在 npm 與 git 安裝之間切換嗎

是. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.
This **does not delete your data** - it only changes the OpenClaw code install. 你的狀態
(`~/.openclaw`) 與工作區 (`~/.openclaw/workspace`) 都會保持不變。

3. 從 npm → git：

```bash
4. git clone https://github.com/openclaw/openclaw.git
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

7. Doctor 會偵測到 gateway 服務進入點不一致，並提供重新寫入服務設定以符合目前安裝（在自動化中使用 `--repair`）。

備份建議：請參閱 [Backup strategy](/help/faq#whats-the-recommended-backup-strategy)。

### Should I run the Gateway on my laptop or a VPS

Short answer: **if you want 24/7 reliability, use a VPS**. If you want the
lowest friction and you're okay with sleep/restarts, run it locally.

**筆電（本地 Gateway）**

- **Pros:** no server cost, direct access to local files, live browser window.
- **Cons:** sleep/network drops = disconnects, OS updates/reboots interrupt, must stay awake.

15. **VPS / 雲端**

- **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
- **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.

**OpenClaw 專屬說明：** WhatsApp/Telegram/Slack/Mattermost（外掛）/Discord 都能從 VPS 正常運作。 The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).

**Recommended default:** VPS if you had gateway disconnects before. Local is great when you're actively using the Mac and want local file access or UI automation with a visible browser.

### How important is it to run OpenClaw on a dedicated machine

Not required, but **recommended for reliability and isolation**.

- **Dedicated host (VPS/Mac mini/Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.
- **Shared laptop/desktop:** totally fine for testing and active use, but expect pauses when the machine sleeps or updates.

If you want the best of both worlds, keep the Gateway on a dedicated host and pair your laptop as a **node** for local screen/camera/exec tools. See [Nodes](/nodes).
For security guidance, read [Security](/gateway/security).

### What are the minimum VPS requirements and recommended OS

OpenClaw is lightweight. For a basic Gateway + one chat channel:

- **Absolute minimum:** 1 vCPU, 1GB RAM, ~500MB disk.
- **Recommended:** 1-2 vCPU, 2GB RAM or more for headroom (logs, media, multiple channels). Node tools and browser automation can be resource hungry.

OS: use **Ubuntu LTS** (or any modern Debian/Ubuntu). The Linux install path is best tested there.

Docs: [Linux](/platforms/linux), [VPS hosting](/vps).

### Can I run OpenClaw in a VM and what are the requirements

是. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough
RAM for the Gateway and any channels you enable.

Baseline guidance:

- **Absolute minimum:** 1 vCPU, 1GB RAM.
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

5. 如果你使用 Windows，**WSL2 是最容易的 VM 風格設定**，且具備最佳的工具相容性。 6. 請參閱 [Windows](/platforms/windows)、[VPS hosting](/vps)。
   If you are running macOS in a VM, see [macOS VM](/install/macos-vm).

## What is OpenClaw?

### What is OpenClaw in one paragraph

OpenClaw is a personal AI assistant you run on your own devices. 10. 它會在你已經使用的訊息平台上回覆（WhatsApp、Telegram、Slack、Mattermost（外掛）、Discord、Google Chat、Signal、iMessage、WebChat），並且在支援的平台上也能提供語音 + 即時 Canvas。 11. **Gateway** 是永遠在線的控制平面；助手本身才是產品。

### 12. 價值主張是什麼

13. OpenClaw 不是「只是 Claude 的包裝器」。 It's a **local-first control plane** that lets you run a
    capable assistant on **your own hardware**, reachable from the chat apps you already use, with
    stateful sessions, memory, and tools - without handing control of your workflows to a hosted
    SaaS.

15. 重點特色：

- 16. **你的裝置，你的資料：** 在任何你想要的地方（Mac、Linux、VPS）執行 Gateway，並將工作區與會話歷史保留在本地。
- **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobile voice and Canvas on supported platforms.
- **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing
  and failover.
- **Local-only option:** run local models so **all data can stay on your device** if you want.
- 20. **多代理路由：** 依頻道、帳號或任務分離不同代理，每個都有自己的工作區與預設值。
- **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### I just set it up what should I do first

Good first projects:

- Build a website (WordPress, Shopify, or a simple static site).
- Prototype a mobile app (outline, screens, API plan).
- Organize files and folders (cleanup, naming, tagging).
- 28. 連接 Gmail，並自動化摘要或後續跟進。

29. 它可以處理大型任務，但在你將任務拆分成多個階段，並使用子代理進行平行工作時，效果最佳。

### 30. OpenClaw 的五大日常使用情境是什麼

Everyday wins usually look like:

- 32. **個人簡報：** 你關心的收件匣、行事曆與新聞摘要。
- **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
- **Reminders and follow ups:** cron or heartbeat driven nudges and checklists.
- **Browser automation:** filling forms, collecting data, and repeating web tasks.
- 36. **跨裝置協作：** 從手機送出任務，讓 Gateway 在伺服器上執行，並在聊天中取回結果。

### 37. OpenClaw 能協助 SaaS 的名單開發、外聯、廣告與部落格嗎

38. 可以，用於**研究、資格篩選與撰寫草稿**。 39. 它可以掃描網站、建立候選清單、整理潛在客戶摘要，並撰寫外聯或廣告文案草稿。

40. 對於**外聯或廣告投放**，請保留人工審核。 Avoid spam, follow local laws and
    platform policies, and review anything before it is sent. The safest pattern is to let
    OpenClaw draft and you approve.

43. 文件：[Security](/gateway/security)。

### What are the advantages vs Claude Code for web development

45. OpenClaw 是一個**個人助理**與協調層，而不是 IDE 的替代品。 46. 在儲存庫內進行最快的直接寫碼循環，請使用 Claude Code 或 Codex。 47. 當你需要持久記憶、跨裝置存取，以及工具編排時，使用 OpenClaw。

Advantages:

- **Persistent memory + workspace** across sessions
- 50. **多平台存取**（WhatsApp、Telegram、TUI、WebChat）
- **Tool orchestration** (browser, files, scheduling, hooks)
- **Always-on Gateway** (run on a VPS, interact from anywhere)
- **Nodes** for local browser/screen/camera/exec

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Skills and automation

### How do I customize skills without keeping the repo dirty

Use managed overrides instead of editing the repo copy. Put your changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence is `<workspace>/skills` > `~/.openclaw/skills` > bundled, so managed overrides win without touching git. Only upstream-worthy edits should live in the repo and go out as PRs.

### Can I load skills from a custom folder

是. Add extra directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence). Default precedence remains: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills`.

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

檢查清單：

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

是. Use the Gateway scheduler:

- **Cron jobs** for scheduled or recurring tasks (persist across restarts).
- **Heartbeat** for "main session" periodic checks.
- **Isolated jobs** for autonomous agents that post summaries or deliver to chats.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Can I run Apple macOS-only skills from Linux?

Not directly. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and skills only appear in the system prompt when they are eligible on the **Gateway host**. On Linux, `darwin`-only skills (like `apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.

You have three supported patterns:

**Option A - run the Gateway on a Mac (simplest).**
Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) or over Tailscale. The skills load normally because the Gateway host is macOS.

由於 Gateway 主機是 macOS，技能會正常載入。 **選項 B - 使用 macOS 節點（不需 SSH）。** The agent runs those skills via the `nodes` tool. If you choose "Always Ask", approving "Always Allow" in the prompt adds that command to the allowlist.

代理會透過 `nodes` 工具執行這些技能。 Then override the skill to allow Linux so it stays eligible.

1. Create an SSH wrapper for the binary (example: `memo` for Apple Notes):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
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

### Do you have a Notion or HeyGen integration

Not built-in today.

Options：

- **Custom skill / plugin:** best for reliable API access (Notion/HeyGen both have APIs).
- **Browser automation:** works without code but is slower and more fragile.

If you want to keep context per client (agency workflows), a simple pattern is:

- **自訂技能／外掛：** 最適合需要穩定 API 存取的情境（Notion／HeyGen 皆提供 API）。
- **瀏覽器自動化：** 無需寫程式即可運作，但速度較慢且較不穩定。

If you want a native integration, open a feature request or build a skill
targeting those APIs.

Install skills:

```bash
clawhub install <skill-slug>
clawhub update --all
```

如果你想要原生整合，請提出功能需求或建立一個針對這些 API 的技能。 安裝技能： clawhub install <skill-slug>
clawhub update --all See [Skills](/tools/skills) and [ClawHub](/tools/clawhub).

### How do I install the Chrome extension for browser takeover

Use the built-in installer, then load the unpacked extension in Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Then Chrome → `chrome://extensions` → enable "Developer mode" → "Load unpacked" → pick that folder.

Full guide (including remote Gateway + security notes): [Chrome extension](/tools/chrome-extension)

使用內建安裝程式，然後在 Chrome 中載入未封裝的擴充功能：
如果 Gateway 閘道器 在其他地方執行，請在瀏覽器機器上執行 node host，
以便 Gateway 閘道器 能代理瀏覽器動作。
You still need to click the extension button on the tab you want to control (it doesn't auto-attach).

## Sandboxing and memory

### 如果 Gateway 與 Chrome 在同一台機器上執行（預設設定），通常**不需要**任何額外設定。

是. 你仍需要在想要控制的分頁上點擊擴充功能按鈕（它不會自動附加）。 沙箱與記憶體

### 是否有專門的沙箱文件？

3. 預設映像以安全為優先，並以 `node` 使用者身分執行，因此不包含系統套件、Homebrew 或內建瀏覽器。 4. 若要更完整的設定：

- Docker 感覺受限，我要如何啟用完整功能？
- 6. 使用 `OPENCLAW_DOCKER_APT_PACKAGES` 將系統相依套件烘焙進映像。
- 7. 透過隨附的 CLI 安裝 Playwright 瀏覽器：
     `node /app/node_modules/playwright-core/cli.js install chromium`
- 8. 設定 `PLAYWRIGHT_BROWSERS_PATH` 並確保該路徑會被持久化。

9. 文件：[Docker](/install/docker), [Browser](/tools/browser)。

10. **我可以讓私訊（DMs）保持私密，同時用一個 agent 讓群組公開並在沙盒中執行嗎**

11. 可以——只要你的私有流量是 **DMs**，而公開流量是 **groups**。

使用 `agents.defaults.sandbox.mode: "non-main"`，讓群組／頻道工作階段（非 main 金鑰）在 Docker 中執行，而主要的 DM 工作階段仍留在主機上。 然後透過 `tools.sandbox.tools` 限制沙箱工作階段可用的工具。

設定流程 + 範例設定：[Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

關鍵設定參考：[Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### 我要如何將主機資料夾綁定到沙箱中

17. 將 `agents.defaults.sandbox.docker.binds` 設為 `["host:path:mode"]`（例如：`"/home/user/src:/src:ro"`）。 18. 全域與每個 agent 的 bind 會合併；當 `scope: "shared"` 時，會忽略每個 agent 的 bind。 19. 對任何敏感內容使用 `:ro`，並記得 bind 會繞過沙盒的檔案系統隔離牆。 範例與安全注意事項請參考 [Sandboxing](/gateway/sandboxing#custom-bind-mounts) 與 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check)。

### 記憶體是如何運作的

22. OpenClaw 的記憶體其實就是 agent 工作區中的 Markdown 檔案：

- 每日筆記位於 `memory/YYYY-MM-DD.md`
- 24. 精選的長期筆記位於 `MEMORY.md`（僅主／私有工作階段）

25. OpenClaw 也會執行 **靜默的預先壓縮記憶體刷新**，提醒模型在自動壓縮前寫下可持久保存的筆記。 這只會在工作區可寫入時執行（唯讀沙箱會跳過）。 請參閱 [Memory](/concepts/memory)。

### 記憶體一直忘記事情，我要怎麼讓它記住

請要求機器人 **將該事實寫入記憶體**。 29. 長期筆記應放在 `MEMORY.md`，短期脈絡則放在 `memory/YYYY-MM-DD.md`。

這仍然是我們正在改進的領域。 31. 提醒模型儲存記憶會很有幫助；它會知道該怎麼做。 32. 如果它仍然忘記，請確認 Gateway 每次執行都使用相同的工作區。

33. 文件：[Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace)。

### 語意記憶搜尋是否需要 OpenAI API 金鑰

只有在你使用 **OpenAI embeddings** 時才需要。 Codex OAuth 僅涵蓋聊天／補全，且**不**提供 embeddings 存取權限，因此 **使用 Codex 登入（OAuth 或 Codex CLI 登入）** 無法用於語意記憶搜尋。 37. OpenAI embeddings 仍然需要真正的 API 金鑰（`OPENAI_API_KEY` 或 `models.providers.openai.apiKey`）。

38. 若未明確設定 provider，OpenClaw 會在能解析到 API 金鑰時自動選擇 provider（驗證設定檔、`models.providers.*.apiKey` 或環境變數）。
39. 若解析到 OpenAI 金鑰則優先使用 OpenAI，否則若解析到 Gemini 金鑰則使用 Gemini。 40. 如果兩者都沒有可用的金鑰，記憶搜尋會保持停用，直到你完成設定。 41. 如果你已設定且存在本地模型路徑，OpenClaw 會優先使用 `local`。

42. 如果你想完全使用本地，請設定 `memorySearch.provider = "local"`（並可選擇設定 `memorySearch.fallback = "none"`）。 如果你想使用 Gemini embeddings，請設定 `memorySearch.provider = "gemini"` 並提供 `GEMINI_API_KEY`（或 `memorySearch.remote.apiKey`）。 44. 我們支援 **OpenAI、Gemini 或 local** 的 embedding 模型——設定細節請參考 [Memory](/concepts/memory)。

### 45. 記憶會永久保存嗎？有什麼限制？

46. 記憶檔案存放在磁碟上，除非你刪除，否則會一直保留。 47. 限制來自你的儲存空間，而不是模型。 **工作階段情境** 仍受模型的情境視窗限制，因此長對話可能會被壓縮或截斷。 這就是為什麼需要記憶體搜尋——它只會將相關部分拉回到情境中。

50. 文件：[Memory](/concepts/memory), [Context](/concepts/context)。

## Where things live on disk

### Is all data used with OpenClaw saved locally

No - **OpenClaw's state is local**, but **external services still see what you send them**.

- **Local by default:** sessions, memory files, config, and workspace live on the Gateway host
  (`~/.openclaw` + your workspace directory).
- **Remote by necessity:** messages you send to model providers (Anthropic/OpenAI/etc.) go to
  their APIs, and chat platforms (WhatsApp/Telegram/Slack/etc.) store message data on their
  servers.
- **You control the footprint:** using local models keeps prompts on your machine, but channel
  traffic still goes through the channel's servers.

Related: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

### Where does OpenClaw store its data

1. 一切都位於 `$OPENCLAW_STATE_DIR` 之下（預設：`~/.openclaw`）：

| 2. 路徑                                                     | 目的                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 3. `$OPENCLAW_STATE_DIR/openclaw.json`                    | Main config (JSON5)                                                                     |
| 5. `$OPENCLAW_STATE_DIR/credentials/oauth.json`           | 6. 舊版 OAuth 匯入（首次使用時複製到驗證設定檔）                                                       |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json`                  | Auth profiles (OAuth + API keys)                                                        |
| 9. `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json` | 10. 執行期驗證快取（自動管理）                                                                   |
| `$OPENCLAW_STATE_DIR/credentials/`                                               | Provider state (e.g. `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                                    | 12. 每個代理的狀態（agentDir + sessions）                                                    |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                                 | 14. 對話歷史與狀態（每個代理）                                                                   |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`                    | 16. 工作階段中繼資料（每個代理）                                                                  |

Legacy single-agent path: `~/.openclaw/agent/*` (migrated by `openclaw doctor`).

Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate and configured via `agents.defaults.workspace` (default: `~/.openclaw/workspace`).

### Where should AGENTSmd SOULmd USERmd MEMORYmd live

21. 這些檔案位於 **代理工作區**，而不是 `~/.openclaw`。

- **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (or `memory.md`), `memory/YYYY-MM-DD.md`, optional `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, credentials, auth profiles, sessions, logs,
  and shared skills (`~/.openclaw/skills`).

24. 預設工作區是 `~/.openclaw/workspace`，可透過以下方式設定：

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

If the bot "forgets" after a restart, confirm the Gateway is using the same
workspace on every launch (and remember: remote mode uses the **gateway host's**
workspace, not your local laptop).

26. 提示：如果你想要持久的行為或偏好，請要求機器人 **將其寫入
    AGENTS.md 或 MEMORY.md**，而不是依賴聊天記錄。

27. 請參閱 [Agent workspace](/concepts/agent-workspace) 與 [Memory](/concepts/memory)。

### 28. 建議的備份策略是什麼

Put your **agent workspace** in a **private** git repo and back it up somewhere
private (for example GitHub private). This captures memory + AGENTS/SOUL/USER
files, and lets you restore the assistant's "mind" later.

Do **not** commit anything under `~/.openclaw` (credentials, sessions, tokens).
If you need a full restore, back up both the workspace and the state directory
separately (see the migration question above).

Docs: [Agent workspace](/concepts/agent-workspace).

### How do I completely uninstall OpenClaw

See the dedicated guide: [Uninstall](/install/uninstall).

### Can agents work outside the workspace

是. 37. 工作區是 **預設的 cwd** 與記憶錨點，而不是硬性沙箱。
Relative paths resolve inside the workspace, but absolute paths can access other
host locations unless sandboxing is enabled. If you need isolation, use
[`agents.defaults.sandbox`](/gateway/sandboxing) or per-agent sandbox settings. If you
want a repo to be the default working directory, point that agent's
`workspace` to the repo root. The OpenClaw repo is just source code; keep the
workspace separate unless you intentionally want the agent to work inside it.

Example (repo as default cwd):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Im in remote mode where is the session store

Session state is owned by the **gateway host**. If you're in remote mode, the session store you care about is on the remote machine, not your local laptop. See [Session management](/concepts/session).

## Config basics

### What format is the config Where is it

OpenClaw reads an optional **JSON5** config from `$OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

If the file is missing, it uses safe-ish defaults (including a default workspace of `~/.openclaw/workspace`).

### I set gatewaybind lan or tailnet and now nothing listens the UI says unauthorized

Non-loopback binds **require auth**. Configure `gateway.auth.mode` + `gateway.auth.token` (or use `OPENCLAW_GATEWAY_TOKEN`).

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

- `gateway.remote.token` is for **remote CLI calls** only; it does not enable local gateway auth.
- The Control UI authenticates via `connect.params.auth.token` (stored in app/UI settings). Avoid putting tokens in URLs.

### Why do I need a token on localhost now

The wizard generates a gateway token by default (even on loopback) so **local WS clients must authenticate**. This blocks other local processes from calling the Gateway. Paste the token into the Control UI settings (or your client config) to connect.

If you **really** want open loopback, remove `gateway.auth` from your config. Doctor can generate a token for you any time: `openclaw doctor --generate-gateway-token`.

### Do I have to restart after changing config

The Gateway watches the config and supports hot-reload:

- `gateway.reload.mode: "hybrid"` (default): hot-apply safe changes, restart for critical ones
- `hot`, `restart`, `off` are also supported

### How do I enable web search and web fetch

`web_fetch` works without an API key. `web_search` requires a Brave Search API
key. **Recommended:** run `openclaw configure --section web` to store it in
`tools.web.search.apiKey`. Environment alternative: set `BRAVE_API_KEY` for the
Gateway process.

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

- If you use allowlists, add `web_search`/`web_fetch` or `group:web`.
- `web_fetch` 預設為啟用（除非明確停用）。
- Daemons read env vars from `~/.openclaw/.env` (or the service environment).

Docs: [Web tools](/tools/web).

### How do I run a central Gateway with specialized workers across devices

The common pattern is **one Gateway** (e.g. Raspberry Pi) plus **nodes** and **agents**:

- **Gateway (central):** owns channels (Signal/WhatsApp), routing, and sessions.
- **Nodes (devices):** Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).
- **Agents (workers):** separate brains/workspaces for special roles (e.g. "Hetzner ops", "Personal data").
- **Sub-agents:** spawn background work from a main agent when you want parallelism.
- **TUI:** connect to the Gateway and switch agents/sessions.

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Can the OpenClaw browser run headless

是. It's a config option:

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

Default is `false` (headful). Headless is more likely to trigger anti-bot checks on some sites. See [Browser](/tools/browser).

Headless uses the **same Chromium engine** and works for most automation (forms, clicks, scraping, logins). 14. 主要差異：

- 15. 沒有可見的瀏覽器視窗（若需要視覺畫面請使用截圖）。
- 16. 某些網站在無頭模式下對自動化更嚴格（CAPTCHA、反機器人）。
  17. 例如，X/Twitter 經常封鎖無頭工作階段。

### How do I use Brave for browser control

Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway.
See the full config examples in [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## 11. 遠端 Gateway 與節點

### 22. 指令如何在 Telegram、gateway 與 nodes 之間傳遞

13. Telegram 訊息由 **gateway** 處理。 24. gateway 會執行 agent，
    然後只有在需要 node 工具時，才透過 **Gateway WebSocket** 呼叫 nodes：

25. Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

26. Nodes 不會看到進來的供應商流量；它們只會接收 node RPC 呼叫。

### 27. 如果 Gateway 託管在遠端，我的 agent 要如何存取我的電腦

18. 簡短答案：**將你的電腦配對為一個節點**。 19. Gateway 在其他地方執行，但它可以透過 Gateway WebSocket 在你的本機上呼叫 `node.*` 工具（螢幕、相機、系統）。

20. 典型設定：

1. 21. 在永遠在線的主機（VPS／家用伺服器）上執行 Gateway。
2. 22. 將 Gateway 主機與你的電腦放在同一個 tailnet 中。
3. 23. 確保 Gateway WS 可達（tailnet 綁定或 SSH 通道）。
4. 24. 在本機開啟 macOS App，並以 **Remote over SSH** 模式（或直接 tailnet）連線，
       以便註冊為一個節點。
5. 25. 在 Gateway 上核准該節點：

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

36) 不需要另外的 TCP 橋接；nodes 透過 Gateway WebSocket 連線。

37. 安全提醒：配對 macOS node 會允許在該機器上執行 `system.run`。 28. 僅
    配對你信任的裝置，並檢視 [Security](/gateway/security)。

29. 文件：[Nodes](/nodes)、[Gateway protocol](/gateway/protocol)、[macOS remote mode](/platforms/mac/remote)、[Security](/gateway/security)。

### 30. Tailscale 已連線，但我沒有收到回覆，接下來怎麼辦

Check the basics:

- Gateway is running: `openclaw gateway status`
- Gateway health: `openclaw status`
- Channel health: `openclaw channels status`

35. 接著驗證驗證與路由：

- 36. 如果你使用 Tailscale Serve，請確保 `gateway.auth.allowTailscale` 設定正確。
- If you connect via SSH tunnel, confirm the local tunnel is up and points at the right port.
- Confirm your allowlists (DM or group) include your account.

Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### 40. 兩個 OpenClaw 實例可以在本機或 VPS 上彼此通訊嗎

是. 41. 目前沒有內建的「機器人對機器人」橋接，但你可以用幾種可靠的方式自行串接：

42. **最簡單：** 使用兩個機器人都能存取的一般聊天通道（Telegram／Slack／WhatsApp）。
43. 讓 Bot A 傳送訊息給 Bot B，然後讓 Bot B 如常回覆。

44. **CLI 橋接（通用）：** 執行一個腳本，呼叫另一個 Gateway：
    `openclaw agent --message ... 45. --deliver`，目標指向另一個機器人
    正在監聽的聊天。 46. 如果其中一個機器人在遠端 VPS 上，請透過 SSH／Tailscale 將你的 CLI 指向該遠端 Gateway（請見 [Remote access](/gateway/remote)）。

Example pattern (run from a machine that can reach the target Gateway):

```bash
48. openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

Tip: add a guardrail so the two bots do not loop endlessly (mention-only, channel
allowlists, or a "do not reply to bot messages" rule).

50. 文件：[Remote access](/gateway/remote)、[Agent CLI](/cli/agent)、[Agent send](/tools/agent-send)。

### Do I need separate VPSes for multiple agents

否. One Gateway can host multiple agents, each with its own workspace, model defaults,
and routing. That is the normal setup and it is much cheaper and simpler than running
one VPS per agent.

Use separate VPSes only when you need hard isolation (security boundaries) or very
different configs that you do not want to share. Otherwise, keep one Gateway and
use multiple agents or sub-agents.

### Is there a benefit to using a node on my personal laptop instead of SSH from a VPS

Yes - nodes are the first-class way to reach your laptop from a remote Gateway, and they
unlock more than shell access. The Gateway runs on macOS/Linux (Windows via WSL2) and is
lightweight (a small VPS or Raspberry Pi-class box is fine; 4 GB RAM is plenty), so a common
setup is an always-on host plus your laptop as a node.

- **No inbound SSH required.** Nodes connect out to the Gateway WebSocket and use device pairing.
- **Safer execution controls.** `system.run` is gated by node allowlists/approvals on that laptop.
- **More device tools.** Nodes expose `canvas`, `camera`, and `screen` in addition to `system.run`.
- **Local browser automation.** Keep the Gateway on a VPS, but run Chrome locally and relay control
  with the Chrome extension + a node host on the laptop.

SSH is fine for ad-hoc shell access, but nodes are simpler for ongoing agent workflows and
device automation.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### Should I install on a second laptop or just add a node

If you only need **local tools** (screen/camera/exec) on the second laptop, add it as a
**node**. That keeps a single Gateway and avoids duplicated config. Local node tools are
currently macOS-only, but we plan to extend them to other OSes.

Install a second Gateway only when you need **hard isolation** or two fully separate bots.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### Do nodes run a gateway service

否. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect
to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node
hosts and CLI control, see [Node host CLI](/cli/node).

A full restart is required for `gateway`, `discovery`, and `canvasHost` changes.

### Is there an API RPC way to apply config

是. `config.apply` validates + writes the full config and restarts the Gateway as part of the operation.

### configapply wiped my config How do I recover and avoid this

`config.apply` replaces the **entire config**. If you send a partial object, everything
else is removed.

Recover:

- Restore from backup (git or a copied `~/.openclaw/openclaw.json`).
- If you have no backup, re-run `openclaw doctor` and reconfigure channels/models.
- If this was unexpected, file a bug and include your last known config or any backup.
- A local coding agent can often reconstruct a working config from logs or history.

Avoid it:

- Use `openclaw config set` for small changes.
- Use `openclaw configure` for interactive edits.

Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### What's a minimal sane config for a first install

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

This sets your workspace and restricts who can trigger the bot.

### How do I set up Tailscale on a VPS and connect from my Mac

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
   - 2. Gateway WS：`ws://your-vps.tailnet-xxxx.ts.net:18789`

If you want the Control UI without SSH, use Tailscale Serve on the VPS:

```bash
openclaw gateway --tailscale serve
```

4. 這會讓 gateway 綁定在 loopback，並透過 Tailscale 對外提供 HTTPS。 5. 請參閱 [Tailscale](/gateway/tailscale)。

### 6. 我要如何將 Mac 節點連線到遠端的 Gateway Tailscale Serve

7. Serve 會暴露 **Gateway Control UI + WS**。 8. 節點會透過同一個 Gateway WS 端點連線。

9. 建議的設定：

1. 10. **請確保 VPS + Mac 位於同一個 tailnet**。
2. 11. **使用 macOS App 的 Remote 模式**（SSH 目標可以是 tailnet 主機名稱）。
   12. 該 App 會建立 Gateway 連接埠的通道，並以節點身分連線。
3. **Approve the node** on the gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## 15. 環境變數與 .env 載入

### How does OpenClaw load environment variables

OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) 17. 並且另外會載入：

- 18. 目前工作目錄中的 `.env`
- a global fallback `.env` from `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)

Neither `.env` file overrides existing env vars.

19. 你也可以在設定中定義行內環境變數（僅在程序環境中不存在時才會套用）：

```json5
20. {
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

See [/environment](/help/environment) for full precedence and sources.

### 21. 我是透過服務啟動 Gateway，但我的環境變數不見了，該怎麼辦

Two common fixes:

1. 23. 將缺少的金鑰放到 `~/.openclaw/.env`，這樣即使服務沒有繼承你的 shell 環境也能讀取到。
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

`openclaw models status` reports whether **shell env import** is enabled. 29. "Shell env: off"
並 **不** 代表你的環境變數遺失——這只表示 OpenClaw 不會自動載入
你的登入 shell。

30. 如果 Gateway 以服務方式執行（launchd/systemd），它不會繼承你的 shell
    環境。 31. 請用以下其中一種方式修正：

1. Put the token in `~/.openclaw/.env`:

   ```
   33. COPILOT_GITHUB_TOKEN=...
   ```

2. 34. 或啟用 shell 匯入（`env.shellEnv.enabled: true`）。

3. Or add it to your config `env` block (applies only if missing).

Then restart the gateway and recheck:

```bash
openclaw models status
```

37. Copilot token 會從 `COPILOT_GITHUB_TOKEN` 讀取（也支援 `GH_TOKEN` / `GITHUB_TOKEN`）。
38. 請參閱 [/concepts/model-providers](/concepts/model-providers) 與 [/environment](/help/environment)。

## 8. 工作階段與多重聊天

### How do I start a fresh conversation

10. 以獨立訊息傳送 `/new` 或 `/reset`。 11. 請參閱 [Session management](/concepts/session)。

### 12. 如果我從不傳送新的訊息，工作階段會自動重置嗎

是. 44. 工作階段會在 `session.idleMinutes` 後過期（預設 **60**）。 14. **下一則**
訊息會為該聊天鍵建立新的工作階段 ID。 15. 這不會刪除
逐字稿——只會啟動新的工作階段。

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### 48. 是否有方法讓一組 OpenClaw 執行個體形成一個 CEO 與多個代理

18. 可以，透過 **多代理路由** 與 **子代理**。 19. 你可以建立一個協調代理
    以及多個具有各自工作區與模型的工作代理。

20. 不過，這最適合被視為一個 **有趣的實驗**。 21. 它非常耗權杖，而且通常
    比使用一個機器人搭配多個工作階段效率更低。 我們所設想的典型模型是：
    你只和一個機器人對話，但用不同的工作階段來進行平行工作。 That
    bot can also spawn sub-agents when needed.

24. 文件：[Multi-agent routing](/concepts/multi-agent)、[Sub-agents](/tools/subagents)、[Agents CLI](/cli/agents)。

### 25. 為什麼在任務進行到一半時脈絡被截斷？我要如何避免

26. 工作階段的脈絡受限於模型的視窗大小。 27. 冗長的聊天、大量的工具輸出，或許多
    檔案都可能觸發壓縮或截斷。

28. 有哪些方法有幫助：

- 29. 要求機器人總結目前狀態並將其寫入檔案。
- 30. 在長任務前使用 `/compact`，切換主題時使用 `/new`。
- Keep important context in the workspace and ask the bot to read it back.
- 對於長時間或平行的工作使用子代理，讓主聊天保持較小。
- 33. 如果經常發生，選擇具有更大脈絡視窗的模型。

### 我要如何在保留安裝的情況下，完全重置 OpenClaw？

Use the reset command:

```bash
openclaw reset
```

Non-interactive full reset:

```bash
openclaw reset --scope full --yes --non-interactive
```

Then re-run onboarding:

```bash
openclaw onboard --install-daemon
```

注意事項：

- The onboarding wizard also offers **Reset** if it sees an existing config. See [Wizard](/start/wizard).
- 41. 如果你使用了設定檔（`--profile` / `OPENCLAW_PROFILE`），請重置每個狀態目錄（預設為 `~/.openclaw-<profile>`）。
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Im getting context too large errors how do I reset or compact

使用以下其中一種：

- 44. **壓縮**（保留對話，但總結較舊的回合）：

  ```
  /compact
  ```

  46. 或使用 `/compact <instructions>` 來引導摘要。

- **重置**（為相同的聊天鍵建立全新的工作階段 ID）：

  ```
  /new
  /reset
  ```

49. 如果持續發生：

- 啟用或調整 **工作階段修剪**（`agents.defaults.contextPruning`），以修剪舊的工具輸出。
- Use a model with a larger context window.

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### Why am I seeing LLM request rejected messagesNcontentXtooluseinput Field required

This is a provider validation error: the model emitted a `tool_use` block without the required
`input`. 這通常表示工作階段歷史已過期或損毀（常見於長對話串
或工具／結構描述變更之後）。

Fix: start a fresh session with `/new` (standalone message).

### 為什麼我每 30 分鐘會收到一次心跳訊息？

心跳預設每 **30m** 執行一次。 Tune or disable them:

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

若 `HEARTBEAT.md` 存在但實質上是空的（僅包含空白行與像 `# Heading` 這樣的 Markdown 標題），OpenClaw 會略過 Heartbeat 執行以節省 API 呼叫。
若檔案不存在，Heartbeat 仍會執行，由模型自行決定要做什麼。
若檔案不存在，心跳仍會執行，並由模型決定要做什麼。

Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Do I need to add a bot account to a WhatsApp group

否. OpenClaw runs on **your own account**, so if you're in the group, OpenClaw can see it.
By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

If you want only **you** to be able to trigger group replies:

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

### How do I get the JID of a WhatsApp group

Option 1 (fastest): tail logs and send a test message in the group:

```bash
openclaw logs --follow --json
```

尋找以 `@g.us` 結尾的 `chatId`（或 `from`），例如：
`1234567890-1234567890@g.us`。

Option 2 (if already configured/allowlisted): list groups from config:

```bash
openclaw directory groups list --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### 為什麼 OpenClaw 在群組中不回覆

Two common causes:

- Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
- You configured `channels.whatsapp.groups` without `"*"` and the group isn't allowlisted.

請參閱 [Groups](/channels/groups) 與 [Group messages](/channels/group-messages)。

### Do groupsthreads share context with DMs

Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### How many workspaces and agents can I create

No hard limits. 數十個（甚至上百個）都沒問題，但請留意：

- **Disk growth:** sessions + transcripts live under `~/.openclaw/agents/<agentId>/sessions/`.
- **Token cost:** more agents means more concurrent model usage.
- **Ops overhead:** per-agent auth profiles, workspaces, and channel routing.

建議：

- Keep one **active** workspace per agent (`agents.defaults.workspace`).
- Prune old sessions (delete JSONL or store entries) if disk grows.
- Use `openclaw doctor` to spot stray workspaces and profile mismatches.

### Can I run multiple bots or chats at the same time Slack and how should I set that up

是. Use **Multi-Agent Routing** to run multiple isolated agents and route inbound messages by
channel/account/peer. Slack is supported as a channel and can be bound to specific agents.

Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can
still block automation. For the most reliable browser control, use the Chrome extension relay
on the machine that runs the browser (and keep the Gateway anywhere).

Best-practice setup:

- 常駐的 Gateway 主機（VPS／Mac mini）。
- 每個角色一個代理（綁定）。
- Slack channel(s) bound to those agents.
- Local browser via extension relay (or a node) when needed.

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## Models: defaults, selection, aliases, switching

### What is the default model

OpenClaw 的預設模型是你設定為以下者：

```
agents.defaults.model.primary
```

Models are referenced as `provider/model` (example: `anthropic/claude-opus-4-6`). If you omit the provider, OpenClaw currently assumes `anthropic` as a temporary deprecation fallback - but you should still **explicitly** set `provider/model`.

### What model do you recommend

**Recommended default:** `anthropic/claude-opus-4-6`.
**良好替代：** `anthropic/claude-sonnet-4-5`。
**Reliable (less character):** `openai/gpt-5.2` - nearly as good as Opus, just less personality.
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 has its own docs: [MiniMax](/providers/minimax) and
[Local models](/gateway/local-models).

經驗法則：高風險工作使用你 **負擔得起的最佳模型**，日常聊天或摘要則使用較便宜的模型。 You can route models per agent and use sub-agents to
parallelize long tasks (each sub-agent consumes tokens). See [Models](/concepts/models) and
[Sub-agents](/tools/subagents).

強烈警告：較弱或過度量化的模型更容易受到提示注入與不安全行為的影響。 See [Security](/gateway/security).

More context: [Models](/concepts/models).

### Can I use selfhosted models llamacpp vLLM Ollama

是. If your local server exposes an OpenAI-compatible API, you can point a
custom provider at it. Ollama is supported directly and is the easiest path.

Security note: smaller or heavily quantized models are more vulnerable to prompt
injection. We strongly recommend **large models** for any bot that can use tools.
If you still want small models, enable sandboxing and strict tool allowlists.

Docs: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
[Model providers](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### How do I switch models without wiping my config

Use **model commands** or edit only the **model** fields. Avoid full config replaces.

Safe options:

- `/model` in chat (quick, per-session)
- `openclaw models set ...` (updates just model config)
- `openclaw configure --section model` (interactive)
- edit `agents.defaults.model` in `~/.openclaw/openclaw.json`

Avoid `config.apply` with a partial object unless you intend to replace the whole config.
If you did overwrite config, restore from backup or re-run `openclaw doctor` to repair.

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### What do OpenClaw, Flawd, and Krill use for models

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - see [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### How do I switch models on the fly without restarting

Use the `/model` command as a standalone message:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

You can list available models with `/model`, `/model list`, or `/model status`.

`/model` (and `/model list`) shows a compact, numbered picker. Select by number:

```
/model 3
```

You can also force a specific auth profile for the provider (per session):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Tip: `/model status` shows which agent is active, which `auth-profiles.json` file is being used, and which auth profile will be tried next.
It also shows the configured provider endpoint (`baseUrl`) and API mode (`api`) when available.

**How do I unpin a profile I set with profile**

Re-run `/model` **without** the `@profile` suffix:

```
/model anthropic/claude-opus-4-6
```

If you want to return to the default, pick it from `/model` (or send `/model <default provider/model>`).
Use `/model status` to confirm which auth profile is active.

### Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding

是. Set one as default and switch as needed:

- **Quick switch (per session):** `/model gpt-5.2` for daily tasks, `/model gpt-5.3-codex` for coding.
- **Default + switch:** set `agents.defaults.model.primary` to `openai/gpt-5.2`, then switch to `openai-codex/gpt-5.3-codex` when coding (or the other way around).
- **Sub-agents:** route coding tasks to sub-agents with a different default model.

See [Models](/concepts/models) and [Slash commands](/tools/slash-commands).

### Why do I see Model is not allowed and then no reply

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any
session overrides. Choosing a model that isn't in that list returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

That error is returned **instead of** a normal reply. Fix: add the model to
`agents.defaults.models`, remove the allowlist, or pick a model from `/model list`.

### 1. 為什麼我會看到 Unknown model minimaxMiniMaxM21

This means the **provider isn't configured** (no MiniMax provider config or auth
profile was found), so the model can't be resolved. 3. 這個偵測問題的修正在 **2026.1.12**（撰寫時尚未發布）。

4. 修正檢查清單：

1. 5. 升級到 **2026.1.12**（或從原始碼 `main` 分支執行），然後重新啟動 gateway。
2. 6. 確認 MiniMax 已設定（精靈或 JSON），或在 env/auth profiles 中存在 MiniMax API key，讓提供者能被注入。
3. 7. 使用精確的模型 ID（區分大小寫）：`minimax/MiniMax-M2.1` 或
      `minimax/MiniMax-M2.1-lightning`。
4. Run:

   ```bash
   openclaw models list
   ```

   8. 並從清單中選擇（或在聊天中使用 `/model list`）。

9) 請參閱 [MiniMax](/providers/minimax) 與 [Models](/concepts/models)。

### Can I use MiniMax as my default and OpenAI for complex tasks

是. 11. **將 MiniMax 設為預設**，需要時再 **依工作階段切換模型**。
Fallbacks are for **errors**, not "hard tasks," so use `/model` or a separate agent.

13. **選項 A：依工作階段切換**

```json5
14. {
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
15. /model gpt
```

**Option B: separate agents**

- Agent A default: MiniMax
- Agent B default: OpenAI
- 19. 依 agent 路由，或使用 `/agent` 來切換

20. 文件：[Models](/concepts/models)、[Multi-Agent Routing](/concepts/multi-agent)、[MiniMax](/providers/minimax)、[OpenAI](/providers/openai)。

### 21. opus、sonnet、gpt 是內建捷徑嗎

是. 22. OpenClaw 隨附一些預設簡寫（僅在模型存在於 `agents.defaults.models` 時才會套用）：

- `opus` → `anthropic/claude-opus-4-6`
- 24. `sonnet` → `anthropic/claude-sonnet-4-5`
- 25. `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- 28. `gemini-flash` → `google/gemini-3-flash-preview`

29. 如果你設定了同名的自訂別名，將以你的設定為準。

### 30. 我要如何定義／覆寫模型捷徑別名

Aliases come from `agents.defaults.models.<modelId>32. `.alias\`。 Example:

```json5
33. {
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

34. 接著 `/model sonnet`（或在支援時使用 `/<alias>`）會解析為該模型 ID。

### 35. 我要如何新增來自 OpenRouter 或 ZAI 等其他提供者的模型

36. OpenRouter（按 token 計費；多種模型）：

```json5
37. {
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

38. Z.AI（GLM 模型）：

```json5
39. {
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

如果你引用了某個供應商/模型，但缺少所需的供應商金鑰，將會在執行時得到驗證錯誤（例如 `No API key found for provider "zai"`）。

41. **新增 agent 後找不到提供者的 API key**

42. 這通常表示 **新的 agent** 有空的驗證儲存。 43. 驗證是以 agent 為單位，並
    儲存在：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

修正方式：

- 44. 執行 `openclaw agents add <id>`，並在精靈中設定驗證。
- 45. 或將主要 agent 的 `agentDir` 中的 `auth-profiles.json` 複製到新 agent 的 `agentDir`。

46. **不要** 在不同 agent 之間重用 `agentDir`；這會造成驗證／工作階段衝突。

## 47. 模型失敗切換與「All models failed」

### 48. 失敗切換如何運作

49. 失敗切換分兩個階段進行：

1. 50. **同一提供者內的驗證設定檔輪替**。
2. **模型後備切換** 到 `agents.defaults.model.fallbacks` 中的下一個模型。

對失敗的設定檔會套用冷卻時間（指數退避），因此即使供應商被限流或暫時失效，OpenClaw 仍能持續回應。

### 這個錯誤代表什麼意思

```
找不到設定檔 "anthropic:default" 的憑證
```

這表示系統嘗試使用驗證設定檔 ID `anthropic:default`，但在預期的驗證儲存區中找不到其憑證。

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
  - In remote mode, auth profiles live on the gateway machine, not your laptop.

### Why did it also try Google Gemini and fail

If your model config includes Google Gemini as a fallback (or you switched to a Gemini shorthand), OpenClaw will try it during model fallback. If you haven't configured Google credentials, you'll see `No API key found for provider "google"`.

Fix: either provide Google auth, or remove/avoid Google models in `agents.defaults.model.fallbacks` / aliases so fallback doesn't route there.

**LLM request rejected message thinking signature required google antigravity**

Cause: the session history contains **thinking blocks without signatures** (often from
an aborted/partial stream). Google Antigravity requires signatures for thinking blocks.

Fix: OpenClaw now strips unsigned thinking blocks for Google Antigravity Claude. If it still appears, start a **new session** or set `/thinking off` for that agent.

## Auth profiles: what they are and how to manage them

Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

### What is an auth profile

An auth profile is a named credential record (OAuth or API key) tied to a provider. Profiles live in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### What are typical profile IDs

OpenClaw uses provider-prefixed IDs like:

- `anthropic:default` (common when no email identity exists)
- `anthropic:<email>` for OAuth identities
- custom IDs you choose (e.g. `anthropic:work`)

### Can I control which auth profile is tried first

是. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

OpenClaw may temporarily skip a profile if it's in a short **cooldown** (rate limits/timeouts/auth failures) or a longer **disabled** state (billing/insufficient credits). To inspect this, run `openclaw models status --json` and check `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

You can also set a **per-agent** order override (stored in that agent's `auth-profiles.json`) via the CLI:

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

1. 要鎖定特定代理：

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### 3. OAuth 與 API 金鑰有什麼差別

OpenClaw supports both:

- **OAuth** often leverages subscription access (where applicable).
- **API keys** use pay-per-token billing.

The wizard explicitly supports Anthropic setup-token and OpenAI Codex OAuth and can store API keys for you.

## Gateway: ports, "already running", and remote mode

### What port does the Gateway use

`gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).

優先順序：

```
11. --port > OPENCLAW_GATEWAY_PORT > gateway.port > 預設 18789
```

### 12. 為什麼 openclaw gateway status 顯示 Runtime running 但 RPC probe failed

Because "running" is the **supervisor's** view (launchd/systemd/schtasks). The RPC probe is the CLI actually connecting to the gateway WebSocket and calling `status`.

15. 使用 `openclaw gateway status`，並信任以下這些行：

- 16. `Probe target:`（探測實際使用的 URL）
- 17. `Listening:`（實際綁定在該連接埠上的內容）
- `Last gateway error:` (common root cause when the process is alive but the port isn't listening)

### Why does openclaw gateway status show Config cli and Config service different

You're editing one config file while the service is running another (often a `--profile` / `OPENCLAW_STATE_DIR` mismatch).

修復:

```bash
21. openclaw gateway install --force
```

22. 從你希望服務使用的相同 `--profile` / 環境執行它。

### What does another gateway instance is already listening mean

24. OpenClaw 會在啟動時立即透過綁定 WebSocket 監聽器來強制執行執行期鎖（預設 `ws://127.0.0.1:18789`）。 If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` indicating another instance is already listening.

Fix: stop the other instance, free the port, or run with `openclaw gateway --port <port>`.

### 27. 我要如何以遠端模式執行 OpenClaw，讓客戶端連線到其他地方的 Gateway

28. 設定 `gateway.mode: "remote"` 並指向遠端 WebSocket URL，可選擇性設定 token/密碼：

```json5
29. {
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

注意事項：

- 30. 只有在 `gateway.mode` 為 `local`（或你傳入覆寫旗標）時，`openclaw gateway` 才會啟動。
- macOS 應用程式會監看設定檔，當這些值變更時即時切換模式。

### Control UI 顯示未授權或一直重新連線，現在該怎麼辦

33. 你的 gateway 啟用了驗證（`gateway.auth.*`），但 UI 沒有送出相符的 token/密碼。

34. 事實（來自程式碼）：

- 35. Control UI 會將 token 儲存在瀏覽器 localStorage 的鍵 `openclaw.control.settings.v1`。

修復:

- 最快方式：`openclaw dashboard`（會輸出並複製儀表板 URL，嘗試開啟；若為無頭環境會顯示 SSH 提示）。
- 37. 如果你還沒有 token：`openclaw doctor --generate-gateway-token`。
- 38. 若為遠端，先建立通道：`ssh -N -L 18789:127.0.0.1:18789 user@host`，然後開啟 `http://127.0.0.1:18789/`。
- 39. 在 gateway 主機上設定 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 40. 在 Control UI 設定中貼上相同的 token。
- 14. 還是卡住？ 42. 執行 `openclaw status --all`，並依照 [Troubleshooting](/gateway/troubleshooting)。 43. 請參閱 [Dashboard](/web/dashboard) 以了解驗證細節。

### 17. 我把 gateway bind 設為 tailnet，但無法綁定，什麼都沒有在監聽

45. `tailnet` 綁定會從你的網路介面中選擇一個 Tailscale IP（100.64.0.0/10）。 19. 如果該機器未加入 Tailscale（或介面已停用），就沒有可綁定的位址。

修復:

- 47. 在該主機上啟動 Tailscale（使其擁有 100.x 位址），或
- 48. 切換為 `gateway.bind: "loopback"` / `"lan"`。

49. 注意：`tailnet` 是明確指定的。 23. `auto` 會偏好 loopback；當你想要僅限 tailnet 綁定時，請使用 `gateway.bind: "tailnet"`。

### Can I run multiple Gateways on the same host

25. 通常不行——一個 Gateway 就能執行多個訊息通道與代理。 Use multiple Gateways only when you need redundancy (ex: rescue bot) or hard isolation.

27. 可以，但你必須做隔離：

- `OPENCLAW_CONFIG_PATH` (per-instance config)
- `OPENCLAW_STATE_DIR` (per-instance state)
- `agents.defaults.workspace` (workspace isolation)
- `gateway.port` (unique ports)

Quick setup (recommended):

- 33. 每個實例使用 `openclaw --profile <name> …`（會自動建立 `~/.openclaw-<name>`）。
- Set a unique `gateway.port` in each profile config (or pass `--port` for manual runs).
- 35. 安裝每個設定檔的服務：`openclaw --profile <name> gateway install`。

Profiles also suffix service names (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Full guide: [Multiple gateways](/gateway/multiple-gateways).

### What does invalid handshake code 1008 mean

The Gateway is a **WebSocket server**, and it expects the very first message to
be a `connect` frame. 41. 必須是 `connect` frame。若收到其他內容，會以 **code 1008**（政策違反）關閉連線。

42. 常見原因：

- You opened the **HTTP** URL in a browser (`http://...`) instead of a WS client.
- 44. 你使用了錯誤的連接埠或路徑。
- A proxy or tunnel stripped auth headers or sent a non-Gateway request.

46. 快速修正：

1. Use the WS URL: `ws://<host>:18789` (or `wss://...` if HTTPS).
2. Don't open the WS port in a normal browser tab.
3. 49. 若啟用了驗證，請在 `connect` frame 中包含 token/密碼。

If you're using the CLI or TUI, the URL should look like:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Protocol details: [Gateway protocol](/gateway/protocol).

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
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

See [Troubleshooting](/gateway/troubleshooting#log-locations) for more.

### How do I startstoprestart the Gateway service

Use the gateway helpers:

```bash
openclaw gateway status
openclaw gateway restart
```

If you run the gateway manually, `openclaw gateway --force` can reclaim the port. See [Gateway](/gateway).

### I closed my terminal on Windows how do I restart OpenClaw

There are **two Windows install modes**:

**1) WSL2 (recommended):** the Gateway runs inside Linux.

Open PowerShell, enter WSL, then restart:

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

如果你從未安裝過服務，請以前景模式啟動：

```bash
openclaw gateway run
```

**2) 原生 Windows（不建議）：** Gateway 直接在 Windows 中執行。

打開 PowerShell 並執行：

```powershell
openclaw gateway status
openclaw gateway restart
```

If you run it manually (no service), use:

```powershell
openclaw gateway run
```

文件： [Windows (WSL2)](/platforms/windows), [Gateway 服務操作手冊](/gateway)。

### The Gateway is up but replies never arrive What should I check

先做一次快速健康檢查：

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

常見原因：

- 模型驗證未在 **gateway 主機** 上載入（檢查 `models status`）。
- Channel 配對 / 允許清單阻擋回覆（檢查 channel 設定與日誌）。
- WebChat / Dashboard 在沒有正確 token 的情況下開啟。

If you are remote, confirm the tunnel/Tailscale connection is up and that the
Gateway WebSocket is reachable.

文件： [Channels](/channels), [疑難排解](/gateway/troubleshooting), [遠端存取](/gateway/remote)。

### 無故與 gateway 斷線 現在該怎麼辦

This usually means the UI lost the WebSocket connection. 檢查：

1. Is the Gateway running? `openclaw gateway status`
2. Gateway 是否健康？ `openclaw status`
3. UI 是否使用正確的 token？ `openclaw dashboard`
4. 如果是遠端連線，tunnel / Tailscale 連結是否正常？

Then tail logs:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands fails with network errors What should I check

先從日誌與 channel 狀態開始：

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

如果你在 VPS 上或位於代理後方，請確認允許對外 HTTPS，且 DNS 正常運作。
如果 Gateway 是遠端的，請確保你查看的是 Gateway 主機上的日誌。

文件： [Telegram](/channels/telegram), [Channel 疑難排解](/channels/troubleshooting)。

### TUI 沒有顯示任何輸出 我該檢查什麼

首先確認 Gateway 可連線，且 agent 可以執行：

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

在 TUI 中，使用 `/status` 查看目前狀態。 如果你預期在聊天
channel 中收到回覆，請確保已啟用傳送（`/deliver on`）。

文件： [TUI](/web/tui), [斜線指令](/tools/slash-commands)。

### 我要如何完全停止再啟動 Gateway

如果你安裝了服務：

```bash
openclaw gateway stop
openclaw gateway start
```

這會停止 / 啟動 **受監管的服務**（macOS 上的 launchd、Linux 上的 systemd）。
當 Gateway 以背景 daemon 方式執行時使用。

如果你以前景模式執行，使用 Ctrl-C 停止，然後：

```bash
openclaw gateway run
```

文件： [Gateway 服務操作手冊](/gateway)。

### ELI5 openclaw gateway restart 與 openclaw gateway 的差別

- `openclaw gateway restart`：重新啟動 **背景服務**（launchd／systemd）。
- `openclaw gateway`：在此終端機工作階段 **以前景模式** 執行 gateway。

如果你安裝了服務，請使用 gateway 相關指令。 當你需要一次性的前景執行時，使用 `openclaw gateway`。

### 當某些事情失敗時，最快取得更多詳細資訊的方法是什麼

1. 使用 `--verbose` 啟動 Gateway 以取得更多主控台細節。 Then inspect the log file for channel auth, model routing, and RPC errors.

## 3. 媒體與附件

### 4. 我的技能產生了一個 imagePDF，但什麼都沒有送出

5. 代理程式送出的外部附件必須包含一行 `MEDIA:<path-or-url>`（需獨立成行）。 6. 請參閱 [OpenClaw assistant setup](/start/openclaw) 與 [Agent send](/tools/agent-send)。

7. CLI 傳送：

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

另外請檢查：

- 10. 目標頻道支援外傳媒體，且未被允許清單（allowlists）封鎖。
- 11. 檔案大小在供應商的限制內（圖片會被調整至最大 2048px）。

12. 請參閱 [Images](/nodes/images)。

## 安全性與存取控制

### 將 OpenClaw 暴露於外部私訊是否安全？

15. 將入站私訊視為不受信任的輸入。 16. 預設值的設計是為了降低風險：

- 在支援私訊的通道上，預設行為是**配對（pairing）**：
  - 未知的傳送者會收到一組配對碼；機器人不會處理其訊息。
  - 19. 透過以下指令核准：`openclaw pairing approve <channel> <code>`
  - 20. 待處理的請求每個頻道上限為 **3 個**；若未收到代碼，請檢查 `openclaw pairing list <channel>`。
- 21. 公開開放私訊需要明確的選擇加入（`dmPolicy: "open"` 並設定允許清單 `"*"`）。

22. 執行 `openclaw doctor` 以揭示有風險的私訊政策。

### 23. 提示注入（prompt injection）是否只對公開機器人構成風險

否. 提示注入關乎的是**不受信任的內容**，而不只是誰能私訊機器人。
25. 如果你的助理會讀取外部內容（網路搜尋/擷取、瀏覽器頁面、電子郵件， 26. 文件、附件、貼上的日誌），那些內容可能包含試圖

最大的風險出現在啟用工具時：模型可能被誘導外洩上下文，或代表你呼叫工具。 28. 即使 **只有你是唯一的傳送者**，這種情況也可能發生。

- 使用唯讀或停用工具的「reader」代理來摘要不受信任的內容。
- 30. 外洩上下文或代表你呼叫工具。
- 31. 透過以下方式降低影響範圍：

32. 使用唯讀或停用工具的「reader」代理程式來摘要不受信任的內容

### 33. 對啟用工具的代理程式關閉 `web_search` / `web_fetch` / `browser`

34. 沙箱化以及嚴格的工具允許清單 將機器人與獨立的帳號與電話號碼隔離，能在出問題時降低影響範圍。 36. 我的機器人是否應該擁有自己的電子郵件、GitHub 帳號或電話號碼

37. 是的，對大多數設定而言如此。 38. 使用獨立的帳號與電話號碼來隔離機器人

39. 若發生問題，可降低影響範圍。

### 40. 這也讓你更容易輪替

41. 憑證或撤銷存取權，而不影響你的個人帳號。 42. 從小規模開始。

- 43. 只授予你實際需要的工具與帳號存取權，並在需要時再
- 44. 擴充。
- 讓它先起草，然後在**送出前核准**。

若要實驗，請在專用帳號上進行，並保持其隔離。 1. 請參閱
[Security](/gateway/security)。

### 2. 我可以用較便宜的模型來處理個人助理任務嗎

3. 可以，**如果**該代理僅用於聊天，且輸入是可信的。 4. 較小的等級
   更容易受到指令劫持的影響，因此請避免將其用於啟用工具的代理
   或在讀取不受信任的內容時使用。 5. 如果你必須使用較小的模型，請鎖定
   工具並在沙箱中運行。 6. 請參閱 [Security](/gateway/security)。

### 7. 我在 Telegram 中執行了 start，但沒有收到配對碼

8. 配對碼**僅**在未知的發送者向機器人傳訊，且
   `dmPolicy: "pairing"` 已啟用時才會發送。 9. 單獨輸入 `/start` 不會產生配對碼。

10. 檢查待處理的請求：

```bash
openclaw pairing list telegram
```

If you want immediate access, allowlist your sender id or set `dmPolicy: "open"`
for that account.

### 12. WhatsApp 會傳訊給我的聯絡人嗎？配對是如何運作的

否. Default WhatsApp DM policy is **pairing**. 14. 未知的發送者只會收到配對碼，他們的訊息**不會被處理**。 15. OpenClaw 只會回覆它收到的聊天，或你明確觸發的發送。

16. 以以下方式核准配對：

```bash
17. openclaw pairing approve whatsapp <code>
```

18. 列出待處理的請求：

```bash
openclaw pairing list whatsapp
```

Wizard phone number prompt: it's used to set your **allowlist/owner** so your own DMs are permitted. 20. 它不會用於自動發送。 21. 如果你在個人 WhatsApp 號碼上運行，請使用該號碼並啟用 `channels.whatsapp.selfChatMode`。

## 22. 聊天指令、終止任務，以及「它停不下來」

### 23. 我要如何阻止內部系統訊息顯示在聊天中

24. 大多數內部或工具訊息只會在該工作階段啟用 **verbose** 或 **reasoning** 時顯示。

Fix in the chat where you see it:

```
/verbose off
/reasoning off
```

If it is still noisy, check the session settings in the Control UI and set verbose
to **inherit**. Also confirm you are not using a bot profile with `verboseDefault` set
to `on` in config.

29. 文件：[Thinking and verbose](/tools/thinking)，[Security](/gateway/security#reasoning--verbose-output-in-groups)。

### 30. 我要如何停止或取消正在執行的任務

31. 將以下任一項**作為獨立訊息**發送（不要加斜線）：

```
32. stop
abort
esc
wait
exit
interrupt
```

33. 這些是中止觸發詞（不是斜線指令）。

34. 對於背景程序（來自 exec 工具），你可以要求代理執行：

```
35. process action:kill sessionId:XXX
```

36. 斜線指令總覽：請參閱 [Slash commands](/tools/slash-commands)。

37. 大多數指令必須以 `/` 開頭並作為**獨立**訊息發送，但少數捷徑（如 `/status`）也可在行內使用，僅限於允許清單中的發送者。

### 38. 我要如何從 Telegram 發送 Discord 訊息？跨情境傳訊被拒絕

39. OpenClaw 預設會封鎖**跨提供者**傳訊。 40. 如果工具呼叫綁定到 Telegram，除非你明確允許，否則它不會發送到 Discord。

41. 為代理啟用跨提供者傳訊：

```json5
42. {
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

43. 編輯設定後重新啟動 gateway。 44. 如果你只想為單一
    代理啟用，請改在 `agents.list[].tools.message` 下設定。

### 45. 為什麼感覺機器人會忽略連續快速發送的訊息

46. 佇列模式控制新訊息如何與正在執行的任務互動。 Use `/queue` to change modes:

- 48. `steer` - 新訊息會重新導向目前的任務
- 49. `followup` - 一次只執行一則訊息
- 50. `collect` - 將訊息批次收集後一次回覆（預設）
- `steer-backlog` - 先進行 steer，然後處理積壓項目
- `interrupt` - 中止目前執行並重新開始

你可以為後續模式新增選項，例如 `debounce:2s cap:25 drop:summarize`。

## 回答截圖／聊天紀錄中的**確切問題**

**Q:「使用 API key 時，Anthropic 的預設模型是什麼？」**

**A:** 在 OpenClaw 中，憑證與模型選擇是分開的。 設定 `ANTHROPIC_API_KEY`（或在 auth profiles 中儲存 Anthropic API key）只會啟用驗證，但實際的預設模型取決於你在 `agents.defaults.model.primary` 中的設定（例如 `anthropic/claude-sonnet-4-5` 或 `anthropic/claude-opus-4-6`）。 如果你看到 `No credentials found for profile "anthropic:default"`，表示 Gateway 在執行中的代理所預期的 `auth-profiles.json` 中找不到 Anthropic 憑證。

---

還是卡住了？ 6. 到 [Discord](https://discord.com/invite/clawd) 詢問，或開啟一個 [GitHub discussion](https://github.com/openclaw/openclaw/discussions)。
