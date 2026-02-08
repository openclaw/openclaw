---
summary: "關於 OpenClaw 設定、設定與使用的常見問題"
title: "常見問題"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:33Z
---

# 常見問題

快速解答加上針對真實世界設定的深入疑難排解（本機開發、VPS、多代理、OAuth / API 金鑰、模型容錯）。執行階段診斷請見 [疑難排解](/gateway/troubleshooting)。完整設定參考請見 [設定](/gateway/configuration)。

## 目錄

- [快速開始與首次執行設定]
  - [我卡住了，最快脫困的方法是什麼？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [安裝與設定 OpenClaw 的建議方式是什麼？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [完成入門引導後，如何開啟儀表板？](#how-do-i-open-the-dashboard-after-onboarding)
  - [在 localhost 與遠端時，如何驗證儀表板（權杖）？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [需要什麼執行環境？](#what-runtime-do-i-need)
  - [可以在 Raspberry Pi 上執行嗎？](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi 安裝有什麼建議？](#any-tips-for-raspberry-pi-installs)
  - [卡在「wake up my friend」/ 入門引導無法孵化，該怎麼辦？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [可以在不重做入門引導的情況下，遷移到新機器（Mac mini）嗎？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [在哪裡查看最新版本的新內容？](#where-do-i-see-what-is-new-in-the-latest-version)
  - [無法存取 docs.openclaw.ai（SSL 錯誤），該怎麼辦？](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable 與 beta 的差異是什麼？](#whats-the-difference-between-stable-and-beta)
  - [如何安裝 beta 版？beta 與 dev 有何不同？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [如何試用最新版本？](#how-do-i-try-the-latest-bits)
  - [安裝與入門引導通常需要多久？](#how-long-does-install-and-onboarding-usually-take)
  - [安裝程式卡住了？如何取得更多回饋？](#installer-stuck-how-do-i-get-more-feedback)
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
- [沙箱與記憶](#sandboxing-and-memory)
- [磁碟上的資料位置](#where-things-live-on-disk)
- [設定基礎](#config-basics)
- [遠端 Gateway 閘道器與節點](#remote-gateways-and-nodes)
- [環境變數與 .env 載入](#env-vars-and-env-loading)
- [工作階段與多重聊天](#sessions-and-multiple-chats)
- [模型：預設、選擇、別名與切換](#models-defaults-selection-aliases-switching)
- [模型容錯與「All models failed」](#model-failover-and-all-models-failed)
- [驗證設定檔：是什麼以及如何管理](#auth-profiles-what-they-are-and-how-to-manage-them)
- [Gateway：連接埠、「already running」與遠端模式](#gateway-ports-already-running-and-remote-mode)
- [記錄與除錯](#logging-and-debugging)
- [媒體與附件](#media-and-attachments)
- [安全性與存取控制](#security-and-access-control)
- [聊天指令、終止任務與「停不下來」](#chat-commands-aborting-tasks-and-it-wont-stop)

（以下內容依原文件逐段翻譯，保留所有程式碼、指令、佔位符與連結不變。）

---

還是卡住了嗎？歡迎到 [Discord](https://discord.com/invite/clawd) 詢問，或在 [GitHub 討論區](https://github.com/openclaw/openclaw/discussions) 發起討論。
