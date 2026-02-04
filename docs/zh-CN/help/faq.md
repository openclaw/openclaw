---
summary: 关于 OpenClaw 安装、配置和使用的常见问题
title: 常见问题
x-i18n:
  generated_at: "2026-02-01T21:32:04Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 5a611f2fda3325b1c7a9ec518616d87c78be41e2bfbe86244ae4f48af3815a26
  source_path: help/faq.md
  workflow: 15
---

# 常见问题

快速解答及针对实际部署场景（本地开发、VPS、多智能体、OAuth/API 密钥、模型故障转移）的深入故障排除。运行时诊断请参阅[故障排除](/gateway/troubleshooting)。完整配置参考请参阅[配置](/gateway/configuration)。

## 目录

- [快速开始与首次运行设置](#quick-start-and-firstrun-setup)
  - [我卡住了，最快的排障方法是什么？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [安装和设置 OpenClaw 的推荐方式是什么？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [新手引导后如何打开仪表板？](#how-do-i-open-the-dashboard-after-onboarding)
  - [如何在本地和远程环境中验证仪表板（令牌）？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [我需要什么运行时？](#what-runtime-do-i-need)
  - [能在 Raspberry Pi 上运行吗？](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi 安装有什么建议？](#any-tips-for-raspberry-pi-installs)
  - [卡在 "wake up my friend" / 新手引导无法启动，怎么办？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [能否将我的设置迁移到新机器（Mac mini）而不重新进行新手引导？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [在哪里查看最新版本的更新内容？](#where-do-i-see-whats-new-in-the-latest-version)
  - [无法访问 docs.openclaw.ai（SSL 错误），怎么办？](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable 和 beta 有什么区别？](#whats-the-difference-between-stable-and-beta)
- [如何安装 beta 版本，beta 和 dev 有什么区别？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [如何试用最新代码？](#how-do-i-try-the-latest-bits)
  - [安装和新手引导通常需要多长时间？](#how-long-does-install-and-onboarding-usually-take)
  - [安装程序卡住了？如何获取更多反馈？](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows 安装提示找不到 git 或无法识别 openclaw](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [文档没有解答我的问题——如何获得更好的答案？](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [如何在 Linux 上安装 OpenClaw？](#how-do-i-install-openclaw-on-linux)
  - [如何在 VPS 上安装 OpenClaw？](#how-do-i-install-openclaw-on-a-vps)
  - [云/VPS 安装指南在哪里？](#where-are-the-cloudvps-install-guides)
  - [可以让 OpenClaw 自行更新吗？](#can-i-ask-openclaw-to-update-itself)
  - [新手引导向导具体做了什么？](#what-does-the-onboarding-wizard-actually-do)
  - [运行 OpenClaw 需要 Claude 或 OpenAI 订阅吗？](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [能否使用 Claude Max 订阅而不需要 API 密钥？](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic "setup-token" 认证如何工作？](#how-does-anthropic-setuptoken-auth-work)
  - [在哪里获取 Anthropic setup-token？](#where-do-i-find-an-anthropic-setuptoken)
  - [是否支持 Claude 订阅认证（Claude Code OAuth）？](#do-you-support-claude-subscription-auth-claude-code-oauth)
  - [为什么我看到 `HTTP 429: rate_limit_error`（来自 Anthropic）？](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [支持 AWS Bedrock 吗？](#is-aws-bedrock-supported)
  - [Codex 认证如何工作？](#how-does-codex-auth-work)
  - [是否支持 OpenAI 订阅认证（Codex OAuth）？](#do-you-support-openai-subscription-auth-codex-oauth)
  - [如何设置 Gemini CLI OAuth？](#how-do-i-set-up-gemini-cli-oauth)
  - [本地模型适合日常聊天吗？](#is-a-local-model-ok-for-casual-chats)
  - [如何将托管模型流量限制在特定区域？](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [我必须购买 Mac Mini 才能安装吗？](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage 支持需要 Mac mini 吗？](#do-i-need-a-mac-mini-for-imessage-support)
  - [如果我买了 Mac mini 运行 OpenClaw，能连接到我的 MacBook Pro 吗？](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [可以使用 Bun 吗？](#can-i-use-bun)
  - [Telegram：`allowFrom` 填什么？](#telegram-what-goes-in-allowfrom)
  - [多人能否使用同一个 WhatsApp 号码配合不同的 OpenClaw 实例？](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [能否同时运行一个“快速聊天”智能体和一个“用 Opus 编程”的智能体？](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew 在 Linux 上可用吗？](#does-homebrew-work-on-linux)
  - [可编辑（git）安装和 npm 安装有什么区别？](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [之后可以在 npm 和 git 安装之间切换吗？](#can-i-switch-between-npm-and-git-installs-later)
  - [应该在笔记本电脑还是 VPS 上运行 Gateway 网关？](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [在专用机器上运行 OpenClaw 有多重要？](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [VPS 的最低要求和推荐操作系统是什么？](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [可以在虚拟机中运行 OpenClaw 吗？有什么要求？](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [什么是 OpenClaw？](#what-is-openclaw)
  - [用一段话描述 OpenClaw？](#what-is-openclaw-in-one-paragraph)
  - [价值主张是什么？](#whats-the-value-proposition)
  - [刚设置好，应该先做什么？](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw 日常最常用的五个场景是什么？](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw 能否帮助 SaaS 进行获客、外联、广告和博客？](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [相比 Claude Code，在 Web 开发方面有什么优势？](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills 与自动化](#skills-and-automation)
  - [如何自定义 Skills 而不弄脏仓库？](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [可以从自定义文件夹加载 Skills 吗？](#can-i-load-skills-from-a-custom-folder)
  - [如何为不同任务使用不同模型？](#how-can-i-use-different-models-for-different-tasks)
  - [机器人在执行繁重工作时卡住了，如何卸载任务？](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [定时任务或提醒没有触发，应该检查什么？](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [如何在 Linux 上安装 Skills？](#how-do-i-install-skills-on-linux)
  - [OpenClaw 能否按计划或在后台持续运行任务？](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [能否从 Linux 运行仅限 Apple/macOS 的 Skills？](#can-i-run-applemacosonly-skills-from-linux)
  - [有 Notion 或 HeyGen 集成吗？](#do-you-have-a-notion-or-heygen-integration)
  - [如何安装用于浏览器接管的 Chrome 扩展？](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [沙箱与记忆](#sandboxing-and-memory)
  - [有专门的沙箱文档吗？](#is-there-a-dedicated-sandboxing-doc)
  - [如何将主机文件夹绑定到沙箱中？](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [记忆是如何工作的？](#how-does-memory-work)
  - [记忆总是遗忘，如何让它持久保存？](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [记忆是否永久保留？有什么限制？](#does-memory-persist-forever-what-are-the-limits)
  - [语义记忆搜索需要 OpenAI API 密钥吗？](#does-semantic-memory-search-require-an-openai-api-key)
- [磁盘上的文件位置](#where-things-live-on-disk)
  - [OpenClaw 使用的所有数据都保存在本地吗？](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw 将数据存储在哪里？](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md 应该放在哪里？](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [推荐的备份策略是什么？](#whats-the-recommended-backup-strategy)
  - [如何完全卸载 OpenClaw？](#how-do-i-completely-uninstall-openclaw)
  - [智能体可以在工作区外工作吗？](#can-agents-work-outside-the-workspace)
  - [我处于远程模式——会话存储在哪里？](#im-in-remote-mode-where-is-the-session-store)
- [配置基础](#config-basics)
  - [配置文件是什么格式？在哪里？](#what-format-is-the-config-where-is-it)
  - [我设置了 `gateway.bind: "lan"`（或 `"tailnet"`），现在什么都监听不了 / UI 显示未授权](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [为什么现在在 localhost 也需要令牌？](#why-do-i-need-a-token-on-localhost-now)
  - [更改配置后需要重启吗？](#do-i-have-to-restart-after-changing-config)
  - [如何启用网络搜索（和网页抓取）？](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply 清空了我的配置，如何恢复和避免？](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [如何运行一个中心 Gateway 网关配合跨设备的专用工作节点？](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [OpenClaw 浏览器可以无头运行吗？](#can-the-openclaw-browser-run-headless)
  - [如何使用 Brave 进行浏览器控制？](#how-do-i-use-brave-for-browser-control)
- [远程 Gateway 网关与节点](#remote-gateways-nodes)
  - [命令如何在 Telegram、Gateway 网关和节点之间传播？](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [如果 Gateway 网关托管在远程，我的智能体如何访问我的电脑？](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale 已连接但收不到回复，怎么办？](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [两个 OpenClaw 实例（本地 + VPS）可以互相通信吗？](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [多个智能体需要独立的 VPS 吗？](#do-i-need-separate-vpses-for-multiple-agents)
  - [在个人笔记本电脑上使用节点而不是从 VPS SSH 有什么好处？](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [节点会运行 Gateway 网关服务吗？](#do-nodes-run-a-gateway-service)
  - [有 API / RPC 方式来应用配置吗？](#is-there-an-api-rpc-way-to-apply-config)
  - [首次安装的最小“合理”配置是什么？](#whats-a-minimal-sane-config-for-a-first-install)
  - [如何在 VPS 上设置 Tailscale 并从 Mac 连接？](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [如何将 Mac 节点连接到远程 Gateway 网关（Tailscale Serve）？](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [应该在第二台笔记本上安装还是只添加一个节点？](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [环境变量和 .env 加载](#env-vars-and-env-loading)
  - [OpenClaw 如何加载环境变量？](#how-does-openclaw-load-environment-variables)
  - [“我通过服务启动了 Gateway 网关，但环境变量消失了。”怎么办？](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [我设置了 `COPILOT_GITHUB_TOKEN`，但 models status 显示"Shell env: off"，为什么？](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [会话与多聊天](#sessions-multiple-chats)
  - [如何开始一个新对话？](#how-do-i-start-a-fresh-conversation)
  - [如果我从不发送 `/new`，会话会自动重置吗？](#do-sessions-reset-automatically-if-i-never-send-new)
  - [能否创建一个 OpenClaw 实例团队——一个 CEO 和多个智能体？](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [为什么上下文在任务中途被截断了？如何防止？](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [如何完全重置 OpenClaw 但保留安装？](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [我遇到了"context too large"错误——如何重置或压缩？](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [为什么我看到"LLM request rejected: messages.N.content.X.tool_use.input: Field required"？](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [为什么每 30 分钟收到一次心跳消息？](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [需要在 WhatsApp 群组中添加“机器人账号”吗？](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [如何获取 WhatsApp 群组的 JID？](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [为什么 OpenClaw 不在群组中回复？](#why-doesnt-openclaw-reply-in-a-group)
  - [群组/线程与私聊共享上下文吗？](#do-groupsthreads-share-context-with-dms)
  - [可以创建多少个工作区和智能体？](#how-many-workspaces-and-agents-can-i-create)
  - [可以同时运行多个机器人或聊天（Slack）吗？应该如何设置？](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [模型：默认值、选择、别名、切换](#models-defaults-selection-aliases-switching)
  - [什么是“默认模型”？](#what-is-the-default-model)
  - [推荐什么模型？](#what-model-do-you-recommend)
  - [如何在不清空配置的情况下切换模型？](#how-do-i-switch-models-without-wiping-my-config)
  - [可以使用自托管模型（llama.cpp、vLLM、Ollama）吗？](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw、Flawd 和 Krill 使用什么模型？](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [如何在运行中切换模型（无需重启）？](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [能否日常任务用 GPT 5.2，编程用 Codex 5.2？](#can-i-use-gpt-52-for-daily-tasks-and-codex-52-for-coding)
  - [为什么我看到"Model … is not allowed"然后没有回复？](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [为什么我看到"Unknown model: minimax/MiniMax-M2.1"？](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [能否将 MiniMax 设为默认，复杂任务用 OpenAI？](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt 是内置快捷方式吗？](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [如何定义/覆盖模型快捷方式（别名）？](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [如何添加其他提供商（如 OpenRouter 或 Z.AI）的模型？](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [模型故障转移与"All models failed"](#model-failover-and-all-models-failed)
  - [故障转移是如何工作的？](#how-does-failover-work)
  - [这个错误是什么意思？](#what-does-this-error-mean)
  - [`No credentials found for profile "anthropic:default"` 的修复清单](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [为什么还尝试了 Google Gemini 并且失败了？](#why-did-it-also-try-google-gemini-and-fail)
- [认证配置文件：概念和管理方式](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [什么是认证配置文件？](#what-is-an-auth-profile)
  - [典型的配置文件 ID 有哪些？](#what-are-typical-profile-ids)
  - [可以控制首先尝试哪个认证配置文件吗？](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth 与 API 密钥：有什么区别？](#oauth-vs-api-key-whats-the-difference)
- [Gateway 网关：端口、“已在运行”和远程模式](#gateway-ports-already-running-and-remote-mode)
  - [Gateway 网关使用什么端口？](#what-port-does-the-gateway-use)
  - [为什么 `openclaw gateway status` 显示 `Runtime: running` 但 `RPC probe: failed`？](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [为什么 `openclaw gateway status` 显示 `Config (cli)` 和 `Config (service)` 不同？](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - ["another gateway instance is already listening"是什么意思？](#what-does-another-gateway-instance-is-already-listening-mean)
  - [如何以远程模式运行 OpenClaw（客户端连接到其他位置的 Gateway 网关）？](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [控制 UI 显示"unauthorized"（或持续重连），怎么办？](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [我设置了 `gateway.bind: "tailnet"` 但无法绑定 / 什么都没监听](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [可以在同一主机上运行多个 Gateway 网关吗？](#can-i-run-multiple-gateways-on-the-same-host)
  - ["invalid handshake" / code 1008 是什么意思？](#what-does-invalid-handshake-code-1008-mean)
- [日志与调试](#logging-and-debugging)
  - [日志在哪里？](#where-are-logs)
  - [如何启动/停止/重启 Gateway 网关服务？](#how-do-i-startstoprestart-the-gateway-service)
  - [我在 Windows 上关闭了终端——如何重启 OpenClaw？](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway 网关已启动但回复始终不到达，应该检查什么？](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason"——怎么办？](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands 因网络错误失败，应该检查什么？](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI 没有输出，应该检查什么？](#tui-shows-no-output-what-should-i-check)
  - [如何完全停止然后启动 Gateway 网关？](#how-do-i-completely-stop-then-start-the-gateway)
  - [通俗解释：`openclaw gateway restart` 与 `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [出现故障时获取更多详情的最快方法是什么？](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [媒体与附件](#media-attachments)
  - [我的 Skills 生成了图片/PDF，但什么都没发送](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [安全与访问控制](#security-and-access-control)
  - [将 OpenClaw 暴露给入站私信安全吗？](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [提示注入只对公开机器人有影响吗？](#is-prompt-injection-only-a-concern-for-public-bots)
  - [我的机器人应该有自己的邮箱、GitHub 账户或电话号码吗？](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [我能让它自主管理我的短信吗？这安全吗？](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [个人助理任务可以使用更便宜的模型吗？](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [我在 Telegram 中运行了 `/start` 但没收到配对码](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp：会给我的联系人发消息吗？配对如何工作？](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [聊天命令、中止任务和“停不下来”](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [如何阻止内部系统消息显示在聊天中？](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [如何停止/取消正在运行的任务？](#how-do-i-stopcancel-a-running-task)
  - [如何从 Telegram 发送 Discord 消息？（"Cross-context messaging denied"）](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [为什么感觉机器人“忽略”了快速连发的消息？](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 出问题后的最初六十秒

1. **快速状态（首先检查）**

   ```bash
   openclaw status
   ```

   快速本地摘要：操作系统 + 更新、Gateway 网关/服务可达性、智能体/会话、提供商配置 + 运行时问题（Gateway 网关可达时）。

2. **可粘贴的报告（可安全分享）**

   ```bash
   openclaw status --all
   ```

   只读诊断，附带日志尾部（令牌已脱敏）。

3. **守护进程 + 端口状态**

   ```bash
   openclaw gateway status
   ```

   显示 supervisor 运行状态与 RPC 可达性、探测目标 URL，以及服务可能使用的配置。

4. **深度探测**

   ```bash
   openclaw status --deep
   ```

   运行 Gateway 网关健康检查 + 提供商探测（需要可达的 Gateway 网关）。参阅[健康检查](/gateway/health)。

5. **跟踪最新日志**

   ```bash
   openclaw logs --follow
   ```

   如果 RPC 不可用，回退到：

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   文件日志与服务日志是分开的；参阅[日志](/logging)和[故障排除](/gateway/troubleshooting)。

6. **运行 doctor（修复）**

   ```bash
   openclaw doctor
   ```

   修复/迁移配置/状态 + 运行健康检查。参阅 [Doctor](/gateway/doctor)。

7. **Gateway 网关快照**
   ```bash
   openclaw health --json
   openclaw health --verbose   # 出错时显示目标 URL + 配置路径
   ```
   向运行中的 Gateway 网关请求完整快照（仅 WS）。参阅[健康检查](/gateway/health)。

## 快速开始与首次运行设置

### 我卡住了，最快的排障方法是什么

使用能**看到你机器**的本地 AI 智能体。这比在 Discord 上提问有效得多，因为大多数“卡住了”的情况都是**本地配置或环境问题**，远程帮助者无法检查。

- **Claude Code**：https://www.anthropic.com/claude-code/
- **OpenAI Codex**：https://openai.com/codex/

这些工具可以读取仓库、运行命令、检查日志，并帮助修复你的机器级别设置（PATH、服务、权限、认证文件）。通过可编辑（git）安装提供**完整源代码**：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

这会从 **git checkout** 安装 OpenClaw，这样智能体可以读取代码 + 文档，并推理你正在运行的确切版本。你可以随时通过不带 `--install-method git` 重新运行安装程序切回稳定版。

提示：要求智能体**计划并监督**修复（逐步进行），然后只执行必要的命令。这样改动较小，更容易审查。

如果你发现了真正的 bug 或修复方案，请提交 GitHub issue 或发送 PR：
https://github.com/openclaw/openclaw/issues
https://github.com/openclaw/openclaw/pulls

从以下命令开始（在寻求帮助时分享输出）：

```bash
openclaw status
openclaw models status
openclaw doctor
```

它们的作用：

- `openclaw status`：Gateway 网关/智能体健康状况 + 基本配置的快速快照。
- `openclaw models status`：检查提供商认证 + 模型可用性。
- `openclaw doctor`：验证并修复常见的配置/状态问题。

其他有用的 CLI 检查：`openclaw status --all`、`openclaw logs --follow`、
`openclaw gateway status`、`openclaw health --verbose`。

快速调试流程：[出问题后的最初六十秒](#first-60-seconds-if-somethings-broken)。
安装文档：[安装](/install)、[安装程序标志](/install/installer)、[更新](/install/updating)。

### 安装和设置 OpenClaw 的推荐方式是什么

仓库推荐从源码运行并使用新手引导向导：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

向导还可以自动构建 UI 资源。新手引导后，通常在端口 **18789** 上运行 Gateway 网关。

从源码安装（贡献者/开发者）：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # 首次运行时自动安装 UI 依赖
openclaw onboard
```

如果你还没有全局安装，通过 `pnpm openclaw onboard` 运行。

### 新手引导后如何打开仪表板

向导现在会在新手引导完成后立即使用带令牌的仪表板 URL 打开浏览器，并在摘要中打印完整链接（带令牌）。保持该标签页打开；如果没有自动启动，请在同一台机器上复制/粘贴打印的 URL。令牌保持在本地主机上——不会从浏览器获取任何内容。

### 如何在本地和远程环境中验证仪表板令牌

**本地（同一台机器）：**

- 打开 `http://127.0.0.1:18789/`。
- 如果要求认证，运行 `openclaw dashboard` 并使用带令牌的链接（`?token=...`）。
- 令牌与 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）的值相同，UI 在首次加载后会存储它。

**非本地环境：**

- **Tailscale Serve**（推荐）：保持绑定 loopback，运行 `openclaw gateway --tailscale serve`，打开 `https://<magicdns>/`。如果 `gateway.auth.allowTailscale` 为 `true`，身份标头满足认证要求（无需令牌）。
- **Tailnet 绑定**：运行 `openclaw gateway --bind tailnet --token "<token>"`，打开 `http://<tailscale-ip>:18789/`，在仪表板设置中粘贴令牌。
- **SSH 隧道**：`ssh -N -L 18789:127.0.0.1:18789 user@host`，然后从 `openclaw dashboard` 打开 `http://127.0.0.1:18789/?token=...`。

参阅[仪表板](/web/dashboard)和 [Web 界面](/web)了解绑定模式和认证详情。

### 我需要什么运行时

Node **>= 22** 是必需的。推荐使用 `pnpm`。**不推荐**使用 Bun 运行 Gateway 网关。

### 能在 Raspberry Pi 上运行吗

可以。Gateway 网关是轻量级的——文档列出 **512MB-1GB RAM**、**1 核**和约 **500MB** 磁盘空间足够个人使用，并指出 **Raspberry Pi 4 可以运行**。

如果你需要额外的余量（日志、媒体、其他服务），**推荐 2GB**，但这不是硬性最低要求。

提示：小型 Pi/VPS 可以托管 Gateway 网关，你可以在笔记本/手机上配对**节点**以获取本地屏幕/摄像头/画布或命令执行能力。参阅[节点](/nodes)。

### Raspberry Pi 安装有什么建议

简短回答：可以运行，但预期会有一些粗糙之处。

- 使用 **64 位**操作系统并保持 Node >= 22。
- 优先选择**可编辑（git）安装**，以便查看日志和快速更新。
- 先不启用渠道/Skills，然后逐个添加。
- 如果遇到奇怪的二进制问题，通常是 **ARM 兼容性**问题。

文档：[Linux](/platforms/linux)、[安装](/install)。

### 卡在 wake up my friend / 新手引导无法启动，怎么办

该界面依赖于 Gateway 网关可达且已认证。TUI 也会在首次启动时自动发送"Wake up, my friend!"。如果你看到该行但**没有回复**且令牌保持为 0，说明智能体从未运行。

1. 重启 Gateway 网关：

```bash
openclaw gateway restart
```

2. 检查状态和认证：

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. 如果仍然挂起，运行：

```bash
openclaw doctor
```

如果 Gateway 网关在远程，确保隧道/Tailscale 连接正常，且 UI 指向正确的 Gateway 网关。参阅[远程访问](/gateway/remote)。

### 能否将我的设置迁移到新机器（Mac mini）而不重新进行新手引导

可以。复制**状态目录**和**工作区**，然后运行一次 Doctor。只要你同时复制**两个**位置，就能保持你的机器人“完全一样”（记忆、会话历史、认证和渠道状态）：

1. 在新机器上安装 OpenClaw。
2. 从旧机器复制 `$OPENCLAW_STATE_DIR`（默认：`~/.openclaw`）。
3. 复制你的工作区（默认：`~/.openclaw/workspace`）。
4. 运行 `openclaw doctor` 并重启 Gateway 网关服务。

这会保留配置、认证配置文件、WhatsApp 凭据、会话和记忆。如果你处于远程模式，请记住 Gateway 网关主机拥有会话存储和工作区。

**重要：** 如果你只将工作区提交/推送到 GitHub，你只备份了**记忆 + 引导文件**，但**不包括**会话历史或认证。它们位于 `~/.openclaw/` 下（例如 `~/.openclaw/agents/<agentId>/sessions/`）。

相关：[迁移](/install/migrating)、[磁盘上的文件位置](/help/faq#where-does-openclaw-store-its-data)、
[智能体工作区](/concepts/agent-workspace)、[Doctor](/gateway/doctor)、
[远程模式](/gateway/remote)。

### 在哪里查看最新版本的更新内容

查看 GitHub 变更日志：
https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md

最新条目在顶部。如果顶部部分标记为 **Unreleased**，则下一个带日期的部分是最新发布版本。条目按**亮点**、**变更**和**修复**分组（需要时还有文档/其他部分）。

### 无法访问 docs.openclaw.ai（SSL 错误），怎么办

一些 Comcast/Xfinity 连接通过 Xfinity Advanced Security 错误地拦截了 `docs.openclaw.ai`。禁用该功能或将 `docs.openclaw.ai` 加入白名单，然后重试。更多详情：[故障排除](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity)。
请帮助我们在此处报告以解除封锁：https://spa.xfinity.com/check_url_status。

如果仍然无法访问该网站，文档在 GitHub 上有镜像：
https://github.com/openclaw/openclaw/tree/main/docs

### stable 和 beta 有什么区别

**Stable** 和 **beta** 是 **npm dist-tags**，不是独立的代码分支：

- `latest` = stable
- `beta` = 用于测试的早期构建

我们将构建发布到 **beta**，测试后，一旦构建稳定，就会**将同一版本提升为 `latest`**。这就是为什么 beta 和 stable 可以指向**相同版本**。

查看变更：
https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md

### 如何安装 beta 版本，beta 和 dev 有什么区别

**Beta** 是 npm dist-tag `beta`（可能与 `latest` 相同）。
**Dev** 是 `main` 的滚动头部（git）；发布时使用 npm dist-tag `dev`。

一行命令（macOS/Linux）：

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows 安装程序（PowerShell）：
https://openclaw.ai/install.ps1

更多详情：[开发渠道](/install/development-channels)和[安装程序标志](/install/installer)。

### 安装和新手引导通常需要多长时间

大致指南：

- **安装：** 2-5 分钟
- **新手引导：** 5-15 分钟，取决于配置多少渠道/模型

如果挂起，请参阅[安装程序卡住](/help/faq#installer-stuck-how-do-i-get-more-feedback)和[我卡住了](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck)中的快速调试流程。

### 如何试用最新代码

两个选项：

1. **Dev 渠道（git checkout）：**

```bash
openclaw update --channel dev
```

这会切换到 `main` 分支并从源码更新。

2. **可编辑安装（从安装程序网站）：**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

这会给你一个可编辑的本地仓库，然后通过 git 更新。

如果你更喜欢手动克隆，使用：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

文档：[更新](/cli/update)、[开发渠道](/install/development-channels)、
[安装](/install)。

### 安装程序卡住了？如何获取更多反馈

使用**详细输出**重新运行安装程序：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

带详细输出的 Beta 安装：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

可编辑（git）安装：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

更多选项：[安装程序标志](/install/installer)。

### Windows 安装提示找不到 git 或无法识别 openclaw

两个常见的 Windows 问题：

**1) npm error spawn git / git not found**

- 安装 **Git for Windows** 并确保 `git` 在你的 PATH 中。
- 关闭并重新打开 PowerShell，然后重新运行安装程序。

**2) openclaw is not recognized（安装后）**

- 你的 npm 全局 bin 文件夹不在 PATH 中。
- 检查路径：
  ```powershell
  npm config get prefix
  ```
- 确保 `<prefix>\\bin` 在 PATH 中（在大多数系统上是 `%AppData%\\npm`）。
- 更新 PATH 后关闭并重新打开 PowerShell。

如果你想要最顺畅的 Windows 设置，请使用 **WSL2** 而不是原生 Windows。
文档：[Windows](/platforms/windows)。

### 文档没有解答我的问题——如何获得更好的答案

使用**可编辑（git）安装**，这样你在本地拥有完整的源码和文档，然后从该文件夹向你的机器人（或 Claude/Codex）提问，这样它可以读取仓库并精确回答。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

更多详情：[安装](/install)和[安装程序标志](/install/installer)。

### 如何在 Linux 上安装 OpenClaw

简短回答：按照 Linux 指南操作，然后运行新手引导向导。

- Linux 快速路径 + 服务安装：[Linux](/platforms/linux)。
- 完整指南：[入门](/start/getting-started)。
- 安装和更新：[安装与更新](/install/updating)。

### 如何在 VPS 上安装 OpenClaw

任何 Linux VPS 都可以。在服务器上安装，然后使用 SSH/Tailscale 访问 Gateway 网关。

指南：[exe.dev](/platforms/exe-dev)、[Hetzner](/platforms/hetzner)、[Fly.io](/platforms/fly)。
远程访问：[Gateway 网关远程](/gateway/remote)。

### 云/VPS 安装指南在哪里

我们维护了一个**托管中心**，涵盖常见提供商。选择一个并按指南操作：

- [VPS 托管](/vps)（所有提供商汇总）
- [Fly.io](/platforms/fly)
- [Hetzner](/platforms/hetzner)
- [exe.dev](/platforms/exe-dev)

在云端的工作方式：**Gateway 网关运行在服务器上**，你通过控制 UI（或 Tailscale/SSH）从笔记本/手机访问。你的状态 + 工作区位于服务器上，因此将主机视为数据来源并做好备份。

你可以将**节点**（Mac/iOS/Android/无头）配对到云端 Gateway 网关，以访问本地屏幕/摄像头/画布或在笔记本上执行命令，同时 Gateway 网关保持在云端。

中心：[平台](/platforms)。远程访问：[Gateway 网关远程](/gateway/remote)。
节点：[节点](/nodes)、[节点 CLI](/cli/nodes)。

### 可以让 OpenClaw 自行更新吗

简短回答：**可以，但不推荐**。更新流程可能重启 Gateway 网关（这会中断活跃会话），可能需要干净的 git checkout，并且可能提示确认。更安全的做法：作为运维人员从 shell 运行更新。

使用 CLI：

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

如果必须从智能体自动化：

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

文档：[更新](/cli/update)、[更新指南](/install/updating)。

### 新手引导向导具体做了什么

`openclaw onboard` 是推荐的设置路径。在**本地模式**下，它引导你完成：

- **模型/认证设置**（推荐使用 Anthropic **setup-token** 进行 Claude 订阅，支持 OpenAI Codex OAuth，API 密钥可选，支持 LM Studio 本地模型）
- **工作区**位置 + 引导文件
- **Gateway 网关设置**（绑定/端口/认证/tailscale）
- **渠道**（WhatsApp、Telegram、Discord、Mattermost（插件）、Signal、iMessage）
- **守护进程安装**（macOS 上的 LaunchAgent；Linux/WSL2 上的 systemd 用户单元）
- **健康检查**和**Skills**选择

如果你配置的模型未知或缺少认证，它还会发出警告。

### 运行 OpenClaw 需要 Claude 或 OpenAI 订阅吗

不需要。你可以使用 **API 密钥**（Anthropic/OpenAI/其他）或**纯本地模型**运行 OpenClaw，这样你的数据留在你的设备上。订阅（Claude Pro/Max 或 OpenAI Codex）是这些提供商的可选认证方式。

文档：[Anthropic](/providers/anthropic)、[OpenAI](/providers/openai)、
[本地模型](/gateway/local-models)、[模型](/concepts/models)。

### 能否使用 Claude Max 订阅而不需要 API 密钥

可以。你可以使用 **setup-token** 代替 API 密钥进行认证。这是订阅路径。

Claude Pro/Max 订阅**不包含 API 密钥**，因此这是订阅账户的正确方式。重要提示：你必须向 Anthropic 确认此用法是否符合其订阅政策和条款。如果你想要最明确、受支持的方式，请使用 Anthropic API 密钥。

### Anthropic setup-token 认证如何工作

`claude setup-token` 通过 Claude Code CLI 生成一个**令牌字符串**（在 Web 控制台中不可用）。你可以在**任何机器**上运行它。在向导中选择 **Anthropic token (paste setup-token)** 或使用 `openclaw models auth paste-token --provider anthropic` 粘贴。令牌作为 **anthropic** 提供商的认证配置文件存储，像 API 密钥一样使用（无自动刷新）。更多详情：[OAuth](/concepts/oauth)。

### 在哪里获取 Anthropic setup-token

它**不在** Anthropic Console 中。setup-token 由 **Claude Code CLI** 在**任何机器**上生成：

```bash
claude setup-token
```

复制它打印的令牌，然后在向导中选择 **Anthropic token (paste setup-token)**。如果你想在 Gateway 网关主机上运行，使用 `openclaw models auth setup-token --provider anthropic`。如果你在其他地方运行了 `claude setup-token`，在 Gateway 网关主机上使用 `openclaw models auth paste-token --provider anthropic` 粘贴。参阅 [Anthropic](/providers/anthropic)。

### 是否支持 Claude 订阅认证（Claude Pro/Max）

是的——通过 **setup-token**。OpenClaw 不再复用 Claude Code CLI OAuth 令牌；请使用 setup-token 或 Anthropic API 密钥。在任何地方生成令牌并在 Gateway 网关主机上粘贴。参阅 [Anthropic](/providers/anthropic) 和 [OAuth](/concepts/oauth)。

注意：Claude 订阅访问受 Anthropic 条款约束。对于生产或多用户工作负载，API 密钥通常是更安全的选择。

### 为什么我看到 HTTP 429 rate_limit_error（来自 Anthropic）

这意味着你当前窗口的 **Anthropic 配额/速率限制**已耗尽。如果你使用 **Claude 订阅**（setup-token 或 Claude Code OAuth），请等待窗口重置或升级你的计划。如果你使用 **Anthropic API 密钥**，请在 Anthropic Console 中检查使用量/计费并根据需要提高限制。

提示：设置一个**备用模型**，这样 OpenClaw 在某个提供商被限速时仍能继续回复。
参阅[模型](/cli/models)和 [OAuth](/concepts/oauth)。

### 支持 AWS Bedrock 吗

是的——通过 pi-ai 的 **Amazon Bedrock (Converse)** 提供商进行**手动配置**。你必须在 Gateway 网关主机上提供 AWS 凭据/区域，并在模型配置中添加 Bedrock 提供商条目。参阅 [Amazon Bedrock](/bedrock) 和[模型提供商](/providers/models)。如果你更喜欢托管密钥流程，在 Bedrock 前面使用兼容 OpenAI 的代理仍然是有效选项。

### Codex 认证如何工作

OpenClaw 通过 OAuth（ChatGPT 登录）支持 **OpenAI Code (Codex)**。向导可以运行 OAuth 流程，并在适当时将默认模型设置为 `openai-codex/gpt-5.2`。参阅[模型提供商](/concepts/model-providers)和[向导](/start/wizard)。

### 是否支持 OpenAI 订阅认证（Codex OAuth）

是的。OpenClaw 完全支持 **OpenAI Code (Codex) 订阅 OAuth**。新手引导向导可以为你运行 OAuth 流程。

参阅 [OAuth](/concepts/oauth)、[模型提供商](/concepts/model-providers)和[向导](/start/wizard)。

### 如何设置 Gemini CLI OAuth

Gemini CLI 使用**插件认证流程**，而不是 `openclaw.json` 中的 client id 或 secret。

步骤：

1. 启用插件：`openclaw plugins enable google-gemini-cli-auth`
2. 登录：`openclaw models auth login --provider google-gemini-cli --set-default`

这会在 Gateway 网关主机上将 OAuth 令牌存储为认证配置文件。详情：[模型提供商](/concepts/model-providers)。

### 本地模型适合日常聊天吗

通常不适合。OpenClaw 需要大上下文 + 强安全性；小显卡会截断且泄漏。如果必须使用，请在本地运行你能运行的**最大** MiniMax M2.1 版本（LM Studio），参阅 [/gateway/local-models](/gateway/local-models)。较小/量化的模型会增加提示注入风险——参阅[安全](/gateway/security)。

### 如何将托管模型流量限制在特定区域

选择区域固定的端点。OpenRouter 为 MiniMax、Kimi 和 GLM 提供美国托管选项；选择美国托管变体以保持数据在区域内。你仍然可以通过使用 `models.mode: "merge"` 在这些旁边列出 Anthropic/OpenAI，这样故障转移保持可用，同时尊重你选择的区域提供商。

### 我必须购买 Mac Mini 才能安装吗

不需要。OpenClaw 运行在 macOS 或 Linux 上（Windows 通过 WSL2）。Mac mini 是可选的——有些人买一台作为常开主机，但小型 VPS、家庭服务器或 Raspberry Pi 级别的设备也可以。

你只有在使用 **macOS 专用工具**时才需要 Mac。对于 iMessage，你可以将 Gateway 网关保持在 Linux 上，通过将 `channels.imessage.cliPath` 指向 SSH 包装器在任何 Mac 上运行 `imsg`。如果你需要其他 macOS 专用工具，在 Mac 上运行 Gateway 网关或配对一个 macOS 节点。

文档：[iMessage](/channels/imessage)、[节点](/nodes)、[Mac 远程模式](/platforms/mac/remote)。

### iMessage 支持需要 Mac mini 吗

你需要**某台登录了 Messages 的 macOS 设备**。它**不一定**是 Mac mini——任何 Mac 都可以。OpenClaw 的 iMessage 集成在 macOS 上运行（BlueBubbles 或 `imsg`），而 Gateway 网关可以在其他地方运行。

常见设置：

- 在 Linux/VPS 上运行 Gateway 网关，将 `channels.imessage.cliPath` 指向在 Mac 上运行 `imsg` 的 SSH 包装器。
- 如果你想要最简单的单机设置，在 Mac 上运行所有组件。

文档：[iMessage](/channels/imessage)、[BlueBubbles](/channels/bluebubbles)、
[Mac 远程模式](/platforms/mac/remote)。

### 如果我买了 Mac mini 运行 OpenClaw，能连接到我的 MacBook Pro 吗

可以。**Mac mini 可以运行 Gateway 网关**，你的 MacBook Pro 可以作为**节点**（伴随设备）连接。节点不运行 Gateway 网关——它们提供额外功能，如该设备上的屏幕/摄像头/画布和 `system.run`。

常见模式：

- Gateway 网关在 Mac mini 上（常开）。
- MacBook Pro 运行 macOS 应用或节点主机并配对到 Gateway 网关。
- 使用 `openclaw nodes status` / `openclaw nodes list` 查看它。

文档：[节点](/nodes)、[节点 CLI](/cli/nodes)。

### 可以使用 Bun 吗

Bun **不推荐**。我们观察到运行时 bug，特别是在 WhatsApp 和 Telegram 方面。
使用 **Node** 以获得稳定的 Gateway 网关。

如果你仍想尝试 Bun，请在没有 WhatsApp/Telegram 的非生产 Gateway 网关上进行。

### Telegram：allowFrom 填什么

`channels.telegram.allowFrom` 是**人类发送者的 Telegram 用户 ID**（数字，推荐）或 `@username`。它不是机器人用户名。

更安全的方式（无需第三方机器人）：

- 给你的机器人发私信，然后运行 `openclaw logs --follow` 并读取 `from.id`。

官方 Bot API：

- 给你的机器人发私信，然后调用 `https://api.telegram.org/bot<bot_token>/getUpdates` 并读取 `message.from.id`。

第三方（隐私性较低）：

- 给 `@userinfobot` 或 `@getidsbot` 发私信。

参阅 [/channels/telegram](/channels/telegram#access-control-dms--groups)。

### 多人能否使用同一个 WhatsApp 号码配合不同的 OpenClaw 实例

可以，通过**多智能体路由**。将每个发送者的 WhatsApp **私信**（peer `kind: "dm"`，发送者 E.164 格式如 `+15551234567`）绑定到不同的 `agentId`，这样每个人获得自己的工作区和会话存储。回复仍然来自**同一个 WhatsApp 账户**，且私信访问控制（`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`）对每个 WhatsApp 账户是全局的。参阅[多智能体路由](/concepts/multi-agent)和 [WhatsApp](/channels/whatsapp)。

### 能否同时运行一个“快速聊天”智能体和一个“用 Opus 编程”的智能体

可以。使用多智能体路由：为每个智能体设置自己的默认模型，然后将入站路由（提供商账户或特定对等方）绑定到每个智能体。示例配置位于[多智能体路由](/concepts/multi-agent)。另参阅[模型](/concepts/models)和[配置](/gateway/configuration)。

### Homebrew 在 Linux 上可用吗

可以。Homebrew 支持 Linux（Linuxbrew）。快速设置：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

如果你通过 systemd 运行 OpenClaw，确保服务 PATH 包含 `/home/linuxbrew/.linuxbrew/bin`（或你的 brew 前缀），以便 `brew` 安装的工具在非登录 shell 中可解析。
最近的构建还会在 Linux systemd 服务上自动添加常见的用户 bin 目录（例如 `~/.local/bin`、`~/.npm-global/bin`、`~/.local/share/pnpm`、`~/.bun/bin`），并在设置时尊重 `PNPM_HOME`、`NPM_CONFIG_PREFIX`、`BUN_INSTALL`、`VOLTA_HOME`、`ASDF_DATA_DIR`、`NVM_DIR` 和 `FNM_DIR`。

### 可编辑（git）安装和 npm 安装有什么区别

- **可编辑（git）安装：** 完整源码 checkout，可编辑，最适合贡献者。你在本地运行构建并可以修补代码/文档。
- **npm 安装：** 全局 CLI 安装，无仓库，最适合“直接运行”。更新来自 npm dist-tags。

文档：[入门](/start/getting-started)、[更新](/install/updating)。

### 之后可以在 npm 和 git 安装之间切换吗

可以。安装另一种方式，然后运行 Doctor 使 Gateway 网关服务指向新的入口点。
这**不会删除你的数据**——它只改变 OpenClaw 代码的安装位置。你的状态
（`~/.openclaw`）和工作区（`~/.openclaw/workspace`）保持不变。

从 npm → git：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

从 git → npm：

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor 会检测 Gateway 网关服务入口点不匹配，并提供重写服务配置以匹配当前安装的选项（在自动化中使用 `--repair`）。

备份提示：参阅[备份策略](/help/faq#whats-the-recommended-backup-strategy)。

### 应该在笔记本电脑还是 VPS 上运行 Gateway 网关简短回答：**如果你想要 24/7 可靠性，使用 VPS**。如果你想要最低摩擦且能接受休眠/重启，在本地运行。

**笔记本（本地 Gateway 网关）**

- **优点：** 无服务器成本，直接访问本地文件，实时浏览器窗口。
- **缺点：** 休眠/网络中断 = 断连，操作系统更新/重启会中断，必须保持唤醒。

**VPS / 云**

- **优点：** 常开，网络稳定，无笔记本休眠问题，更容易保持运行。
- **缺点：** 通常无头运行（使用截图），仅远程文件访问，更新需要 SSH。

**OpenClaw 特定说明：** WhatsApp/Telegram/Slack/Mattermost（插件）/Discord 在 VPS 上都能正常工作。唯一的真正权衡是**无头浏览器**与可见窗口。参阅[浏览器](/tools/browser)。

**推荐默认值：** 如果之前遇到过 Gateway 网关断连，使用 VPS。当你正在积极使用 Mac 并且需要本地文件访问或可见浏览器的 UI 自动化时，本地运行很好。

### 在专用机器上运行 OpenClaw 有多重要

不是必需的，但**推荐用于可靠性和隔离**。

- **专用主机（VPS/Mac mini/Pi）：** 常开，更少的休眠/重启中断，更干净的权限，更容易保持运行。
- **共享的笔记本/台式机：** 完全适合测试和活跃使用，但当机器休眠或更新时预期会有暂停。

如果你想要两全其美，将 Gateway 网关保持在专用主机上，并将笔记本配对为**节点**以获取本地屏幕/摄像头/执行工具。参阅[节点](/nodes)。
安全指南请阅读[安全](/gateway/security)。

### VPS 的最低要求和推荐操作系统是什么

OpenClaw 是轻量级的。对于基本的 Gateway 网关 + 一个聊天渠道：

- **绝对最低：** 1 vCPU，1GB RAM，约 500MB 磁盘。
- **推荐：** 1-2 vCPU，2GB RAM 或更多以留有余量（日志、媒体、多渠道）。节点工具和浏览器自动化可能消耗较多资源。

操作系统：使用 **Ubuntu LTS**（或任何现代 Debian/Ubuntu）。Linux 安装路径在那里测试得最充分。

文档：[Linux](/platforms/linux)、[VPS 托管](/vps)。

### 可以在虚拟机中运行 OpenClaw 吗？有什么要求

可以。将虚拟机视为与 VPS 相同：它需要常开、可达，并有足够的 RAM 用于 Gateway 网关和你启用的任何渠道。

基准指南：

- **绝对最低：** 1 vCPU，1GB RAM。
- **推荐：** 2GB RAM 或更多，如果你运行多个渠道、浏览器自动化或媒体工具。
- **操作系统：** Ubuntu LTS 或其他现代 Debian/Ubuntu。

如果你使用 Windows，**WSL2 是最简单的虚拟机式设置**，具有最佳的工具兼容性。参阅 [Windows](/platforms/windows)、[VPS 托管](/vps)。
如果你在虚拟机中运行 macOS，参阅 [macOS VM](/platforms/macos-vm)。

## 什么是 OpenClaw？

### 用一段话描述 OpenClaw

OpenClaw 是一个运行在你自己设备上的个人 AI 助手。它在你已经使用的消息平台上回复（WhatsApp、Telegram、Slack、Mattermost（插件）、Discord、Google Chat、Signal、iMessage、WebChat），还可以在支持的平台上进行语音和实时 Canvas。**Gateway 网关** 是常开的控制平面；助手是产品。

### 价值主张是什么

OpenClaw 不是“只是一个 Claude 包装器”。它是一个**本地优先的控制平面**，让你在**自己的硬件**上运行强大的助手，可从你已经使用的聊天应用访问，具有有状态会话、记忆和工具——无需将工作流程的控制权交给托管 SaaS。

亮点：

- **你的设备，你的数据：** 在任何你想要的地方运行 Gateway 网关（Mac、Linux、VPS），并将工作区 + 会话历史保持在本地。
- **真实渠道，而非 Web 沙箱：** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/等，加上支持平台上的移动语音和 Canvas。
- **模型无关：** 使用 Anthropic、OpenAI、MiniMax、OpenRouter 等，支持按智能体路由和故障转移。
- **纯本地选项：** 运行本地模型，让**所有数据都保留在你的设备上**。
- **多智能体路由：** 按渠道、账户或任务分配不同的智能体，每个都有自己的工作区和默认值。
- **开源且可编辑：** 无供应商锁定地检查、扩展和自托管。

文档：[Gateway 网关](/gateway)、[渠道](/channels)、[多智能体](/concepts/multi-agent)、
[记忆](/concepts/memory)。

### 刚设置好，应该先做什么

好的入门项目：

- 建一个网站（WordPress、Shopify 或简单的静态站点）。
- 做一个移动应用原型（大纲、界面、API 计划）。
- 整理文件和文件夹（清理、命名、打标签）。
- 连接 Gmail 并自动化摘要或跟进。

它可以处理大型任务，但最好将其拆分为多个阶段，并使用子智能体进行并行工作。

### OpenClaw 日常最常用的五个场景是什么

日常收益通常包括：

- **个人简报：** 收件箱、日历和你关心的新闻摘要。
- **研究和起草：** 快速研究、摘要以及邮件或文档的初稿。
- **提醒和跟进：** 定时任务或心跳驱动的提醒和检查清单。
- **浏览器自动化：** 填写表单、收集数据和重复性网页任务。
- **跨设备协调：** 从手机发送任务，让 Gateway 网关在服务器上运行，然后在聊天中获取结果。

### OpenClaw 能否帮助 SaaS 进行获客、外联、广告和博客

可以用于**调研、筛选和起草**。它可以扫描网站、建立候选名单、总结潜在客户，并撰写外联或广告文案草稿。

对于**外联或广告投放**，请保持人工审核。避免垃圾邮件，遵守当地法律和平台政策，在发送之前审查所有内容。最安全的模式是让 OpenClaw 起草，由你批准。

文档：[安全](/gateway/security)。

### 相比 Claude Code，在 Web 开发方面有什么优势

OpenClaw 是一个**个人助手**和协调层，不是 IDE 替代品。使用 Claude Code 或 Codex 在仓库中进行最快的直接编码循环。当你需要持久记忆、跨设备访问和工具编排时，使用 OpenClaw。

优势：

- 跨会话的**持久记忆 + 工作区**
- **多平台访问**（WhatsApp、Telegram、TUI、WebChat）
- **工具编排**（浏览器、文件、调度、钩子）
- **常开 Gateway 网关**（在 VPS 上运行，从任何地方交互）
- 用于本地浏览器/屏幕/摄像头/执行的**节点**

展示：https://openclaw.ai/showcase

## Skills 与自动化

### 如何自定义 Skills 而不弄脏仓库

使用托管覆盖而不是编辑仓库副本。将你的更改放在 `~/.openclaw/skills/<name>/SKILL.md`（或通过 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 添加文件夹）。优先级是 `<workspace>/skills` > `~/.openclaw/skills` > 内置，所以托管覆盖优先生效而不会修改 git。只有值得上游合并的编辑才应该放在仓库中并作为 PR 提交。

### 可以从自定义文件夹加载 Skills 吗

可以。通过 `~/.openclaw/openclaw.json` 中的 `skills.load.extraDirs` 添加额外目录（最低优先级）。默认优先级保持不变：`<workspace>/skills` → `~/.openclaw/skills` → 内置 → `skills.load.extraDirs`。`clawhub` 默认安装到 `./skills`，OpenClaw 将其视为 `<workspace>/skills`。

### 如何为不同任务使用不同模型

目前支持的模式有：

- **定时任务**：隔离的任务可以为每个任务设置 `model` 覆盖。
- **子智能体**：将任务路由到具有不同默认模型的独立智能体。
- **按需切换**：使用 `/model` 随时切换当前会话模型。

参阅[定时任务](/automation/cron-jobs)、[多智能体路由](/concepts/multi-agent)和[斜杠命令](/tools/slash-commands)。

### 机器人在执行繁重工作时卡住了，如何卸载任务

使用**子智能体**处理长时间或并行任务。子智能体在自己的会话中运行，返回摘要，并保持你的主聊天响应。

要求你的机器人“为这个任务生成一个子智能体”或使用 `/subagents`。
在聊天中使用 `/status` 查看 Gateway 网关当前正在做什么（以及是否忙碌）。

令牌提示：长任务和子智能体都消耗令牌。如果关注成本，通过 `agents.defaults.subagents.model` 为子智能体设置更便宜的模型。

文档：[子智能体](/tools/subagents)。

### 定时任务或提醒没有触发，应该检查什么

定时任务在 Gateway 网关进程内运行。如果 Gateway 网关没有持续运行，计划任务将不会运行。

检查清单：

- 确认 cron 已启用（`cron.enabled`）且未设置 `OPENCLAW_SKIP_CRON`。
- 检查 Gateway 网关是否 24/7 运行（无休眠/重启）。
- 验证任务的时区设置（`--tz` 与主机时区）。

调试：

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

文档：[定时任务](/automation/cron-jobs)、[定时任务 vs 心跳](/automation/cron-vs-heartbeat)。

### 如何在 Linux 上安装 Skills

使用 **ClawHub**（CLI）或将 Skills 放入你的工作区。macOS Skills UI 在 Linux 上不可用。
浏览 Skills：https://clawhub.com。

安装 ClawHub CLI（选择一个包管理器）：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw 能否按计划或在后台持续运行任务

可以。使用 Gateway 网关调度器：

- **定时任务**用于计划或重复任务（跨重启持久化）。
- **心跳**用于“主会话”定期检查。
- **隔离任务**用于自主智能体发布摘要或投递到聊天。

文档：[定时任务](/automation/cron-jobs)、[定时任务 vs 心跳](/automation/cron-vs-heartbeat)、
[心跳](/gateway/heartbeat)。

**能否从 Linux 运行仅限 Apple/macOS 的 Skills**

不能直接运行。macOS Skills 受 `metadata.openclaw.os` 和所需二进制文件限制，Skills 只有在 **Gateway 网关主机**上符合条件时才会出现在系统提示中。在 Linux 上，`darwin` 专用 Skills（如 `apple-notes`、`apple-reminders`、`things-mac`）不会加载，除非你覆盖限制。

你有三种支持的模式：

**方案 A - 在 Mac 上运行 Gateway 网关（最简单）。**
在 macOS 二进制文件所在的地方运行 Gateway 网关，然后从 Linux 通过[远程模式](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)或 Tailscale 连接。Skills 正常加载，因为 Gateway 网关主机是 macOS。

**方案 B - 使用 macOS 节点（无需 SSH）。**
在 Linux 上运行 Gateway 网关，配对一个 macOS 节点（菜单栏应用），并在 Mac 上将**节点运行命令**设置为“始终询问”或“始终允许”。当所需二进制文件存在于节点上时，OpenClaw 可以将 macOS 专用 Skills 视为符合条件。智能体通过 `nodes` 工具运行这些 Skills。如果你选择“始终询问”，在提示中批准“始终允许”会将该命令添加到允许列表。

**方案 C - 通过 SSH 代理 macOS 二进制文件（高级）。**
保持 Gateway 网关在 Linux 上，但使所需的 CLI 二进制文件解析为在 Mac 上运行的 SSH 包装器。然后覆盖 Skills 以允许 Linux 使其保持符合条件。

1. 为二进制文件创建 SSH 包装器（示例：`imsg`）：
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/imsg "$@"
   ```
2. 将包装器放在 Linux 主机的 `PATH` 上（例如 `~/bin/imsg`）。
3. 覆盖 Skills 元数据（工作区或 `~/.openclaw/skills`）以允许 Linux：
   ```markdown
   ---
   name: imsg
   description: iMessage/SMS CLI for listing chats, history, watch, and sending.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["imsg"] } } }
   ---
   ```
4. 开始新会话以刷新 Skills 快照。

对于 iMessage，你也可以将 `channels.imessage.cliPath` 指向 SSH 包装器（OpenClaw 只需要 stdio）。参阅 [iMessage](/channels/imessage)。

### 有 Notion 或 HeyGen 集成吗

目前没有内置集成。

选项：

- **自定义 Skills / 插件：** 最适合可靠的 API 访问（Notion/HeyGen 都有 API）。
- **浏览器自动化：** 无需编码但更慢且更脆弱。

如果你想按客户保留上下文（代理工作流），一个简单的模式是：

- 每个客户一个 Notion 页面（上下文 + 偏好 + 当前工作）。
- 在会话开始时要求智能体获取该页面。

如果你想要原生集成，请提交功能请求或构建一个针对这些 API 的 Skills。

安装 Skills：

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub 安装到当前目录下的 `./skills`（或回退到你配置的 OpenClaw 工作区）；OpenClaw 在下一个会话中将其视为 `<workspace>/skills`。对于跨智能体共享的 Skills，将它们放在 `~/.openclaw/skills/<name>/SKILL.md`。某些 Skills 期望通过 Homebrew 安装二进制文件；在 Linux 上意味着 Linuxbrew（参阅上面的 Homebrew Linux 常见问题条目）。参阅[Skills](/tools/skills)和 [ClawHub](/tools/clawhub)。

### 如何安装用于浏览器接管的 Chrome 扩展

使用内置安装程序，然后在 Chrome 中加载未打包的扩展：

```bash
openclaw browser extension install
openclaw browser extension path
```

然后 Chrome → `chrome://extensions` → 启用“开发者模式” → “加载已解压的扩展程序” → 选择该文件夹。

完整指南（包括远程 Gateway 网关 + 安全注意事项）：[Chrome 扩展](/tools/chrome-extension)

如果 Gateway 网关运行在与 Chrome 同一台机器上（默认设置），你通常**不需要**额外配置。
如果 Gateway 网关运行在其他地方，在运行浏览器的机器上运行一个节点主机，以便 Gateway 网关可以代理浏览器操作。
你仍然需要在要控制的标签页上点击扩展按钮（它不会自动附加）。

## 沙箱与记忆

### 有专门的沙箱文档吗

有。参阅[沙箱](/gateway/sandboxing)。对于 Docker 特定设置（完整 Gateway 网关在 Docker 中或沙箱镜像），参阅 [Docker](/install/docker)。

**能否让私信保持私密，但群组用一个智能体公开沙箱隔离**

可以——如果你的私密流量是**私信**而公开流量是**群组**。

使用 `agents.defaults.sandbox.mode: "non-main"`，这样群组/频道会话（非主键）在 Docker 中运行，而主私信会话保持在主机上。然后通过 `tools.sandbox.tools` 限制沙箱会话中可用的工具。

设置指南 + 示例配置：[群组：个人私信 + 公开群组](/concepts/groups#pattern-personal-dms-public-groups-single-agent)

关键配置参考：[Gateway 网关配置](/gateway/configuration#agentsdefaultssandbox)

### 如何将主机文件夹绑定到沙箱中

将 `agents.defaults.sandbox.docker.binds` 设置为 `["host:path:mode"]`（例如 `"/home/user/src:/src:ro"`）。全局 + 按智能体的绑定会合并；当 `scope: "shared"` 时按智能体的绑定会被忽略。对于敏感内容使用 `:ro`，并记住绑定会绕过沙箱文件系统隔离。参阅[沙箱](/gateway/sandboxing#custom-bind-mounts)和[沙箱 vs 工具策略 vs 提权](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check)了解示例和安全注意事项。

### 记忆是如何工作的

OpenClaw 记忆就是智能体工作区中的 Markdown 文件：

- 每日笔记在 `memory/YYYY-MM-DD.md`
- 精选的长期笔记在 `MEMORY.md`（仅限主/私密会话）

OpenClaw 还会运行**静默的预压缩记忆刷新**，以提醒模型在自动压缩之前写入持久笔记。这只在工作区可写时运行（只读沙箱会跳过）。参阅[记忆](/concepts/memory)。

### 记忆总是遗忘，如何让它持久保存

要求机器人**将事实写入记忆**。长期笔记属于 `MEMORY.md`，短期上下文放入 `memory/YYYY-MM-DD.md`。

这仍然是我们正在改进的领域。提醒模型存储记忆会有帮助；它会知道如何操作。如果它持续遗忘，验证 Gateway 网关每次运行时是否使用相同的工作区。

文档：[记忆](/concepts/memory)、[智能体工作区](/concepts/agent-workspace)。

### 语义记忆搜索需要 OpenAI API 密钥吗

只有在使用 **OpenAI embeddings** 时才需要。Codex OAuth 覆盖 chat/completions 但**不**授予 embeddings 访问权限，因此**使用 Codex 登录（OAuth 或 Codex CLI 登录）**对语义记忆搜索没有帮助。OpenAI embeddings 仍然需要真正的 API 密钥（`OPENAI_API_KEY` 或 `models.providers.openai.apiKey`）。

如果你没有明确设置提供商，OpenClaw 会在能解析 API 密钥（认证配置文件、`models.providers.*.apiKey` 或环境变量）时自动选择提供商。如果 OpenAI 密钥可解析则优先使用 OpenAI，否则如果 Gemini 密钥可解析则使用 Gemini。如果两个密钥都不可用，记忆搜索保持禁用直到你配置它。如果你配置了本地模型路径且存在，OpenClaw 优先使用 `local`。

如果你更想保持本地运行，设置 `memorySearch.provider = "local"`（可选 `memorySearch.fallback = "none"`）。如果你想使用 Gemini embeddings，设置 `memorySearch.provider = "gemini"` 并提供 `GEMINI_API_KEY`（或 `memorySearch.remote.apiKey`）。我们支持 **OpenAI、Gemini 或本地** embedding 模型——参阅[记忆](/concepts/memory)了解设置详情。

### 记忆是否永久保留？有什么限制

记忆文件保存在磁盘上，持久存在直到你删除它们。限制是你的存储空间，而不是模型。**会话上下文**仍然受模型上下文窗口限制，所以长对话可能会压缩或截断。这就是记忆搜索存在的原因——它只将相关部分拉回上下文。

文档：[记忆](/concepts/memory)、[上下文](/concepts/context)。

## 磁盘上的文件位置

### OpenClaw 使用的所有数据都保存在本地吗

不是——**OpenClaw 的状态是本地的**，但**外部服务仍然会看到你发送给它们的内容**。

- **默认本地：** 会话、记忆文件、配置和工作区位于 Gateway 网关主机上（`~/.openclaw` + 你的工作区目录）。
- **必然远程：** 你发送给模型提供商（Anthropic/OpenAI/等）的消息会发送到它们的 API，聊天平台（WhatsApp/Telegram/Slack/等）在它们的服务器上存储消息数据。
- **你控制范围：** 使用本地模型可以将提示保留在你的机器上，但渠道流量仍然通过渠道的服务器。

相关：[智能体工作区](/concepts/agent-workspace)、[记忆](/concepts/memory)。

### OpenClaw 将数据存储在哪里

所有内容位于 `$OPENCLAW_STATE_DIR`（默认：`~/.openclaw`）下：

| 路径                                                            | 用途                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | 主配置（JSON5）                                      |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | 旧版 OAuth 导入（首次使用时复制到认证配置文件）      |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 认证配置文件（OAuth + API 密钥）                     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | 运行时认证缓存（自动管理）                           |
| `$OPENCLAW_STATE_DIR/credentials/`                              | 提供商状态（例如 `whatsapp/<accountId>/creds.json`） |
| `$OPENCLAW_STATE_DIR/agents/`                                   | 按智能体的状态（agentDir + 会话）                    |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | 对话历史和状态（按智能体）                           |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | 会话元数据（按智能体）                               |

旧版单智能体路径：`~/.openclaw/agent/*`（通过 `openclaw doctor` 迁移）。

你的**工作区**（AGENTS.md、记忆文件、Skills 等）是独立的，通过 `agents.defaults.workspace` 配置（默认：`~/.openclaw/workspace`）。

### AGENTS.md / SOUL.md / USER.md / MEMORY.md 应该放在哪里

这些文件位于**智能体工作区**中，而不是 `~/.openclaw`。

- **工作区（按智能体）**：`AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、
  `MEMORY.md`（或 `memory.md`）、`memory/YYYY-MM-DD.md`、可选的 `HEARTBEAT.md`。
- **状态目录（`~/.openclaw`）**：配置、凭据、认证配置文件、会话、日志和共享 Skills（`~/.openclaw/skills`）。

默认工作区是 `~/.openclaw/workspace`，可通过以下方式配置：

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

如果机器人在重启后“忘记”了内容，确认 Gateway 网关每次启动时都使用相同的工作区（记住：远程模式使用 **Gateway 网关主机的**工作区，而不是你本地笔记本的）。

提示：如果你想要一个持久的行为或偏好，要求机器人**将其写入 AGENTS.md 或 MEMORY.md**，而不是依赖聊天历史。

参阅[智能体工作区](/concepts/agent-workspace)和[记忆](/concepts/memory)。

### 推荐的备份策略是什么

将你的**智能体工作区**放入一个**私有** git 仓库，并备份到某个私有位置（例如 GitHub 私有仓库）。这会捕获记忆 + AGENTS/SOUL/USER 文件，让你以后可以恢复助手的“思维”。

**不要**提交 `~/.openclaw` 下的任何内容（凭据、会话、令牌）。如果你需要完整恢复，将工作区和状态目录分别备份（参阅上面的迁移问题）。

文档：[智能体工作区](/concepts/agent-workspace)。

### 如何完全卸载 OpenClaw

参阅专门指南：[卸载](/install/uninstall)。

### 智能体可以在工作区外工作吗

可以。工作区是**默认 cwd** 和记忆锚点，不是硬沙箱。相对路径在工作区内解析，但绝对路径可以访问其他主机位置，除非启用了沙箱。如果你需要隔离，使用 [`agents.defaults.sandbox`](/gateway/sandboxing) 或按智能体的沙箱设置。如果你希望某个仓库作为默认工作目录，将该智能体的 `workspace` 指向仓库根目录。OpenClaw 仓库只是源代码；除非你有意要让智能体在其中工作，否则保持工作区独立。

示例（仓库作为默认 cwd）：

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### 我处于远程模式——会话存储在哪里

会话状态归 **Gateway 网关主机**所有。如果你处于远程模式，你关心的会话存储在远程机器上，而不是你的本地笔记本上。参阅[会话管理](/concepts/session)。

## 配置基础

### 配置文件是什么格式？在哪里

OpenClaw 从 `$OPENCLAW_CONFIG_PATH`（默认：`~/.openclaw/openclaw.json`）读取可选的 **JSON5** 配置：

```
$OPENCLAW_CONFIG_PATH
```

如果文件不存在，使用安全的默认值（包括默认工作区 `~/.openclaw/workspace`）。

### 我设置了 gateway.bind: "lan"（或 "tailnet"），现在什么都监听不了 / UI 显示未授权

非 local loopback 绑定**需要认证**。配置 `gateway.auth.mode` + `gateway.auth.token`（或使用 `OPENCLAW_GATEWAY_TOKEN`）。

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

注意：

- `gateway.remote.token` 仅用于**远程 CLI 调用**；它不启用本地 Gateway 网关认证。
- 控制 UI 通过 `connect.params.auth.token`（存储在应用/UI 设置中）进行认证。避免将令牌放在 URL 中。

### 为什么现在在 localhost 也需要令牌

向导默认生成 Gateway 网关令牌（即使在 local loopback 上），因此**本地 WS 客户端必须认证**。这阻止了其他本地进程调用 Gateway 网关。在控制 UI 设置（或你的客户端配置）中粘贴令牌以连接。

如果你**确实**想要开放 local loopback，从配置中移除 `gateway.auth`。Doctor 可以随时为你生成令牌：`openclaw doctor --generate-gateway-token`。

### 更改配置后需要重启吗

Gateway 网关监视配置文件并支持热重载：

- `gateway.reload.mode: "hybrid"`（默认）：安全更改热应用，关键更改重启
- 也支持 `hot`、`restart`、`off`

### 如何启用网络搜索（和网页抓取）

`web_fetch` 无需 API 密钥即可工作。`web_search` 需要 Brave Search API 密钥。**推荐：** 运行 `openclaw configure --section web` 将其存储在 `tools.web.search.apiKey` 中。环境变量替代方案：为 Gateway 网关进程设置 `BRAVE_API_KEY`。

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

注意：

- 如果你使用允许列表，添加 `web_search`/`web_fetch` 或 `group:web`。
- `web_fetch` 默认启用（除非明确禁用）。
- 守护进程从 `~/.openclaw/.env`（或服务环境）读取环境变量。

文档：[Web 工具](/tools/web)。

### config.apply 清空了我的配置，如何恢复和避免

`config.apply` 替换**整个配置**。如果你发送部分对象，其他所有内容都会被移除。

恢复：

- 从备份恢复（git 或复制的 `~/.openclaw/openclaw.json`）。
- 如果没有备份，重新运行 `openclaw doctor` 并重新配置渠道/模型。
- 如果这是意外情况，提交 bug 并附上你最后已知的配置或任何备份。
- 本地编码智能体通常可以从日志或历史中重建工作配置。

避免方法：

- 对小更改使用 `openclaw config set`。
- 对交互式编辑使用 `openclaw configure`。

文档：[Config](/cli/config)、[Configure](/cli/configure)、[Doctor](/gateway/doctor)。

### 如何运行一个中心 Gateway 网关配合跨设备的专用工作节点

常见模式是**一个 Gateway 网关**（例如 Raspberry Pi）加上**节点**和**智能体**：

- **Gateway 网关（中心）：** 拥有渠道（Signal/WhatsApp）、路由和会话。
- **节点（设备）：** Mac/iOS/Android 作为外围设备连接，暴露本地工具（`system.run`、`canvas`、`camera`）。
- **智能体（工作者）：** 用于特殊角色的独立大脑/工作区（例如“Hetzner 运维”、“个人数据”）。
- **子智能体：** 需要并行处理时从主智能体生成后台工作。
- **TUI：** 连接到 Gateway 网关并切换智能体/会话。

文档：[节点](/nodes)、[远程访问](/gateway/remote)、[多智能体路由](/concepts/multi-agent)、[子智能体](/tools/subagents)、[TUI](/tui)。

### OpenClaw 浏览器可以无头运行吗

可以。这是一个配置选项：

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

默认为 `false`（有头）。无头模式在某些网站上更容易触发反机器人检测。参阅[浏览器](/tools/browser)。

无头模式使用**相同的 Chromium 引擎**，适用于大多数自动化（表单、点击、抓取、登录）。主要区别：

- 没有可见的浏览器窗口（如果需要视觉效果使用截图）。
- 某些网站在无头模式下对自动化更严格（验证码、反机器人）。例如，X/Twitter 经常阻止无头会话。

### 如何使用 Brave 进行浏览器控制

将 `browser.executablePath` 设置为你的 Brave 二进制文件（或任何基于 Chromium 的浏览器）并重启 Gateway 网关。
参阅[浏览器](/tools/browser#use-brave-or-another-chromium-based-browser)中的完整配置示例。

## 远程 Gateway 网关与节点

### 命令如何在 Telegram、Gateway 网关和节点之间传播

Telegram 消息由 **Gateway 网关** 处理。Gateway 网关运行智能体，只有在需要节点工具时才通过 **Gateway 网关 WebSocket** 调用节点：

Telegram → Gateway 网关 → 智能体 → `node.*` → 节点 → Gateway 网关 → Telegram

节点不会看到入站提供商流量；它们只接收节点 RPC 调用。

### 如果 Gateway 网关托管在远程，我的智能体如何访问我的电脑

简短回答：**将你的电脑配对为节点**。Gateway 网关运行在其他地方，但它可以通过 Gateway 网关 WebSocket 在你的本地机器上调用 `node.*` 工具（屏幕、摄像头、系统）。

典型设置：

1. 在常开主机（VPS/家庭服务器）上运行 Gateway 网关。
2. 将 Gateway 网关主机和你的电脑放在同一个 tailnet 上。
3. 确保 Gateway 网关 WS 可达（tailnet 绑定或 SSH 隧道）。
4. 在本地打开 macOS 应用并以**远程 over SSH** 模式连接（或直接 tailnet），使其可以注册为节点。
5. 在 Gateway 网关上批准节点：
   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

不需要单独的 TCP 桥接；节点通过 Gateway 网关 WebSocket 连接。

安全提醒：配对 macOS 节点允许在该机器上执行 `system.run`。只配对你信任的设备，并查阅[安全](/gateway/security)。

文档：[节点](/nodes)、[Gateway 网关协议](/gateway/protocol)、[macOS 远程模式](/platforms/mac/remote)、[安全](/gateway/security)。

### Tailscale 已连接但收不到回复，怎么办

检查基础项：

- Gateway 网关正在运行：`openclaw gateway status`
- Gateway 网关健康：`openclaw status`
- 渠道健康：`openclaw channels status`

然后验证认证和路由：

- 如果你使用 Tailscale Serve，确保 `gateway.auth.allowTailscale` 设置正确。
- 如果你通过 SSH 隧道连接，确认本地隧道已启动并指向正确端口。
- 确认你的允许列表（私信或群组）包含你的账户。

文档：[Tailscale](/gateway/tailscale)、[远程访问](/gateway/remote)、[渠道](/channels)。

### 两个 OpenClaw 实例（本地 + VPS）可以互相通信吗

可以。没有内置的“机器人对机器人”桥接，但你可以通过几种可靠的方式实现：

**最简单：** 使用两个机器人都能访问的普通聊天渠道（Telegram/Slack/WhatsApp）。让机器人 A 给机器人 B 发消息，然后让机器人 B 正常回复。

**CLI 桥接（通用）：** 运行一个脚本调用另一个 Gateway 网关，使用 `openclaw agent --message ... --deliver`，定向到另一个机器人监听的聊天。如果一个机器人在远程 VPS 上，通过 SSH/Tailscale 将你的 CLI 指向该远程 Gateway 网关（参阅[远程访问](/gateway/remote)）。

示例模式（从能到达目标 Gateway 网关的机器上运行）：

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

提示：添加护栏防止两个机器人无限循环（仅提及、渠道允许列表或“不回复机器人消息”规则）。

文档：[远程访问](/gateway/remote)、[Agent CLI](/cli/agent)、[Agent send](/tools/agent-send)。

### 多个智能体需要独立的 VPS 吗

不需要。一个 Gateway 网关可以托管多个智能体，每个都有自己的工作区、模型默认值和路由。这是正常设置，比每个智能体一个 VPS 便宜且简单得多。

只有在需要硬隔离（安全边界）或非常不同的配置（你不想共享）时才使用独立的 VPS。否则保持一个 Gateway 网关并使用多个智能体或子智能体。

### 在个人笔记本电脑上使用节点而不是从 VPS SSH 有什么好处

有——节点是从远程 Gateway 网关到达你笔记本的首选方式，它们解锁的不仅仅是 shell 访问。Gateway 网关运行在 macOS/Linux（Windows 通过 WSL2）上且是轻量级的（小型 VPS 或 Raspberry Pi 级别的设备就够用；4 GB RAM 足够），所以常见设置是一个常开主机加上你的笔记本作为节点。

- **无需入站 SSH。** 节点向 Gateway 网关 WebSocket 发起出站连接并使用设备配对。
- **更安全的执行控制。** `system.run` 受该笔记本上节点允许列表/审批的限制。
- **更多设备工具。** 节点除了 `system.run` 还暴露 `canvas`、`camera` 和 `screen`。
- **本地浏览器自动化。** 将 Gateway 网关保持在 VPS 上，但在本地运行 Chrome 并通过 Chrome 扩展 + 笔记本上的节点主机中继控制。

SSH 对临时 shell 访问很好，但节点对于持续的智能体工作流和设备自动化更简单。

文档：[节点](/nodes)、[节点 CLI](/cli/nodes)、[Chrome 扩展](/tools/chrome-extension)。

### 应该在第二台笔记本上安装还是只添加一个节点

如果你只需要第二台笔记本上的**本地工具**（屏幕/摄像头/执行），将其添加为**节点**。这保持单一 Gateway 网关并避免重复配置。本地节点工具目前仅限 macOS，但我们计划扩展到其他操作系统。

只有在需要**硬隔离**或两个完全独立的机器人时才安装第二个 Gateway 网关。

文档：[节点](/nodes)、[节点 CLI](/cli/nodes)、[多 Gateway 网关](/gateway/multiple-gateways)。

### 节点会运行 Gateway 网关服务吗

不会。每台主机上应该只运行**一个 Gateway 网关**，除非你有意运行隔离的配置文件（参阅[多 Gateway 网关](/gateway/multiple-gateways)）。节点是连接到 Gateway 网关的外围设备（iOS/Android 节点，或 macOS 菜单栏应用的“节点模式”）。对于无头节点主机和 CLI 控制，参阅[节点主机 CLI](/cli/node)。

`gateway`、`discovery` 和 `canvasHost` 的更改需要完全重启。

### 有 API / RPC 方式来应用配置吗

有。`config.apply` 验证 + 写入完整配置，并在操作过程中重启 Gateway 网关。

### 首次安装的最小“合理”配置是什么

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

这设置了你的工作区并限制谁可以触发机器人。

### 如何在 VPS 上设置 Tailscale 并从 Mac 连接

最简步骤：

1. **在 VPS 上安装并登录**
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. **在 Mac 上安装并登录**
   - 使用 Tailscale 应用并登录到同一个 tailnet。
3. **启用 MagicDNS（推荐）**
   - 在 Tailscale 管理控制台中启用 MagicDNS，这样 VPS 有一个稳定的名称。
4. **使用 tailnet 主机名**
   - SSH：`ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway 网关 WS：`ws://your-vps.tailnet-xxxx.ts.net:18789`

如果你想要无 SSH 的控制 UI，在 VPS 上使用 Tailscale Serve：

```bash
openclaw gateway --tailscale serve
```

这保持 Gateway 网关绑定到 local loopback 并通过 Tailscale 暴露 HTTPS。参阅 [Tailscale](/gateway/tailscale)。

### 如何将 Mac 节点连接到远程 Gateway 网关（Tailscale Serve）

Serve 暴露 **Gateway 网关控制 UI + WS**。节点通过同一个 Gateway 网关 WS 端点连接。

推荐设置：

1. **确保 VPS + Mac 在同一个 tailnet 上**。
2. **使用 macOS 应用的远程模式**（SSH 目标可以是 tailnet 主机名）。应用会隧道 Gateway 网关端口并作为节点连接。
3. **在 Gateway 网关上批准节点**：
   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

文档：[Gateway 网关协议](/gateway/protocol)、[发现](/gateway/discovery)、[macOS 远程模式](/platforms/mac/remote)。

## 环境变量和 .env 加载

### OpenClaw 如何加载环境变量

OpenClaw 从父进程（shell、launchd/systemd、CI 等）读取环境变量，并额外加载：

- 当前工作目录下的 `.env`
- `~/.openclaw/.env`（即 `$OPENCLAW_STATE_DIR/.env`）的全局回退 `.env`

两个 `.env` 文件都不会覆盖已有的环境变量。

你也可以在配置中定义内联环境变量（仅在进程环境中缺失时应用）：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

参阅 [/environment](/environment) 了解优先级和来源详情。

### 我通过服务启动了 Gateway 网关，但环境变量消失了，怎么办

两个常见修复方法：

1. 将缺失的密钥放在 `~/.openclaw/.env` 中，这样即使服务不继承你的 shell 环境也能被获取。
2. 启用 shell 导入（可选的便利功能）：

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

这会运行你的登录 shell 并仅导入缺失的预期键名（从不覆盖）。环境变量等效项：
`OPENCLAW_LOAD_SHELL_ENV=1`、`OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`。

### 我设置了 COPILOT_GITHUB_TOKEN，但 models status 显示"Shell env: off"，为什么

`openclaw models status` 报告的是 **shell 环境导入**是否启用。"Shell env: off"**不**意味着你的环境变量缺失——它只意味着 OpenClaw 不会自动加载你的登录 shell。

如果 Gateway 网关作为服务（launchd/systemd）运行，它不会继承你的 shell 环境。通过以下方式之一修复：

1. 将令牌放在 `~/.openclaw/.env` 中：
   ```
   COPILOT_GITHUB_TOKEN=...
   ```
2. 或启用 shell 导入（`env.shellEnv.enabled: true`）。
3. 或将其添加到配置的 `env` 块中（仅在缺失时应用）。

然后重启 Gateway 网关并重新检查：

```bash
openclaw models status
```

Copilot 令牌从 `COPILOT_GITHUB_TOKEN` 读取（也支持 `GH_TOKEN` / `GITHUB_TOKEN`）。
参阅 [/concepts/model-providers](/concepts/model-providers) 和 [/environment](/environment)。

## 会话与多聊天

### 如何开始一个新对话

发送 `/new` 或 `/reset` 作为独立消息。参阅[会话管理](/concepts/session)。

### 如果我从不发送 /new，会话会自动重置吗

会。会话在 `session.idleMinutes`（默认 **60**）后过期。**下一条**消息会为该聊天键开始一个新的会话 ID。这不会删除记录——只是开始一个新会话。

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### 能否创建一个 OpenClaw 实例团队——一个 CEO 和多个智能体

可以，通过**多智能体路由**和**子智能体**。你可以创建一个协调器智能体和多个工作者智能体，每个都有自己的工作区和模型。

话虽如此，最好将其视为一个**有趣的实验**。它消耗大量令牌，通常不如使用一个机器人配合不同会话的效率高。我们设想的典型模型是一个你与之对话的机器人，用不同的会话进行并行工作。该机器人也可以在需要时生成子智能体。

文档：[多智能体路由](/concepts/multi-agent)、[子智能体](/tools/subagents)、[智能体 CLI](/cli/agents)。

### 为什么上下文在任务中途被截断了？如何防止

会话上下文受模型窗口限制。长对话、大量工具输出或许多文件可能触发压缩或截断。

有帮助的做法：

- 要求机器人总结当前状态并写入文件。
- 在长任务之前使用 `/compact`，切换话题时使用 `/new`。
- 将重要上下文保存在工作区中，要求机器人读取。
- 对长时间或并行工作使用子智能体，这样主聊天保持较小。
- 如果这种情况经常发生，选择具有更大上下文窗口的模型。

### 如何完全重置 OpenClaw 但保留安装

使用重置命令：

```bash
openclaw reset
```

非交互式完整重置：

```bash
openclaw reset --scope full --yes --non-interactive
```

然后重新运行新手引导：

```bash
openclaw onboard --install-daemon
```

注意：

- 新手引导向导在看到现有配置时也提供**重置**选项。参阅[向导](/start/wizard)。
- 如果你使用了配置文件（`--profile` / `OPENCLAW_PROFILE`），重置每个状态目录（默认为 `~/.openclaw-<profile>`）。
- 开发重置：`openclaw gateway --dev --reset`（仅限开发；清除开发配置 + 凭据 + 会话 + 工作区）。

### 我遇到了 context too large 错误——如何重置或压缩

使用以下方式之一：

- **压缩**（保留对话但总结较早的轮次）：

  ```
  /compact
  ```

  或 `/compact <instructions>` 来引导总结。

- **重置**（为同一聊天键开始新的会话 ID）：
  ```
  /new
  /reset
  ```

如果持续出现：

- 启用或调整**会话修剪**（`agents.defaults.contextPruning`）以裁剪旧的工具输出。
- 使用具有更大上下文窗口的模型。

文档：[压缩](/concepts/compaction)、[会话修剪](/concepts/session-pruning)、[会话管理](/concepts/session)。

### 为什么我看到 LLM request rejected: messages.N.content.X.tool_use.input: Field required

这是一个提供商验证错误：模型发出了一个没有必需 `input` 的 `tool_use` 块。通常意味着会话历史已过时或损坏（通常在长线程或工具/模式变更后发生）。

修复：使用 `/new`（独立消息）开始新会话。

### 为什么每 30 分钟收到一次心跳消息

心跳默认每 **30 分钟**运行一次。调整或禁用：

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // 或 "0m" 禁用
      },
    },
  },
}
```

如果 `HEARTBEAT.md` 存在但实际上为空（只有空行和 markdown 标题如 `# Heading`），OpenClaw 会跳过心跳运行以节省 API 调用。如果文件不存在，心跳仍然运行，由模型决定做什么。

按智能体覆盖使用 `agents.list[].heartbeat`。文档：[心跳](/gateway/heartbeat)。

### 需要在 WhatsApp 群组中添加“机器人账号”吗

不需要。OpenClaw 运行在**你自己的账户**上，所以如果你在群组中，OpenClaw 就能看到它。
默认情况下，群组回复被阻止，直到你允许发送者（`groupPolicy: "allowlist"`）。

如果你只想**你自己**能触发群组回复：

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

### 如何获取 WhatsApp 群组的 JID

方法 1（最快）：跟踪日志并在群组中发送测试消息：

```bash
openclaw logs --follow --json
```

查找以 `@g.us` 结尾的 `chatId`（或 `from`），如：
`1234567890-1234567890@g.us`。

方法 2（如果已配置/加入允许列表）：从配置中列出群组：

```bash
openclaw directory groups list --channel whatsapp
```

文档：[WhatsApp](/channels/whatsapp)、[目录](/cli/directory)、[日志](/cli/logs)。

### 为什么 OpenClaw 不在群组中回复

两个常见原因：

- 提及限制已开启（默认）。你必须 @提及机器人（或匹配 `mentionPatterns`）。
- 你配置了 `channels.whatsapp.groups` 但没有 `"*"` 且该群组未加入允许列表。

参阅[群组](/concepts/groups)和[群组消息](/concepts/group-messages)。

### 群组/线程与私聊共享上下文吗

直接聊天默认折叠到主会话。群组/频道有自己的会话键，Telegram 话题 / Discord 线程是独立的会话。参阅[群组](/concepts/groups)和[群组消息](/concepts/group-messages)。

### 可以创建多少个工作区和智能体

没有硬性限制。几十个（甚至几百个）都没问题，但请注意：

- **磁盘增长：** 会话 + 记录位于 `~/.openclaw/agents/<agentId>/sessions/` 下。
- **令牌成本：** 更多智能体意味着更多并发模型使用。
- **运维开销：** 按智能体的认证配置文件、工作区和渠道路由。

提示：

- 每个智能体保持一个**活跃**工作区（`agents.defaults.workspace`）。
- 如果磁盘增长，修剪旧会话（删除 JSONL 或存储条目）。
- 使用 `openclaw doctor` 发现无用的工作区和配置文件不匹配。

### 可以同时运行多个机器人或聊天（Slack）吗？应该如何设置

可以。使用**多智能体路由**运行多个隔离的智能体，并按渠道/账户/对等方路由入站消息。Slack 作为渠道受支持，可以绑定到特定智能体。

浏览器访问功能强大，但不是“能做人类能做的一切”——反机器人、验证码和 MFA 仍然可以阻止自动化。为了最可靠的浏览器控制，在运行浏览器的机器上使用 Chrome 扩展中继（Gateway 网关可以在任何地方）。

最佳实践设置：

- 常开 Gateway 网关主机（VPS/Mac mini）。
- 每个角色一个智能体（绑定）。
- Slack 渠道绑定到这些智能体。
- 需要时通过扩展中继（或节点）使用本地浏览器。

文档：[多智能体路由](/concepts/multi-agent)、[Slack](/channels/slack)、
[浏览器](/tools/browser)、[Chrome 扩展](/tools/chrome-extension)、[节点](/nodes)。

## 模型：默认值、选择、别名、切换

### 什么是“默认模型”

OpenClaw 的默认模型是你设置的：

```
agents.defaults.model.primary
```

模型以 `provider/model` 引用（示例：`anthropic/claude-opus-4-5`）。如果你省略提供商，OpenClaw 目前假设 `anthropic` 作为临时弃用回退——但你仍然应该**明确**设置 `provider/model`。

### 推荐什么模型

**推荐默认：** `anthropic/claude-opus-4-5`。
**好的替代：** `anthropic/claude-sonnet-4-5`。
**可靠（个性较少）：** `openai/gpt-5.2`——几乎和 Opus 一样好，只是个性较少。
**经济：** `zai/glm-4.7`。

MiniMax M2.1 有自己的文档：[MiniMax](/providers/minimax) 和
[本地模型](/gateway/local-models)。

经验法则：高风险工作使用你能负担的**最好的模型**，日常聊天或摘要使用更便宜的模型。你可以按智能体路由模型并使用子智能体并行处理长任务（每个子智能体消耗令牌）。参阅[模型](/concepts/models)和[子智能体](/tools/subagents)。

重要警告：较弱/过度量化的模型更容易受到提示注入和不安全行为的影响。参阅[安全](/gateway/security)。

更多上下文：[模型](/concepts/models)。

### 可以使用自托管模型（llama.cpp、vLLM、Ollama）吗

可以。如果你的本地服务器暴露了兼容 OpenAI 的 API，你可以将自定义提供商指向它。Ollama 直接支持，是最简单的路径。

安全说明：较小或大幅量化的模型更容易受到提示注入的影响。我们强烈建议对任何可以使用工具的机器人使用**大型模型**。如果你仍然想使用小模型，启用沙箱和严格的工具允许列表。

文档：[Ollama](/providers/ollama)、[本地模型](/gateway/local-models)、
[模型提供商](/concepts/model-providers)、[安全](/gateway/security)、
[沙箱](/gateway/sandboxing)。

### 如何在不清空配置的情况下切换模型

使用**模型命令**或只编辑**模型**字段。避免完整配置替换。

安全选项：

- 聊天中的 `/model`（快速，按会话）
- `openclaw models set ...`（只更新模型配置）
- `openclaw configure --section models`（交互式）
- 编辑 `~/.openclaw/openclaw.json` 中的 `agents.defaults.model`

避免使用部分对象执行 `config.apply`，除非你打算替换整个配置。如果你确实覆盖了配置，从备份恢复或重新运行 `openclaw doctor` 来修复。

文档：[模型](/concepts/models)、[Configure](/cli/configure)、[Config](/cli/config)、[Doctor](/gateway/doctor)。

### OpenClaw、Flawd 和 Krill 使用什么模型

- **OpenClaw + Flawd：** Anthropic Opus（`anthropic/claude-opus-4-5`）——参阅 [Anthropic](/providers/anthropic)。
- **Krill：** MiniMax M2.1（`minimax/MiniMax-M2.1`）——参阅 [MiniMax](/providers/minimax)。

### 如何在运行中切换模型（无需重启）

使用 `/model` 命令作为独立消息：

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

你可以使用 `/model`、`/model list` 或 `/model status` 列出可用模型。

`/model`（和 `/model list`）显示紧凑的编号选择器。按编号选择：

```
/model 3
```

你也可以为提供商强制指定特定的认证配置文件（按会话）：

```
/model opus@anthropic:default
/model opus@anthropic:work
```

提示：`/model status` 显示哪个智能体是活跃的、正在使用哪个 `auth-profiles.json` 文件，以及接下来将尝试哪个认证配置文件。
它还显示配置的提供商端点（`baseUrl`）和 API 模式（`api`）（如果可用）。

**如何取消用 @profile 设置的配置文件固定**

重新运行 `/model` 但**不带** `@profile` 后缀：

```
/model anthropic/claude-opus-4-5
```

如果你想返回默认值，从 `/model` 中选择（或发送 `/model <default provider/model>`）。
使用 `/model status` 确认哪个认证配置文件是活跃的。

### 能否日常任务用 GPT 5.2，编程用 Codex 5.2

可以。设置一个为默认并按需切换：

- **快速切换（按会话）：** 日常任务用 `/model gpt-5.2`，编程用 `/model gpt-5.2-codex`。
- **默认 + 切换：** 将 `agents.defaults.model.primary` 设置为 `openai-codex/gpt-5.2`，然后编程时切换到 `openai-codex/gpt-5.2-codex`（或反过来）。
- **子智能体：** 将编程任务路由到具有不同默认模型的子智能体。

参阅[模型](/concepts/models)和[斜杠命令](/tools/slash-commands)。

### 为什么我看到"Model … is not allowed"然后没有回复

如果设置了 `agents.defaults.models`，它成为 `/model` 和任何会话覆盖的**允许列表**。选择不在该列表中的模型会返回：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

该错误**代替**正常回复返回。修复：将模型添加到 `agents.defaults.models`，移除允许列表，或从 `/model list` 中选择一个模型。

### 为什么我看到"Unknown model: minimax/MiniMax-M2.1"

这意味着**提供商未配置**（未找到 MiniMax 提供商配置或认证配置文件），因此模型无法解析。此检测的修复在 **2026.1.12**（撰写本文时尚未发布）中。

修复清单：

1. 升级到 **2026.1.12**（或从源码 `main` 运行），然后重启 Gateway 网关。
2. 确保 MiniMax 已配置（向导或 JSON），或者 MiniMax API 密钥存在于环境/认证配置文件中以便提供商可以被注入。
3. 使用精确的模型 ID（区分大小写）：`minimax/MiniMax-M2.1` 或 `minimax/MiniMax-M2.1-lightning`。
4. 运行：
   ```bash
   openclaw models list
   ```
   并从列表中选择（或在聊天中使用 `/model list`）。

参阅 [MiniMax](/providers/minimax) 和[模型](/concepts/models)。

### 能否将 MiniMax 设为默认，复杂任务用 OpenAI

可以。使用 **MiniMax 作为默认**，需要时**按会话**切换模型。故障转移用于**错误**，而非“困难任务”，所以使用 `/model` 或单独的智能体。

**方案 A：按会话切换**

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

然后：

```
/model gpt
```

**方案 B：分离智能体**

- 智能体 A 默认：MiniMax
- 智能体 B 默认：OpenAI
- 按智能体路由或使用 `/agent` 切换

文档：[模型](/concepts/models)、[多智能体路由](/concepts/multi-agent)、[MiniMax](/providers/minimax)、[OpenAI](/providers/openai)。

### opus / sonnet / gpt 是内置快捷方式吗

是的。OpenClaw 内置了一些默认简写（仅在模型存在于 `agents.defaults.models` 中时应用）：

- `opus` → `anthropic/claude-opus-4-5`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

如果你设置了同名的自定义别名，你的值优先。

### 如何定义/覆盖模型快捷方式（别名）

别名来自 `agents.defaults.models.<modelId>.alias`。示例：

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-5" },
      models: {
        "anthropic/claude-opus-4-5": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

然后 `/model sonnet`（或支持时的 `/<alias>`）解析为该模型 ID。

### 如何添加其他提供商（如 OpenRouter 或 Z.AI）的模型

OpenRouter（按令牌付费；多种模型）：

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

Z.AI（GLM 模型）：

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

如果你引用了 provider/model 但缺少所需的提供商密钥，你会收到运行时认证错误（例如 `No API key found for provider "zai"`）。

**添加新智能体后提示 No API key found for provider**

这通常意味着**新智能体**的认证存储为空。认证是按智能体的，存储在：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

修复选项：

- 运行 `openclaw agents add <id>` 并在向导中配置认证。
- 或从主智能体的 `agentDir` 复制 `auth-profiles.json` 到新智能体的 `agentDir`。

**不要**在智能体之间重用 `agentDir`；这会导致认证/会话冲突。

## 模型故障转移与"All models failed"

### 故障转移是如何工作的

故障转移分两个阶段：

1. 同一提供商内的**认证配置文件轮换**。
2. **模型回退**到 `agents.defaults.model.fallbacks` 中的下一个模型。

冷却期适用于失败的配置文件（指数退避），因此 OpenClaw 即使在提供商被限速或临时失败时也能继续响应。

### 这个错误是什么意思

```
No credentials found for profile "anthropic:default"
```

这意味着系统尝试使用认证配置文件 ID `anthropic:default`，但在预期的认证存储中找不到它的凭据。

### No credentials found for profile "anthropic:default" 的修复清单

- **确认认证配置文件的位置**（新路径 vs 旧路径）
  - 当前：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - 旧版：`~/.openclaw/agent/*`（通过 `openclaw doctor` 迁移）
- **确认环境变量被 Gateway 网关加载**
  - 如果你在 shell 中设置了 `ANTHROPIC_API_KEY` 但通过 systemd/launchd 运行 Gateway 网关，它可能不会继承。将其放在 `~/.openclaw/.env` 中或启用 `env.shellEnv`。
- **确保你编辑的是正确的智能体**
  - 多智能体设置意味着可能有多个 `auth-profiles.json` 文件。
- **完整性检查模型/认证状态**
  - 使用 `openclaw models status` 查看已配置的模型以及提供商是否已认证。

**No credentials found for profile "anthropic" 的修复清单**

这意味着运行固定到 Anthropic 认证配置文件，但 Gateway 网关在其认证存储中找不到它。

- **使用 setup-token**
  - 运行 `claude setup-token`，然后用 `openclaw models auth setup-token --provider anthropic` 粘贴。
  - 如果令牌在另一台机器上创建，使用 `openclaw models auth paste-token --provider anthropic`。
- **如果你想使用 API 密钥**
  - 在 **Gateway 网关主机**上将 `ANTHROPIC_API_KEY` 放入 `~/.openclaw/.env`。
  - 清除任何强制缺失配置文件的固定顺序：
    ```bash
    openclaw models auth order clear --provider anthropic
    ```
- **确认你在 Gateway 网关主机上运行命令**
  - 在远程模式下，认证配置文件位于 Gateway 网关机器上，而不是你的笔记本上。

### 为什么还尝试了 Google Gemini 并且失败了

如果你的模型配置包含 Google Gemini 作为回退（或你切换到了 Gemini 简写），OpenClaw 会在模型回退期间尝试它。如果你没有配置 Google 凭据，你会看到 `No API key found for provider "google"`。

修复：提供 Google 认证，或从 `agents.defaults.model.fallbacks` / 别名中移除/避免 Google 模型，这样回退不会路由到那里。

**LLM request rejected message thinking signature required google antigravity**

原因：会话历史包含**没有签名的 thinking 块**（通常来自中止/部分流）。Google Antigravity 要求 thinking 块有签名。

修复：OpenClaw 现在为 Google Antigravity Claude 剥离未签名的 thinking 块。如果仍然出现，开始**新会话**或为该智能体设置 `/thinking off`。

## 认证配置文件：概念和管理方式

相关：[/concepts/oauth](/concepts/oauth)（OAuth 流程、令牌存储、多账户模式）

### 什么是认证配置文件

认证配置文件是绑定到提供商的命名凭据记录（OAuth 或 API 密钥）。配置文件位于：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### 典型的配置文件 ID 有哪些

OpenClaw 使用提供商前缀的 ID，如：

- `anthropic:default`（没有邮箱身份时常见）
- `anthropic:<email>`（用于 OAuth 身份）
- 你自定义的 ID（例如 `anthropic:work`）

### 可以控制首先尝试哪个认证配置文件吗

可以。配置支持配置文件的可选元数据和按提供商的排序（`auth.order.<provider>`）。这**不**存储密钥；它将 ID 映射到 provider/mode 并设置轮换顺序。

如果某个配置文件处于短期**冷却**（速率限制/超时/认证失败）或较长的**禁用**状态（计费/额度不足），OpenClaw 可能会临时跳过它。要检查这一点，运行 `openclaw models status --json` 并查看 `auth.unusableProfiles`。调优：`auth.cooldowns.billingBackoffHours*`。

你也可以通过 CLI 设置**按智能体**的顺序覆盖（存储在该智能体的 `auth-profiles.json` 中）：

```bash
# 默认为配置的默认智能体（省略 --agent）
openclaw models auth order get --provider anthropic

# 将轮换锁定到单个配置文件（只尝试这一个）
openclaw models auth order set --provider anthropic anthropic:default

# 或设置明确的顺序（提供商内回退）
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# 清除覆盖（回退到配置 auth.order / 轮换）
openclaw models auth order clear --provider anthropic
```

要针对特定智能体：

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth 与 API 密钥：有什么区别

OpenClaw 两者都支持：

- **OAuth** 通常利用订阅访问（如适用）。
- **API 密钥** 使用按令牌付费的计费。

向导明确支持 Anthropic setup-token 和 OpenAI Codex OAuth，也可以为你存储 API 密钥。

## Gateway 网关：端口、“已在运行”和远程模式

### Gateway 网关使用什么端口

`gateway.port` 控制用于 WebSocket + HTTP（控制 UI、钩子等）的单个复用端口。

优先级：

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > 默认 18789
```

### 为什么 openclaw gateway status 显示 Runtime: running 但 RPC probe: failed

因为"running"是 **supervisor** 的视角（launchd/systemd/schtasks）。RPC 探测是 CLI 实际连接到 Gateway 网关 WebSocket 并调用 `status`。

使用 `openclaw gateway status` 并关注这些行：

- `Probe target:`（探测实际使用的 URL）
- `Listening:`（端口上实际绑定的内容）
- `Last gateway error:`（进程存活但端口未监听时的常见根因）

### 为什么 openclaw gateway status 显示 Config (cli) 和 Config (service) 不同

你正在编辑一个配置文件，而服务运行的是另一个（通常是 `--profile` / `OPENCLAW_STATE_DIR` 不匹配）。

修复：

```bash
openclaw gateway install --force
```

从你希望服务使用的相同 `--profile` / 环境运行该命令。

### "another gateway instance is already listening"是什么意思

OpenClaw 通过在启动时立即绑定 WebSocket 监听器来强制运行时锁（默认 `ws://127.0.0.1:18789`）。如果绑定因 `EADDRINUSE` 失败，它会抛出 `GatewayLockError` 表示另一个实例已在监听。

修复：停止另一个实例，释放端口，或使用 `openclaw gateway --port <port>` 运行。

### 如何以远程模式运行 OpenClaw（客户端连接到其他位置的 Gateway 网关）

设置 `gateway.mode: "remote"` 并指向远程 WebSocket URL，可选带令牌/密码：

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

注意：

- `openclaw gateway` 仅在 `gateway.mode` 为 `local` 时启动（或你传递覆盖标志）。
- macOS 应用监视配置文件，当这些值更改时实时切换模式。

### 控制 UI 显示"unauthorized"或持续重连，怎么办

你的 Gateway 网关运行时启用了认证（`gateway.auth.*`），但 UI 没有发送匹配的令牌/密码。

事实（来自代码）：

- 控制 UI 将令牌存储在浏览器 localStorage 键 `openclaw.control.settings.v1` 中。
- UI 可以导入一次 `?token=...`（和/或 `?password=...`），然后从 URL 中剥离。

修复：

- 最快：`openclaw dashboard`（打印 + 复制带令牌的链接，尝试打开；如果无头则显示 SSH 提示）。
- 如果你还没有令牌：`openclaw doctor --generate-gateway-token`。
- 如果是远程，先建隧道：`ssh -N -L 18789:127.0.0.1:18789 user@host` 然后打开 `http://127.0.0.1:18789/?token=...`。
- 在 Gateway 网关主机上设置 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）。
- 在控制 UI 设置中粘贴相同的令牌（或使用一次性 `?token=...` 链接刷新）。
- 仍然卡住？运行 `openclaw status --all` 并按[故障排除](/gateway/troubleshooting)操作。参阅[仪表板](/web/dashboard)了解认证详情。

### 我设置了 gateway.bind: "tailnet" 但无法绑定 / 什么都没监听

`tailnet` 绑定从你的网络接口中选择 Tailscale IP（100.64.0.0/10）。如果机器没有在 Tailscale 上（或接口已关闭），就没有可绑定的地址。

修复：

- 在该主机上启动 Tailscale（使其拥有 100.x 地址），或
- 切换到 `gateway.bind: "loopback"` / `"lan"`。

注意：`tailnet` 是明确的。`auto` 优先 local loopback；当你想要仅 tailnet 绑定时使用 `gateway.bind: "tailnet"`。

### 可以在同一主机上运行多个 Gateway 网关吗

通常不需要——一个 Gateway 网关可以运行多个消息渠道和智能体。仅在需要冗余（例如救援机器人）或硬隔离时使用多个 Gateway 网关。

可以，但你必须隔离：

- `OPENCLAW_CONFIG_PATH`（每实例配置）
- `OPENCLAW_STATE_DIR`（每实例状态）
- `agents.defaults.workspace`（工作区隔离）
- `gateway.port`（唯一端口）

快速设置（推荐）：

- 每实例使用 `openclaw --profile <name> …`（自动创建 `~/.openclaw-<name>`）。
- 在每个配置文件配置中设置唯一的 `gateway.port`（或手动运行时传 `--port`）。
- 安装每配置文件的服务：`openclaw --profile <name> gateway install`。

配置文件还会为服务名称添加后缀（`bot.molt.<profile>`；旧版 `com.openclaw.*`、`openclaw-gateway-<profile>.service`、`OpenClaw Gateway 网关 (<profile>)`）。
完整指南：[多 Gateway 网关](/gateway/multiple-gateways)。

### "invalid handshake" / code 1008 是什么意思

Gateway 网关是一个 **WebSocket 服务器**，它期望第一条消息是 `connect` 帧。如果收到其他内容，它会以 **code 1008**（策略违规）关闭连接。

常见原因：

- 你在浏览器中打开了 **HTTP** URL（`http://...`）而不是 WS 客户端。
- 你使用了错误的端口或路径。
- 代理或隧道剥离了认证头或发送了非 Gateway 网关请求。

快速修复：

1. 使用 WS URL：`ws://<host>:18789`（或 `wss://...` 如果 HTTPS）。
2. 不要在普通浏览器标签页中打开 WS 端口。
3. 如果认证已启用，在 `connect` 帧中包含令牌/密码。

如果你使用 CLI 或 TUI，URL 应该类似：

```
openclaw tui --url ws://<host>:18789 --token <token>
```

协议详情：[Gateway 网关协议](/gateway/protocol)。

## 日志与调试

### 日志在哪里

文件日志（结构化）：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

你可以通过 `logging.file` 设置稳定路径。文件日志级别由 `logging.level` 控制。控制台详细度由 `--verbose` 和 `logging.consoleLevel` 控制。

最快的日志跟踪：

```bash
openclaw logs --follow
```

服务/supervisor 日志（当 Gateway 网关通过 launchd/systemd 运行时）：

- macOS：`$OPENCLAW_STATE_DIR/logs/gateway.log` 和 `gateway.err.log`（默认：`~/.openclaw/logs/...`；配置文件使用 `~/.openclaw-<profile>/logs/...`）
- Linux：`journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows：`schtasks /Query /TN "OpenClaw Gateway 网关 (<profile>)" /V /FO LIST`

参阅[故障排除](/gateway/troubleshooting#log-locations)了解更多。

### 如何启动/停止/重启 Gateway 网关服务

使用 Gateway 网关辅助命令：

```bash
openclaw gateway status
openclaw gateway restart
```

如果你手动运行 Gateway 网关，`openclaw gateway --force` 可以回收端口。参阅 [Gateway 网关](/gateway)。

### 我在 Windows 上关闭了终端——如何重启 OpenClaw

有**两种 Windows 安装模式**：

**1) WSL2（推荐）：** Gateway 网关运行在 Linux 内部。

打开 PowerShell，进入 WSL，然后重启：

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

如果你从未安装服务，在前台启动：

```bash
openclaw gateway run
```

**2) 原生 Windows（不推荐）：** Gateway 网关直接在 Windows 中运行。

打开 PowerShell 并运行：

```powershell
openclaw gateway status
openclaw gateway restart
```

如果你手动运行（无服务），使用：

```powershell
openclaw gateway run
```

文档：[Windows (WSL2)](/platforms/windows)、[Gateway 网关服务运维手册](/gateway)。

### Gateway 网关已启动但回复始终不到达，应该检查什么

从快速健康扫描开始：

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

常见原因：

- 模型认证未在 **Gateway 网关主机**上加载（检查 `models status`）。
- 渠道配对/允许列表阻止回复（检查渠道配置 + 日志）。
- WebChat/仪表板打开但没有正确的令牌。

如果你在远程，确认隧道/Tailscale 连接正常且 Gateway 网关 WebSocket 可达。

文档：[渠道](/channels)、[故障排除](/gateway/troubleshooting)、[远程访问](/gateway/remote)。

### "Disconnected from gateway: no reason"——怎么办

这通常意味着 UI 丢失了 WebSocket 连接。检查：

1. Gateway 网关在运行吗？`openclaw gateway status`
2. Gateway 网关健康吗？`openclaw status`
3. UI 有正确的令牌吗？`openclaw dashboard`
4. 如果是远程，隧道/Tailscale 链接正常吗？

然后跟踪日志：

```bash
openclaw logs --follow
```

文档：[仪表板](/web/dashboard)、[远程访问](/gateway/remote)、[故障排除](/gateway/troubleshooting)。

### Telegram setMyCommands 因网络错误失败，应该检查什么

从日志和渠道状态开始：

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

如果你在 VPS 上或代理后面，确认出站 HTTPS 被允许且 DNS 正常工作。
如果 Gateway 网关在远程，确保你在 Gateway 网关主机上查看日志。

文档：[Telegram](/channels/telegram)、[渠道故障排除](/channels/troubleshooting)。

### TUI 没有输出，应该检查什么

首先确认 Gateway 网关可达且智能体可以运行：

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

在 TUI 中，使用 `/status` 查看当前状态。如果你期望在聊天渠道中收到回复，确保投递已启用（`/deliver on`）。

文档：[TUI](/tui)、[斜杠命令](/tools/slash-commands)。

### 如何完全停止然后启动 Gateway 网关如果你安装了服务：

```bash
openclaw gateway stop
openclaw gateway start
```

这会停止/启动**受监管的服务**（macOS 上的 launchd，Linux 上的 systemd）。
当 Gateway 网关作为守护进程在后台运行时使用此命令。

如果你在前台运行，用 Ctrl‑C 停止，然后：

```bash
openclaw gateway run
```

文档：[Gateway 网关服务运维手册](/gateway)。

### 通俗解释：openclaw gateway restart 与 openclaw gateway

- `openclaw gateway restart`：重启**后台服务**（launchd/systemd）。
- `openclaw gateway`：在这个终端会话中**前台**运行 Gateway 网关。

如果你安装了服务，使用 Gateway 网关命令。想要一次性前台运行时使用 `openclaw gateway`。

### 出现故障时获取更多详情的最快方法是什么

使用 `--verbose` 启动 Gateway 网关以获取更多控制台详情。然后检查日志文件中的渠道认证、模型路由和 RPC 错误。

## 媒体与附件

### 我的 Skills 生成了图片/PDF，但什么都没发送

智能体的出站附件必须包含 `MEDIA:<path-or-url>` 行（独占一行）。参阅 [OpenClaw 助手设置](/start/openclaw)和 [Agent send](/tools/agent-send)。

CLI 发送：

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

还要检查：

- 目标渠道支持出站媒体且未被允许列表阻止。
- 文件在提供商的大小限制内（图片会调整到最大 2048px）。

参阅[图片](/nodes/images)。

## 安全与访问控制

### 将 OpenClaw 暴露给入站私信安全吗

将入站私信视为不可信输入。默认设计旨在降低风险：

- 支持私信的渠道上的默认行为是**配对**：
  - 未知发送者会收到配对码；机器人不处理他们的消息。
  - 批准方式：`openclaw pairing approve <channel> <code>`
  - 每个渠道的待处理请求上限为 **3 个**；如果没收到代码，检查 `openclaw pairing list <channel>`。
- 公开开放私信需要明确选择加入（`dmPolicy: "open"` 且允许列表 `"*"`）。

运行 `openclaw doctor` 以发现有风险的私信策略。

### 提示注入只对公开机器人有影响吗

不是。提示注入是关于**不可信内容**，不仅仅是谁能给机器人发私信。如果你的助手读取外部内容（网络搜索/抓取、浏览器页面、邮件、文档、附件、粘贴的日志），这些内容可能包含试图劫持模型的指令。即使**你是唯一的发送者**，这也可能发生。

最大的风险是在启用工具时：模型可能被诱导泄露上下文或代表你调用工具。通过以下方式减少影响范围：

- 使用只读或禁用工具的“阅读器”智能体来总结不可信内容
- 对启用工具的智能体关闭 `web_search` / `web_fetch` / `browser`
- 沙箱隔离和严格的工具允许列表

详情：[安全](/gateway/security)。

### 我的机器人应该有自己的邮箱、GitHub 账户或电话号码吗

是的，对于大多数设置来说。用独立的账户和电话号码隔离机器人可以在出问题时减少影响范围。这也使得轮换凭据或撤销访问更容易，而不影响你的个人账户。

从小处开始。只授予你实际需要的工具和账户的访问权限，以后需要时再扩展。

文档：[安全](/gateway/security)、[配对](/start/pairing)。

### 我能让它自主管理我的短信吗？这安全吗

我们**不建议**完全自主管理你的个人消息。最安全的模式是：

- 将私信保持在**配对模式**或严格的允许列表中。
- 如果你希望它代表你发消息，使用**独立的号码或账户**。
- 让它起草，然后**发送前批准**。

如果你想实验，在专用账户上进行并保持隔离。参阅[安全](/gateway/security)。

### 个人助理任务可以使用更便宜的模型吗

可以，**如果**智能体仅用于聊天且输入是可信的。较小的模型更容易受到指令劫持，因此避免将它们用于启用工具的智能体或读取不可信内容时。如果你必须使用较小的模型，锁定工具并在沙箱中运行。参阅[安全](/gateway/security)。

### 我在 Telegram 中运行了 /start 但没收到配对码

配对码**仅在**未知发送者向机器人发消息且 `dmPolicy: "pairing"` 启用时发送。`/start` 本身不会生成代码。

检查待处理请求：

```bash
openclaw pairing list telegram
```

如果你想立即获得访问权限，将你的发送者 ID 加入允许列表或为该账户设置 `dmPolicy: "open"`。

### WhatsApp：会给我的联系人发消息吗？配对如何工作

不会。WhatsApp 的默认私信策略是**配对**。未知发送者只会收到配对码，他们的消息**不会被处理**。OpenClaw 只回复它收到的聊天或你明确触发的发送。

批准配对：

```bash
openclaw pairing approve whatsapp <code>
```

列出待处理请求：

```bash
openclaw pairing list whatsapp
```

向导电话号码提示：它用于设置你的**允许列表/所有者**，以便你自己的私信被允许。它不用于自动发送。如果你在个人 WhatsApp 号码上运行，使用该号码并启用 `channels.whatsapp.selfChatMode`。

## 聊天命令、中止任务和“停不下来”

### 如何阻止内部系统消息显示在聊天中

大多数内部或工具消息只在该会话启用了 **verbose** 或 **reasoning** 时才出现。

在你看到它的聊天中修复：

```
/verbose off
/reasoning off
```

如果仍然嘈杂，检查控制 UI 中的会话设置并将 verbose 设为**继承**。同时确认你没有使用在配置中将 `verboseDefault` 设为 `on` 的机器人配置文件。

文档：[思考和详细输出](/tools/thinking)、[安全](/gateway/security#reasoning--verbose-output-in-groups)。

### 如何停止/取消正在运行的任务

发送以下任一内容作为**独立消息**（不带斜杠）：

```
stop
abort
esc
wait
exit
interrupt
```

这些是中止触发器（不是斜杠命令）。

对于后台进程（来自 exec 工具），你可以要求智能体运行：

```
process action:kill sessionId:XXX
```

斜杠命令概览：参阅[斜杠命令](/tools/slash-commands)。

大多数命令必须作为以 `/` 开头的**独立**消息发送，但一些快捷方式（如 `/status`）对允许列表中的发送者也支持内联使用。

### 如何从 Telegram 发送 Discord 消息？（"Cross-context messaging denied"）

OpenClaw 默认阻止**跨提供商**消息。如果工具调用绑定到 Telegram，除非你明确允许，否则不会发送到 Discord。

为智能体启用跨提供商消息：

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

编辑配置后重启 Gateway 网关。如果你只想为单个智能体设置，将其放在 `agents.list[].tools.message` 下。

### 为什么感觉机器人“忽略”了快速连发的消息

队列模式控制新消息如何与正在进行的运行交互。使用 `/queue` 更改模式：

- `steer` - 新消息重定向当前任务
- `followup` - 逐条处理消息
- `collect` - 批量消息并回复一次（默认）
- `steer-backlog` - 立即转向，然后处理积压
- `interrupt` - 中止当前运行并重新开始

你可以为 followup 模式添加选项如 `debounce:2s cap:25 drop:summarize`。

## 从截图/聊天记录中准确回答问题

**问：“使用 API 密钥时 Anthropic 的默认模型是什么？”**

**答：** 在 OpenClaw 中，凭据和模型选择是分开的。设置 `ANTHROPIC_API_KEY`（或在认证配置文件中存储 Anthropic API 密钥）启用认证，但实际的默认模型是你在 `agents.defaults.model.primary` 中配置的（例如 `anthropic/claude-sonnet-4-5` 或 `anthropic/claude-opus-4-5`）。如果你看到 `No credentials found for profile "anthropic:default"`，意味着 Gateway 网关在正在运行的智能体的预期 `auth-profiles.json` 中找不到 Anthropic 凭据。

---

仍然卡住？在 [Discord](https://discord.com/invite/clawd) 中提问或发起 [GitHub 讨论](https://github.com/openclaw/openclaw/discussions)。
