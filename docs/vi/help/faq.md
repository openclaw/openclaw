---
summary: "Các câu hỏi thường gặp về thiết lập, cấu hình và cách dùng OpenClaw"
title: "FAQ"
---

# FAQ

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## Mục lục

- [Khởi động nhanh và thiết lập lần đầu]
  - [Tôi bị kẹt, cách nhanh nhất để thoát là gì?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Cách cài đặt và thiết lập OpenClaw được khuyến nghị là gì?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Làm sao mở dashboard sau khi onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Xác thực dashboard (token) trên localhost so với remote thế nào?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Cần runtime gì?](#what-runtime-do-i-need)
  - [Có chạy trên Raspberry Pi không?](#does-it-run-on-raspberry-pi)
  - [Mẹo nào cho cài đặt Raspberry Pi?](#any-tips-for-raspberry-pi-installs)
  - 45. [Nó bị kẹt ở "wake up my friend" / onboarding không khởi tạo được. What now?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Có thể chuyển setup sang máy mới (Mac mini) mà không làm lại onboarding không?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Xem điểm mới trong phiên bản mới nhất ở đâu?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [I can't access docs.openclaw.ai (SSL error). 46. Giờ phải làm gì?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Khác nhau giữa stable và beta là gì?](#whats-the-difference-between-stable-and-beta)
  - [Cài bản beta thế nào, và beta khác dev ra sao?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Làm sao thử các bản mới nhất?](#how-do-i-try-the-latest-bits)
  - [Cài đặt và onboarding thường mất bao lâu?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer stuck? How do I get more feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows báo git không tìm thấy hoặc openclaw không nhận diện](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Docs không trả lời được câu hỏi của tôi — làm sao có câu trả lời tốt hơn?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Cài OpenClaw trên Linux thế nào?](#how-do-i-install-openclaw-on-linux)
  - [Cài OpenClaw trên VPS thế nào?](#how-do-i-install-openclaw-on-a-vps)
  - [Hướng dẫn cài cloud/VPS ở đâu?](#where-are-the-cloudvps-install-guides)
  - [Có thể yêu cầu OpenClaw tự cập nhật không?](#can-i-ask-openclaw-to-update-itself)
  - [Trình hướng dẫn onboarding thực sự làm gì?](#what-does-the-onboarding-wizard-actually-do)
  - [Có cần gói Claude hay OpenAI để chạy không?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Dùng gói Claude Max không cần API key được không](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Xác thực Anthropic “setup-token” hoạt động ra sao?](#how-does-anthropic-setuptoken-auth-work)
  - [Tìm Anthropic setup-token ở đâu?](#where-do-i-find-an-anthropic-setuptoken)
  - [Có hỗ trợ xác thực thuê bao Claude (Pro hoặc Max) không?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Vì sao tôi thấy `HTTP 429: rate_limit_error` từ Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Có hỗ trợ AWS Bedrock không?](#is-aws-bedrock-supported)
  - [Xác thực Codex hoạt động thế nào?](#how-does-codex-auth-work)
  - [Có hỗ trợ xác thực thuê bao OpenAI (Codex OAuth) không?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Thiết lập Gemini CLI OAuth thế nào](#how-do-i-set-up-gemini-cli-oauth)
  - [Mô hình cục bộ có ổn cho chat thông thường không?](#is-a-local-model-ok-for-casual-chats)
  - [Giữ lưu lượng mô hình hosted trong một vùng cụ thể thế nào?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Có phải mua Mac Mini để cài không?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Có cần Mac mini để hỗ trợ iMessage không?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Nếu mua Mac mini chạy OpenClaw, có kết nối với MacBook Pro được không?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Dùng Bun được không?](#can-i-use-bun)
  - [Telegram: `allowFrom` điền gì?](#telegram-what-goes-in-allowfrom)
  - [Nhiều người có thể dùng chung một số WhatsApp với các instance OpenClaw khác nhau không?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Chạy một tác tử “chat nhanh” và một tác tử “Opus cho coding” được không?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew có chạy trên Linux không?](#does-homebrew-work-on-linux)
  - [Khác nhau giữa cài hackable (git) và npm là gì?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Có thể chuyển qua lại giữa cài npm và git sau này không?](#can-i-switch-between-npm-and-git-installs-later)
  - [Nên chạy Gateway trên laptop hay VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Quan trọng thế nào khi chạy OpenClaw trên máy chuyên dụng?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Yêu cầu VPS tối thiểu và OS khuyến nghị là gì?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Có thể chạy OpenClaw trong VM không và yêu cầu ra sao](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [OpenClaw là gì?](#what-is-openclaw)
  - [OpenClaw là gì, gói gọn trong một đoạn?](#what-is-openclaw-in-one-paragraph)
  - [Giá trị cốt lõi là gì?](#whats-the-value-proposition)
  - [Tôi vừa cài xong, nên làm gì trước?](#i-just-set-it-up-what-should-i-do-first)
  - [Năm trường hợp dùng hằng ngày hàng đầu cho OpenClaw là gì](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw có giúp lead gen, quảng cáo và blog cho SaaS không](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Ưu điểm so với Claude Code cho phát triển web là gì?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills và tự động hóa](#skills-and-automation)
  - [Tùy biến skills mà không làm bẩn repo thế nào?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Có thể tải skills từ thư mục tùy chỉnh không?](#can-i-load-skills-from-a-custom-folder)
  - [Dùng mô hình khác nhau cho các tác vụ khác nhau thế nào?](#how-can-i-use-different-models-for-different-tasks)
  - 47. [Bot bị treo khi đang thực hiện công việc nặng. How do I offload that?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron or reminders do not fire. What should I check?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Cài skills trên Linux thế nào?](#how-do-i-install-skills-on-linux)
  - [OpenClaw có chạy tác vụ theo lịch hoặc liên tục nền không?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Chạy skills chỉ dành cho macOS từ Linux được không?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Có tích hợp Notion hoặc HeyGen không?](#do-you-have-a-notion-or-heygen-integration)
  - [Cài Chrome extension để takeover trình duyệt thế nào?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing và bộ nhớ](#sandboxing-and-memory)
  - [Có tài liệu riêng về sandboxing không?](#is-there-a-dedicated-sandboxing-doc)
  - [Gắn thư mục host vào sandbox thế nào?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Bộ nhớ hoạt động ra sao?](#how-does-memory-work)
  - 48. [Bộ nhớ cứ quên mọi thứ. How do I make it stick?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - 49. [Bộ nhớ có tồn tại vĩnh viễn không? What are the limits?](#does-memory-persist-forever-what-are-the-limits)
  - [Tìm kiếm bộ nhớ ngữ nghĩa có cần API key OpenAI không?](#does-semantic-memory-search-require-an-openai-api-key)
- [Vị trí dữ liệu trên đĩa](#where-things-live-on-disk)
  - [Mọi dữ liệu dùng với OpenClaw đều lưu cục bộ không?](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw lưu dữ liệu ở đâu?](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md nên nằm ở đâu?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Chiến lược sao lưu khuyến nghị là gì?](#whats-the-recommended-backup-strategy)
  - [Gỡ cài đặt OpenClaw hoàn toàn thế nào?](#how-do-i-completely-uninstall-openclaw)
  - [Tác tử có thể làm việc ngoài workspace không?](#can-agents-work-outside-the-workspace)
  - [Tôi ở chế độ remote — kho phiên nằm ở đâu?](#im-in-remote-mode-where-is-the-session-store)
- [Cơ bản về cấu hình](#config-basics)
  - [What format is the config? Where is it?](#what-format-is-the-config-where-is-it)
  - [Tôi đặt `gateway.bind: "lan"` (hoặc `"tailnet"`) và giờ không có gì lắng nghe / UI báo unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Vì sao giờ localhost cũng cần token?](#why-do-i-need-a-token-on-localhost-now)
  - [Có cần khởi động lại sau khi đổi cấu hình không?](#do-i-have-to-restart-after-changing-config)
  - [Bật web search (và web fetch) thế nào?](#how-do-i-enable-web-search-and-web-fetch)
  - 50. [config.apply đã xóa cấu hình của tôi. How do I recover and avoid this?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Chạy một Gateway trung tâm với các worker chuyên biệt trên nhiều thiết bị thế nào?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Trình duyệt OpenClaw chạy headless được không?](#can-the-openclaw-browser-run-headless)
  - [Dùng Brave để điều khiển trình duyệt thế nào?](#how-do-i-use-brave-for-browser-control)
- [Gateway và node từ xa](#remote-gateways-and-nodes)
  - [Lệnh đi qua Telegram, gateway và node thế nào?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Tác tử truy cập máy tôi thế nào nếu Gateway host ở xa?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - Tailscale đã kết nối nhưng tôi không nhận được phản hồi. What now?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Hai instance OpenClaw có nói chuyện với nhau không (local + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Có cần VPS riêng cho nhiều tác tử không](#do-i-need-separate-vpses-for-multiple-agents)
  - [Dùng node trên laptop cá nhân có lợi hơn SSH từ VPS không?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Node có chạy dịch vụ gateway không?](#do-nodes-run-a-gateway-service)
  - [Có API / RPC để áp dụng cấu hình không?](#is-there-an-api-rpc-way-to-apply-config)
  - [Cấu hình “tối thiểu hợp lý” cho cài lần đầu là gì?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Thiết lập Tailscale trên VPS và kết nối từ Mac thế nào?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Kết nối node Mac tới Gateway remote (Tailscale Serve) thế nào?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Nên cài trên laptop thứ hai hay chỉ thêm node?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Biến môi trường và tải .env](#env-vars-and-env-loading)
  - [OpenClaw tải biến môi trường thế nào?](#how-does-openclaw-load-environment-variables)
  - ["Tôi khởi động Gateway qua dịch vụ và các biến env của tôi đã biến mất." What now?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Tôi đã đặt `COPILOT_GITHUB_TOKEN`, nhưng trạng thái models hiển thị "Shell env: off." Why?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Phiên và nhiều cuộc chat](#sessions-and-multiple-chats)
  - [Bắt đầu cuộc trò chuyện mới thế nào?](#how-do-i-start-a-fresh-conversation)
  - [Phiên có tự reset nếu tôi không gửi `/new` không?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Có cách nào tạo đội OpenClaw một CEO và nhiều agent không](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Vì sao ngữ cảnh bị cắt giữa chừng khi đang làm tác vụ? Làm thế nào để ngăn chặn điều đó?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Reset hoàn toàn OpenClaw nhưng vẫn giữ cài đặt thế nào?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Lỗi "context too large" — reset hoặc nén thế nào?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Vì sao tôi thấy "LLM request rejected: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Vì sao tôi nhận heartbeat mỗi 30 phút?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Có cần thêm "tài khoản bot" vào nhóm WhatsApp không?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Lấy JID của nhóm WhatsApp thế nào?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Vì sao OpenClaw không trả lời trong nhóm?](#why-doesnt-openclaw-reply-in-a-group)
  - [Nhóm/thread có chia sẻ ngữ cảnh với DM không?](#do-groupsthreads-share-context-with-dms)
  - [Tạo được bao nhiêu workspace và agent?](#how-many-workspaces-and-agents-can-i-create)
  - [Chạy nhiều bot hoặc chat cùng lúc (Slack) được không, và nên thiết lập thế nào?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Mô hình: mặc định, chọn, alias, chuyển đổi](#models-defaults-selection-aliases-switching)
  - [“Mô hình mặc định” là gì?](#what-is-the-default-model)
  - [Khuyến nghị mô hình nào?](#what-model-do-you-recommend)
  - [Chuyển mô hình mà không xóa cấu hình thế nào?](#how-do-i-switch-models-without-wiping-my-config)
  - [Dùng mô hình tự host (llama.cpp, vLLM, Ollama) được không?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw, Flawd và Krill dùng mô hình gì?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Chuyển mô hình tức thì (không restart) thế nào?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Dùng GPT 5.2 cho việc hằng ngày và Codex 5.3 cho coding được không](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Tại sao tôi thấy "Model … is not allowed" and then no reply?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Vì sao thấy "Unknown model: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Dùng MiniMax làm mặc định và OpenAI cho tác vụ phức tạp được không?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt có phải shortcut tích hợp sẵn không?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Định nghĩa/ghi đè alias mô hình thế nào?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Thêm mô hình từ nhà cung cấp khác như OpenRouter hoặc Z.AI thế nào?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Failover mô hình và “All models failed”](#model-failover-and-all-models-failed)
  - [Failover hoạt động thế nào?](#how-does-failover-work)
  - [Lỗi này nghĩa là gì?](#what-does-this-error-mean)
  - [Danh sách sửa lỗi cho `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Vì sao nó cũng thử Google Gemini rồi thất bại?](#why-did-it-also-try-google-gemini-and-fail)
- [Auth profile: là gì và quản lý thế nào](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Auth profile là gì?](#what-is-an-auth-profile)
  - [ID profile thường gặp là gì?](#what-are-typical-profile-ids)
  - [Có kiểm soát profile nào được thử trước không?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API key: khác nhau gì?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: cổng, “already running”, và chế độ remote](#gateway-ports-already-running-and-remote-mode)
  - [Gateway dùng cổng nào?](#what-port-does-the-gateway-use)
  - [Vì sao `openclaw gateway status` nói `Runtime: running` nhưng `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Vì sao `openclaw gateway status` hiển thị `Config (cli)` và `Config (service)` khác nhau?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [“another gateway instance is already listening” nghĩa là gì?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Chạy OpenClaw ở chế độ remote (client kết nối Gateway ở nơi khác) thế nào?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [Giao diện Control UI hiển thị "unauthorized" (hoặc liên tục kết nối lại). Bây giờ phải làm gì?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Tôi đặt `gateway.bind: "tailnet"` nhưng không bind được / không có gì lắng nghe](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Chạy nhiều Gateway trên cùng host được không?](#can-i-run-multiple-gateways-on-the-same-host)
  - [“invalid handshake” / mã 1008 nghĩa là gì?](#what-does-invalid-handshake-code-1008-mean)
- [Ghi log và debug](#logging-and-debugging)
  - [Log ở đâu?](#where-are-logs)
  - [Bắt đầu/dừng/khởi động lại Gateway service thế nào?](#how-do-i-startstoprestart-the-gateway-service)
  - [Đóng terminal trên Windows rồi — khởi động lại OpenClaw thế nào?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway đang chạy nhưng phản hồi không bao giờ tới. Tôi nên kiểm tra những gì?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason" — giờ sao?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands thất bại với lỗi mạng. What should I check?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI không hiển thị đầu ra. What should I check?](#tui-shows-no-output-what-should-i-check)
  - [Dừng hẳn rồi khởi động lại Gateway thế nào?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Cách nhanh nhất để có thêm chi tiết khi lỗi?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Media và tệp đính kèm](#media-and-attachments)
  - [Skill tạo ảnh/PDF nhưng không gửi gì](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Bảo mật và kiểm soát truy cập](#security-and-access-control)
  - [Có an toàn khi mở OpenClaw cho DM đến không?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Prompt injection chỉ là vấn đề với bot công khai?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Bot có nên có email/tài khoản GitHub/số điện thoại riêng không](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Có thể cho bot tự chủ với tin nhắn của tôi không và có an toàn không](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Dùng mô hình rẻ hơn cho trợ lý cá nhân được không?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Tôi chạy `/start` trong Telegram nhưng không nhận mã ghép đôi](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: nó có nhắn tin cho các liên hệ của tôi không? Cơ chế ghép cặp hoạt động như thế nào?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Lệnh chat, hủy tác vụ, và “nó không dừng”](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Ẩn thông điệp hệ thống nội bộ khỏi chat thế nào](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Dừng/hủy một tác vụ đang chạy thế nào?](#how-do-i-stopcancel-a-running-task)
  - [Làm thế nào để gửi tin nhắn Discord từ Telegram? ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Vì sao bot có vẻ “phớt lờ” tin nhắn dồn dập?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 60 giây đầu nếu có gì đó hỏng

1. **Trạng thái nhanh (kiểm tra đầu tiên)**

   ```bash
   openclaw status
   ```

   Tóm tắt nhanh cục bộ: OS + cập nhật, khả năng truy cập gateway/service, agents/sessions, cấu hình nhà cung cấp + sự cố runtime (khi gateway truy cập được).

2. **Báo cáo có thể dán (an toàn để chia sẻ)**

   ```bash
   openclaw status --all
   ```

   Chẩn đoán chỉ đọc kèm tail log (đã ẩn token).

3. **Trạng thái daemon + cổng**

   ```bash
   openclaw gateway status
   ```

   Hiển thị runtime của supervisor so với khả năng RPC, URL probe, và cấu hình mà service có thể đã dùng.

4. **Probe sâu**

   ```bash
   openclaw status --deep
   ```

   Chạy kiểm tra tình trạng gateway + thăm dò provider (yêu cầu gateway có thể truy cập được). Xem [Health](/gateway/health).

5. **Theo dõi log mới nhất**

   ```bash
   openclaw logs --follow
   ```

   Nếu RPC down, dùng tạm:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   Log file tách biệt với log service; xem [Logging](/logging) và [Troubleshooting](/gateway/troubleshooting).

6. **Chạy doctor (sửa chữa)**

   ```bash
   openclaw doctor
   ```

   Sửa chữa/di chuyển cấu hình/trạng thái + chạy kiểm tra sức khỏe. Xem [Doctor](/gateway/doctor).

7. **Snapshot Gateway**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Yêu cầu gateway đang chạy cung cấp một ảnh chụp đầy đủ (chỉ WS). Xem [Health](/gateway/health).

## Khởi động nhanh và thiết lập lần đầu

### Im stuck whats the fastest way to get unstuck

Sử dụng một agent AI cục bộ có thể **nhìn thấy máy của bạn**. Cách này hiệu quả hơn nhiều so với việc hỏi
trong Discord, vì hầu hết các trường hợp "tôi bị kẹt" là **vấn đề cấu hình hoặc môi trường cục bộ** mà
những người hỗ trợ từ xa không thể kiểm tra.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

Các công cụ này có thể đọc repo, chạy lệnh, kiểm tra log và giúp sửa thiết lập
ở cấp máy của bạn (PATH, dịch vụ, quyền, tệp xác thực). Hãy cung cấp cho họ **toàn bộ bản checkout mã nguồn** thông qua
cài đặt hackable (git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Cách này cài đặt OpenClaw **từ một git checkout**, để agent có thể đọc mã + tài liệu và
lý luận chính xác về phiên bản bạn đang chạy. Bạn luôn có thể chuyển lại bản ổn định sau bằng cách chạy lại trình cài đặt mà không dùng `--install-method git`.

Mẹo: hãy yêu cầu agent **lập kế hoạch và giám sát** việc sửa lỗi (từng bước), sau đó chỉ thực thi
những lệnh thực sự cần thiết. Điều đó giúp thay đổi ít hơn và dễ kiểm tra hơn.

Nếu phát hiện bug thật hoặc có bản sửa, vui lòng tạo issue hoặc PR trên GitHub:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Bắt đầu với các lệnh này (chia sẻ output khi xin trợ giúp):

```bash
openclaw status
openclaw models status
openclaw doctor
```

Ý nghĩa:

- `openclaw status`: snapshot nhanh tình trạng gateway/agent + cấu hình cơ bản.
- `openclaw models status`: kiểm tra xác thực nhà cung cấp + khả dụng mô hình.
- `openclaw doctor`: xác thực và sửa các lỗi cấu hình/trạng thái thường gặp.

Các kiểm tra CLI hữu ích khác: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Vòng debug nhanh: [60 giây đầu tiên khi có gì đó bị hỏng](#first-60-seconds-if-somethings-broken).
Tài liệu cài đặt: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### Cách được khuyến nghị để cài đặt và thiết lập OpenClaw là gì

Repo khuyến nghị chạy từ mã nguồn và dùng trình hướng dẫn onboarding:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

Trình hướng dẫn cũng có thể tự động build các asset UI. Sau khi onboarding, bạn thường chạy Gateway trên cổng **18789**.

Từ mã nguồn (contributors/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # tự động cài đặt các phụ thuộc UI ở lần chạy đầu
openclaw onboard
```

Nếu bạn chưa cài đặt toàn cục, hãy chạy bằng `pnpm openclaw onboard`.

### Làm thế nào để mở dashboard sau khi onboarding

Trình hướng dẫn sẽ mở trình duyệt của bạn với URL dashboard sạch (không có token) ngay sau khi onboarding và cũng in liên kết đó trong phần tóm tắt. Hãy giữ tab đó mở; nếu nó không tự mở, hãy copy/paste URL đã in trên cùng một máy.

### Làm thế nào để xác thực token dashboard trên localhost so với từ xa

**Localhost (cùng máy):**

- Mở `http://127.0.0.1:18789/`.
- Nếu nó yêu cầu xác thực, hãy dán token từ `gateway.auth.token` (hoặc `OPENCLAW_GATEWAY_TOKEN`) vào phần cài đặt Control UI.
- Lấy nó từ máy chủ gateway: `openclaw config get gateway.auth.token` (hoặc tạo một cái: `openclaw doctor --generate-gateway-token`).

**Không phải localhost:**

- **Tailscale Serve** (khuyến nghị): giữ bind loopback, chạy `openclaw gateway --tailscale serve`, mở `https://<magicdns>/`. Nếu `gateway.auth.allowTailscale` là `true`, các header danh tính sẽ đáp ứng xác thực (không cần token).
- **Tailnet bind**: chạy `openclaw gateway --bind tailnet --token "<token>"`, mở `http://<tailscale-ip>:18789/`, dán token vào phần cài đặt dashboard.
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` rồi mở `http://127.0.0.1:18789/` và dán token trong cài đặt Control UI.

Xem [Dashboard](/web/dashboard) và [Web surfaces](/web) để biết các chế độ bind và chi tiết xác thực.

### Tôi cần runtime nào

Yêu cầu Node **>= 22**. `pnpm` được khuyến nghị. Bun **không được khuyến nghị** cho Gateway.

### Nó có chạy trên Raspberry Pi không

Có. Gateway rất nhẹ — tài liệu liệt kê **512MB-1GB RAM**, **1 lõi**, và khoảng **500MB** dung lượng đĩa là đủ cho sử dụng cá nhân, và lưu ý rằng **Raspberry Pi 4 có thể chạy được**.

Nếu bạn muốn dư địa thêm (log, media, dịch vụ khác), **khuyến nghị 2GB**, nhưng đó không phải là mức tối thiểu cứng.

Mẹo: một Pi/VPS nhỏ có thể host Gateway, và bạn có thể ghép cặp **nodes** trên laptop/điện thoại để dùng màn hình/camera/canvas cục bộ hoặc thực thi lệnh. Xem [Nodes](/nodes).

### Có mẹo nào cho việc cài đặt trên Raspberry Pi không

Bản ngắn gọn: chạy được, nhưng hãy chờ đợi một số trục trặc.

- 1. Sử dụng hệ điều hành **64-bit** và giữ Node >= 22.
- 2. Ưu tiên **cài đặt dạng hackable (git)** để bạn có thể xem log và cập nhật nhanh.
- 3. Bắt đầu mà không có kênh/kỹ năng, sau đó thêm từng cái một.
- Nếu bạn gặp các vấn đề nhị phân kỳ lạ, thì thường đó là vấn đề **tương thích ARM**.

5. Tài liệu: [Linux](/platforms/linux), [Install](/install).

### Nó bị kẹt ở bước wake up my friend, onboarding không chịu nở, bây giờ phải làm gì

Màn hình đó phụ thuộc vào việc Gateway có thể truy cập được và đã xác thực hay chưa. TUI cũng tự động gửi
"Wake up, my friend!" ở lần hatch đầu tiên. 9. Nếu bạn thấy dòng đó với **không có phản hồi**
và token vẫn ở mức 0, thì agent chưa bao giờ chạy.

1. Khởi động lại Gateway:

```bash
openclaw gateway restart
```

2. 10. Kiểm tra trạng thái + xác thực:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. Nếu vẫn bị treo, hãy chạy:

```bash
openclaw doctor
```

Nếu Gateway ở xa, hãy đảm bảo tunnel/kết nối Tailscale đang hoạt động và UI
được trỏ tới đúng Gateway. Xem [Remote access](/gateway/remote).

### Tôi có thể di chuyển thiết lập của mình sang một máy mới (Mac mini) mà không phải làm lại onboarding không

Có. Copy the **state directory** and **workspace**, then run Doctor once. This
keeps your bot "exactly the same" (memory, session history, auth, and channel
state) as long as you copy **both** locations:

1. Install OpenClaw on the new machine.
2. Copy `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) from the old machine.
3. Copy your workspace (default: `~/.openclaw/workspace`).
4. 20. Chạy `openclaw doctor` và khởi động lại dịch vụ Gateway.

That preserves config, auth profiles, WhatsApp creds, sessions, and memory. If you're in
remote mode, remember the gateway host owns the session store and workspace.

23. **Quan trọng:** nếu bạn chỉ commit/push workspace của mình lên GitHub, bạn đang sao lưu
    **bộ nhớ + các tệp bootstrap**, nhưng **không** phải lịch sử phiên hay xác thực. 24. Những thứ đó nằm
    trong `~/.openclaw/` (ví dụ `~/.openclaw/agents/<agentId>/sessions/`).

Related: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),
[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Remote mode](/gateway/remote).

### Where do I see what is new in the latest version

Check the GitHub changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Newest entries are at the top. If the top section is marked **Unreleased**, the next dated
section is the latest shipped version. 30. Các mục được nhóm theo **Highlights**, **Changes** và
**Fixes** (kèm theo docs/các mục khác khi cần).

### 31. Tôi không thể truy cập docs.openclaw.ai, gặp lỗi SSL. Giờ phải làm gì

Some Comcast/Xfinity connections incorrectly block `docs.openclaw.ai` via Xfinity
Advanced Security. Disable it or allowlist `docs.openclaw.ai`, then retry. More
detail: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Please help us unblock it by reporting here: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

If you still can't reach the site, the docs are mirrored on GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 37. Sự khác biệt giữa stable và beta là gì

**Stable** and **beta** are **npm dist-tags**, not separate code lines:

- `latest` = stable
- `beta` = early build for testing

41. Chúng tôi phát hành các bản build lên **beta**, kiểm thử chúng, và khi một bản build ổn định chúng tôi sẽ **nâng cấp
    chính phiên bản đó lên `latest`**. That's why beta and stable can point at the
    **same version**.

See what changed:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 44. Làm thế nào để cài đặt phiên bản beta và sự khác biệt giữa beta và dev là gì

**Beta** is the npm dist-tag `beta` (may match `latest`).
**Dev** is the moving head of `main` (git); when published, it uses the npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
48. curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

50. Trình cài đặt Windows (PowerShell):
    [https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

More detail: [Development channels](/install/development-channels) and [Installer flags](/install/installer).

### How long does install and onboarding usually take

Rough guide:

- **Install:** 2-5 minutes
- **Onboarding:** 5–15 phút tùy thuộc vào số kênh/mô hình bạn cấu hình

Nếu bị treo, hãy dùng [Trình cài đặt bị kẹt](/help/faq#installer-stuck-how-do-i-get-more-feedback)
và vòng lặp debug nhanh trong [Tôi bị kẹt](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

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

### Installer stuck How do I get more feedback

Chạy lại trình cài đặt với **đầu ra chi tiết (verbose)**:

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

Tùy chọn khác: [Installer flags](/install/installer).

### Cài đặt trên Windows báo không tìm thấy git hoặc không nhận ra openclaw

Two common Windows issues:

**1) npm error spawn git / git not found**

- Install **Git for Windows** and make sure `git` is on your PATH.
- Đóng và mở lại PowerShell, sau đó chạy lại trình cài đặt.

**2) openclaw is not recognized after install**

- Thư mục bin toàn cục của npm chưa có trong PATH.

- Kiểm tra đường dẫn:

  ```powershell
  npm config get prefix
  ```

- Đảm bảo `<prefix>\\bin` nằm trong PATH (trên hầu hết hệ thống là `%AppData%\\npm`).

- Đóng và mở lại PowerShell sau khi cập nhật PATH.

Nếu bạn muốn thiết lập Windows mượt nhất, hãy dùng **WSL2** thay vì Windows native.
Docs: [Windows](/platforms/windows).

### Tài liệu không trả lời câu hỏi của tôi – làm sao để có câu trả lời tốt hơn

Hãy dùng **cài đặt hackable (git)** để có toàn bộ mã nguồn và tài liệu ở máy local, sau đó hỏi
bot của bạn (hoặc Claude/Codex) _từ thư mục đó_ để nó có thể đọc repo và trả lời chính xác.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Chi tiết hơn: [Install](/install) và [Installer flags](/install/installer).

### Làm thế nào để cài OpenClaw trên Linux

Câu trả lời ngắn gọn: làm theo hướng dẫn Linux, sau đó chạy trình hướng dẫn onboarding.

- Đường nhanh Linux + cài dạng service: [Linux](/platforms/linux).
- Hướng dẫn đầy đủ: [Getting Started](/start/getting-started).
- Trình cài đặt + cập nhật: [Install & updates](/install/updating).

### Làm thế nào để cài OpenClaw trên VPS

Bất kỳ VPS Linux nào cũng dùng được. Cài đặt trên máy chủ, sau đó dùng SSH/Tailscale để truy cập Gateway.

Hướng dẫn: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Truy cập từ xa: [Gateway remote](/gateway/remote).

### Các hướng dẫn cài đặt cloudVPS ở đâu

We keep a **hosting hub** with the common providers. Chọn một và làm theo hướng dẫn:

- [VPS hosting](/vps) (all providers in one place)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

How it works in the cloud: the **Gateway runs on the server**, and you access it
from your laptop/phone via the Control UI (or Tailscale/SSH). Trạng thái + workspace của bạn
nằm trên máy chủ, vì vậy hãy coi máy chủ là nguồn sự thật và sao lưu nó.

You can pair **nodes** (Mac/iOS/Android/headless) to that cloud Gateway to access
local screen/camera/canvas or run commands on your laptop while keeping the
Gateway in the cloud.

Hub: [Platforms](/platforms). Remote access: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Tôi có thể yêu cầu OpenClaw tự cập nhật không

Câu trả lời ngắn gọn: **có thể, nhưng không khuyến nghị**. Quy trình cập nhật có thể khởi động lại
Gateway (làm rớt phiên đang hoạt động), có thể cần một git checkout sạch, và
có thể yêu cầu xác nhận. Safer: run updates from a shell as the operator.

Dùng CLI:

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

**Thiết lập model/xác thực** (khuyến nghị Anthropic **setup-token** cho các gói thuê bao Claude, hỗ trợ OpenAI Codex OAuth, API key là tùy chọn, hỗ trợ mô hình cục bộ LM Studio) Trong **chế độ local** nó sẽ hướng dẫn bạn:

- Tôi có cần đăng ký Claude hoặc OpenAI để chạy cái này không
- **Workspace** location + bootstrap files
- **Gateway settings** (bind/port/auth/tailscale)
- **Nhà cung cấp** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Cài đặt daemon** (LaunchAgent trên macOS; systemd user unit trên Linux/WSL2)
- **Kiểm tra sức khỏe** và lựa chọn **skills**

Nó cũng cảnh báo nếu model bạn cấu hình là không xác định hoặc thiếu xác thực.

### Quan trọng: bạn phải xác minh với&#xA;Anthropic rằng cách sử dụng này được phép theo chính sách và điều khoản thuê bao của họ.

Không. Bạn có thể chạy OpenClaw với **API key** (Anthropic/OpenAI/khác) hoặc với
**model chỉ chạy cục bộ** để dữ liệu của bạn nằm trên thiết bị. Subscriptions (Claude
Pro/Max or OpenAI Codex) are optional ways to authenticate those providers.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Local models](/gateway/local-models), [Models](/concepts/models).

### Tôi có thể dùng gói Claude Max mà không cần API key không

Có. You can authenticate with a **setup-token**
instead of an API key. This is the subscription path.

Claude Pro/Max subscriptions **do not include an API key**, so this is the
correct approach for subscription accounts. Bộ nhớ đệm xác thực runtime (được quản lý tự động)
If you want the most explicit, supported path, use an Anthropic API key.

### How does Anthropic setuptoken auth work

`claude setup-token` generates a **token string** via the Claude Code CLI (it is not available in the web console). You can run it on **any machine**. Chọn **Anthropic token (dán setup-token)** trong wizard hoặc dán bằng `openclaw models auth paste-token --provider anthropic`. Token được lưu như một hồ sơ xác thực cho nhà cung cấp **anthropic** và được dùng như API key (không tự làm mới). Chi tiết hơn: [OAuth](/concepts/oauth).

### Where do I find an Anthropic setuptoken

It is **not** in the Anthropic Console. setup-token được tạo bởi **Claude Code CLI** trên **bất kỳ máy nào**:

```bash
claude setup-token
```

Copy the token it prints, then choose **Anthropic token (paste setup-token)** in the wizard. If you want to run it on the gateway host, use `openclaw models auth setup-token --provider anthropic`. If you ran `claude setup-token` elsewhere, paste it on the gateway host with `openclaw models auth paste-token --provider anthropic`. See [Anthropic](/providers/anthropic).

### Bạn có hỗ trợ xác thực thuê bao Claude (Claude Pro hoặc Max) không

Yes - via **setup-token**. OpenClaw no longer reuses Claude Code CLI OAuth tokens; use a setup-token or an Anthropic API key. Generate the token anywhere and paste it on the gateway host. See [Anthropic](/providers/anthropic) and [OAuth](/concepts/oauth).

Note: Claude subscription access is governed by Anthropic's terms. For production or multi-user workloads, API keys are usually the safer choice.

### Why am I seeing HTTP 429 ratelimiterror from Anthropic

That means your **Anthropic quota/rate limit** is exhausted for the current window. If you
use a **Claude subscription** (setup-token or Claude Code OAuth), wait for the window to
reset or upgrade your plan. If you use an **Anthropic API key**, check the Anthropic Console
for usage/billing and raise limits as needed.

Tip: set a **fallback model** so OpenClaw can keep replying while a provider is rate-limited.
See [Models](/cli/models) and [OAuth](/concepts/oauth).

### AWS Bedrock có được hỗ trợ không

Yes - via pi-ai's **Amazon Bedrock (Converse)** provider with **manual config**. You must supply AWS credentials/region on the gateway host and add a Bedrock provider entry in your models config. See [Amazon Bedrock](/providers/bedrock) and [Model providers](/providers/models). Nếu bạn предпоч thích một luồng khóa được quản lý, một proxy tương thích OpenAI đặt trước Bedrock vẫn là một lựa chọn hợp lệ.

### How does Codex auth work

OpenClaw hỗ trợ **OpenAI Code (Codex)** thông qua OAuth (đăng nhập ChatGPT). Trình hướng dẫn có thể chạy luồng OAuth và sẽ đặt mô hình mặc định thành `openai-codex/gpt-5.3-codex` khi phù hợp. See [Model providers](/concepts/model-providers) and [Wizard](/start/wizard).

### Bạn có hỗ trợ xác thực thuê bao OpenAI Codex OAuth không

Có. OpenClaw fully supports **OpenAI Code (Codex) subscription OAuth**. The onboarding wizard
can run the OAuth flow for you.

See [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), and [Wizard](/start/wizard).

### How do I set up Gemini CLI OAuth

Gemini CLI uses a **plugin auth flow**, not a client id or secret in `openclaw.json`.

Steps:

1. Enable the plugin: `openclaw plugins enable google-gemini-cli-auth`
2. Đăng nhập: `openclaw models auth login --provider google-gemini-cli --set-default`

This stores OAuth tokens in auth profiles on the gateway host. Details: [Model providers](/concepts/model-providers).

### Mô hình cục bộ có ổn cho các cuộc trò chuyện thông thường không

Usually no. OpenClaw cần ngữ cảnh lớn + an toàn mạnh; các card nhỏ sẽ bị cắt ngắn và rò rỉ. If you must, run the **largest** MiniMax M2.1 build you can locally (LM Studio) and see [/gateway/local-models](/gateway/local-models). Smaller/quantized models increase prompt-injection risk - see [Security](/gateway/security).

### How do I keep hosted model traffic in a specific region

Pick region-pinned endpoints. OpenRouter exposes US-hosted options for MiniMax, Kimi, and GLM; choose the US-hosted variant to keep data in-region. You can still list Anthropic/OpenAI alongside these by using `models.mode: "merge"` so fallbacks stay available while respecting the regioned provider you select.

### Do I have to buy a Mac Mini to install this

Không. OpenClaw runs on macOS or Linux (Windows via WSL2). A Mac mini is optional - some people
buy one as an always-on host, but a small VPS, home server, or Raspberry Pi-class box works too.

You only need a Mac **for macOS-only tools**. For iMessage, use [BlueBubbles](/channels/bluebubbles) (recommended) - the BlueBubbles server runs on any Mac, and the Gateway can run on Linux or elsewhere. If you want other macOS-only tools, run the Gateway on a Mac or pair a macOS node.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

### Do I need a Mac mini for iMessage support

You need **some macOS device** signed into Messages. It does **not** have to be a Mac mini -
any Mac works. **Use [BlueBubbles](/channels/bluebubbles)** (recommended) for iMessage - the BlueBubbles server runs on macOS, while the Gateway can run on Linux or elsewhere.

Các thiết lập phổ biến:

- Run the Gateway on Linux/VPS, and run the BlueBubbles server on any Mac signed into Messages.
- Run everything on the Mac if you want the simplest single‑machine setup.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac remote mode](/platforms/mac/remote).

### Nếu tôi mua một Mac mini để chạy OpenClaw thì tôi có thể kết nối nó với MacBook Pro của mình không

Có. The **Mac mini can run the Gateway**, and your MacBook Pro can connect as a
**node** (companion device). Nodes don't run the Gateway - they provide extra
capabilities like screen/camera/canvas and `system.run` on that device.

Common pattern:

- Gateway on the Mac mini (always-on).
- MacBook Pro runs the macOS app or a node host and pairs to the Gateway.
- Use `openclaw nodes status` / `openclaw nodes list` to see it.

Tài liệu: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Tôi có thể dùng Bun không

Bun is **not recommended**. We see runtime bugs, especially with WhatsApp and Telegram.
Use **Node** for stable gateways.

If you still want to experiment with Bun, do it on a non-production gateway
without WhatsApp/Telegram.

### Telegram what goes in allowFrom

24. `channels.telegram.allowFrom` là **ID người gửi Telegram của con người** (dạng số, khuyến nghị) hoặc `@username`. It is not the bot username.

An toàn hơn (không dùng bot bên thứ ba):

- DM your bot, then run `openclaw logs --follow` and read `from.id`.

Official Bot API:

- DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.

Bên thứ ba (ít riêng tư hơn):

- DM `@userinfobot` or `@getidsbot`.

See [/channels/telegram](/channels/telegram#access-control-dms--groups).

### 31. Nhiều người có thể dùng chung một số WhatsApp với các instance OpenClaw khác nhau không

Yes, via **multi-agent routing**. 33. Gắn mỗi WhatsApp **DM** của người gửi (peer `kind: "dm"`, sender E.164 như `+15551234567`) với một `agentId` khác nhau, để mỗi người có workspace và session store riêng. Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).

### 36. Tôi có thể chạy một chat agent nhanh và một agent Opus để code không

Có. 37. Dùng multi-agent routing: cho mỗi agent một model mặc định riêng, sau đó gắn các tuyến inbound (tài khoản nhà cung cấp hoặc các peer cụ thể) với từng agent. Example config lives in [Multi-Agent Routing](/concepts/multi-agent). 39. Xem thêm [Models](/concepts/models) và [Configuration](/gateway/configuration).

### Does Homebrew work on Linux

Có. Homebrew supports Linux (Linuxbrew). Thiết lập nhanh:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

43. Nếu bạn chạy OpenClaw qua systemd, hãy đảm bảo PATH của service bao gồm `/home/linuxbrew/.linuxbrew/bin` (hoặc brew prefix của bạn) để các công cụ cài bằng `brew` được resolve trong các non-login shell.
44. Các bản build gần đây cũng prepend các thư mục bin người dùng phổ biến trên Linux cho systemd services (ví dụ `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) và tôn trọng `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, và `FNM_DIR` khi được thiết lập.

### 45. Sự khác nhau giữa bản cài hackable bằng git và bản cài npm là gì

- **Hackable (git) install:** full source checkout, editable, best for contributors.
  You run builds locally and can patch code/docs.
- **npm install:** global CLI install, no repo, best for "just run it."
  Updates come from npm dist-tags.

Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

### Can I switch between npm and git installs later

Có. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.
This **does not delete your data** - it only changes the OpenClaw code install. Your state
(`~/.openclaw`) and workspace (`~/.openclaw/workspace`) stay untouched.

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

Doctor detects a gateway service entrypoint mismatch and offers to rewrite the service config to match the current install (use `--repair` in automation).

Backup tips: see [Backup strategy](/help/faq#whats-the-recommended-backup-strategy).

### Should I run the Gateway on my laptop or a VPS

Short answer: **if you want 24/7 reliability, use a VPS**. If you want the
lowest friction and you're okay with sleep/restarts, run it locally.

**Laptop (local Gateway)**

- **Pros:** no server cost, direct access to local files, live browser window.
- **Cons:** sleep/network drops = disconnects, OS updates/reboots interrupt, must stay awake.

**VPS / cloud**

- **Ưu điểm:** luôn bật, mạng ổn định, không gặp vấn đề laptop ngủ, dễ duy trì chạy liên tục.
- **Nhược điểm:** thường chạy headless (dùng ảnh chụp màn hình), chỉ truy cập file từ xa, bạn phải SSH để cập nhật.

**OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord all work fine from a VPS. Điểm đánh đổi thực sự duy nhất là **trình duyệt headless** so với cửa sổ hiển thị. Xem [Browser](/tools/browser).

**Mặc định khuyến nghị:** VPS nếu trước đây bạn từng gặp lỗi gateway bị ngắt kết nối. Local rất tốt khi bạn đang chủ động dùng Mac và muốn truy cập file cục bộ hoặc tự động hóa UI với trình duyệt hiển thị.

### Việc chạy OpenClaw trên một máy chuyên dụng quan trọng đến mức nào

Không bắt buộc, nhưng **được khuyến nghị để đảm bảo độ tin cậy và cách ly**.

- **Dedicated host (VPS/Mac mini/Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.
- **Laptop/desktop dùng chung:** hoàn toàn ổn cho thử nghiệm và sử dụng chủ động, nhưng hãy chấp nhận việc bị tạm dừng khi máy ngủ hoặc cập nhật.

If you want the best of both worlds, keep the Gateway on a dedicated host and pair your laptop as a **node** for local screen/camera/exec tools. Xem [Nodes](/nodes).
Để biết hướng dẫn bảo mật, đọc [Security](/gateway/security).

### Yêu cầu VPS tối thiểu và hệ điều hành khuyến nghị là gì

OpenClaw rất nhẹ. Với một Gateway cơ bản + một kênh chat:

- **Absolute minimum:** 1 vCPU, 1GB RAM, ~500MB disk.
- **Khuyến nghị:** 1–2 vCPU, 2GB RAM trở lên để có dư địa (log, media, nhiều kênh). Các công cụ node và tự động hóa trình duyệt có thể tiêu tốn nhiều tài nguyên.

OS: use **Ubuntu LTS** (or any modern Debian/Ubuntu). Lộ trình cài đặt trên Linux được kiểm thử tốt nhất.

Tài liệu: [Linux](/platforms/linux), [VPS hosting](/vps).

### Tôi có thể chạy OpenClaw trong VM không và yêu cầu là gì

Có. Hãy coi VM giống như VPS: cần luôn bật, có thể truy cập được, và có đủ
RAM cho Gateway và bất kỳ kênh nào bạn bật.

Hướng dẫn cơ bản:

- **Tối thiểu tuyệt đối:** 1 vCPU, 1GB RAM.
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
compatibility. Xem [Windows](/platforms/windows), [VPS hosting](/vps).
Nếu bạn chạy macOS trong VM, xem [macOS VM](/install/macos-vm).

## OpenClaw là gì?

### OpenClaw là gì trong một đoạn

OpenClaw là một trợ lý AI cá nhân mà bạn chạy trên chính thiết bị của mình. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. **Gateway** là mặt phẳng điều khiển luôn bật; trợ lý là sản phẩm.

### Giá trị cốt lõi là gì

OpenClaw không chỉ là "một wrapper cho Claude." Đó là một **mặt phẳng điều khiển ưu tiên local** cho phép bạn chạy một
trợ lý mạnh mẽ trên **phần cứng của chính bạn**, có thể truy cập từ các ứng dụng chat bạn đã dùng, với
phiên làm việc có trạng thái, bộ nhớ và công cụ – mà không giao quyền kiểm soát quy trình làm việc của bạn cho một
SaaS được lưu trữ.

Điểm nổi bật:

- **Thiết bị của bạn, dữ liệu của bạn:** chạy Gateway ở bất cứ đâu bạn muốn (Mac, Linux, VPS) và giữ
  workspace + lịch sử phiên làm việc ở local.
- **Kênh thực, không phải web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  cùng với giọng nói di động và Canvas trên các nền tảng được hỗ trợ.
- **Không phụ thuộc mô hình:** dùng Anthropic, OpenAI, MiniMax, OpenRouter, v.v., với định tuyến theo từng agent
  và cơ chế dự phòng.
- **Tùy chọn chỉ-local:** chạy mô hình local để **toàn bộ dữ liệu có thể ở lại trên thiết bị của bạn** nếu bạn muốn.
- **Định tuyến đa agent:** tách agent theo kênh, tài khoản, hoặc tác vụ, mỗi agent có
  workspace và mặc định riêng.
- **Mã nguồn mở và dễ hack:** kiểm tra, mở rộng và tự host mà không bị khóa nhà cung cấp.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### Tôi vừa cài xong thì nên làm gì trước

Các dự án đầu tiên tốt:

- Xây dựng một website (WordPress, Shopify, hoặc site tĩnh đơn giản).
- Tạo nguyên mẫu app di động (phác thảo, màn hình, kế hoạch API).
- Organize files and folders (cleanup, naming, tagging).
- Kết nối Gmail và tự động hóa tóm tắt hoặc follow up.

Nó có thể xử lý các tác vụ lớn, nhưng hoạt động hiệu quả nhất khi bạn chia nhỏ thành các giai đoạn và
sử dụng sub agent cho công việc song song.

### Năm trường hợp sử dụng hằng ngày hàng đầu của OpenClaw là gì

Everyday wins usually look like:

- **Bản tin cá nhân:** tóm tắt hộp thư, lịch và tin tức bạn quan tâm.
- **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
- **Nhắc nhở và theo dõi:** các nhắc nhở và checklist được kích hoạt bởi cron hoặc heartbeat.
- **Tự động hóa trình duyệt:** điền form, thu thập dữ liệu và lặp lại các tác vụ web.
- **Cross device coordination:** send a task from your phone, let the Gateway run it on a server, and get the result back in chat.

### OpenClaw có thể giúp lead gen, outreach, ads và blog cho một SaaS không

Có, cho **nghiên cứu, sàng lọc và soạn thảo**. Nó có thể quét website, xây dựng danh sách ngắn,
tóm tắt khách hàng tiềm năng và viết bản nháp nội dung outreach hoặc quảng cáo.

For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and
platform policies, and review anything before it is sent. Mẫu an toàn nhất là để
OpenClaw soạn thảo và bạn phê duyệt.

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

Có. Add extra directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence). Default precedence remains: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills`.

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

Danh sách kiểm tra:

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

Cài đặt ClawHub CLI (chọn một trình quản lý gói):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Can OpenClaw run tasks on a schedule or continuously in the background

Có. Use the Gateway scheduler:

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

**Option B - use a macOS node (no SSH).**
Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. OpenClaw can treat macOS-only skills as eligible when the required binaries exist on the node. The agent runs those skills via the `nodes` tool. If you choose "Always Ask", approving "Always Allow" in the prompt adds that command to the allowlist.

**Option C - proxy macOS binaries over SSH (advanced).**
Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac. Then override the skill to allow Linux so it stays eligible.

1. Tạo một SSH wrapper cho binary (ví dụ: `memo` cho Apple Notes):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. 1. Đặt wrapper vào `PATH` trên máy chủ Linux (ví dụ `~/bin/memo`).

3. 2. Ghi đè metadata của skill (workspace hoặc `~/.openclaw/skills`) để cho phép Linux:

   ```markdown
   3. ---
   name: apple-notes
   description: Quản lý Apple Notes thông qua CLI memo trên macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. 4. Bắt đầu một phiên mới để snapshot skill được làm mới.

### 5) Bạn có tích hợp Notion hoặc HeyGen không

6. Hiện tại chưa có tích hợp sẵn.

Tùy chọn:

- 7. **Skill / plugin tùy chỉnh:** tốt nhất cho truy cập API đáng tin cậy (Notion/HeyGen đều có API).
- 8. **Tự động hóa trình duyệt:** hoạt động không cần code nhưng chậm hơn và dễ lỗi hơn.

9. Nếu bạn muốn giữ ngữ cảnh theo từng khách hàng (quy trình agency), một mẫu đơn giản là:

- 10. Một trang Notion cho mỗi khách hàng (ngữ cảnh + tùy chọn + công việc đang hoạt động).
- 11. Yêu cầu agent lấy trang đó khi bắt đầu một phiên.

12. Nếu bạn muốn tích hợp gốc, hãy mở một yêu cầu tính năng hoặc xây dựng một skill nhắm tới các API đó.

Install skills:

```bash
13. clawhub install <skill-slug>
clawhub update --all
```

ClawHub installs into `./skills` under your current directory (or falls back to your configured OpenClaw workspace); OpenClaw treats that as `<workspace>/skills` on the next session. 14. Đối với các skill dùng chung giữa nhiều agent, hãy đặt chúng trong `~/.openclaw/skills/<name>/SKILL.md`. 15. Một số skill yêu cầu cài đặt binary qua Homebrew; trên Linux điều đó có nghĩa là Linuxbrew (xem mục Homebrew Linux FAQ ở trên). See [Skills](/tools/skills) and [ClawHub](/tools/clawhub).

### How do I install the Chrome extension for browser takeover

Use the built-in installer, then load the unpacked extension in Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

16. Sau đó Chrome → `chrome://extensions` → bật "Developer mode" → "Load unpacked" → chọn thư mục đó.

17. Hướng dẫn đầy đủ (bao gồm Gateway từ xa + ghi chú bảo mật): [Chrome extension](/tools/chrome-extension)

18. Nếu Gateway chạy trên cùng một máy với Chrome (thiết lập mặc định), bạn thường **không** cần thêm bất cứ thứ gì.
    Nếu Gateway chạy ở nơi khác, hãy chạy một node host trên máy có trình duyệt để Gateway có thể proxy các hành động trình duyệt.
19. Bạn vẫn cần nhấp nút extension trên tab mà bạn muốn điều khiển (nó không tự động gắn).

## 20. Sandbox và bộ nhớ

### 21. Có tài liệu sandboxing riêng không

Có. See [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).

### Docker feels limited How do I enable full features

22. Image mặc định ưu tiên bảo mật và chạy dưới user `node`, vì vậy nó không bao gồm các gói hệ thống, Homebrew hoặc trình duyệt được đóng gói sẵn. For a fuller setup:

- Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.
- Bake system deps into the image with `OPENCLAW_DOCKER_APT_PACKAGES`.
- 23. Cài đặt các trình duyệt Playwright qua CLI đi kèm:
      `node /app/node_modules/playwright-core/cli.js install chromium`
- Set `PLAYWRIGHT_BROWSERS_PATH` and ensure the path is persisted.

24. Tài liệu: [Docker](/install/docker), [Browser](/tools/browser).

**Can I keep DMs personal but make groups public sandboxed with one agent**

Yes - if your private traffic is **DMs** and your public traffic is **groups**.

Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. Then restrict what tools are available in sandboxed sessions via `tools.sandbox.tools`.

25. Hướng dẫn thiết lập + cấu hình ví dụ: [Groups: DM cá nhân + nhóm công khai](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Key config reference: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### How do I bind a host folder into the sandbox

Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). 26. Liên kết (binds) toàn cục + theo agent được gộp; các bind theo agent sẽ bị bỏ qua khi `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls. 27. Xem [Sandboxing](/gateway/sandboxing#custom-bind-mounts) và [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) để biết ví dụ và lưu ý an toàn.

### 28. Bộ nhớ hoạt động như thế nào

Bộ nhớ OpenClaw chỉ là các tệp Markdown trong workspace của agent:

- Ghi chú hằng ngày trong `memory/YYYY-MM-DD.md`
- Ghi chú dài hạn đã được tuyển chọn trong `MEMORY.md` (chỉ các phiên chính/riêng tư)

OpenClaw cũng chạy một **đợt xả bộ nhớ tiền nén im lặng** để nhắc mô hình 29. Điều này chỉ chạy khi workspace có thể ghi (sandbox chỉ đọc sẽ bỏ qua). Xem [Memory](/concepts/memory).

### 30. Bộ nhớ cứ quên mọi thứ — làm sao để nó ghi nhớ lâu

Bộ nhớ cứ quên mọi thứ Làm sao để nó nhớ lâu Hãy yêu cầu bot **ghi sự thật vào bộ nhớ**.

Ghi chú dài hạn thuộc về `MEMORY.md`, 31. Việc nhắc mô hình lưu trữ ký ức sẽ hữu ích; nó sẽ biết phải làm gì. Đây vẫn là lĩnh vực chúng tôi đang cải thiện.

Việc nhắc mô hình lưu bộ nhớ sẽ hữu ích;

### 32. Tìm kiếm bộ nhớ ngữ nghĩa có yêu cầu khóa OpenAI API không

Nếu nó vẫn quên, hãy kiểm tra Gateway có đang dùng cùng một 33. Codex OAuth bao phủ chat/completions và **không** cấp quyền truy cập embeddings, vì vậy **đăng nhập bằng Codex (OAuth hoặc đăng nhập Codex CLI)** không giúp cho tìm kiếm bộ nhớ ngữ nghĩa. 34. Embeddings của OpenAI vẫn cần một API key thực (`OPENAI_API_KEY` hoặc `models.providers.openai.apiKey`).

Tìm kiếm bộ nhớ ngữ nghĩa có cần khóa OpenAI API không
Chỉ khi bạn dùng **OpenAI embeddings**. 35. Nếu không có khóa nào khả dụng, tìm kiếm bộ nhớ sẽ bị vô hiệu hóa cho đến khi bạn cấu hình nó. 36. Nếu bạn có đường dẫn mô hình cục bộ được cấu hình và tồn tại, OpenClaw sẽ ưu tiên `local`.

Codex CLI login)\*\* không giúp ích cho tìm kiếm bộ nhớ ngữ nghĩa. 37. Nếu bạn muốn embeddings của Gemini, hãy đặt `memorySearch.provider = "gemini"` và cung cấp `GEMINI_API_KEY` (hoặc `memorySearch.remote.apiKey`). vẫn cần một khóa API thực (`OPENAI_API_KEY` hoặc `models.providers.openai.apiKey`).

### 38. Bộ nhớ có tồn tại vĩnh viễn không? Giới hạn là gì

Các tệp bộ nhớ nằm trên đĩa và tồn tại cho đến khi bạn xóa chúng. Nó ưu tiên OpenAI nếu có khóa OpenAI, nếu không thì Gemini nếu có khóa Gemini. Nếu không có khóa nào, tìm kiếm bộ nhớ sẽ bị vô hiệu hóa cho đến khi bạn 40. Đó là lý do tại sao có tìm kiếm bộ nhớ — nó chỉ kéo những phần liên quan trở lại ngữ cảnh.

Nếu bạn có đường dẫn mô hình cục bộ được cấu hình và tồn tại, OpenClaw

## sẽ ưu tiên `local`.

### 41. Có phải tất cả dữ liệu được dùng với OpenClaw đều được lưu cục bộ không

42. Không — **trạng thái của OpenClaw là cục bộ**, nhưng **các dịch vụ bên ngoài vẫn thấy những gì bạn gửi cho họ**.

- 43. **Mặc định là cục bộ:** các phiên, tệp bộ nhớ, cấu hình và workspace nằm trên máy chủ Gateway (`~/.openclaw` + thư mục workspace của bạn).
- `memorySearch.provider = "gemini"` và cung cấp `GEMINI_API_KEY` (hoặc `memorySearch.remote.apiKey`). Chúng tôi hỗ trợ **OpenAI, Gemini, hoặc local** cho các mô hình embedding
- - xem [Memory](/concepts/memory) để biết chi tiết thiết lập.

Bộ nhớ có tồn tại mãi mãi không Các giới hạn là gì

### Các tệp bộ nhớ nằm trên đĩa và tồn tại cho đến khi bạn xóa chúng.

Giới hạn là

| dung lượng lưu trữ của bạn, không phải mô hình.                            | Mục đích                                                                                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Ngữ cảnh phiên** vẫn bị giới hạn bởi                                                     | cửa sổ ngữ cảnh của mô hình, vì vậy các cuộc trò chuyện dài có thể bị nén hoặc cắt bớt.                          |
| Đó là lý do                                                                                | 44. Nhập OAuth kế thừa (được sao chép vào hồ sơ xác thực khi sử dụng lần đầu)          |
| 45. `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Mọi thứ nằm ở đâu trên đĩa                                                                                                       |
| Tất cả dữ liệu dùng với OpenClaw có được lưu cục bộ không                                  | Một Gateway có thể lưu trữ nhiều agent, mỗi agent có workspace, giá trị mặc định model và định tuyến riêng.      |
| `$OPENCLAW_STATE_DIR/credentials/`                                                         | 47. Trạng thái nhà cung cấp (ví dụ: `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                                              | 48. Trạng thái theo agent (agentDir + sessions)                                        |
| 49. `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Lịch sử & trạng thái hội thoại (theo từng agent)                                          |
| 50. `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Session metadata (per agent)                                                                                  |

Đường dẫn legacy cho agent đơn: `~/.openclaw/agent/*` (được migrate bởi `openclaw doctor`).

Your **workspace** (AGENTS.md, memory files, skills, etc.) là tách biệt và được cấu hình qua `agents.defaults.workspace` (mặc định: `~/.openclaw/workspace`).

### AGENTSmd SOULmd USERmd MEMORYmd nên đặt ở đâu

These files live in the **agent workspace**, not `~/.openclaw`.

- **Workspace (theo từng agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (hoặc `memory.md`), `memory/YYYY-MM-DD.md`, tùy chọn `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, credentials, auth profiles, sessions, logs,
  and shared skills (`~/.openclaw/skills`).

Default workspace is `~/.openclaw/workspace`, configurable via:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Nếu bot "quên" sau khi khởi động lại, hãy xác nhận Gateway đang dùng cùng một
workspace ở mỗi lần chạy (và nhớ rằng: chế độ remote dùng **workspace của máy chủ gateway**,
không phải laptop cục bộ của bạn).

Tip: if you want a durable behavior or preference, ask the bot to **write it into
AGENTS.md or MEMORY.md** rather than relying on chat history.

Xem [Agent workspace](/concepts/agent-workspace) và [Memory](/concepts/memory).

### Chiến lược sao lưu được khuyến nghị là gì

Đặt **agent workspace** của bạn trong một repo git **riêng tư** và sao lưu nó ở nơi
riêng tư (ví dụ GitHub private). This captures memory + AGENTS/SOUL/USER
files, and lets you restore the assistant's "mind" later.

Do **not** commit anything under `~/.openclaw` (credentials, sessions, tokens).
If you need a full restore, back up both the workspace and the state directory
separately (see the migration question above).

Docs: [Agent workspace](/concepts/agent-workspace).

### Làm thế nào để gỡ cài đặt OpenClaw hoàn toàn

Xem hướng dẫn riêng: [Uninstall](/install/uninstall).

### Agent có thể hoạt động ngoài workspace không

Có. The workspace is the **default cwd** and memory anchor, not a hard sandbox.
Đường dẫn tương đối sẽ được resolve bên trong workspace, nhưng đường dẫn tuyệt đối có thể truy cập các vị trí khác trên host trừ khi bật sandboxing. Nếu bạn cần cách ly, hãy dùng
[`agents.defaults.sandbox`](/gateway/sandboxing) hoặc cài đặt sandbox theo từng agent. If you
want a repo to be the default working directory, point that agent's
`workspace` to the repo root. The OpenClaw repo is just source code; keep the
workspace separate unless you intentionally want the agent to work inside it.

Ví dụ (repo làm cwd mặc định):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Tôi đang ở chế độ remote, kho lưu phiên ở đâu

Trạng thái phiên thuộc về **máy chủ gateway**. Nếu bạn đang ở chế độ remote, kho lưu phiên mà bạn quan tâm nằm trên máy từ xa, không phải laptop cục bộ của bạn. See [Session management](/concepts/session).

## Config basics

### Cấu hình có định dạng gì và nó nằm ở đâu

OpenClaw đọc một file cấu hình **JSON5** tùy chọn từ `$OPENCLAW_CONFIG_PATH` (mặc định: `~/.openclaw/openclaw.json`):

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

Ghi chú:

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
`tools.web.search.apiKey`. Phương án môi trường: đặt `BRAVE_API_KEY` cho tiến trình Gateway.

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

Ghi chú:

- If you use allowlists, add `web_search`/`web_fetch` or `group:web`.
- `web_fetch` được bật theo mặc định (trừ khi bị tắt rõ ràng).
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

### Trình duyệt OpenClaw có thể chạy ở chế độ headless không

Có. Đó là một tùy chọn cấu hình:

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

Mặc định là `false` (có giao diện). Chế độ headless có khả năng kích hoạt các kiểm tra chống bot trên một số trang web cao hơn. Xem [Browser](/tools/browser).

Headless sử dụng **cùng một engine Chromium** và hoạt động cho hầu hết các tác vụ tự động hóa (biểu mẫu, nhấp chuột, thu thập dữ liệu, đăng nhập). Các khác biệt chính:

- No visible browser window (use screenshots if you need visuals).
- Một số trang web nghiêm ngặt hơn với tự động hóa ở chế độ headless (CAPTCHA, chống bot).
  Ví dụ, X/Twitter thường chặn các phiên headless.

### Làm thế nào để tôi sử dụng Brave cho việc điều khiển trình duyệt

Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway.
Xem các ví dụ cấu hình đầy đủ tại [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Gateway và node từ xa

### How do commands propagate between Telegram the gateway and nodes

Tin nhắn Telegram được xử lý bởi **gateway**. The gateway runs the agent and
only then calls nodes over the **Gateway WebSocket** when a node tool is needed:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Các node không thấy lưu lượng từ nhà cung cấp đi vào; chúng chỉ nhận các lời gọi RPC của node.

### Làm thế nào agent của tôi có thể truy cập máy tính của tôi nếu Gateway được lưu trữ từ xa

Short answer: **pair your computer as a node**. Gateway chạy ở nơi khác, nhưng nó có thể
call các công cụ `node.*` (màn hình, camera, hệ thống) trên máy cục bộ của bạn qua Gateway WebSocket.

Typical setup:

1. Run the Gateway on the always-on host (VPS/home server).
2. Đặt host Gateway + máy tính của bạn trong cùng một tailnet.
3. Đảm bảo Gateway WS có thể truy cập được (tailnet bind hoặc SSH tunnel).
4. Mở ứng dụng macOS tại máy cục bộ và kết nối ở chế độ **Remote over SSH** (hoặc tailnet trực tiếp)
   để nó có thể đăng ký làm một node.
5. Phê duyệt node trên Gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Không cần cầu nối TCP riêng; các node kết nối qua Gateway WebSocket.

Nhắc nhở bảo mật: ghép cặp một node macOS cho phép `system.run` trên máy đó. Only
pair devices you trust, and review [Security](/gateway/security).

Tài liệu: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale đã kết nối nhưng tôi không nhận được phản hồi Phải làm gì bây giờ

Kiểm tra những điều cơ bản:

- Gateway đang chạy: `openclaw gateway status`
- Tình trạng Gateway: `openclaw status`
- Tình trạng kênh: `openclaw channels status`

Sau đó xác minh xác thực và định tuyến:

- Nếu bạn dùng Tailscale Serve, hãy đảm bảo `gateway.auth.allowTailscale` được đặt đúng.
- Nếu bạn kết nối qua SSH tunnel, hãy xác nhận tunnel cục bộ đang hoạt động và trỏ đúng cổng.
- Xác nhận các allowlist (DM hoặc nhóm) có bao gồm tài khoản của bạn.

Tài liệu: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### Hai instance OpenClaw có thể nói chuyện với nhau trên VPS cục bộ không

Có. There is no built-in "bot-to-bot" bridge, but you can wire it up in a few
reliable ways:

**Đơn giản nhất:** dùng một kênh chat thông thường mà cả hai bot đều truy cập được (Telegram/Slack/WhatsApp).
Cho Bot A gửi tin nhắn tới Bot B, sau đó để Bot B trả lời như bình thường.

**Cầu nối CLI (chung):** chạy một script gọi Gateway còn lại với
`openclaw agent --message ... --deliver`, nhắm tới một cuộc trò chuyện nơi bot kia
lắng nghe. Nếu một bot nằm trên VPS từ xa, hãy trỏ CLI của bạn tới Gateway từ xa đó
qua SSH/Tailscale (xem [Remote access](/gateway/remote)).

Mẫu ví dụ (chạy từ một máy có thể truy cập Gateway mục tiêu):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

Mẹo: thêm một hàng rào bảo vệ để hai bot không lặp vô hạn (chỉ-đề-cập, allowlist kênh, hoặc quy tắc "không trả lời tin nhắn của bot").

Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### Tôi có cần các VPS riêng cho nhiều agent không

Không. Nếu không, hãy giữ một Gateway và
sử dụng nhiều agent hoặc sub-agent. That is the normal setup and it is much cheaper and simpler than running
one VPS per agent.

Use separate VPSes only when you need hard isolation (security boundaries) or very
different configs that you do not want to share. Chạy `openclaw agents add <id>` và cấu hình xác thực trong quá trình wizard.

### Có lợi ích gì khi dùng một node trên laptop cá nhân thay vì SSH từ một VPS không

Có – node là cách hạng nhất để truy cập laptop của bạn từ Gateway từ xa, và chúng
mở khóa nhiều hơn là chỉ truy cập shell. The Gateway runs on macOS/Linux (Windows via WSL2) and is
lightweight (a small VPS or Raspberry Pi-class box is fine; 4 GB RAM is plenty), so a common
setup is an always-on host plus your laptop as a node.

- **Không cần SSH inbound.** Node kết nối ra Gateway WebSocket và sử dụng ghép cặp thiết bị.
- **Kiểm soát thực thi an toàn hơn.** `system.run` được kiểm soát bởi allowlist/phê duyệt node trên laptop đó.
- **More device tools.** Nodes expose `canvas`, `camera`, and `screen` in addition to `system.run`.
- **Tự động hóa trình duyệt cục bộ.** Giữ Gateway trên VPS, nhưng chạy Chrome cục bộ và chuyển tiếp điều khiển
  bằng tiện ích mở rộng Chrome + một node host trên laptop.

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

Không. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect
to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node
hosts and CLI control, see [Node host CLI](/cli/node).

A full restart is required for `gateway`, `discovery`, and `canvasHost` changes.

### Is there an API RPC way to apply config

Có. `config.apply` validates + writes the full config and restarts the Gateway as part of the operation.

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
3. Nếu không, hãy giữ một Gateway và

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## dùng nhiều agent hoặc sub-agent.

### How does OpenClaw load environment variables

OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

- `.env` from the current working directory
- a global fallback `.env` from `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)

Neither `.env` file overrides existing env vars.

You can also define inline env vars in config (applied only if missing from the process env):

```json5
**Phê duyệt node** trên gateway:
```

See [/environment](/help/environment) for full precedence and sources.

### I started the Gateway via the service and my env vars disappeared What now

Biến môi trường và tải .env

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

1. {
   env: {
   OPENROUTER_API_KEY: "sk-or-...",
   vars: { GROQ_API_KEY: "gsk-..." },
   },
   }

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Or enable shell import (`env.shellEnv.enabled: true`).

3. Or add it to your config `env` block (applies only if missing).

Hai cách khắc phục phổ biến:

```bash
openclaw models status
```

Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).
See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

## Sessions and multiple chats

### How do I start a fresh conversation

Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).

### Do sessions reset automatically if I never send new

Có. Sessions expire after `session.idleMinutes` (default **60**). The **next**
message starts a fresh session id for that chat key. This does not delete
transcripts - it just starts a new session.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### Is there a way to make a team of OpenClaw instances one CEO and many agents

Yes, via **multi-agent routing** and **sub-agents**. You can create one coordinator
agent and several worker agents with their own workspaces and models.

That said, this is best seen as a **fun experiment**. Đặt token vào `~/.openclaw/.env`: The typical model we
envision is one bot you talk to, with different sessions for parallel work. That
bot can also spawn sub-agents when needed.

Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Why did context get truncated midtask How do I prevent it

Session context is limited by the model window. Long chats, large tool outputs, or many
files can trigger compaction or truncation.

What helps:

- Ask the bot to summarize the current state and write it to a file.
- Use `/compact` before long tasks, and `/new` when switching topics.
- Sau đó khởi động lại gateway và kiểm tra lại:
- Use sub-agents for long or parallel work so the main chat stays smaller.
- Pick a model with a larger context window if this happens often.

### How do I completely reset OpenClaw but keep it installed

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

Ghi chú:

- The onboarding wizard also offers **Reset** if it sees an existing config. Nó tiêu tốn nhiều token và thường
  kém hiệu quả hơn so với việc dùng một bot với các phiên riêng biệt.
- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (defaults are `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Tôi đang gặp lỗi context quá lớn, làm sao để reset hoặc compact

Dùng một trong các cách sau:

- 1. **Thu gọn** (giữ cuộc trò chuyện nhưng tóm tắt các lượt cũ hơn):

  ```
  2. /compact
  ```

  hoặc `/compact <instructions>` để hướng dẫn cách tóm tắt.

- 3. **Đặt lại** (ID phiên mới cho cùng một khóa chat):

  ```
  /new
  /reset
  ```

Nếu vẫn 계속 xảy ra:

- Bật hoặc tinh chỉnh **session pruning** (`agents.defaults.contextPruning`) để cắt bớt output tool cũ.
- 4. Sử dụng mô hình có cửa sổ ngữ cảnh lớn hơn.

5. Tài liệu: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### 6. Tại sao tôi thấy thông báo LLM request rejected messagesNcontentXtooluseinput Field required

Giữ ngữ cảnh quan trọng trong workspace và yêu cầu bot đọc lại. Điều này thường có nghĩa là lịch sử phiên đã cũ hoặc bị hỏng (thường sau các thread dài hoặc khi thay đổi tool/schema).

8. Cách khắc phục: bắt đầu một phiên mới với `/new` (tin nhắn độc lập).

### Vì sao tôi nhận được thông báo heartbeat mỗi 30 phút

Heartbeat chạy mỗi **30m** theo mặc định. 9. Điều chỉnh hoặc vô hiệu hóa chúng:

```json5
10. {
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // hoặc "0m" để vô hiệu hóa
      },
    },
  },
}
```

11. Nếu `HEARTBEAT.md` tồn tại nhưng thực chất trống (chỉ có dòng trống và các tiêu đề markdown như `# Heading`), OpenClaw sẽ bỏ qua lần chạy heartbeat để tiết kiệm lượt gọi API.
    Nếu tệp bị thiếu, heartbeat vẫn chạy và mô hình tự quyết định làm gì.

12. Ghi đè theo từng agent sử dụng `agents.list[].heartbeat`. Tài liệu: [Heartbeat](/gateway/heartbeat).

### 13. Tôi có cần thêm một tài khoản bot vào nhóm WhatsApp không

Không. 14. OpenClaw chạy trên **chính tài khoản của bạn**, vì vậy nếu bạn ở trong nhóm, OpenClaw có thể thấy nó.
Theo mặc định, trả lời trong nhóm bị chặn cho đến khi bạn cho phép người gửi (`groupPolicy: "allowlist"`).

15. Nếu bạn chỉ muốn **bạn** có thể kích hoạt phản hồi trong nhóm:

```json5
16. {
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### Làm sao để lấy JID của một nhóm WhatsApp

Cách 1 (nhanh nhất): theo dõi logs và gửi một tin nhắn thử trong nhóm:

```bash
17. openclaw logs --follow --json
```

Xem [Wizard](/start/wizard).

Cách 2 (nếu đã cấu hình/allowlist): liệt kê các nhóm từ cấu hình:

```bash
openclaw directory groups list --channel whatsapp
```

19. Tài liệu: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Vì sao OpenClaw không trả lời trong nhóm

Hai nguyên nhân phổ biến:

- 20. Kiểm soát bằng đề cập (mention gating) đang bật (mặc định). Bạn phải @mention bot (hoặc khớp `mentionPatterns`).
- 21. Bạn đã cấu hình `channels.whatsapp.groups` mà không có `"*"` và nhóm đó không nằm trong allowlist.

22. Xem [Groups](/channels/groups) và [Group messages](/channels/group-messages).

### 23. Các nhóm/luồng có chia sẻ ngữ cảnh với DM không

24. Trò chuyện trực tiếp mặc định sẽ gộp vào phiên chính. 25. Nhóm/kênh có khóa phiên riêng, và các chủ đề Telegram / luồng Discord là các phiên riêng biệt. Xem [Groups](/channels/groups) và [Group messages](/channels/group-messages).

### 26. Tôi có thể tạo bao nhiêu workspace và agent

27. Không có giới hạn cứng. Hàng chục (thậm chí hàng trăm) đều ổn, nhưng hãy chú ý:

- 1. **Tăng dung lượng đĩa:** các session + transcript nằm dưới `~/.openclaw/agents/<agentId>/sessions/`.
- 28. **Chi phí token:** nhiều agent hơn nghĩa là sử dụng mô hình đồng thời nhiều hơn.
- 3. **Chi phí vận hành:** hồ sơ xác thực, workspace và định tuyến kênh theo từng agent.

Mẹo:

- 29. Giữ một workspace **đang hoạt động** cho mỗi agent (`agents.defaults.workspace`).
- 30. Dọn dẹp các phiên cũ (xóa JSONL hoặc các mục lưu trữ) nếu dung lượng đĩa tăng.
- 31. Sử dụng `openclaw doctor` để phát hiện các workspace lạc và sai lệch cấu hình hồ sơ.

### 32. Tôi có thể chạy nhiều bot hoặc nhiều cuộc chat cùng lúc trên Slack không và nên thiết lập thế nào

Có. Đây là lỗi xác thực nhà cung cấp: mô hình đã phát ra một khối `tool_use` mà không có
`input` bắt buộc. 34. Slack được hỗ trợ như một kênh và có thể gắn với các agent cụ thể.

35. Truy cập trình duyệt rất mạnh nhưng không phải là "làm được mọi thứ như con người" — chống bot, CAPTCHA và MFA vẫn có thể chặn tự động hóa. 36. Để điều khiển trình duyệt đáng tin cậy nhất, hãy dùng relay của tiện ích Chrome trên máy chạy trình duyệt (và có thể đặt Gateway ở bất kỳ đâu).

37. Thiết lập theo thực tiễn tốt nhất:

- 38. Máy chủ Gateway luôn bật (VPS/Mac mini).
- 39. Mỗi agent cho một vai trò (bindings).
- 40. Kênh Slack được gắn với các agent đó.
- 41. Trình duyệt cục bộ qua relay tiện ích (hoặc một node) khi cần.

Tìm `chatId` (hoặc `from`) kết thúc bằng `@g.us`, như:
`1234567890-1234567890@g.us`.

## 43. Mô hình: mặc định, lựa chọn, bí danh, chuyển đổi

### 44. Mô hình mặc định là gì

45. Mô hình mặc định của OpenClaw là bất cứ mô hình nào bạn đặt là:

```
agents.defaults.model.primary
```

46. Mô hình được tham chiếu dưới dạng `provider/model` (ví dụ: `anthropic/claude-opus-4-6`). 47. Nếu bạn bỏ qua provider, OpenClaw hiện giả định `anthropic` như một phương án tạm thời trong giai đoạn loại bỏ dần — nhưng bạn vẫn nên **chỉ định rõ ràng** `provider/model`.

### Sử dụng **Multi-Agent Routing** để chạy nhiều agent cô lập và định tuyến các tin nhắn đến theo&#xA;kênh/tài khoản/đối tác.

49. **Mặc định được khuyến nghị:** `anthropic/claude-opus-4-6`.
    Tài liệu: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
    [Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).
    **Reliable (less character):** `openai/gpt-5.2` - nearly as good as Opus, just less personality.
    **Budget:** `zai/glm-4.7`.

MiniMax M2.1 has its own docs: [MiniMax](/providers/minimax) and
[Local models](/gateway/local-models).

Rule of thumb: use the **best model you can afford** for high-stakes work, and a cheaper
model for routine chat or summaries. You can route models per agent and use sub-agents to
parallelize long tasks (each sub-agent consumes tokens). See [Models](/concepts/models) and
[Sub-agents](/tools/subagents).

32. Cảnh báo mạnh: các mô hình yếu hơn hoặc bị quantize quá mức dễ bị tấn công prompt injection và hành vi không an toàn hơn. 33. Xem [Security](/gateway/security).

34. Thêm ngữ cảnh: [Models](/concepts/models).

### Can I use selfhosted models llamacpp vLLM Ollama

Có. If your local server exposes an OpenAI-compatible API, you can point a
custom provider at it. Ollama is supported directly and is the easiest path.

38. Lưu ý về bảo mật: các mô hình nhỏ hoặc bị quantize mạnh dễ bị prompt injection hơn. We strongly recommend **large models** for any bot that can use tools.
    If you still want small models, enable sandboxing and strict tool allowlists.

Bạn khuyến nghị mô hình nào

### How do I switch models without wiping my config

Use **model commands** or edit only the **model** fields. Avoid full config replaces.

Safe options:

- 46. `/model` trong chat (nhanh, theo từng session)
- 47. `openclaw models set ...` (chỉ cập nhật cấu hình model)
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

**Lựa chọn thay thế tốt:** `anthropic/claude-sonnet-4-5`.

```
/model anthropic/claude-opus-4-6
```

If you want to return to the default, pick it from `/model` (or send `/model <default provider/model>`).
Use `/model status` to confirm which auth profile is active.

### Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding

Có. Set one as default and switch as needed:

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

Có. Use **MiniMax as the default** and switch models **per session** when needed.
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

Sau đó:

```
/model gpt
```

**Option B: separate agents**

- Agent A default: MiniMax
- Agent B default: OpenAI
- Route by agent or use `/agent` to switch

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Tài liệu: [Ollama](/providers/ollama), [Local models](/gateway/local-models),&#xA;[Model providers](/concepts/model-providers), [Security](/gateway/security),&#xA;[Sandboxing](/gateway/sandboxing).

Có. OpenClaw ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Nếu bạn tự đặt alias trùng tên, giá trị của bạn sẽ được ưu tiên.

### Làm thế nào để định nghĩa/ghi đè các alias phím tắt của model

Alias đến từ `agents.defaults.models.<modelId>`.alias\`. Ví dụ:

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

Chạy lại `/model` **không** có hậu tố `@profile`:

### Làm thế nào để thêm model từ các nhà cung cấp khác như OpenRouter hoặc ZAI

OpenRouter (trả tiền theo token; nhiều model):

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

Z.AI (các model GLM):

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

Nếu bạn tham chiếu tới một provider/model nhưng thiếu khóa provider tương ứng, bạn sẽ gặp lỗi xác thực lúc chạy (ví dụ: `No API key found for provider "zai"`).

**Không tìm thấy API key cho provider sau khi thêm agent mới**

opus sonnet gpt có phải là các phím tắt tích hợp sẵn không Xác thực là theo từng agent và
được lưu tại:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Các cách khắc phục:

- Để nó soạn thảo, sau đó **phê duyệt trước khi gửi**.
- Hoặc sao chép `auth-profiles.json` từ `agentDir` của agent chính sang `agentDir` của agent mới.

KHÔNG dùng chung `agentDir` giữa các agent; việc này gây xung đột xác thực/phiên.

## Điều này thường có nghĩa là **agent mới** có kho xác thực trống.

### Chạy `openclaw agents add <id>` và cấu hình xác thực trong trình hướng dẫn.

Failover diễn ra theo hai giai đoạn:

1. **Luân phiên auth profile** trong cùng một provider.
2. **Dự phòng mô hình** sang mô hình tiếp theo trong `agents.defaults.model.fallbacks`.

Cooldown áp dụng cho các profile bị lỗi (backoff theo cấp số nhân), vì vậy OpenClaw vẫn có thể tiếp tục phản hồi ngay cả khi provider bị giới hạn tốc độ hoặc tạm thời gặp sự cố.

### Lỗi này có nghĩa là gì

```
No credentials found for profile "anthropic:default"
```

Điều này có nghĩa là hệ thống đã cố sử dụng ID auth profile `anthropic:default`, nhưng không tìm thấy thông tin xác thực cho nó trong kho xác thực dự kiến.

### Failover mô hình và "All models failed"

- **Xác nhận vị trí lưu auth profiles** (đường dẫn mới so với legacy)
  - Hiện tại: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Failover hoạt động như thế nào
- **Xác nhận biến môi trường của bạn được Gateway nạp**
  - Nếu bạn đặt `ANTHROPIC_API_KEY` trong shell nhưng chạy Gateway qua systemd/launchd, nó có thể không được kế thừa. Đặt nó trong `~/.openclaw/.env` hoặc bật `env.shellEnv`.
- **Đảm bảo bạn đang chỉnh sửa đúng agent**
  - Thiết lập multi-agent có nghĩa là có thể tồn tại nhiều file `auth-profiles.json`.
- **Kiểm tra nhanh trạng thái model/xác thực**
  - Dùng `openclaw models status` để xem các model đã cấu hình và liệu các provider đã được xác thực hay chưa.

Checklist khắc phục cho No credentials found for profile anthropicdefault

Điều này có nghĩa là lần chạy bị ghim (pinned) vào một auth profile của Anthropic, nhưng Gateway
không tìm thấy nó trong kho xác thực.

- **Sử dụng setup-token**
  - 1. Chạy `claude setup-token`, sau đó dán nó bằng `openclaw models auth setup-token --provider anthropic`.
  - Nếu token được tạo trên máy khác, dùng `openclaw models auth paste-token --provider anthropic`.

- 3. **Nếu bạn muốn dùng API key thay thế**
  - Đặt `ANTHROPIC_API_KEY` trong `~/.openclaw/.env` trên **máy chủ gateway**.
  - Cũ (Legacy): `~/.openclaw/agent/*` (được di chuyển bởi `openclaw doctor`)

    ```bash
    6. openclaw models auth order clear --provider anthropic
    ```

- 7. **Xác nhận rằng bạn đang chạy lệnh trên máy gateway**
  - **Checklist khắc phục cho No credentials found for profile anthropic**

### Vì sao nó cũng thử Google Gemini và bị lỗi

Nếu cấu hình model của bạn bao gồm Google Gemini như một fallback (hoặc bạn chuyển sang shorthand Gemini), OpenClaw sẽ thử nó trong quá trình fallback model. Nếu bạn chưa cấu hình thông tin xác thực Google, bạn sẽ thấy `No API key found for provider "google"`.

Cách khắc phục: либо cung cấp xác thực Google, hoặc loại bỏ/tránh các model Google trong `agents.defaults.model.fallbacks` / aliases để fallback không chuyển hướng sang đó.

**LLM request rejected message thinking signature required google antigravity**

Nguyên nhân: lịch sử phiên chứa **các thinking blocks không có chữ ký** (thường do stream bị hủy/không hoàn tất). Google Antigravity yêu cầu chữ ký cho các thinking blocks.

Cách khắc phục: OpenClaw hiện đã loại bỏ các thinking blocks không có chữ ký cho Google Antigravity Claude. Nếu vẫn còn xuất hiện, hãy bắt đầu **phiên mới** hoặc đặt `/thinking off` cho agent đó.

## 18. Auth profile: chúng là gì và cách quản lý

Liên quan: [/concepts/oauth](/concepts/oauth) (luồng OAuth, lưu trữ token, mô hình đa tài khoản)

### Auth profile là gì

Auth profile là một bản ghi thông tin xác thực được đặt tên (OAuth hoặc API key) gắn với một provider. 22. Các profile nằm tại:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Các ID profile thường gặp là gì

24. OpenClaw sử dụng các ID có tiền tố theo nhà cung cấp như:

- 25. `anthropic:default` (phổ biến khi không tồn tại danh tính email)
- `anthropic:<email>` cho các danh tính OAuth
- 27. các ID tùy chỉnh do bạn chọn (ví dụ: `anthropic:work`)

### 28. Tôi có thể kiểm soát auth profile nào được thử trước không

Có. 29. Cấu hình hỗ trợ metadata tùy chọn cho profile và thứ tự theo từng nhà cung cấp (\`auth.order.<provider>\`\`). Xóa mọi thứ tự ghim buộc vào một profile bị thiếu:

32. OpenClaw có thể tạm thời bỏ qua một profile nếu nó đang ở trạng thái **cooldown** ngắn (giới hạn tốc độ/timeouts/lỗi xác thực) hoặc trạng thái **disabled** dài hơn (thanh toán/không đủ tín dụng). Để kiểm tra, chạy `openclaw models status --json` và xem `auth.unusableProfiles`. 34. Tinh chỉnh: `auth.cooldowns.billingBackoffHours*`.

35. Bạn cũng có thể đặt ghi đè thứ tự **theo từng agent** (được lưu trong `auth-profiles.json` của agent đó) thông qua CLI:

```bash
36. # Mặc định là agent mặc định đã cấu hình (bỏ qua --agent)
openclaw models auth order get --provider anthropic

# Khóa xoay vòng vào một profile duy nhất (chỉ thử profile này)
openclaw models auth order set --provider anthropic anthropic:default

# Hoặc đặt thứ tự rõ ràng (fallback trong cùng nhà cung cấp)
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# Xóa ghi đè (quay về auth.order trong cấu hình / round-robin)
openclaw models auth order clear --provider anthropic
```

Để nhắm tới một agent cụ thể:

```bash
38. openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth so với API key khác nhau như thế nào

OpenClaw supports both:

- **OAuth** often leverages subscription access (where applicable).
- **API keys** use pay-per-token billing.

43. Trình hướng dẫn hỗ trợ rõ ràng Anthropic setup-token và OpenAI Codex OAuth và có thể lưu API key cho bạn.

## 44. Gateway: cổng, "đã chạy", và chế độ remote

### What port does the Gateway use

46. `gateway.port` điều khiển cổng ghép kênh duy nhất cho WebSocket + HTTP (UI điều khiển, hooks, v.v.).

Thứ tự ưu tiên:

```
47. --port > OPENCLAW_GATEWAY_PORT > gateway.port > mặc định 18789
```

### Why does openclaw gateway status say Runtime running but RPC probe failed

49. Vì "running" là góc nhìn của **supervisor** (launchd/systemd/schtasks). The RPC probe is the CLI actually connecting to the gateway WebSocket and calling `status`.

Use `openclaw gateway status` and trust these lines:

- `Probe target:` (the URL the probe actually used)
- `Listening:` (what's actually bound on the port)
- `Last gateway error:` (common root cause when the process is alive but the port isn't listening)

### Why does openclaw gateway status show Config cli and Config service different

You're editing one config file while the service is running another (often a `--profile` / `OPENCLAW_STATE_DIR` mismatch).

Fix:

```bash
openclaw gateway install --force
```

Run that from the same `--profile` / environment you want the service to use.

### What does another gateway instance is already listening mean

OpenClaw enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` indicating another instance is already listening.

Fix: stop the other instance, free the port, or run with `openclaw gateway --port <port>`.

### How do I run OpenClaw in remote mode client connects to a Gateway elsewhere

Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with a token/password:

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

Ghi chú:

- `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).
- The macOS app watches the config file and switches modes live when these values change.

### The Control UI says unauthorized or keeps reconnecting What now

Your gateway is running with auth enabled (`gateway.auth.*`), but the UI is not sending the matching token/password.

Facts (from code):

- The Control UI stores the token in browser localStorage key `openclaw.control.settings.v1`.

Fix:

- Fastest: `openclaw dashboard` (prints + copies the dashboard URL, tries to open; shows SSH hint if headless).
- If you don't have a token yet: `openclaw doctor --generate-gateway-token`.
- If remote, tunnel first: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`.
- Set `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) on the gateway host.
- In the Control UI settings, paste the same token.
- Still stuck? Run `openclaw status --all` and follow [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.

### I set gatewaybind tailnet but it cant bind nothing listens

`tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine isn't on Tailscale (or the interface is down), there's nothing to bind to.

Fix:

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
Full guide: [Multiple gateways](/gateway/multiple-gateways).

### What does invalid handshake code 1008 mean

The Gateway is a **WebSocket server**, and it expects the very first message to
be a `connect` frame. 2. Nếu nó nhận được bất kỳ thứ gì khác, nó sẽ đóng kết nối với **mã 1008** (vi phạm chính sách).

Common causes:

- You opened the **HTTP** URL in a browser (`http://...`) instead of a WS client.
- You used the wrong port or path.
- 6. Một proxy hoặc tunnel đã loại bỏ header xác thực hoặc gửi một yêu cầu không phải Gateway.

7. Cách khắc phục nhanh:

1. 8. Dùng URL WS: `ws://<host>:18789` (hoặc `wss://...` nếu dùng HTTPS).
2. Don't open the WS port in a normal browser tab.
3. If auth is on, include the token/password in the `connect` frame.

11) Nếu bạn đang dùng CLI hoặc TUI, URL sẽ trông như sau:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

13. Chi tiết giao thức: [Gateway protocol](/gateway/protocol).

## 14. Ghi log và gỡ lỗi

### 15. Log nằm ở đâu

16. Log file (có cấu trúc):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

17. Bạn có thể đặt đường dẫn cố định thông qua `logging.file`. 18. Mức log của file được điều khiển bởi `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.

20. Cách xem log nhanh nhất:

```bash
openclaw logs --follow
```

Service/supervisor logs (when the gateway runs via launchd/systemd):

- 22. macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` và `gateway.err.log` (mặc định: `~/.openclaw/logs/...`; các profile dùng `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- 24. Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

See [Troubleshooting](/gateway/troubleshooting#log-locations) for more.

### How do I startstoprestart the Gateway service

27. Dùng các helper của gateway:

```bash
openclaw gateway status
openclaw gateway restart
```

29. Nếu bạn chạy gateway thủ công, `openclaw gateway --force` có thể giành lại cổng. 30. Xem [Gateway](/gateway).

### I closed my terminal on Windows how do I restart OpenClaw

There are **two Windows install modes**:

33. **1) WSL2 (khuyến nghị):** Gateway chạy bên trong Linux.

34. Mở PowerShell, vào WSL, rồi khởi động lại:

```powershell
35. wsl
openclaw gateway status
openclaw gateway restart
```

If you never installed the service, start it in the foreground:

```bash
openclaw gateway run
```

37. **2) Windows gốc (không khuyến nghị):** Gateway chạy trực tiếp trên Windows.

38. Mở PowerShell và chạy:

```powershell
39. openclaw gateway status
openclaw gateway restart
```

40. Nếu bạn chạy thủ công (không có service), hãy dùng:

```powershell
openclaw gateway run
```

41. Tài liệu: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### 42. Gateway đang chạy nhưng không bao giờ nhận được phản hồi — tôi nên kiểm tra gì

Start with a quick health sweep:

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

Common causes:

- 46. Xác thực model chưa được nạp trên **máy chủ gateway** (kiểm tra `models status`).
- Channel pairing/allowlist blocking replies (check channel config + logs).
- 48. WebChat/Dashboard đang mở nhưng không có đúng token.

49. Nếu bạn truy cập từ xa, hãy xác nhận tunnel/Tailscale đang hoạt động và WebSocket của Gateway có thể truy cập được.

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### Disconnected from gateway no reason what now

This usually means the UI lost the WebSocket connection. Check:

1. Is the Gateway running? `openclaw gateway status`
2. Is the Gateway healthy? `openclaw status`
3. Does the UI have the right token? `openclaw dashboard`
4. If remote, is the tunnel/Tailscale link up?

Then tail logs:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands fails with network errors What should I check

Start with logs and channel status:

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

Trong chế độ remote, các profile xác thực nằm trên máy gateway, không phải laptop của bạn.
If the Gateway is remote, make sure you are looking at logs on the Gateway host.

Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

### TUI shows no output What should I check

First confirm the Gateway is reachable and the agent can run:

```bash
trạng thái openclaw
trạng thái các mô hình openclaw
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

### What's the fastest way to get more details when something fails

Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for channel auth, model routing, and RPC errors.

## Media and attachments

### My skill generated an imagePDF but nothing was sent

Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [OpenClaw assistant setup](/start/openclaw) and [Agent send](/tools/agent-send).

CLI sending:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Also check:

- Kênh mục tiêu hỗ trợ gửi media đi và không bị chặn bởi allowlist.
- The file is within the provider's size limits (images are resized to max 2048px).

See [Images](/nodes/images).

## Security and access control

### Is it safe to expose OpenClaw to inbound DMs

Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

- Hành vi mặc định trên các kênh hỗ trợ DM là **ghép cặp**:
  - Unknown senders receive a pairing code; the bot does not process their message.
  - Approve with: `openclaw pairing approve <channel> <code>`
  - 4. Các yêu cầu đang chờ được giới hạn ở **3 mỗi kênh**; kiểm tra `openclaw pairing list <channel>` nếu mã không đến.
- 5. Mở DM công khai yêu cầu phải chủ động cho phép (`dmPolicy: "open"` và allowlist `"*"`).

Run `openclaw doctor` to surface risky DM policies.

### Prompt injection chỉ là mối lo đối với các bot công khai hay không

Không. Prompt injection is about **untrusted content**, not just who can DM the bot.
9. Nếu trợ lý của bạn đọc nội dung bên ngoài (tìm kiếm/lấy dữ liệu web, trang trình duyệt, email,
tài liệu, tệp đính kèm, log được dán), nội dung đó có thể chứa các chỉ dẫn nhằm
chiếm quyền điều khiển mô hình. Rủi ro lớn nhất là khi các công cụ được bật: mô hình có thể bị đánh lừa để
rò rỉ ngữ cảnh hoặc gọi công cụ thay mặt bạn.

Rủi ro lớn nhất là khi các công cụ được bật: mô hình có thể bị lừa để
rò rỉ ngữ cảnh hoặc gọi công cụ thay mặt bạn. sử dụng một agent "reader" chỉ đọc hoặc bị vô hiệu hóa công cụ để tóm tắt nội dung không đáng tin cậy

- sử dụng một agent "reader" chỉ đọc hoặc bị vô hiệu hóa công cụ để tóm tắt nội dung không đáng tin cậy
- Chi tiết: [Security](/gateway/security).
- 15. sandbox hóa và danh sách cho phép công cụ nghiêm ngặt

Điều này cũng giúp việc xoay vòng thông tin xác thực hoặc thu hồi quyền truy cập trở nên dễ dàng hơn mà không ảnh hưởng đến các tài khoản cá nhân của bạn.

### 17. Bot của tôi có nên có email, tài khoản GitHub hoặc số điện thoại riêng không

18. Có, với hầu hết các thiết lập. 19. Cách ly bot bằng các tài khoản và số điện thoại riêng
    sẽ giảm phạm vi ảnh hưởng nếu có sự cố xảy ra. Điều này cũng giúp việc xoay vòng
    thông tin xác thực hoặc thu hồi quyền truy cập dễ dàng hơn mà không ảnh hưởng đến các tài khoản cá nhân của bạn.

Tài liệu: [Security](/gateway/security), [Pairing](/channels/pairing). 22. Chỉ cấp quyền cho những công cụ và tài khoản bạn thực sự cần, và mở rộng
sau nếu cần.

Tôi có thể giao cho nó quyền tự chủ đối với tin nhắn văn bản của mình không và điều đó có an toàn không

### Chúng tôi **không** khuyến nghị trao toàn quyền tự chủ đối với các tin nhắn cá nhân của bạn.

Mẫu an toàn nhất là: Để nó soạn thảo, sau đó **phê duyệt trước khi gửi**.

- 27. Giữ DM ở **chế độ ghép cặp** hoặc một allowlist chặt chẽ.
- 28. Dùng **một số điện thoại hoặc tài khoản riêng** nếu bạn muốn nó nhắn tin thay mặt bạn.
- **dev**: di chuyển theo head của `main` (git).

Có, **nếu** agent chỉ trò chuyện và đầu vào là đáng tin cậy. 31. Xem
[Security](/gateway/security).

### 32. Tôi có thể dùng các mô hình rẻ hơn cho tác vụ trợ lý cá nhân không

Kiểm tra các yêu cầu đang chờ: 34. Các tier nhỏ hơn
dễ bị chiếm quyền chỉ dẫn hơn, vì vậy hãy tránh dùng chúng cho các agent có bật công cụ
hoặc khi đọc nội dung không đáng tin cậy. 35. Nếu buộc phải dùng mô hình nhỏ hơn, hãy khóa chặt
công cụ và chạy trong sandbox. 36. Xem [Security](/gateway/security).

### 37. Tôi đã chạy start trong Telegram nhưng không nhận được mã ghép cặp

38. Mã ghép cặp **chỉ** được gửi khi một người gửi không xác định nhắn tin cho bot và
    `dmPolicy: "pairing"` được bật. 39. Lệnh `/start` tự nó không tạo ra mã.

Người gửi không xác định chỉ nhận được mã ghép cặp và tin nhắn của họ **không được xử lý**.

```bash
openclaw pairing list telegram
```

41. Nếu bạn muốn truy cập ngay, hãy thêm sender id của bạn vào allowlist hoặc đặt `dmPolicy: "open"`
    cho tài khoản đó.

### 42. WhatsApp nó có nhắn cho danh bạ của tôi không Việc ghép cặp hoạt động thế nào

Không. 43. Chính sách DM mặc định của WhatsApp là **ghép cặp**. OpenClaw chỉ trả lời các cuộc trò chuyện mà nó nhận được hoặc các lần gửi rõ ràng do bạn kích hoạt. Liệt kê các yêu cầu đang chờ:

46. Phê duyệt ghép cặp bằng:

```bash
openclaw pairing approve whatsapp <code>
```

Nếu bạn chạy trên số WhatsApp cá nhân của mình, hãy sử dụng số đó và bật `channels.whatsapp.selfChatMode`.

```bash
openclaw pairing list whatsapp
```

48. Lời nhắc số điện thoại trong trình hướng dẫn: nó được dùng để đặt **allowlist/chủ sở hữu** để DM của chính bạn được cho phép. 49. Nó không được dùng để tự động gửi. Lệnh chat, hủy tác vụ và "nó không dừng lại"

/verbose off
/reasoning off
--------------

### Làm thế nào để ngăn các thông báo hệ thống nội bộ hiển thị trong chat

Hầu hết các thông báo nội bộ hoặc công cụ chỉ xuất hiện khi **verbose** hoặc **reasoning** được bật
cho phiên đó.

Cách khắc phục ngay trong chat nơi bạn thấy nó:

```
Nếu vẫn còn quá ồn, hãy kiểm tra cài đặt phiên trong Control UI và đặt verbose
thành **inherit**.
```

Đối với các tiến trình nền (từ công cụ exec), bạn có thể yêu cầu agent chạy: Ngoài ra, hãy xác nhận rằng bạn không đang sử dụng hồ sơ bot có `verboseDefault` được đặt
thành `on` trong config.

Tài liệu: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### Làm thế nào để dừng/hủy một tác vụ đang chạy

Gửi bất kỳ mục nào sau đây **dưới dạng một tin nhắn độc lập** (không có dấu gạch chéo):

```
stop
abort
esc
wait
exit
interrupt
```

Đây là các trigger hủy (không phải lệnh gạch chéo).

process action:kill sessionId:XXX

```
Hầu hết các lệnh phải được gửi như một tin nhắn **độc lập** bắt đầu bằng `/`, nhưng một vài phím tắt (như `/status`) cũng hoạt động nội tuyến cho các người gửi được cho phép.
```

Tổng quan lệnh gạch chéo: xem [Slash commands](/tools/slash-commands).

OpenClaw chặn nhắn tin **xuyên nhà cung cấp** theo mặc định.

### Làm thế nào để gửi một tin nhắn Discord từ Telegram — Crosscontext messaging bị từ chối

Nếu một lần gọi công cụ được ràng buộc
với Telegram, nó sẽ không gửi sang Discord trừ khi bạn cho phép rõ ràng. Khởi động lại gateway sau khi chỉnh sửa cấu hình.

Bật nhắn tin xuyên nhà cung cấp cho agent:

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

Nếu bạn chỉ muốn điều này cho một agent
duy nhất, hãy đặt nó trong `agents.list[].tools.message` thay thế. Chế độ hàng đợi kiểm soát cách các tin nhắn mới tương tác với một lần chạy đang diễn ra.

### Tại sao có cảm giác như bot bỏ qua các tin nhắn gửi dồn dập

Sử dụng `/queue` để thay đổi chế độ: `followup` - chạy các tin nhắn từng cái một

- `steer` - các tin nhắn mới điều hướng lại tác vụ hiện tại
- `steer-backlog` - điều hướng ngay, sau đó xử lý tồn đọng
- `collect` - gom tin nhắn và trả lời một lần (mặc định)
- Bạn có thể thêm các tùy chọn như `debounce:2s cap:25 drop:summarize` cho các chế độ followup.
- `interrupt` - hủy lần chạy hiện tại và bắt đầu lại

Trả lời chính xác câu hỏi từ ảnh chụp màn hình / nhật ký chat

## **Q: "Mô hình mặc định cho Anthropic khi dùng API key là gì?"**

**A:** Trong OpenClaw, thông tin xác thực và việc chọn mô hình là hai thứ tách biệt.

Việc đặt `ANTHROPIC_API_KEY` (hoặc lưu API key Anthropic trong auth profiles) cho phép xác thực, nhưng mô hình mặc định thực tế là bất cứ thứ gì bạn cấu hình trong `agents.defaults.model.primary` (ví dụ: `anthropic/claude-sonnet-4-5` hoặc `anthropic/claude-opus-4-6`). Nếu bạn thấy `No credentials found for profile "anthropic:default"`, điều đó có nghĩa là Gateway không thể tìm thấy thông tin xác thực Anthropic trong `auth-profiles.json` được mong đợi cho agent đang chạy. Hãy hỏi trong [Discord](https://discord.com/invite/clawd) hoặc mở một [thảo luận GitHub](https://github.com/openclaw/openclaw/discussions).

---

Vẫn bị kẹt? Giữ các thay đổi tập trung.
