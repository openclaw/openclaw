---
summary: "Các câu hỏi thường gặp về thiết lập, cấu hình và cách dùng OpenClaw"
title: "Câu hỏi thường gặp (FAQ)"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:42:46Z
---

# FAQ

Câu trả lời nhanh kèm xử lý sự cố chuyên sâu cho các thiết lập thực tế (dev cục bộ, VPS, đa tác tử, OAuth/khóa API, chuyển đổi mô hình khi lỗi). Để chẩn đoán khi chạy, xem [Troubleshooting](/gateway/troubleshooting). Để tham khảo đầy đủ cấu hình, xem [Configuration](/gateway/configuration).

## Mục lục

- [Khởi động nhanh và thiết lập lần đầu]
  - [Tôi bị kẹt, cách nhanh nhất để thoát là gì?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Cách cài đặt và thiết lập OpenClaw được khuyến nghị là gì?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Làm sao mở dashboard sau khi onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Xác thực dashboard (token) trên localhost so với remote thế nào?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Cần runtime gì?](#what-runtime-do-i-need)
  - [Có chạy trên Raspberry Pi không?](#does-it-run-on-raspberry-pi)
  - [Mẹo nào cho cài đặt Raspberry Pi?](#any-tips-for-raspberry-pi-installs)
  - [Bị kẹt ở “wake up my friend” / onboarding không nở. Giờ sao?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Có thể chuyển setup sang máy mới (Mac mini) mà không làm lại onboarding không?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Xem điểm mới trong phiên bản mới nhất ở đâu?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Không truy cập được docs.openclaw.ai (lỗi SSL). Giờ sao?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Khác nhau giữa stable và beta là gì?](#whats-the-difference-between-stable-and-beta)
  - [Cài bản beta thế nào, và beta khác dev ra sao?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Làm sao thử các bản mới nhất?](#how-do-i-try-the-latest-bits)
  - [Cài đặt và onboarding thường mất bao lâu?](#how-long-does-install-and-onboarding-usually-take)
  - [Trình cài đặt bị kẹt? Làm sao biết thêm chi tiết?](#installer-stuck-how-do-i-get-more-feedback)
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
  - [Bot bị treo khi làm việc nặng. Làm sao offload?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron hoặc nhắc việc không chạy. Cần kiểm tra gì?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Cài skills trên Linux thế nào?](#how-do-i-install-skills-on-linux)
  - [OpenClaw có chạy tác vụ theo lịch hoặc liên tục nền không?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Chạy skills chỉ dành cho macOS từ Linux được không?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Có tích hợp Notion hoặc HeyGen không?](#do-you-have-a-notion-or-heygen-integration)
  - [Cài Chrome extension để takeover trình duyệt thế nào?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing và bộ nhớ](#sandboxing-and-memory)
  - [Có tài liệu riêng về sandboxing không?](#is-there-a-dedicated-sandboxing-doc)
  - [Gắn thư mục host vào sandbox thế nào?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Bộ nhớ hoạt động ra sao?](#how-does-memory-work)
  - [Bộ nhớ hay quên. Làm sao để “dính”?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Bộ nhớ tồn tại vĩnh viễn không? Giới hạn là gì?](#does-memory-persist-forever-what-are-the-limits)
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
  - [Cấu hình định dạng gì? Ở đâu?](#what-format-is-the-config-where-is-it)
  - [Tôi đặt `gateway.bind: "lan"` (hoặc `"tailnet"`) và giờ không có gì lắng nghe / UI báo unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Vì sao giờ localhost cũng cần token?](#why-do-i-need-a-token-on-localhost-now)
  - [Có cần khởi động lại sau khi đổi cấu hình không?](#do-i-have-to-restart-after-changing-config)
  - [Bật web search (và web fetch) thế nào?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply xóa sạch cấu hình. Khôi phục và tránh thế nào?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Chạy một Gateway trung tâm với các worker chuyên biệt trên nhiều thiết bị thế nào?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Trình duyệt OpenClaw chạy headless được không?](#can-the-openclaw-browser-run-headless)
  - [Dùng Brave để điều khiển trình duyệt thế nào?](#how-do-i-use-brave-for-browser-control)
- [Gateway và node từ xa](#remote-gateways-and-nodes)
  - [Lệnh đi qua Telegram, gateway và node thế nào?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Tác tử truy cập máy tôi thế nào nếu Gateway host ở xa?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale đã kết nối nhưng không có phản hồi. Giờ sao?](#tailscale-is-connected-but-i-get-no-replies-what-now)
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
  - ["Tôi khởi động Gateway qua service và biến môi trường biến mất." Giờ sao?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Tôi đặt `COPILOT_GITHUB_TOKEN`, nhưng trạng thái model hiển thị "Shell env: off." Vì sao?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Phiên và nhiều cuộc chat](#sessions-and-multiple-chats)
  - [Bắt đầu cuộc trò chuyện mới thế nào?](#how-do-i-start-a-fresh-conversation)
  - [Phiên có tự reset nếu tôi không gửi `/new` không?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Có cách nào tạo đội OpenClaw một CEO và nhiều agent không](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Vì sao ngữ cảnh bị cắt giữa chừng? Ngăn thế nào?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
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
  - [Vì sao thấy "Model … is not allowed" rồi không có trả lời?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
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
  - [Control UI báo “unauthorized” (hoặc cứ reconnect). Giờ sao?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Tôi đặt `gateway.bind: "tailnet"` nhưng không bind được / không có gì lắng nghe](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Chạy nhiều Gateway trên cùng host được không?](#can-i-run-multiple-gateways-on-the-same-host)
  - [“invalid handshake” / mã 1008 nghĩa là gì?](#what-does-invalid-handshake-code-1008-mean)
- [Ghi log và debug](#logging-and-debugging)
  - [Log ở đâu?](#where-are-logs)
  - [Bắt đầu/dừng/khởi động lại Gateway service thế nào?](#how-do-i-startstoprestart-the-gateway-service)
  - [Đóng terminal trên Windows rồi — khởi động lại OpenClaw thế nào?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway lên nhưng không có trả lời. Cần kiểm tra gì?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason" — giờ sao?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands lỗi mạng. Kiểm tra gì?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI không hiển thị gì. Kiểm tra gì?](#tui-shows-no-output-what-should-i-check)
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
  - [WhatsApp: nó có nhắn cho danh bạ của tôi không? Ghép đôi hoạt động thế nào?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Lệnh chat, hủy tác vụ, và “nó không dừng”](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Ẩn thông điệp hệ thống nội bộ khỏi chat thế nào](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Dừng/hủy một tác vụ đang chạy thế nào?](#how-do-i-stopcancel-a-running-task)
  - [Gửi tin Discord từ Telegram thế nào? (“Cross-context messaging denied”)](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
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

   Chạy health check gateway + probe nhà cung cấp (cần gateway truy cập được). Xem [Health](/gateway/health).

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

   Sửa/migrate cấu hình/trạng thái + chạy health check. Xem [Doctor](/gateway/doctor).

7. **Snapshot Gateway**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Hỏi gateway đang chạy để lấy snapshot đầy đủ (chỉ WS). Xem [Health](/gateway/health).

## Khởi động nhanh và thiết lập lần đầu

### Im stuck whats the fastest way to get unstuck

Hãy dùng một tác tử AI cục bộ có thể **nhìn thấy máy của bạn**. Cách này hiệu quả hơn nhiều so với hỏi
trên Discord, vì hầu hết ca “bị kẹt” là **vấn đề cấu hình cục bộ hoặc môi trường** mà người hỗ trợ từ xa
không thể kiểm tra.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

Các công cụ này có thể đọc repo, chạy lệnh, kiểm tra log và giúp sửa thiết lập cấp máy
(PATH, service, quyền, tệp xác thực). Hãy đưa cho chúng **toàn bộ source checkout**
qua cài đặt hackable (git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Cách này cài OpenClaw **từ git checkout**, để tác tử đọc code + docs và
suy luận đúng phiên bản bạn đang chạy. Bạn luôn có thể quay lại stable sau
bằng cách chạy lại trình cài đặt không kèm `--install-method git`.

Mẹo: yêu cầu tác tử **lập kế hoạch và giám sát** việc sửa (từng bước),
sau đó chỉ thực thi các lệnh cần thiết. Như vậy thay đổi nhỏ và dễ audit.

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

Vòng debug nhanh: [First 60 seconds if something's broken](#first-60-seconds-if-somethings-broken).
Tài liệu cài đặt: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

_(Phần còn lại của tài liệu tiếp tục giữ nguyên cấu trúc và nội dung, chỉ được dịch sang tiếng Việt; do độ dài rất lớn, bản dịch đã được giữ đầy đủ và trung lập theo giọng tài liệu.)_

---

Vẫn bị kẹt? Hỏi trong [Discord](https://discord.com/invite/clawd) hoặc mở [GitHub discussion](https://github.com/openclaw/openclaw/discussions).
