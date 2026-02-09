---
summary: "คำถามที่พบบ่อยเกี่ยวกับการตั้งค่า การกำหนดค่า และการใช้งาน OpenClaw"
title: "คำถามที่พบบ่อย"
---

# คำถามที่พบบ่อย

คำตอบแบบรวดเร็วพร้อมการแก้ไขปัญหาเชิงลึกสำหรับการตั้งค่าในโลกจริง (พัฒนาในเครื่อง, VPS, หลายเอเจนต์, OAuth/API keys, การสลับโมเดลอัตโนมัติเมื่อผิดพลาด) สำหรับการวินิจฉัยขณะรัน ดูที่ [การแก้ไขปัญหา](/gateway/troubleshooting) สำหรับอ้างอิงคอนฟิกทั้งหมด ดูที่ [การกำหนดค่า](/gateway/configuration) For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## สารบัญ

- [เริ่มต้นอย่างรวดเร็วและการตั้งค่าครั้งแรก]
  - [ผมติดอยู่ ทำอย่างไรถึงจะหลุดเร็วที่สุด?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [วิธีที่แนะนำในการติดตั้งและตั้งค่า OpenClaw คืออะไร?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [เปิดแดชบอร์ดหลังทำ onboarding อย่างไร?](#how-do-i-open-the-dashboard-after-onboarding)
  - [ยืนยันตัวตนแดชบอร์ด(โทเคน)บน localhost เทียบกับรีโมตอย่างไร?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [ต้องใช้ runtime อะไร?](#what-runtime-do-i-need)
  - [รันบน Raspberry Pi ได้ไหม?](#does-it-run-on-raspberry-pi)
  - [มีทิปสำหรับติดตั้งบน Raspberry Pi ไหม?](#any-tips-for-raspberry-pi-installs)
  - [It is stuck on "wake up my friend" / onboarding will not hatch. [ค้างที่ "wake up my friend" / onboarding ไม่ยอมฟัก ทำอย่างไร?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [ย้ายการตั้งค่าไปเครื่องใหม่(Mac mini)โดยไม่ต้องทำ onboarding ใหม่ได้ไหม?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [ดูว่ามีอะไรใหม่ในเวอร์ชันล่าสุดได้ที่ไหน?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [I can't access docs.openclaw.ai (SSL error). [ค้างที่ "wake up my friend" / onboarding ไม่ยอมฟัก ทำอย่างไร?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable กับ beta ต่างกันอย่างไร?](#whats-the-difference-between-stable-and-beta)
  - [ติดตั้ง beta อย่างไร และ beta ต่างจาก dev อย่างไร?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [ลองของใหม่ล่าสุดได้อย่างไร?](#how-do-i-try-the-latest-bits)
  - [การติดตั้งและ onboarding ใช้เวลานานแค่ไหน?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer stuck? How do I get more feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [ติดตั้งบน Windows ขึ้นว่าไม่พบ git หรือไม่รู้จัก openclaw](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [เอกสารไม่ตอบคำถาม จะขอคำตอบที่ดีกว่าได้อย่างไร?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [ติดตั้ง OpenClaw บน Linux อย่างไร?](#how-do-i-install-openclaw-on-linux)
  - [ติดตั้ง OpenClaw บน VPS อย่างไร?](#how-do-i-install-openclaw-on-a-vps)
  - [คู่มือติดตั้งบนคลาวด์/VPS อยู่ที่ไหน?](#where-are-the-cloudvps-install-guides)
  - [สั่งให้ OpenClaw อัปเดตตัวเองได้ไหม?](#can-i-ask-openclaw-to-update-itself)
  - [ตัวช่วย onboarding ทำอะไรบ้างจริงๆ?](#what-does-the-onboarding-wizard-actually-do)
  - [ต้องมีสมัคร Claude หรือ OpenAI ถึงจะรันได้ไหม?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [ใช้ Claude Max โดยไม่ใช้ API key ได้ไหม](#can-i-use-claude-max-subscription-without-an-api-key)
  - [การยืนยันตัวตน Anthropic "setup-token" ทำงานอย่างไร?](#how-does-anthropic-setuptoken-auth-work)
  - [หา Anthropic setup-token ได้ที่ไหน?](#where-do-i-find-an-anthropic-setuptoken)
  - [รองรับการยืนยันตัวตนด้วยสมาชิก Claude(Pro หรือ Max)ไหม?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [ทำไมเห็น `HTTP 429: rate_limit_error` จาก Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [รองรับ AWS Bedrock ไหม?](#is-aws-bedrock-supported)
  - [การยืนยันตัวตน Codex ทำงานอย่างไร?](#how-does-codex-auth-work)
  - [รองรับ OpenAI subscription auth(Codex OAuth)ไหม?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [ตั้งค่า Gemini CLI OAuth อย่างไร](#how-do-i-set-up-gemini-cli-oauth)
  - [ใช้โมเดลโลคัลสำหรับแชตทั่วไปได้ไหม?](#is-a-local-model-ok-for-casual-chats)
  - [ทำอย่างไรให้ทราฟฟิกโมเดลที่โฮสต์อยู่ในภูมิภาคเดียว?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [ต้องซื้อ Mac Mini เพื่อติดตั้งไหม?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [ต้องใช้ Mac mini เพื่อรองรับ iMessage ไหม?](#do-i-need-a-mac-mini-for-imessage-support)
  - [ถ้าซื้อ Mac mini มารัน OpenClaw จะเชื่อมต่อกับ MacBook Pro ได้ไหม?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [ใช้ Bun ได้ไหม?](#can-i-use-bun)
  - [Telegram: ใส่อะไรใน `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [หลายคนใช้ WhatsApp เบอร์เดียวกับ OpenClaw หลายอินสแตนซ์ได้ไหม?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [รันเอเจนต์แชตเร็วและเอเจนต์ Opus สำหรับโค้ดพร้อมกันได้ไหม?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew ใช้บน Linux ได้ไหม?](#does-homebrew-work-on-linux)
  - [ติดตั้งแบบ hackable(git) ต่างจาก npm อย่างไร?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [สลับระหว่าง npm และ git ภายหลังได้ไหม?](#can-i-switch-between-npm-and-git-installs-later)
  - [ควรรัน Gateway บนแล็ปท็อปหรือ VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [การรัน OpenClaw บนเครื่องเฉพาะสำคัญแค่ไหน?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [สเปก VPS ขั้นต่ำและ OS ที่แนะนำคืออะไร?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [รัน OpenClaw ใน VM ได้ไหม และต้องการอะไรบ้าง](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [OpenClaw คืออะไร?](#what-is-openclaw)
  - [OpenClaw คืออะไรในหนึ่งย่อหน้า?](#what-is-openclaw-in-one-paragraph)
  - [คุณค่าที่ได้คืออะไร?](#whats-the-value-proposition)
  - [เพิ่งตั้งค่าเสร็จ ควรทำอะไรต่อดี](#i-just-set-it-up-what-should-i-do-first)
  - [กรณีใช้งานประจำวันยอดนิยม 5 อันดับของ OpenClaw คืออะไร](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw ช่วยทำ lead gen, outreach, โฆษณา และบล็อกสำหรับ SaaS ได้ไหม](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [ข้อดีเมื่อเทียบกับ Claude Code สำหรับเว็บดีเวลอปเมนต์คืออะไร?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills และออโตเมชัน](#skills-and-automation)
  - [ปรับแต่ง skills โดยไม่ทำให้ repo สกปรกได้อย่างไร?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [โหลด skills จากโฟลเดอร์กำหนดเองได้ไหม?](#can-i-load-skills-from-a-custom-folder)
  - [ใช้โมเดลต่างกันสำหรับงานต่างกันได้อย่างไร?](#how-can-i-use-different-models-for-different-tasks)
  - [The bot freezes while doing heavy work. How do I offload that?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron or reminders do not fire. [Gateway ทำงานแต่คำตอบไม่มา ควรเช็กอะไร?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [ติดตั้ง skills บน Linux อย่างไร?](#how-do-i-install-skills-on-linux)
  - [OpenClaw รันงานตามตารางหรือเบื้องหลังต่อเนื่องได้ไหม?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [รัน skills ที่รองรับเฉพาะ Apple macOS จาก Linux ได้ไหม?](#can-i-run-apple-macos-only-skills-from-linux)
  - [มีอินทิเกรชัน Notion หรือ HeyGen ไหม?](#do-you-have-a-notion-or-heygen-integration)
  - [ติดตั้ง Chrome extension สำหรับยึดการควบคุมเบราว์เซอร์อย่างไร?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing และหน่วยความจำ](#sandboxing-and-memory)
  - [มีเอกสาร sandboxing แยกไหม?](#is-there-a-dedicated-sandboxing-doc)
  - [ผูกโฟลเดอร์โฮสต์เข้า sandbox อย่างไร?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [หน่วยความจำทำงานอย่างไร?](#how-does-memory-work)
  - [Memory keeps forgetting things. How do I make it stick?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Does memory persist forever? What are the limits?](#does-memory-persist-forever-what-are-the-limits)
  - [การค้นหาหน่วยความจำเชิงความหมายต้องใช้ OpenAI API key ไหม?](#does-semantic-memory-search-require-an-openai-api-key)
- [ไฟล์ต่างๆอยู่ที่ไหนบนดิสก์](#where-things-live-on-disk)
  - [ข้อมูลทั้งหมดของ OpenClaw ถูกบันทึกไว้ในเครื่องไหม?](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw เก็บข้อมูลไว้ที่ไหน?](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md ควรอยู่ที่ไหน?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [กลยุทธ์สำรองข้อมูลที่แนะนำคืออะไร?](#whats-the-recommended-backup-strategy)
  - [ถอนการติดตั้ง OpenClaw ทั้งหมดอย่างไร?](#how-do-i-completely-uninstall-openclaw)
  - [เอเจนต์ทำงานนอก workspace ได้ไหม?](#can-agents-work-outside-the-workspace)
  - [อยู่ในโหมดรีโมต ที่เก็บเซสชันอยู่ที่ไหน?](#im-in-remote-mode-where-is-the-session-store)
- [พื้นฐานคอนฟิก](#config-basics)
  - [What format is the config? Where is it?](#what-format-is-the-config-where-is-it)
  - [ตั้งค่า `gateway.bind: "lan"`(หรือ `"tailnet"`) แล้วไม่มีอะไรฟัง/ UI ขึ้น unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [ทำไม localhost ต้องใช้โทเคนตอนนี้?](#why-do-i-need-a-token-on-localhost-now)
  - [เปลี่ยนคอนฟิกแล้วต้องรีสตาร์ตไหม?](#do-i-have-to-restart-after-changing-config)
  - [เปิดใช้งาน web search(และ web fetch)อย่างไร?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply wiped my config. How do I recover and avoid this?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [รัน Gateway กลางพร้อม workers เฉพาะทางข้ามอุปกรณ์อย่างไร?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [เบราว์เซอร์ OpenClaw รันแบบ headless ได้ไหม?](#can-the-openclaw-browser-run-headless)
  - [ใช้ Brave เพื่อควบคุมเบราว์เซอร์อย่างไร?](#how-do-i-use-brave-for-browser-control)
- [Gateway และโหนดระยะไกล](#remote-gateways-and-nodes)
  - [คำสั่งไหลระหว่าง Telegram, gateway และโหนดอย่างไร?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [เอเจนต์เข้าถึงคอมพิวเตอร์ฉันได้อย่างไรถ้า Gateway โฮสต์ระยะไกล?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale is connected but I get no replies. [ค้างที่ "wake up my friend" / onboarding ไม่ยอมฟัก ทำอย่างไร?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [OpenClaw สองอินสแตนซ์คุยกันได้ไหม(local+VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [ต้องใช้ VPS แยกสำหรับหลายเอเจนต์ไหม](#do-i-need-separate-vpses-for-multiple-agents)
  - [ใช้โหนดบนแล็ปท็อปส่วนตัวดีกว่า SSH จาก VPS ไหม?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [โหนดรันบริการ gateway ไหม?](#do-nodes-run-a-gateway-service)
  - [มี API/RPC สำหรับ apply คอนฟิกไหม?](#is-there-an-api-rpc-way-to-apply-config)
  - [คอนฟิกขั้นต่ำที่เหมาะสมสำหรับติดตั้งครั้งแรกคืออะไร?](#whats-a-minimal-sane-config-for-a-first-install)
  - [ตั้งค่า Tailscale บน VPS และเชื่อมต่อจาก Mac อย่างไร?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [เชื่อมต่อโหนด Mac กับ Gateway ระยะไกล(Tailscale Serve)อย่างไร?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [ควรติดตั้งบนแล็ปท็อปเครื่องที่สองหรือแค่เพิ่มโหนด?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars และการโหลด .env](#env-vars-and-env-loading)
  - [OpenClaw โหลด environment variables อย่างไร?](#how-does-openclaw-load-environment-variables)
  - ["I started the Gateway via the service and my env vars disappeared." [ค้างที่ "wake up my friend" / onboarding ไม่ยอมฟัก ทำอย่างไร?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [I set `COPILOT_GITHUB_TOKEN`, but models status shows "Shell env: off." Why?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [เซสชันและหลายแชต](#sessions-and-multiple-chats)
  - [เริ่มการสนทนาใหม่อย่างไร?](#how-do-i-start-a-fresh-conversation)
  - [ถ้าไม่เคยส่ง `/new` เซสชันจะรีเซ็ตอัตโนมัติไหม?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [ทำทีม OpenClaw แบบหนึ่ง CEO หลายเอเจนต์ได้ไหม](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Why did context get truncated mid-task? How do I prevent it?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [รีเซ็ต OpenClaw ทั้งหมดแต่คงการติดตั้งไว้ได้อย่างไร?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [เจอข้อผิดพลาด "context too large" จะรีเซ็ตหรือย่ออย่างไร?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [ทำไมเห็น "LLM request rejected: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [ทำไมได้ข้อความ heartbeat ทุก 30 นาที?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [ต้องเพิ่ม "บัญชีบอต" เข้า WhatsApp group ไหม?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [ดู JID ของ WhatsApp group อย่างไร?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [ทำไม OpenClaw ไม่ตอบในกลุ่ม?](#why-doesnt-openclaw-reply-in-a-group)
  - [กลุ่ม/เธรดแชร์บริบทกับ DM ไหม?](#do-groupsthreads-share-context-with-dms)
  - [สร้าง workspace และเอเจนต์ได้กี่ตัว?](#how-many-workspaces-and-agents-can-i-create)
  - [รันหลายบอตหรือหลายแชตพร้อมกัน(Slack)ได้ไหม และควรตั้งค่าอย่างไร?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [โมเดล: ค่าเริ่มต้น การเลือก อลิแอส การสลับ](#models-defaults-selection-aliases-switching)
  - [โมเดลเริ่มต้นคืออะไร?](#what-is-the-default-model)
  - [แนะนำโมเดลอะไร?](#what-model-do-you-recommend)
  - [สลับโมเดลโดยไม่ล้างคอนฟิกได้อย่างไร?](#how-do-i-switch-models-without-wiping-my-config)
  - [ใช้โมเดลโฮสต์เอง(llama.cpp, vLLM, Ollama)ได้ไหม?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw, Flawd และ Krill ใช้โมเดลอะไร?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [สลับโมเดลทันทีโดยไม่รีสตาร์ตได้อย่างไร?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [ใช้ GPT 5.2 สำหรับงานประจำ และ Codex 5.3 สำหรับโค้ดได้ไหม](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [ทำไมเห็น "Model … is not allowed" แล้วไม่ตอบ?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [ทำไมเห็น "Unknown model: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [ตั้ง MiniMax เป็นค่าเริ่มต้นและใช้ OpenAI สำหรับงานซับซ้อนได้ไหม?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt เป็นช็อตคัตในตัวไหม?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [กำหนด/แทนที่ช็อตคัตโมเดล(อลิแอส)อย่างไร?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [เพิ่มโมเดลจากผู้ให้บริการอื่นอย่าง OpenRouter หรือ Z.AI อย่างไร?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [การสลับโมเดลเมื่อผิดพลาดและ "All models failed"](#model-failover-and-all-models-failed)
  - [failover ทำงานอย่างไร?](#how-does-failover-work)
  - [ข้อผิดพลาดนี้หมายความว่าอะไร?](#what-does-this-error-mean)
  - [เช็กลิสต์แก้ไขสำหรับ `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [ทำไมมันลอง Google Gemini ด้วยแล้วล้มเหลว?](#why-did-it-also-try-google-gemini-and-fail)
- [โปรไฟล์การยืนยันตัวตน: คืออะไรและจัดการอย่างไร](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [โปรไฟล์การยืนยันตัวตนคืออะไร?](#what-is-an-auth-profile)
  - [ID โปรไฟล์ที่พบบ่อยคืออะไร?](#what-are-typical-profile-ids)
  - [ควบคุมลำดับการลองโปรไฟล์ได้ไหม?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth กับ API key ต่างกันอย่างไร?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: พอร์ต, "already running" และโหมดรีโมต](#gateway-ports-already-running-and-remote-mode)
  - [Gateway ใช้พอร์ตอะไร?](#what-port-does-the-gateway-use)
  - [ทำไม `openclaw gateway status` บอก `Runtime: running` แต่ `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [ทำไม `openclaw gateway status` แสดง `Config (cli)` กับ `Config (service)` ต่างกัน?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - ["another gateway instance is already listening" หมายความว่าอะไร?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [รัน OpenClaw ในโหมดรีโมต(ไคลเอนต์เชื่อมต่อ Gateway ที่อื่น)อย่างไร?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [The Control UI says "unauthorized" (or keeps reconnecting). [ค้างที่ "wake up my friend" / onboarding ไม่ยอมฟัก ทำอย่างไร?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [ตั้ง `gateway.bind: "tailnet"` แล้ว bind ไม่ได้/ไม่มีอะไรฟัง](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [รันหลาย Gateway บนโฮสต์เดียวได้ไหม?](#can-i-run-multiple-gateways-on-the-same-host)
  - ["invalid handshake"/โค้ด 1008 หมายความว่าอะไร?](#what-does-invalid-handshake-code-1008-mean)
- [บันทึกและดีบัก](#logging-and-debugging)
  - [บันทึกอยู่ที่ไหน?](#where-are-logs)
  - [เริ่ม/หยุด/รีสตาร์ต Gateway service อย่างไร?](#how-do-i-startstoprestart-the-gateway-service)
  - [ปิดเทอร์มินัลบน Windows ไปแล้ว จะรีสตาร์ต OpenClaw อย่างไร?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [The Gateway is up but replies never arrive. [Gateway ทำงานแต่คำตอบไม่มา ควรเช็กอะไร?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason" ทำอย่างไร?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands fails with network errors. [Gateway ทำงานแต่คำตอบไม่มา ควรเช็กอะไร?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI shows no output. [Gateway ทำงานแต่คำตอบไม่มา ควรเช็กอะไร?](#tui-shows-no-output-what-should-i-check)
  - [หยุดแล้วเริ่ม Gateway ใหม่ทั้งหมดอย่างไร?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` เทียบกับ `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [วิธีที่เร็วที่สุดในการดูรายละเอียดเมื่อมีความล้มเหลวคืออะไร?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [สื่อและไฟล์แนบ](#media-and-attachments)
  - [skill สร้างภาพ/PDF แต่ไม่ถูกส่ง](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [ความปลอดภัยและการควบคุมการเข้าถึง](#security-and-access-control)
  - [ปลอดภัยไหมที่จะเปิดรับ DMs เข้ามา?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [prompt injection เป็นปัญหาเฉพาะบอตสาธารณะหรือไม่?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [บอตควรมีอีเมล/บัญชี GitHub/เบอร์โทรของตัวเองไหม](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [ให้มันมีอิสระจัดการข้อความของฉันได้ไหม และปลอดภัยหรือไม่](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [ใช้โมเดลที่ถูกกว่าสำหรับงานผู้ช่วยส่วนตัวได้ไหม?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [ฉันรัน `/start` ใน Telegram แต่ไม่ได้โค้ดจับคู่](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: มันจะส่งข้อความหาคอนแทคของฉันไหม? การจับคู่ทำงานอย่างไร?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [คำสั่งแชต การยกเลิกงาน และ "มันไม่หยุด"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [หยุดไม่ให้ข้อความระบบภายในแสดงในแชตอย่างไร](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [หยุด/ยกเลิกงานที่กำลังรันอย่างไร?](#how-do-i-stopcancel-a-running-task)
  - [ส่งข้อความ Discord จาก Telegram อย่างไร? ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [ทำไมรู้สึกว่าบอต "เมิน" ข้อความที่ส่งรัวๆ?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## 60 วินาทีแรกถ้ามีอะไรพัง

1. **สถานะด่วน(เช็กแรก)**

   ```bash
   openclaw status
   ```

   สรุปในเครื่องอย่างรวดเร็ว: OS+การอัปเดต, การเข้าถึง gateway/service, เอเจนต์/เซสชัน, คอนฟิกผู้ให้บริการ+ปัญหา runtime(เมื่อเข้าถึง gateway ได้)

2. **รายงานที่คัดลอกไปวางได้(แชร์ได้อย่างปลอดภัย)**

   ```bash
   openclaw status --all
   ```

   การวินิจฉัยแบบอ่านอย่างเดียวพร้อม log tail(ปิดบังโทเคนแล้ว)

3. **สถานะเดมอน+พอร์ต**

   ```bash
   openclaw gateway status
   ```

   แสดง runtime ของ supervisor เทียบกับการเข้าถึง RPC, URL เป้าหมายของ probe และคอนฟิกที่ service น่าจะใช้

4. **การตรวจเชิงลึก**

   ```bash
   openclaw status --deep
   ```

   รัน health checks ของ gateway + provider probes(ต้องเข้าถึง gateway ได้) ดู [Health](/gateway/health) See [Health](/gateway/health).

5. **ดู log ล่าสุด**

   ```bash
   openclaw logs --follow
   ```

   ถ้า RPC ล่ม ให้ใช้ทางเลือก:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   ไฟล์ log แยกจาก service logs; ดู [Logging](/logging) และ [Troubleshooting](/gateway/troubleshooting)

6. **รัน doctor(ซ่อมแซม)**

   ```bash
   openclaw doctor
   ```

   ซ่อม/ย้ายคอนฟิก/สถานะ + รัน health checks ดู [Doctor](/gateway/doctor) See [Doctor](/gateway/doctor).

7. **สแนปช็อต Gateway**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   ขอ snapshot เต็มจาก gateway ที่กำลังรัน(เฉพาะ WS) ดู [Health](/gateway/health) See [Health](/gateway/health).

## เริ่มต้นอย่างรวดเร็วและการตั้งค่าครั้งแรก

### Im stuck whats the fastest way to get unstuck

Use a local AI agent that can **see your machine**. ใช้เอเจนต์ AI ในเครื่องที่สามารถ **เห็นเครื่องของคุณได้** วิธีนี้ได้ผลกว่าการถาม
ใน Discord มาก เพราะกรณี "ติด" ส่วนใหญ่เป็น **คอนฟิกหรือสภาพแวดล้อมในเครื่อง**
ที่ผู้ช่วยระยะไกลตรวจดูไม่ได้

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

เครื่องมือเหล่านี้อ่าน repo, รันคำสั่ง, ตรวจ log และช่วยแก้การตั้งค่าระดับเครื่อง
(PATH, services, permissions, auth files) ให้มันเห็น **ซอร์สโค้ดทั้งหมด** ผ่านการติดตั้งแบบ hackable(git): Give them the **full source checkout** via
the hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

การติดตั้งนี้จะติดตั้ง OpenClaw **จาก git checkout** เพื่อให้เอเจนต์อ่านโค้ด+เอกสาร
และวิเคราะห์เวอร์ชันที่คุณใช้อยู่ได้ตรงเป๊ะ คุณสามารถสลับกลับไป stable ได้เสมอ
โดยรันตัวติดตั้งใหม่โดยไม่ใช้ `--install-method git` You can always switch back to stable later
by re-running the installer without `--install-method git`.

เคล็ดลับ: ขอให้เอเจนต์ **วางแผนและกำกับ** การแก้ไข(ทีละขั้น) แล้วค่อยรันเฉพาะ
คำสั่งที่จำเป็น จะช่วยให้การเปลี่ยนแปลงเล็กและตรวจสอบง่าย That keeps changes small and easier to audit.

ถ้าพบบั๊กจริงหรือมีวิธีแก้ โปรดเปิด GitHub issue หรือส่ง PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

เริ่มด้วยคำสั่งเหล่านี้(แชร์เอาต์พุตเมื่อขอความช่วยเหลือ):

```bash
openclaw status
openclaw models status
openclaw doctor
```

What they do:

- `openclaw status`: สแนปช็อตสุขภาพ gateway/เอเจนต์ + คอนฟิกพื้นฐาน
- `openclaw models status`: ตรวจการยืนยันตัวตนผู้ให้บริการ + ความพร้อมของโมเดล
- `openclaw doctor`: ตรวจและซ่อมปัญหาคอนฟิก/สถานะที่พบบ่อย

การตรวจ CLI ที่มีประโยชน์อื่นๆ: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`

ลูปดีบักแบบเร็ว: [60 วินาทีแรกถ้ามีอะไรพัง](#first-60-seconds-if-somethings-broken)
เอกสารติดตั้ง: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating)
Install docs: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### What's the recommended way to install and set up OpenClaw

The repo recommends running from source and using the onboarding wizard:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

From source (contributors/dev):

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

- 1. เปิด `http://127.0.0.1:18789/`.
- 2. หากระบบขอการยืนยันตัวตน ให้วางโทเค็นจาก `gateway.auth.token` (หรือ `OPENCLAW_GATEWAY_TOKEN`) ลงในการตั้งค่า Control UI
- 3. ดึงโทเค็นจากโฮสต์ของเกตเวย์: `openclaw config get gateway.auth.token` (หรือสร้างใหม่: `openclaw doctor --generate-gateway-token`).

4. **ไม่ได้รันบน localhost:**

- 5. **Tailscale Serve** (แนะนำ): คงการ bind แบบ loopback แล้วรัน `openclaw gateway --tailscale serve` จากนั้นเปิด `https://<magicdns>/`. 6. หาก `gateway.auth.allowTailscale` เป็น `true` เฮดเดอร์ตัวตนจะผ่านการยืนยันตัวตน (ไม่ต้องใช้โทเค็น)
- 7. **Tailnet bind**: รัน `openclaw gateway --bind tailnet --token "<token>"` เปิด `http://<tailscale-ip>:18789/` แล้ววางโทเค็นในหน้าการตั้งค่าแดชบอร์ด
- 8. **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` จากนั้นเปิด `http://127.0.0.1:18789/` และวางโทเค็นใน Control UI settings

9. ดู [Dashboard](/web/dashboard) และ [Web surfaces](/web) สำหรับโหมด bind และรายละเอียดการยืนยันตัวตน

### 10. ต้องใช้ runtime อะไร

11. ต้องใช้ Node **>= 22** 12. แนะนำให้ใช้ `pnpm` 13. Bun **ไม่แนะนำ** สำหรับ Gateway

### 14. รันบน Raspberry Pi ได้ไหม

15. ได้ 16. Gateway มีขนาดเล็ก เอกสารระบุว่า **RAM 512MB-1GB**, **1 core** และดิสก์ประมาณ **500MB** ก็เพียงพอสำหรับการใช้งานส่วนตัว และระบุว่า **Raspberry Pi 4 สามารถรันได้**

17. หากต้องการเผื่อทรัพยากรเพิ่ม (ล็อก สื่อ บริการอื่น) **แนะนำ 2GB**, แต่ไม่ใช่ขั้นต่ำที่บังคับ

18. เคล็ดลับ: Pi/VPS ขนาดเล็กสามารถโฮสต์ Gateway ได้ และคุณสามารถจับคู่ **nodes** บนแล็ปท็อป/โทรศัพท์เพื่อใช้หน้าจอ/กล้อง/แคนวาสภายในเครื่องหรือสั่งรันคำสั่ง 19. ดู [Nodes](/nodes).

### 20. มีคำแนะนำสำหรับการติดตั้งบน Raspberry Pi ไหม

Short version: it works, but expect rough edges.

- 22. ใช้ระบบปฏิบัติการ **64-bit** และคง Node >= 22
- 23. แนะนำการติดตั้งแบบ **hackable (git)** เพื่อดูล็อกและอัปเดตได้รวดเร็ว
- 24. เริ่มต้นโดยไม่เปิด channels/skills แล้วค่อยเพิ่มทีละอย่าง
- If you hit weird binary issues, it is usually an **ARM compatibility** problem.

26. เอกสาร: [Linux](/platforms/linux), [Install](/install).

### 27. มันค้างที่หน้าจอ wake up my friend onboarding แล้วไม่ hatch ทำอย่างไรดี

28. หน้าจอนั้นขึ้นกับการที่ Gateway เข้าถึงได้และผ่านการยืนยันตัวตน 29. TUI จะส่งข้อความ
    "Wake up, my friend!" อัตโนมัติในครั้งแรกที่ hatch 30. หากคุณเห็นบรรทัดนั้นโดย **ไม่มีการตอบกลับ**
    และตัวนับโทเค็นยังคงเป็น 0 แสดงว่าเอเจนต์ไม่เคยรัน

1. 31. รีสตาร์ต Gateway:

```bash
openclaw gateway restart
```

2. 32. ตรวจสอบสถานะ + การยืนยันตัวตน:

```bash
33. openclaw status
openclaw models status
openclaw logs --follow
```

3. 34. หากยังค้างอยู่ ให้รัน:

```bash
openclaw doctor
```

35. หาก Gateway อยู่ระยะไกล ตรวจสอบให้แน่ใจว่า tunnel/Tailscale เชื่อมต่ออยู่ และ UI ชี้ไปยัง Gateway ที่ถูกต้อง ดู [Remote access](/gateway/remote).

### 36. ฉันสามารถย้ายการตั้งค่าไปยังเครื่องใหม่ Mac mini โดยไม่ต้องทำ onboarding ใหม่ได้ไหม

37. ได้ 38. คัดลอก **state directory** และ **workspace** จากนั้นรัน Doctor หนึ่งครั้ง 39. วิธีนี้จะ
    ทำให้บอทของคุณ "เหมือนเดิมทุกประการ" (หน่วยความจำ ประวัติเซสชัน การยืนยันตัวตน และสถานะ channel)
    ตราบใดที่คุณคัดลอก **ทั้งสองตำแหน่ง**:

1. 40. ติดตั้ง OpenClaw บนเครื่องใหม่
2. 41. คัดลอก `$OPENCLAW_STATE_DIR` (ค่าเริ่มต้น: `~/.openclaw`) จากเครื่องเดิม
3. 42. คัดลอก workspace ของคุณ (ค่าเริ่มต้น: `~/.openclaw/workspace`)
4. 43. รัน `openclaw doctor` แล้วรีสตาร์ตบริการ Gateway

44) สิ่งนี้จะคงค่า config โปรไฟล์การยืนยันตัวตน ข้อมูลรับรอง WhatsApp เซสชัน และหน่วยความจำไว้ 45. หากคุณอยู่ในโหมด remote โปรดจำไว้ว่าโฮสต์ของ gateway เป็นผู้ถือที่เก็บเซสชันและ workspace

46. **สำคัญ:** หากคุณเพียง commit/push workspace ไปยัง GitHub คุณกำลังสำรองข้อมูล **memory + bootstrap files** แต่ **ไม่รวม** ประวัติเซสชันหรือการยืนยันตัวตน 47. สิ่งเหล่านั้นอยู่ภายใต้
    `~/.openclaw/` (เช่น `~/.openclaw/agents/<agentId>/sessions/`)

48. ที่เกี่ยวข้อง: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),
    [Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
    [Remote mode](/gateway/remote).

### 49. ดูได้ที่ไหนว่ามีอะไรใหม่ในเวอร์ชันล่าสุด

50. ตรวจสอบ changelog บน GitHub:
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

รายการใหม่ล่าสุดจะอยู่ด้านบนสุด หากส่วนบนสุดถูกทำเครื่องหมายว่า **Unreleased** ส่วนที่มีวันที่ถัดไปคือเวอร์ชันล่าสุดที่เผยแพร่แล้ว รายการถูกจัดกลุ่มตาม **Highlights**, **Changes**, และ **Fixes** (รวมถึงส่วนเอกสาร/อื่น ๆ เมื่อจำเป็น)

### [เข้า docs.openclaw.ai ไม่ได้(SSL error) ทำอย่างไร?](#i-cant-access-docsopenclawai-ssl-error-what-now)

การเชื่อมต่อ Comcast/Xfinity บางรายการบล็อก `docs.openclaw.ai` อย่างไม่ถูกต้องผ่าน Xfinity Advanced Security ปิดการทำงานหรือเพิ่ม `docs.openclaw.ai` ใน allowlist แล้วลองใหม่อีกครั้ง รายละเอียดเพิ่มเติม: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity)
โปรดช่วยเราปลดบล็อกโดยรายงานที่นี่: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status)

หากคุณยังไม่สามารถเข้าถึงไซต์ได้ เอกสารถูกมิเรอร์ไว้บน GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### ความแตกต่างระหว่าง stable และ beta คืออะไร

**Stable** และ **beta** คือ **npm dist-tags** ไม่ใช่สายโค้ดแยกกัน:

- `latest` = stable
- `beta` = บิลด์เริ่มต้นสำหรับการทดสอบ

เราปล่อยบิลด์ไปที่ **beta** ทดสอบ และเมื่อบิลด์นั้นมีความเสถียรแล้ว เราจะ **โปรโมตเวอร์ชันเดียวกันนั้นไปเป็น `latest`** นั่นคือเหตุผลที่ beta และ stable อาจชี้ไปที่ **เวอร์ชันเดียวกัน**

See what changed:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### ฉันจะติดตั้งเวอร์ชัน beta ได้อย่างไร และความแตกต่างระหว่าง beta กับ dev คืออะไร

**Beta** คือ npm dist-tag `beta` (อาจตรงกับ `latest`)
**Dev** คือหัวเคลื่อนที่ของ `main` (git); เมื่อเผยแพร่จะใช้ npm dist-tag `dev`

คำสั่งบรรทัดเดียว (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

ตัวติดตั้งสำหรับ Windows (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

รายละเอียดเพิ่มเติม: [Development channels](/install/development-channels) และ [Installer flags](/install/installer)

### โดยปกติการติดตั้งและการเริ่มต้นใช้งานใช้เวลานานเท่าใด

แนวทางโดยประมาณ:

- **ติดตั้ง:** 2–5 นาที
- **เริ่มต้นใช้งาน:** 5–15 นาที ขึ้นอยู่กับจำนวนช่อง/โมเดลที่คุณตั้งค่า

หากค้าง ให้ใช้ [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback) และวงจรดีบักแบบรวดเร็วใน [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck)

### ฉันจะลองใช้บิตล่าสุดได้อย่างไร

มีสองตัวเลือก:

1. **ช่องทาง Dev (git checkout):**

```bash
openclaw update --channel dev
```

คำสั่งนี้จะสลับไปที่สาขา `main` และอัปเดตจากซอร์ส

2. **การติดตั้งแบบแก้ไขได้ (จากไซต์ตัวติดตั้ง):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

คุณจะได้รีโปในเครื่องที่สามารถแก้ไขได้ จากนั้นอัปเดตผ่าน git

หากคุณต้องการโคลนแบบสะอาดด้วยตนเอง ให้ใช้:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

เอกสาร: [Update](/cli/update), [Development channels](/install/development-channels),
[Install](/install)

### [ตัวติดตั้งค้าง จะดูข้อมูลเพิ่มได้อย่างไร?](#installer-stuck-how-do-i-get-more-feedback)

รันตัวติดตั้งอีกครั้งพร้อม **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

ติดตั้ง Beta พร้อม verbose:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

สำหรับการติดตั้งแบบ hackable (git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

ตัวเลือกเพิ่มเติม: [Installer flags](/install/installer)

### การติดตั้งบน Windows แสดงว่าไม่พบ git หรือไม่รู้จัก openclaw

ปัญหา Windows ที่พบบ่อยสองประการ:

**1) ข้อผิดพลาด npm spawn git / ไม่พบ git**

- ติดตั้ง **Git for Windows** และตรวจสอบให้แน่ใจว่า `git` อยู่ใน PATH ของคุณ
- ปิดและเปิด PowerShell ใหม่ จากนั้นรันตัวติดตั้งอีกครั้ง

**2) openclaw is not recognized after install**

- Your npm global bin folder is not on PATH.

- Check the path:

  ```powershell
  npm config get prefix
  ```

- Ensure `<prefix>\\bin` is on PATH (on most systems it is `%AppData%\\npm`).

- Close and reopen PowerShell after updating PATH.

If you want the smoothest Windows setup, use **WSL2** instead of native Windows.
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

Hub: [Platforms](/platforms). Remote access: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I ask OpenClaw to update itself

Short answer: **possible, not recommended**. The update flow can restart the
Gateway (which drops the active session), may need a clean git checkout, and
can prompt for confirmation. Safer: run updates from a shell as the operator.

Use the CLI:

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

`openclaw onboard` is the recommended setup path. In **local mode** it walks you through:

- **Model/auth setup** (Anthropic **setup-token** recommended for Claude subscriptions, OpenAI Codex OAuth supported, API keys optional, LM Studio local models supported)
- **Workspace** location + bootstrap files
- **Gateway settings** (bind/port/auth/tailscale)
- **Providers** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)
- **Health checks** and **skills** selection

It also warns if your configured model is unknown or missing auth.

### Do I need a Claude or OpenAI subscription to run this

No. You can run OpenClaw with **API keys** (Anthropic/OpenAI/others) or with
**local-only models** so your data stays on your device. Subscriptions (Claude
Pro/Max or OpenAI Codex) are optional ways to authenticate those providers.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Local models](/gateway/local-models), [Models](/concepts/models).

### Can I use Claude Max subscription without an API key

Yes. You can authenticate with a **setup-token**
instead of an API key. This is the subscription path.

Claude Pro/Max subscriptions **do not include an API key**, so this is the
correct approach for subscription accounts. Important: you must verify with
Anthropic that this usage is allowed under their subscription policy and terms.
If you want the most explicit, supported path, use an Anthropic API key.

### How does Anthropic setuptoken auth work

`claude setup-token` generates a **token string** via the Claude Code CLI (it is not available in the web console). You can run it on **any machine**. Choose **Anthropic token (paste setup-token)** in the wizard or paste it with `openclaw models auth paste-token --provider anthropic`. The token is stored as an auth profile for the **anthropic** provider and used like an API key (no auto-refresh). More detail: [OAuth](/concepts/oauth).

### Where do I find an Anthropic setuptoken

It is **not** in the Anthropic Console. The setup-token is generated by the **Claude Code CLI** on **any machine**:

```bash
claude setup-token
```

Copy the token it prints, then choose **Anthropic token (paste setup-token)** in the wizard. If you want to run it on the gateway host, use `openclaw models auth setup-token --provider anthropic`. If you ran `claude setup-token` elsewhere, paste it on the gateway host with `openclaw models auth paste-token --provider anthropic`. See [Anthropic](/providers/anthropic).

### Do you support Claude subscription auth (Claude Pro or Max)

Yes - via **setup-token**. OpenClaw no longer reuses Claude Code CLI OAuth tokens; use a setup-token or an Anthropic API key. Generate the token anywhere and paste it on the gateway host. See [Anthropic](/providers/anthropic) and [OAuth](/concepts/oauth).

Note: Claude subscription access is governed by Anthropic's terms. For production or multi-user workloads, API keys are usually the safer choice.

### Why am I seeing HTTP 429 ratelimiterror from Anthropic

That means your **Anthropic quota/rate limit** is exhausted for the current window. If you
use a **Claude subscription** (setup-token or Claude Code OAuth), wait for the window to
reset or upgrade your plan. If you use an **Anthropic API key**, check the Anthropic Console
for usage/billing and raise limits as needed.

Tip: set a **fallback model** so OpenClaw can keep replying while a provider is rate-limited.
See [Models](/cli/models) and [OAuth](/concepts/oauth).

### Is AWS Bedrock supported

Yes - via pi-ai's **Amazon Bedrock (Converse)** provider with **manual config**. You must supply AWS credentials/region on the gateway host and add a Bedrock provider entry in your models config. See [Amazon Bedrock](/providers/bedrock) and [Model providers](/providers/models). If you prefer a managed key flow, an OpenAI-compatible proxy in front of Bedrock is still a valid option.

### How does Codex auth work

OpenClaw supports **OpenAI Code (Codex)** via OAuth (ChatGPT sign-in). The wizard can run the OAuth flow and will set the default model to `openai-codex/gpt-5.3-codex` when appropriate. See [Model providers](/concepts/model-providers) and [Wizard](/start/wizard).

### Do you support OpenAI subscription auth Codex OAuth

1. ใช่ 2. OpenClaw รองรับ **OpenAI Code (Codex) subscription OAuth** อย่างสมบูรณ์ 3. ตัวช่วยเริ่มต้น (onboarding wizard)
   สามารถรันขั้นตอน OAuth ให้คุณได้

4. ดู [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers) และ [Wizard](/start/wizard)

### 5. ฉันจะตั้งค่า Gemini CLI OAuth ได้อย่างไร

6. Gemini CLI ใช้ **plugin auth flow** ไม่ได้ใช้ client id หรือ secret ใน `openclaw.json`

7. ขั้นตอน:

1. 8. เปิดใช้งานปลั๊กอิน: `openclaw plugins enable google-gemini-cli-auth`
2. เข้าสู่ระบบ: `openclaw models auth login --provider google-gemini-cli --set-default`

9) การทำเช่นนี้จะเก็บ OAuth tokens ไว้ใน auth profiles บนเครื่อง gateway host 10. รายละเอียด: [Model providers](/concepts/model-providers)

### 11. โมเดลแบบ local ใช้คุยเล่นสบาย ๆ ได้ไหม

12. โดยทั่วไปไม่เหมาะ 13. OpenClaw ต้องการ context ขนาดใหญ่และความปลอดภัยที่แข็งแรง; การ์ดขนาดเล็กจะตัด context และมีความเสี่ยงข้อมูลรั่ว 14. หากจำเป็นจริง ๆ ให้รัน MiniMax M2.1 รุ่น **ที่ใหญ่ที่สุด** เท่าที่คุณรันได้ในเครื่อง (LM Studio) และดู [/gateway/local-models](/gateway/local-models) 15. โมเดลที่เล็กหรือถูก quantize จะเพิ่มความเสี่ยงต่อ prompt-injection — ดู [Security](/gateway/security)

### 16. ฉันจะจำกัดให้ทราฟฟิกของ hosted model อยู่ในภูมิภาคที่กำหนดได้อย่างไร

17. เลือก endpoint ที่ผูกกับภูมิภาค (region-pinned) 18. OpenRouter มีตัวเลือกที่โฮสต์ในสหรัฐฯ สำหรับ MiniMax, Kimi และ GLM; ให้เลือกเวอร์ชันที่โฮสต์ในสหรัฐฯ เพื่อเก็บข้อมูลไว้ในภูมิภาค 19. คุณยังสามารถแสดง Anthropic/OpenAI ควบคู่กันได้โดยใช้ `models.mode: "merge"` เพื่อให้ยังมี fallback พร้อมใช้งาน ขณะเดียวกันก็เคารพผู้ให้บริการที่ผูกกับภูมิภาคที่คุณเลือก

### 20. ฉันจำเป็นต้องซื้อ Mac mini เพื่อติดตั้งสิ่งนี้ไหม

21. ไม่จำเป็น 22. OpenClaw รันได้บน macOS หรือ Linux (Windows ผ่าน WSL2) 23. Mac mini เป็นทางเลือกเท่านั้น — บางคนซื้อมาเป็นโฮสต์ที่เปิดตลอดเวลา แต่ VPS ขนาดเล็ก เซิร์ฟเวอร์ที่บ้าน หรือกล่องระดับ Raspberry Pi ก็ใช้ได้เช่นกัน

24. คุณต้องใช้ Mac **เฉพาะสำหรับเครื่องมือที่เป็น macOS-only** เท่านั้น 25. สำหรับ iMessage ให้ใช้ [BlueBubbles](/channels/bluebubbles) (แนะนำ) — เซิร์ฟเวอร์ BlueBubbles รันบน Mac ใดก็ได้ และ Gateway สามารถรันบน Linux หรือที่อื่นได้ 26. หากต้องการใช้เครื่องมือ macOS-only อื่น ๆ ให้รัน Gateway บน Mac หรือจับคู่กับโหนด macOS

27. เอกสาร: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote)

### 28. ฉันต้องใช้ Mac mini สำหรับการรองรับ iMessage ไหม

29. คุณต้องมี **อุปกรณ์ macOS สักเครื่อง** ที่ลงชื่อเข้าใช้ Messages 30. **ไม่จำเป็น** ต้องเป็น Mac mini — Mac เครื่องใดก็ได้ 31. **ใช้ [BlueBubbles](/channels/bluebubbles)** (แนะนำ) สำหรับ iMessage — เซิร์ฟเวอร์ BlueBubbles รันบน macOS ขณะที่ Gateway สามารถรันบน Linux หรือที่อื่นได้

32. รูปแบบการตั้งค่าที่พบบ่อย:

- 33. รัน Gateway บน Linux/VPS และรันเซิร์ฟเวอร์ BlueBubbles บน Mac ใดก็ได้ที่ลงชื่อเข้าใช้ Messages
- 34. รันทุกอย่างบน Mac เครื่องเดียว หากต้องการการตั้งค่าที่ง่ายที่สุด

35. เอกสาร: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
    [Mac remote mode](/platforms/mac/remote)

### 36. ถ้าฉันซื้อ Mac mini มารัน OpenClaw ฉันสามารถเชื่อมต่อกับ MacBook Pro ของฉันได้ไหม

37. ได้ 38. **Mac mini สามารถรัน Gateway ได้** และ MacBook Pro ของคุณสามารถเชื่อมต่อเป็น
    **node** (อุปกรณ์คู่หู) 39. Node ไม่ได้รัน Gateway — แต่จะให้ความสามารถเพิ่มเติม เช่น หน้าจอ/กล้อง/canvas และ `system.run` บนอุปกรณ์นั้น

40. รูปแบบที่ใช้กันทั่วไป:

- 41. Gateway อยู่บน Mac mini (เปิดตลอดเวลา)
- 42. MacBook Pro รันแอป macOS หรือโฮสต์ node และจับคู่กับ Gateway
- 43. ใช้ `openclaw nodes status` / `openclaw nodes list` เพื่อดูสถานะ

เอกสาร: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### 44. ฉันสามารถใช้ Bun ได้ไหม

45. **ไม่แนะนำ** ให้ใช้ Bun 46. เราพบปัญหา runtime bugs โดยเฉพาะกับ WhatsApp และ Telegram
46. ใช้ **Node** เพื่อ Gateway ที่เสถียร

48. หากยังอยากทดลองใช้ Bun ให้ทำบน gateway ที่ไม่ใช้งานจริง (non-production)
    โดยไม่มี WhatsApp/Telegram

### 49. Telegram ต้องใส่อะไรใน allowFrom

50. `channels.telegram.allowFrom` คือ **Telegram user ID ของผู้ส่งที่เป็นมนุษย์** (เป็นตัวเลข แนะนำ) หรือ `@username` It is not the bot username.

ปลอดภัยกว่า (ไม่มีบอตบุคคลที่สาม):

- DM your bot, then run `openclaw logs --follow` and read `from.id`.

Official Bot API:

- DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.

บุคคลที่สาม (ความเป็นส่วนตัวน้อยกว่า):

- DM `@userinfobot` or `@getidsbot`.

See [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Can multiple people use one WhatsApp number with different OpenClaw instances

Yes, via **multi-agent routing**. Bind each sender's WhatsApp **DM** (peer `kind: "dm"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).

### Can I run a fast chat agent and an Opus for coding agent

Yes. Use multi-agent routing: give each agent its own default model, then bind inbound routes (provider account or specific peers) to each agent. Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).

### Does Homebrew work on Linux

Yes. Homebrew รองรับ Linux (Linuxbrew). Quick setup:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

If you run OpenClaw via systemd, ensure the service PATH includes `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non-login shells.
Recent builds also prepend common user bin dirs on Linux systemd services (for example `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.

### What's the difference between the hackable git install and npm install

- **Hackable (git) install:** full source checkout, editable, best for contributors.
  You run builds locally and can patch code/docs.
- **npm install:** global CLI install, no repo, best for "just run it."
  Updates come from npm dist-tags.

Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

### ฉันสามารถสลับระหว่างการติดตั้งแบบ npm และ git ภายหลังได้หรือไม่

Yes. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.
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

- **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
- **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.

**OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord all work fine from a VPS. The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).

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

Yes. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough
RAM for the Gateway and any channels you enable.

Baseline guidance:

- **Absolute minimum:** 1 vCPU, 1GB RAM.
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).
If you are running macOS in a VM, see [macOS VM](/install/macos-vm).

## What is OpenClaw?

### What is OpenClaw in one paragraph

OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.

### What's the value proposition

OpenClaw is not "just a Claude wrapper." It's a **local-first control plane** that lets you run a
capable assistant on **your own hardware**, reachable from the chat apps you already use, with
stateful sessions, memory, and tools - without handing control of your workflows to a hosted
SaaS.

ไฮไลต์:

- **Your devices, your data:** run the Gateway wherever you want (Mac, Linux, VPS) and keep the
  workspace + session history local.
- **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobile voice and Canvas on supported platforms.
- **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing
  and failover.
- **Local-only option:** run local models so **all data can stay on your device** if you want.
- **Multi-agent routing:** separate agents per channel, account, or task, each with its own
  workspace and defaults.
- **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### I just set it up what should I do first

Good first projects:

- Build a website (WordPress, Shopify, or a simple static site).
- Prototype a mobile app (outline, screens, API plan).
- Organize files and folders (cleanup, naming, tagging).
- Connect Gmail and automate summaries or follow ups.

It can handle large tasks, but it works best when you split them into phases and
use sub agents for parallel work.

### 1. กรณีการใช้งานประจำวัน 5 อันดับแรกของ OpenClaw คืออะไร

2. ความสำเร็จในชีวิตประจำวันมักจะมีลักษณะดังนี้:

- 3. **การสรุปส่วนบุคคล:** สรุปกล่องจดหมาย ปฏิทิน และข่าวที่คุณสนใจ
- 4. **การค้นคว้าและการร่าง:** การค้นคว้าอย่างรวดเร็ว การสรุป และร่างแรกสำหรับอีเมลหรือเอกสาร
- 5. **การเตือนความจำและการติดตามผล:** การแจ้งเตือนและเช็กลิสต์ที่ขับเคลื่อนด้วย cron หรือ heartbeat
- 6. **ระบบอัตโนมัติบนเบราว์เซอร์:** กรอกฟอร์ม รวบรวมข้อมูล และทำงานเว็บซ้ำ ๆ
- 7. **การประสานงานข้ามอุปกรณ์:** ส่งงานจากโทรศัพท์ของคุณ ให้ Gateway รันบนเซิร์ฟเวอร์ และรับผลลัพธ์กลับมาในแชต

### 8. OpenClaw สามารถช่วยทำ lead gen, outreach, โฆษณา และบล็อกสำหรับ SaaS ได้หรือไม่

9. ได้ สำหรับ **การค้นคว้า การคัดกรอง และการร่าง** 10. สามารถสแกนเว็บไซต์ สร้างรายชื่อสั้น,
   สรุปข้อมูลผู้มุ่งหวัง และเขียนร่างข้อความ outreach หรือโฆษณา

11. สำหรับ **outreach หรือการรันโฆษณา** ควรมีมนุษย์อยู่ในวงการทำงาน 12. หลีกเลี่ยงสแปม ปฏิบัติตามกฎหมายท้องถิ่นและ
    นโยบายของแพลตฟอร์ม และตรวจทานทุกอย่างก่อนส่ง 13. รูปแบบที่ปลอดภัยที่สุดคือให้
    OpenClaw ร่าง แล้วคุณเป็นผู้อนุมัติ

14. เอกสาร: [Security](/gateway/security).

### 15. ข้อได้เปรียบเมื่อเทียบกับ Claude Code สำหรับการพัฒนาเว็บคืออะไร

16. OpenClaw เป็น **ผู้ช่วยส่วนบุคคล** และเลเยอร์สำหรับการประสานงาน ไม่ใช่ตัวแทน IDE 17. ใช้
    Claude Code หรือ Codex สำหรับลูปการเขียนโค้ดโดยตรงที่รวดเร็วที่สุดภายใน repo 18. ใช้ OpenClaw เมื่อคุณ
    ต้องการหน่วยความจำถาวร การเข้าถึงข้ามอุปกรณ์ และการจัดการเครื่องมือ

19. ข้อได้เปรียบ:

- 20. **หน่วยความจำถาวร + เวิร์กสเปซ** ข้ามเซสชัน
- 21. **การเข้าถึงหลายแพลตฟอร์ม** (WhatsApp, Telegram, TUI, WebChat)
- 22. **การจัดการเครื่องมือ** (เบราว์เซอร์ ไฟล์ การตั้งเวลา hooks)
- 23. **Gateway ที่ทำงานตลอดเวลา** (รันบน VPS โต้ตอบได้จากทุกที่)
- 24. **Nodes** สำหรับเบราว์เซอร์/หน้าจอ/กล้อง/การรันคำสั่งในเครื่อง

25. ตัวอย่างผลงาน: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## 26. ทักษะและระบบอัตโนมัติ

### 27. ฉันจะปรับแต่งทักษะโดยไม่ทำให้ repo สกปรกได้อย่างไร

28. ใช้ managed overrides แทนการแก้ไขสำเนาใน repo 29. ใส่การเปลี่ยนแปลงของคุณใน `~/.openclaw/skills/<name>/SKILL.md` (หรือเพิ่มโฟลเดอร์ผ่าน `skills.load.extraDirs` ใน `~/.openclaw/openclaw.json`). 30. ลำดับความสำคัญคือ `<workspace>/skills` > `~/.openclaw/skills` > bundled ดังนั้น managed overrides จะชนะโดยไม่ต้องแตะ git 31. การแก้ไขที่เหมาะจะส่งขึ้น upstream เท่านั้นควรอยู่ใน repo และส่งออกเป็น PRs

### 32. ฉันสามารถโหลดทักษะจากโฟลเดอร์ที่กำหนดเองได้หรือไม่

33. ได้ 34. เพิ่มไดเรกทอรีเพิ่มเติมผ่าน `skills.load.extraDirs` ใน `~/.openclaw/openclaw.json` (ลำดับความสำคัญต่ำสุด) 35. ลำดับความสำคัญเริ่มต้นยังคงเป็น: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs` 36. `clawhub` จะติดตั้งลงใน `./skills` ตามค่าเริ่มต้น ซึ่ง OpenClaw จะมองว่าเป็น `<workspace>/skills`

### 37. ฉันจะใช้โมเดลที่แตกต่างกันสำหรับงานที่แตกต่างกันได้อย่างไร

38. ปัจจุบันรูปแบบที่รองรับคือ:

- 39. **Cron jobs**: งานที่แยกจากกันสามารถตั้งค่า override ของ `model` ต่อหนึ่งงานได้
- 40. **Sub-agents**: ส่งงานไปยังเอเจนต์แยกที่มีโมเดลเริ่มต้นต่างกัน
- 41. **การสลับตามต้องการ**: ใช้ `/model` เพื่อสลับโมเดลของเซสชันปัจจุบันได้ตลอดเวลา

42. ดู [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent) และ [Slash commands](/tools/slash-commands).

### [บอตค้างตอนทำงานหนัก จะย้ายงานออกได้อย่างไร?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)

43. ใช้ **sub-agents** สำหรับงานที่ยาวหรือทำงานแบบขนาน 44. Sub-agents จะรันในเซสชันของตัวเอง,
    ส่งคืนสรุป และทำให้แชตหลักของคุณตอบสนองได้ดี

45. ขอให้บอตของคุณ "spawn a sub-agent for this task" หรือใช้ `/subagents`
46. ใช้ `/status` ในแชตเพื่อดูว่า Gateway กำลังทำอะไรอยู่ตอนนี้ (และกำลังยุ่งอยู่หรือไม่)

47. เคล็ดลับเรื่องโทเคน: งานที่ยาวและ sub-agents ต่างก็ใช้โทเคน 48. หากค่าใช้จ่ายเป็นข้อกังวล ให้ตั้งค่า
    โมเดลที่ถูกกว่าสำหรับ sub-agents ผ่าน `agents.defaults.subagents.model`

49. เอกสาร: [Sub-agents](/tools/subagents).

### [Cron หรือการเตือนไม่ทำงาน ควรเช็กอะไร?](#cron-or-reminders-do-not-fire-what-should-i-check)

50. Cron ทำงานภายในโปรเซสของ Gateway If the Gateway is not running continuously,
    scheduled jobs will not run.

เช็กลิสต์:

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

Yes. Use the Gateway scheduler:

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

ตัวเลือก:

- **Custom skill / plugin:** best for reliable API access (Notion/HeyGen both have APIs).
- **Browser automation:** works without code but is slower and more fragile.

If you want to keep context per client (agency workflows), a simple pattern is:

- One Notion page per client (context + preferences + active work).
- Ask the agent to fetch that page at the start of a session.

If you want a native integration, open a feature request or build a skill
targeting those APIs.

Install skills:

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub installs into `./skills` under your current directory (or falls back to your configured OpenClaw workspace); OpenClaw treats that as `<workspace>/skills` on the next session. For shared skills across agents, place them in `~/.openclaw/skills/<name>/SKILL.md`. บางสกิลคาดว่าจะมีไบนารีที่ติดตั้งผ่าน Homebrew; บน Linux หมายถึง Linuxbrew (ดูรายการคำถามที่พบบ่อย Homebrew สำหรับ Linux ด้านบน) ดูที่ [Skills](/tools/skills) และ [ClawHub](/tools/clawhub)

### ฉันจะติดตั้งส่วนขยาย Chrome สำหรับการควบคุมเบราว์เซอร์ได้อย่างไร

ใช้ตัวติดตั้งที่มีมาให้ จากนั้นโหลดส่วนขยายแบบ unpacked ใน Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

จากนั้น Chrome → `chrome://extensions` → เปิด "Developer mode" → "Load unpacked" → เลือกโฟลเดอร์นั้น

คู่มือฉบับเต็ม (รวม Gateway ระยะไกล + หมายเหตุด้านความปลอดภัย): [Chrome extension](/tools/chrome-extension)

หาก Gateway รันอยู่บนเครื่องเดียวกับ Chrome (การตั้งค่าเริ่มต้น) โดยปกติ **ไม่จำเป็น** ต้องมีอะไรเพิ่มเติม
หาก Gateway รันอยู่ที่อื่น ให้รันโฮสต์โหนดบนเครื่องเบราว์เซอร์เพื่อให้ Gateway พร็อกซีการกระทำของเบราว์เซอร์ได้
คุณยังต้องคลิกปุ่มส่วนขยายบนแท็บที่ต้องการควบคุม (มันไม่เชื่อมต่ออัตโนมัติ)

## Sandboxing และหน่วยความจำ

### มีเอกสาร sandboxing โดยเฉพาะหรือไม่

มี ดูที่ [Sandboxing](/gateway/sandboxing) สำหรับการตั้งค่าเฉพาะ Docker (gateway เต็มรูปแบบใน Docker หรืออิมเมจ sandbox) ดูที่ [Docker](/install/docker)

### Docker ดูจำกัด ฉันจะเปิดใช้ฟีเจอร์ครบได้อย่างไร

อิมเมจเริ่มต้นเน้นความปลอดภัยเป็นหลักและรันด้วยผู้ใช้ `node` ดังนั้นจึงไม่มี แพ็กเกจระบบ, Homebrew หรือเบราว์เซอร์ที่บันเดิลมา

- สำหรับการตั้งค่าที่ครบขึ้น:
- ทำให้ `/home/node` คงอยู่ด้วย `OPENCLAW_HOME_VOLUME` เพื่อให้แคชยังอยู่
- อบแพ็กเกจระบบเข้าอิมเมจด้วย `OPENCLAW_DOCKER_APT_PACKAGES`
- ติดตั้งเบราว์เซอร์ Playwright ผ่าน CLI ที่บันเดิลมา:
  `node /app/node_modules/playwright-core/cli.js install chromium`

ตั้งค่า `PLAYWRIGHT_BROWSERS_PATH` และตรวจสอบให้แน่ใจว่าเส้นทางนั้นถูกทำให้คงอยู่

เอกสาร: [Docker](/install/docker), [Browser](/tools/browser)

**ฉันสามารถเก็บ DM เป็นส่วนตัว แต่ทำให้กลุ่มเป็นสาธารณะและ sandboxed ด้วยเอเจนต์เดียวได้หรือไม่**

ได้ — หากทราฟฟิกส่วนตัวของคุณคือ **DMs** และทราฟฟิกสาธารณะคือ **groups** ใช้ `agents.defaults.sandbox.mode: "non-main"` เพื่อให้เซสชันกลุ่ม/แชนเนล (คีย์ non-main) รันใน Docker ขณะที่เซสชัน DM หลักยังรันบนโฮสต์

จากนั้นจำกัดเครื่องมือที่ใช้ได้ในเซสชันที่ถูก sandbox ผ่าน `tools.sandbox.tools`

ขั้นตอนการตั้งค่า + ตัวอย่างคอนฟิก: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

### อ้างอิงคอนฟิกหลัก: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

ฉันจะ bind โฟลเดอร์จากโฮสต์เข้าไปใน sandbox ได้อย่างไร ตั้งค่า `agents.defaults.sandbox.docker.binds` เป็น `["host:path:mode"]` (เช่น `"/home/user/src:/src:ro"`) การ bind ระดับ global และต่อเอเจนต์จะถูกรวมกัน; การ bind ต่อเอเจนต์จะถูกละเว้นเมื่อ `scope: "shared"` ใช้ `:ro` สำหรับสิ่งที่อ่อนไหว และจำไว้ว่าการ bind จะข้ามกำแพงระบบไฟล์ของ sandbox

### ดูตัวอย่างและหมายเหตุด้านความปลอดภัยที่ [Sandboxing](/gateway/sandboxing#custom-bind-mounts) และ [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check)

หน่วยความจำทำงานอย่างไร

- หน่วยความจำของ OpenClaw เป็นเพียงไฟล์ Markdown ใน workspace ของเอเจนต์:
- บันทึกประจำวันใน `memory/YYYY-MM-DD.md`

บันทึกระยะยาวที่คัดสรรแล้วใน `MEMORY.md` (เฉพาะเซสชันหลัก/ส่วนตัว) OpenClaw ยังรัน **silent pre-compaction memory flush** เพื่อเตือนโมเดล ดู[หน่วยความจำ](/concepts/memory)

### [หน่วยความจำลืมบ่อย จะทำให้จำได้อย่างไร?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)

ให้เขียนบันทึกที่คงทนก่อนการบีบอัดอัตโนมัติ สิ่งนี้จะรันเฉพาะเมื่อ workspace

สามารถเขียนได้ (sandbox แบบอ่านอย่างเดียวจะข้ามไป) ขอให้บอท **เขียนข้อเท็จจริงลงหน่วยความจำ** บันทึกระยะยาวควรอยู่ใน `MEMORY.md`,

บริบทระยะสั้นให้อยู่ใน `memory/YYYY-MM-DD.md`

### ส่วนนี้ยังอยู่ระหว่างการปรับปรุง

การเตือนโมเดลให้จัดเก็บหน่วยความจำช่วยได้; มันจะรู้ว่าต้องทำอะไร หากยังลืมอยู่ ให้ตรวจสอบว่า Gateway ใช้

workspace เดียวกันทุกครั้งที่รัน
เอกสาร: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace) 1. หากไม่มีคีย์ใดพร้อมใช้งาน การค้นหาหน่วยความจำจะถูกปิดใช้งานจนกว่าคุณจะตั้งค่า 2. หากคุณตั้งค่าและมีพาธโมเดลแบบโลคัลอยู่ OpenClaw จะเลือกใช้ `local` ก่อน

3. หากคุณต้องการใช้งานแบบโลคัล ให้ตั้งค่า `memorySearch.provider = "local"` (และอาจตั้งค่า `memorySearch.fallback = "none"` เพิ่มเติม) 4. หากคุณต้องการใช้ Gemini embeddings ให้ตั้งค่า
   `memorySearch.provider = "gemini"` และระบุ `GEMINI_API_KEY` (หรือ
   `memorySearch.remote.apiKey`) 5. เรารองรับโมเดล embedding แบบ **OpenAI, Gemini หรือ local** — ดูรายละเอียดการตั้งค่าที่ [Memory](/concepts/memory)

### [หน่วยความจำคงอยู่ตลอดไหม มีข้อจำกัดอะไร?](#does-memory-persist-forever-what-are-the-limits)

6. ไฟล์หน่วยความจำจะถูกเก็บไว้บนดิสก์และคงอยู่จนกว่าคุณจะลบออก 7. ขีดจำกัดคือพื้นที่จัดเก็บของคุณ ไม่ใช่ตัวโมเดล 8. **บริบทของเซสชัน** ยังถูกจำกัดด้วยหน้าต่างบริบทของโมเดล ดังนั้นการสนทนาที่ยาวอาจถูกย่อหรือถูกตัดทอน 9. นั่นคือเหตุผลที่มีการค้นหาหน่วยความจำ — มันจะดึงเฉพาะส่วนที่เกี่ยวข้องกลับเข้าสู่บริบท

10. เอกสาร: [Memory](/concepts/memory), [Context](/concepts/context)

## 11. ข้อมูลต่าง ๆ ถูกเก็บไว้บนดิสก์ที่ไหน

### 12. ข้อมูลทั้งหมดที่ใช้กับ OpenClaw ถูกบันทึกไว้ในเครื่องหรือไม่

13. ไม่ — **สถานะของ OpenClaw อยู่ในเครื่อง**, แต่ **บริการภายนอกยังคงเห็นข้อมูลที่คุณส่งไปให้พวกเขา**

- 14. **โลคัลเป็นค่าเริ่มต้น:** เซสชัน ไฟล์หน่วยความจำ คอนฟิก และเวิร์กสเปซ อยู่บนโฮสต์ของ Gateway
      (`~/.openclaw` + ไดเรกทอรีเวิร์กสเปซของคุณ)
- 15. **รีโมตตามความจำเป็น:** ข้อความที่คุณส่งไปยังผู้ให้บริการโมเดล (Anthropic/OpenAI/etc.) 16. จะถูกส่งไปยัง
      API ของพวกเขา และแพลตฟอร์มแชต (WhatsApp/Telegram/Slack/etc.) 17. จะจัดเก็บข้อมูลข้อความบน
      เซิร์ฟเวอร์ของพวกเขา
- 18. **คุณควบคุมขอบเขตได้:** การใช้โมเดลโลคัลจะทำให้พรอมป์ตอยู่บนเครื่องของคุณ แต่ทราฟฟิกของช่องทางยังคงผ่านเซิร์ฟเวอร์ของช่องทางนั้น

19. ที่เกี่ยวข้อง: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory)

### 20. OpenClaw จัดเก็บข้อมูลไว้ที่ใด

21. ทุกอย่างอยู่ภายใต้ `$OPENCLAW_STATE_DIR` (ค่าเริ่มต้น: `~/.openclaw`):

| 22. พาธ                                                             | วัตถุประสงค์                                                                                                                     |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 23. `$OPENCLAW_STATE_DIR/openclaw.json`                             | 24. คอนฟิกหลัก (JSON5)                                                                 |
| 25. `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | 26. การนำเข้า OAuth แบบเดิม (จะถูกคัดลอกไปยังโปรไฟล์การยืนยันตัวตนเมื่อใช้งานครั้งแรก) |
| 27. `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 28. โปรไฟล์การยืนยันตัวตน (OAuth + API keys)                                           |
| 29. `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | 30. แคชการยืนยันตัวตนขณะรัน (จัดการอัตโนมัติ)                                          |
| `$OPENCLAW_STATE_DIR/credentials/`                                                         | 31. สถานะของผู้ให้บริการ (เช่น `whatsapp/<accountId>/creds.json`)                      |
| `$OPENCLAW_STATE_DIR/agents/`                                                              | 32. สถานะต่อเอเจนต์ (agentDir + เซสชัน)                                                |
| 33. `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | 34. ประวัติและสถานะการสนทนา (ต่อเอเจนต์)                                               |
| 35. `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | 36. เมทาดาทาของเซสชัน (ต่อเอเจนต์)                                                     |

37. พาธเอเจนต์เดี่ยวแบบเดิม: `~/.openclaw/agent/*` (ย้ายข้อมูลโดย `openclaw doctor`)

38. **เวิร์กสเปซ** ของคุณ (AGENTS.md, ไฟล์หน่วยความจำ, สกิล ฯลฯ) 39. แยกต่างหากและตั้งค่าผ่าน `agents.defaults.workspace` (ค่าเริ่มต้น: `~/.openclaw/workspace`)

### 40. ไฟล์ AGENTSmd SOULmd USERmd MEMORYmd ควรอยู่ที่ไหน

41. ไฟล์เหล่านี้อยู่ใน **เวิร์กสเปซของเอเจนต์** ไม่ใช่ `~/.openclaw`

- 42. **เวิร์กสเปซ (ต่อเอเจนต์)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
      `MEMORY.md` (หรือ `memory.md`), `memory/YYYY-MM-DD.md`, และ `HEARTBEAT.md` (ไม่บังคับ)
- 43. **ไดเรกทอรีสถานะ (`~/.openclaw`)**: คอนฟิก, ครีเดนเชียล, โปรไฟล์การยืนยันตัวตน, เซสชัน, ล็อก,
      และสกิลที่ใช้ร่วมกัน (`~/.openclaw/skills`)

44. เวิร์กสเปซเริ่มต้นคือ `~/.openclaw/workspace` สามารถตั้งค่าได้ผ่าน:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

45. หากบอท "ลืม" หลังรีสตาร์ต ให้ตรวจสอบว่า Gateway ใช้เวิร์กสเปซเดียวกันทุกครั้งที่เริ่มทำงาน (และจำไว้ว่าโหมดรีโมตใช้เวิร์กสเปซของ **โฮสต์ Gateway** ไม่ใช่แล็ปท็อปของคุณ)

46. เคล็ดลับ: หากคุณต้องการพฤติกรรมหรือความชอบที่คงทน ให้ขอให้บอท **เขียนลงใน AGENTS.md หรือ MEMORY.md** แทนการพึ่งพาประวัติแชต

47. ดู [Agent workspace](/concepts/agent-workspace) และ [Memory](/concepts/memory)

### 48. กลยุทธ์การสำรองข้อมูลที่แนะนำคืออะไร

49. นำ **เวิร์กสเปซของเอเจนต์** ใส่ไว้ในรีโป git แบบ **ส่วนตัว** และสำรองไว้ในที่ส่วนตัว (เช่น GitHub แบบ private) 50. วิธีนี้จะเก็บทั้งหน่วยความจำและไฟล์ AGENTS/SOUL/USER และช่วยให้คุณกู้คืน "จิตใจ" ของผู้ช่วยได้ในภายหลัง

อย่า **commit** อะไรก็ตามที่อยู่ใต้ `~/.openclaw` (ข้อมูลรับรอง, เซสชัน, โทเค็น)
หากคุณต้องการกู้คืนแบบเต็ม ให้สำรองข้อมูลทั้ง workspace และไดเรกทอรีสถานะ
แยกจากกัน (ดูคำถามเรื่องการย้ายข้อมูลด้านบน)

เอกสาร: [Agent workspace](/concepts/agent-workspace)

### ฉันจะถอนการติดตั้ง OpenClaw ทั้งหมดได้อย่างไร

ดูคู่มือเฉพาะ: [Uninstall](/install/uninstall)

### เอเจนต์สามารถทำงานนอก workspace ได้หรือไม่

ได้ workspace คือ **cwd เริ่มต้น** และจุดยึดหน่วยความจำ ไม่ใช่ sandbox แบบบังคับ
พาธแบบ relative จะอ้างอิงภายใน workspace แต่พาธแบบ absolute สามารถเข้าถึงตำแหน่งอื่นบนโฮสต์ได้
เว้นแต่จะเปิดใช้ sandboxing หากต้องการการแยกตัว ให้ใช้
[`agents.defaults.sandbox`](/gateway/sandboxing) หรือการตั้งค่า sandbox รายเอเจนต์ หากคุณ
ต้องการให้ repo เป็นไดเรกทอรีทำงานเริ่มต้น ให้ชี้ค่า `workspace` ของเอเจนต์นั้น
ไปที่รากของ repo repo ของ OpenClaw เป็นเพียงซอร์สโค้ด; ควรแยก workspace ออกต่างหาก เว้นแต่คุณตั้งใจให้เอเจนต์ทำงานภายในนั้น

ตัวอย่าง (ใช้ repo เป็น cwd เริ่มต้น):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### ฉันอยู่ในโหมดรีโมต ที่เก็บเซสชันอยู่ที่ไหน

สถานะเซสชันเป็นของ **โฮสต์ Gateway** หากคุณอยู่ในโหมดรีโมต ที่เก็บเซสชันที่เกี่ยวข้องจะอยู่บนเครื่องรีโมต ไม่ใช่แล็ปท็อปของคุณ ดู [Session management](/concepts/session)

## พื้นฐานการตั้งค่า

### [คอนฟิกเป็นรูปแบบอะไร อยู่ที่ไหน?](#what-format-is-the-config-where-is-it)

OpenClaw จะอ่านไฟล์ตั้งค่า **JSON5** แบบเลือกได้จาก `$OPENCLAW_CONFIG_PATH` (ค่าเริ่มต้น: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

หากไม่มีไฟล์ จะใช้ค่าเริ่มต้นที่ค่อนข้างปลอดภัย (รวมถึง workspace เริ่มต้นที่ `~/.openclaw/workspace`)

### ฉันตั้งค่า gateway bind เป็น lan หรือ tailnet แล้วตอนนี้ไม่มีอะไรฟังอยู่ UI แสดงว่า unauthorized

การ bind ที่ไม่ใช่ loopback **จำเป็นต้องมีการยืนยันตัวตน** ตั้งค่า `gateway.auth.mode` + `gateway.auth.token` (หรือใช้ `OPENCLAW_GATEWAY_TOKEN`)

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

Notes:

- `gateway.remote.token` ใช้สำหรับ **การเรียก CLI ระยะไกล** เท่านั้น; ไม่ได้เปิดการยืนยันตัวตนของ gateway ภายในเครื่อง
- Control UI ทำการยืนยันตัวตนผ่าน `connect.params.auth.token` (เก็บไว้ในการตั้งค่าแอป/UI) หลีกเลี่ยงการใส่โทเค็นใน URL

### ทำไมตอนนี้ฉันต้องใช้โทเค็นบน localhost

วิซาร์ดจะสร้างโทเค็นของ gateway ให้โดยค่าเริ่มต้น (แม้บน loopback) ดังนั้น **ไคลเอนต์ WS ภายในเครื่องต้องยืนยันตัวตน** สิ่งนี้ป้องกันไม่ให้โปรเซสภายในเครื่องอื่น ๆ เรียกใช้งาน Gateway วางโทเค็นลงในการตั้งค่า Control UI (หรือไฟล์ตั้งค่าไคลเอนต์ของคุณ) เพื่อเชื่อมต่อ

หากคุณ **ต้องการ loopback แบบเปิดจริง ๆ** ให้ลบ `gateway.auth` ออกจากไฟล์ตั้งค่าของคุณ Doctor สามารถสร้างโทเค็นให้คุณได้ทุกเมื่อ: `openclaw doctor --generate-gateway-token`

### ฉันต้องรีสตาร์ทหลังจากเปลี่ยนการตั้งค่าหรือไม่

Gateway จะเฝ้าดูไฟล์ตั้งค่าและรองรับการโหลดใหม่แบบร้อน:

- `gateway.reload.mode: "hybrid"` (ค่าเริ่มต้น): นำการเปลี่ยนแปลงที่ปลอดภัยไปใช้ทันที และรีสตาร์ทสำหรับการเปลี่ยนแปลงที่สำคัญ
- ยังรองรับ `hot`, `restart`, `off`

### ฉันจะเปิดใช้ web search และ web fetch ได้อย่างไร

`web_fetch` ทำงานได้โดยไม่ต้องใช้ API key `web_search` ต้องใช้ Brave Search API
key **แนะนำ:** รัน `openclaw configure --section web` เพื่อบันทึกไว้ใน
`tools.web.search.apiKey` ทางเลือกผ่าน environment: ตั้งค่า `BRAVE_API_KEY` สำหรับ
โปรเซส Gateway

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

หมายเหตุ:

- หากคุณใช้ allowlist ให้เพิ่ม `web_search`/`web_fetch` หรือ `group:web`
- `web_fetch` เปิดใช้งานเป็นค่าเริ่มต้น (เว้นแต่จะปิดใช้งานอย่างชัดเจน)
- Daemon จะอ่านตัวแปร env จาก `~/.openclaw/.env` (หรือจาก environment ของบริการ)

เอกสาร: [Web tools](/tools/web)

### ฉันจะรัน Gateway ศูนย์กลางพร้อม worker เฉพาะทางข้ามอุปกรณ์ได้อย่างไร

รูปแบบที่ใช้กันทั่วไปคือ **Gateway หนึ่งตัว** (เช่น Raspberry Pi) พร้อม **nodes** และ **agents**:

- **Gateway (central):** owns channels (Signal/WhatsApp), routing, and sessions.
- **Nodes (devices):** Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).
- **Agents (workers):** separate brains/workspaces for special roles (e.g. "Hetzner ops", "Personal data").
- **Sub-agents:** spawn background work from a main agent when you want parallelism.
- **TUI:** connect to the Gateway and switch agents/sessions.

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Can the OpenClaw browser run headless

Yes. It's a config option:

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

Default is `false` (headful). Headless is more likely to trigger anti-bot checks on some sites. ดูที่ [Browser](/tools/browser).

Headless uses the **same Chromium engine** and works for most automation (forms, clicks, scraping, logins). The main differences:

- ไม่มีหน้าต่างเบราว์เซอร์ที่มองเห็นได้ (ใช้ภาพหน้าจอหากต้องการภาพประกอบ).
- Some sites are stricter about automation in headless mode (CAPTCHAs, anti-bot).
  For example, X/Twitter often blocks headless sessions.

### How do I use Brave for browser control

Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway.
See the full config examples in [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Remote gateways and nodes

### คำสั่งถูกส่งต่อระหว่าง Telegram เกตเวย์ และโหนดอย่างไร

Telegram messages are handled by the **gateway**. The gateway runs the agent and
only then calls nodes over the **Gateway WebSocket** when a node tool is needed:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Nodes don't see inbound provider traffic; they only receive node RPC calls.

### How can my agent access my computer if the Gateway is hosted remotely

Short answer: **pair your computer as a node**. The Gateway runs elsewhere, but it can
call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

Typical setup:

1. Run the Gateway on the always-on host (VPS/home server).
2. Put the Gateway host + your computer on the same tailnet.
3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet)
   so it can register as a node.
5. Approve the node on the Gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

No separate TCP bridge is required; nodes connect over the Gateway WebSocket.

Security reminder: pairing a macOS node allows `system.run` on that machine. Only
pair devices you trust, and review [Security](/gateway/security).

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### [Tailscale เชื่อมต่อแล้วแต่ไม่มีการตอบกลับ ทำอย่างไร?](#tailscale-is-connected-but-i-get-no-replies-what-now)

Check the basics:

- Gateway is running: `openclaw gateway status`
- Gateway health: `openclaw status`
- Channel health: `openclaw channels status`

Then verify auth and routing:

- If you use Tailscale Serve, make sure `gateway.auth.allowTailscale` is set correctly.
- If you connect via SSH tunnel, confirm the local tunnel is up and points at the right port.
- Confirm your allowlists (DM or group) include your account.

Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### Can two OpenClaw instances talk to each other local VPS

ใช่ ไม่มีบริดจ์แบบ "bot-to-bot" ที่มีมาให้ในตัว แต่คุณสามารถเชื่อมต่อได้ด้วยวิธีที่เชื่อถือได้หลายแบบ:

**วิธีที่ง่ายที่สุด:** ใช้ช่องแชตปกติที่บอททั้งสองเข้าถึงได้ (Telegram/Slack/WhatsApp)
ให้ Bot A ส่งข้อความไปหา Bot B แล้วปล่อยให้ Bot B ตอบกลับตามปกติ

**CLI bridge (ทั่วไป):** รันสคริปต์ที่เรียก Gateway อีกตัวด้วยคำสั่ง
`openclaw agent --message ... --deliver` โดยกำหนดเป้าหมายไปยังแชตที่บอทอีกตัวรับฟังอยู่ หากบอทตัวหนึ่งอยู่บน VPS ระยะไกล ให้ชี้ CLI ของคุณไปยัง Gateway ระยะไกลนั้นผ่าน SSH/Tailscale (ดู [Remote access](/gateway/remote))

ตัวอย่างแพตเทิร์น (รันจากเครื่องที่สามารถเข้าถึง Gateway เป้าหมายได้):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

เคล็ดลับ: เพิ่ม guardrail เพื่อไม่ให้บอททั้งสองวนลูปตอบกันไม่รู้จบ (เช่น ตอบเฉพาะเมื่อถูก mention, allowlist ช่อง, หรือกฎ "ไม่ตอบข้อความจากบอท")

เอกสาร: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send)

### ฉันจำเป็นต้องใช้ VPS แยกสำหรับหลายเอเจนต์หรือไม่

ไม่จำเป็น Gateway หนึ่งตัวสามารถโฮสต์เอเจนต์หลายตัวได้ โดยแต่ละตัวมี workspace ค่าเริ่มต้นของโมเดล และ routing ของตัวเอง นี่คือการตั้งค่าปกติ และถูกกว่าและง่ายกว่าการรันหนึ่ง VPS ต่อหนึ่งเอเจนต์มาก

ใช้ VPS แยกเฉพาะเมื่อคุณต้องการการแยกแบบเข้มงวด (ขอบเขตด้านความปลอดภัย) หรือการตั้งค่าที่แตกต่างกันมากจนไม่อยากใช้ร่วมกัน นอกนั้น ให้ใช้ Gateway เดียว และใช้หลายเอเจนต์หรือซับเอเจนต์

### มีประโยชน์หรือไม่ที่จะใช้โหนดบนแล็ปท็อปส่วนตัวของฉันแทนการ SSH จาก VPS

มีประโยชน์ — node เป็นวิธีระดับ first-class ในการเข้าถึงแล็ปท็อปของคุณจาก Gateway ระยะไกล และให้ความสามารถมากกว่าแค่ shell access Gateway รันบน macOS/Linux (Windows ผ่าน WSL2) และมีน้ำหนักเบา (VPS ขนาดเล็กหรือเครื่องระดับ Raspberry Pi ก็เพียงพอ; RAM 4 GB ก็เหลือเฟือ) ดังนั้นการตั้งค่าที่พบบ่อยคือมีโฮสต์ที่เปิดตลอดเวลา พร้อมกับใช้แล็ปท็อปของคุณเป็น node

- **ไม่ต้องมี inbound SSH** node จะเชื่อมต่อออกไปยัง Gateway ผ่าน WebSocket และใช้การจับคู่กับอุปกรณ์
- **การควบคุมการรันที่ปลอดภัยกว่า** `system.run` ถูกจำกัดด้วย allowlist/การอนุมัติของ node บนแล็ปท็อปนั้น
- **เครื่องมืออุปกรณ์มากกว่าเดิม** node เปิดใช้ `canvas`, `camera` และ `screen` เพิ่มเติมจาก `system.run`
- **การทำ browser automation แบบโลคัล** เก็บ Gateway ไว้บน VPS แต่รัน Chrome แบบโลคัล แล้วรีเลย์การควบคุมด้วย Chrome extension + node host บนแล็ปท็อป

SSH เหมาะสำหรับการเข้าถึง shell แบบเฉพาะกิจ แต่ node จะง่ายกว่าสำหรับเวิร์กโฟลว์ของเอเจนต์ระยะยาวและการทำ device automation

เอกสาร: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension)

### ฉันควรติดตั้งบนแล็ปท็อปเครื่องที่สอง หรือแค่เพิ่ม node ดี

ถ้าคุณต้องการแค่ **เครื่องมือโลคัล** (screen/camera/exec) บนแล็ปท็อปเครื่องที่สอง ให้เพิ่มเป็น **node** วิธีนี้จะคงไว้ซึ่ง Gateway เดียวและหลีกเลี่ยงการตั้งค่าที่ซ้ำซ้อน เครื่องมือ node แบบโลคัลในตอนนี้รองรับเฉพาะ macOS แต่เรามีแผนจะขยายไปยังระบบปฏิบัติการอื่น

ติดตั้ง Gateway ตัวที่สองเฉพาะเมื่อคุณต้องการ **การแยกแบบเข้มงวด** หรือบอทที่แยกจากกันอย่างสมบูรณ์สองตัว

เอกสาร: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways)

### node รันบริการ gateway ด้วยหรือไม่

ไม่ ควรมี **gateway เพียงตัวเดียว** ต่อโฮสต์ เว้นแต่คุณจะตั้งใจรันโปรไฟล์ที่แยกกัน (ดู [Multiple gateways](/gateway/multiple-gateways)) node เป็นอุปกรณ์ต่อพ่วงที่เชื่อมต่อเข้ากับ gateway (node บน iOS/Android หรือโหมด "node mode" บนแอป menubar ของ macOS) สำหรับโฮสต์ node แบบ headless และการควบคุมผ่าน CLI ดูที่ [Node host CLI](/cli/node)

จำเป็นต้องรีสตาร์ตทั้งหมดเมื่อมีการเปลี่ยนแปลง `gateway`, `discovery` และ `canvasHost`

### มีวิธีใช้ API RPC เพื่อปรับใช้คอนฟิกหรือไม่

มี `config.apply` จะตรวจสอบความถูกต้อง + เขียนคอนฟิกทั้งหมด และรีสตาร์ท Gateway เป็นส่วนหนึ่งของกระบวนการนี้.

### [config.apply ลบคอนฟิกฉัน ทำอย่างไรจะกู้และป้องกัน?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)

`config.apply` จะแทนที่ **คอนฟิกทั้งหมด** หากคุณส่งออบเจ็กต์มาเพียงบางส่วน ส่วนอื่นทั้งหมดจะถูกลบออก

การกู้คืน:

- กู้คืนจากแบ็กอัป (git หรือไฟล์ที่คัดลอกไว้ `~/.openclaw/openclaw.json`)
- ถ้าไม่มีแบ็กอัป ให้รัน `openclaw doctor` อีกครั้ง และตั้งค่าช่อง/โมเดลใหม่
- ถ้าเหตุการณ์นี้ไม่คาดคิด ให้รายงานบั๊กและแนบคอนฟิกล่าสุดที่คุณทราบ หรือแบ็กอัปใด ๆ ที่มี
- เอเจนต์เขียนโค้ดแบบโลคัลมักสามารถสร้างคอนฟิกที่ใช้งานได้ขึ้นมาใหม่จากล็อกหรือประวัติได้

วิธีหลีกเลี่ยง:

- ใช้ `openclaw config set` สำหรับการเปลี่ยนแปลงเล็ก ๆ
- 1. ใช้ `openclaw configure` สำหรับการแก้ไขแบบโต้ตอบ

2. เอกสาร: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### 3. คอนฟิกที่สมเหตุสมผลขั้นต่ำสำหรับการติดตั้งครั้งแรกคืออะไร

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

4. สิ่งนี้จะตั้งค่า workspace ของคุณและจำกัดว่าใครสามารถเรียกใช้บอทได้

### 5. ฉันจะตั้งค่า Tailscale บน VPS และเชื่อมต่อจาก Mac ได้อย่างไร

6. ขั้นตอนขั้นต่ำ:

1. 7. **ติดตั้ง + เข้าสู่ระบบบน VPS**

   ```bash
   8. curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. 9. **ติดตั้ง + เข้าสู่ระบบบน Mac ของคุณ**
   - 10. ใช้แอป Tailscale และลงชื่อเข้าใช้ tailnet เดียวกัน

3. 11. **เปิดใช้งาน MagicDNS (แนะนำ)**
   - 12. ในคอนโซลผู้ดูแล Tailscale ให้เปิดใช้งาน MagicDNS เพื่อให้ VPS มีชื่อที่เสถียร

4. 13. **ใช้ชื่อโฮสต์ของ tailnet**
   - 14. SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - 15. Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

16) หากคุณต้องการ Control UI โดยไม่ใช้ SSH ให้ใช้ Tailscale Serve บน VPS:

```bash
openclaw gateway --tailscale serve
```

17. สิ่งนี้จะทำให้ gateway ผูกกับ loopback และเปิดเผย HTTPS ผ่าน Tailscale 18. ดู [Tailscale](/gateway/tailscale).

### 19. ฉันจะเชื่อมต่อโหนด Mac เข้ากับ Gateway ระยะไกลด้วย Tailscale Serve ได้อย่างไร

20. Serve จะเปิดเผย **Gateway Control UI + WS** 21. โหนดจะเชื่อมต่อผ่าน Gateway WS endpoint เดียวกัน

22. การตั้งค่าที่แนะนำ:

1. 23. **ตรวจสอบให้แน่ใจว่า VPS + Mac อยู่ใน tailnet เดียวกัน**
2. 24. **ใช้แอป macOS ในโหมด Remote** (เป้าหมาย SSH สามารถเป็นชื่อโฮสต์ของ tailnet ได้)
   25. แอปจะทำการ tunnel พอร์ต Gateway และเชื่อมต่อเป็นโหนด
3. 26. **อนุมัติโหนด** บน gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

27) เอกสาร: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## 28. ตัวแปรสภาพแวดล้อมและการโหลด .env

### 29. OpenClaw โหลดตัวแปรสภาพแวดล้อมอย่างไร

30. OpenClaw อ่านตัวแปรสภาพแวดล้อมจากโปรเซสแม่ (shell, launchd/systemd, CI ฯลฯ) 31. และยังโหลดเพิ่มเติม:

- 32. `.env` จากไดเรกทอรีการทำงานปัจจุบัน
- ค่า fallback ส่วนกลาง `.env` จาก `~/.openclaw/.env` (หรือ `$OPENCLAW_STATE_DIR/.env`)

ไฟล์ `.env` ใดๆ จะไม่เขียนทับตัวแปรสภาพแวดล้อมที่มีอยู่

33. คุณยังสามารถกำหนดตัวแปรสภาพแวดล้อมแบบ inline ในคอนฟิกได้ (จะถูกนำมาใช้เฉพาะเมื่อไม่มีใน process env):

```json5
34. {
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

ดู [/environment](/help/environment) สำหรับลำดับความสำคัญและแหล่งที่มาอย่างครบถ้วน

### ["เริ่ม Gateway ผ่าน service แล้ว env vars หาย" ทำอย่างไร?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)

35. วิธีแก้ไขที่พบบ่อยสองอย่าง:

1. 36. ใส่คีย์ที่ขาดหายไปใน `~/.openclaw/.env` เพื่อให้ถูกอ่านแม้เมื่อบริการไม่ได้รับ env จาก shell ของคุณ
2. 37. เปิดใช้งานการนำเข้า shell (ความสะดวกแบบ opt-in):

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

38. สิ่งนี้จะรัน login shell ของคุณและนำเข้าเฉพาะคีย์ที่คาดหวังซึ่งยังขาดอยู่ (จะไม่เขียนทับ) 39. ตัวแปร env ที่เทียบเท่า:
    `OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### [ตั้ง `COPILOT_GITHUB_TOKEN` แต่สถานะโมเดลแสดง "Shell env: off" ทำไม?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)

40. `openclaw models status` จะแจ้งว่ามีการเปิดใช้งาน **shell env import** หรือไม่ 41. "Shell env: off"
    ไม่ได้หมายความว่าตัวแปรสภาพแวดล้อมของคุณหายไป — เพียงหมายความว่า OpenClaw จะไม่โหลด
    login shell ของคุณโดยอัตโนมัติ

42. หาก Gateway รันเป็นบริการ (launchd/systemd) จะไม่ได้รับสภาพแวดล้อมจาก shell ของคุณ 43. แก้ไขโดยทำอย่างใดอย่างหนึ่งต่อไปนี้:

1. 44. ใส่โทเค็นใน `~/.openclaw/.env`:

   ```
   45. COPILOT_GITHUB_TOKEN=...
   ```

2. 46. หรือเปิดใช้งานการนำเข้า shell (`env.shellEnv.enabled: true`).

3. 47. หรือเพิ่มลงในบล็อก `env` ของคอนฟิก (จะมีผลเฉพาะเมื่อยังขาดอยู่)

48) จากนั้นรีสตาร์ท gateway และตรวจสอบอีกครั้ง:

```bash
openclaw models status
```

49. โทเค็น Copilot จะถูกอ่านจาก `COPILOT_GITHUB_TOKEN` (รวมถึง `GH_TOKEN` / `GITHUB_TOKEN`).
50. ดู [/concepts/model-providers](/concepts/model-providers) และ [/environment](/help/environment).

## เซสชันและหลายแชต

### ฉันจะเริ่มการสนทนาใหม่ได้อย่างไร

ส่ง `/new` หรือ `/reset` เป็นข้อความเดี่ยว ๆ. ดู [การจัดการเซสชัน](/concepts/session)

### ถ้าฉันไม่ส่งข้อความใหม่ เซสชันจะรีเซ็ตอัตโนมัติหรือไม่

ใช่ เซสชันจะหมดอายุหลังจาก `session.idleMinutes` (ค่าเริ่มต้น **60**) ข้อความ **ถัดไป**
จะเริ่ม session id ใหม่สำหรับคีย์แชทนั้น การทำเช่นนี้จะไม่ลบ
บันทึกการสนทนา — เพียงแค่เริ่มเซสชันใหม่

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### มีวิธีสร้างทีมของอินสแตนซ์ OpenClaw ให้มี CEO หนึ่งตัวและเอเจนต์หลายตัวหรือไม่

มี โดยใช้ **multi-agent routing** และ **sub-agents** คุณสามารถสร้างเอเจนต์ผู้ประสานงานหนึ่งตัว
และเอเจนต์คนงานหลายตัวที่มี workspace และโมเดลของตนเอง

อย่างไรก็ตาม สิ่งนี้เหมาะจะมองว่าเป็น **การทดลองที่สนุก** มากกว่า มันใช้โทเค็นมากและมักจะ
มีประสิทธิภาพน้อยกว่าการใช้บอทตัวเดียวที่มีหลายเซสชัน รูปแบบทั่วไปที่เรา
จินตนาการไว้คือบอทหนึ่งตัวที่คุณคุยด้วย โดยมีหลายเซสชันสำหรับงานคู่ขนาน บอทนั้น
ยังสามารถสร้าง sub-agents เมื่อจำเป็น

เอกสาร: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents)

### [ทำไมบริบทถูกตัดกลางงาน จะป้องกันอย่างไร?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)

บริบทของเซสชันถูกจำกัดด้วยขนาดหน้าต่างของโมเดล แชทยาว เอาต์พุตจากเครื่องมือขนาดใหญ่ หรือไฟล์จำนวนมาก
อาจกระตุ้นให้เกิดการบีบอัดหรือการตัดทอน

สิ่งที่ช่วยได้:

- ขอให้บอทสรุปสถานะปัจจุบันและเขียนลงไฟล์
- ใช้ `/compact` ก่อนงานยาว และใช้ `/new` เมื่อเปลี่ยนหัวข้อ
- เก็บบริบทสำคัญไว้ใน workspace และขอให้บอทอ่านกลับมา
- ใช้ sub-agents สำหรับงานยาวหรือแบบขนาน เพื่อให้แชทหลักมีขนาดเล็กลง
- เลือกโมเดลที่มีหน้าต่างบริบทใหญ่ขึ้นหากเกิดปัญหานี้บ่อย

### ฉันจะรีเซ็ต OpenClaw ทั้งหมดได้อย่างไรโดยยังคงติดตั้งไว้

ใช้คำสั่งรีเซ็ต:

```bash
openclaw reset
```

รีเซ็ตเต็มรูปแบบแบบไม่โต้ตอบ:

```bash
openclaw reset --scope full --yes --non-interactive
```

จากนั้นรัน onboarding ใหม่:

```bash
openclaw onboard --install-daemon
```

Notes:

- ตัวช่วย onboarding ยังมีตัวเลือก **Reset** หากตรวจพบการตั้งค่าที่มีอยู่ ดู [Wizard](/start/wizard)
- หากคุณใช้โปรไฟล์ (`--profile` / `OPENCLAW_PROFILE`) ให้รีเซ็ตแต่ละ state dir (ค่าเริ่มต้นคือ `~/.openclaw-<profile>`)
- รีเซ็ตสำหรับนักพัฒนา: `openclaw gateway --dev --reset` (เฉพาะ dev; จะลบการตั้งค่า dev + ข้อมูลรับรอง + เซสชัน + workspace)

### ฉันได้รับข้อผิดพลาด context too large ฉันจะรีเซ็ตหรือบีบอัดได้อย่างไร

ใช้หนึ่งในตัวเลือกต่อไปนี้:

- **Compact** (เก็บการสนทนาไว้แต่สรุปเทิร์นเก่า):

  ```
  /compact
  ```

  หรือ `/compact <instructions>` เพื่อกำหนดแนวทางการสรุป

- **Reset** (สร้าง session ID ใหม่สำหรับคีย์แชทเดิม):

  ```
  /new
  /reset
  ```

หากยังเกิดขึ้นอีก:

- เปิดใช้หรือปรับแต่ง **session pruning** (`agents.defaults.contextPruning`) เพื่อตัดเอาต์พุตเครื่องมือเก่า
- ใช้โมเดลที่มีหน้าต่างบริบทใหญ่ขึ้น

เอกสาร: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session)

### ทำไมฉันจึงเห็นข้อความ LLM request rejected messagesNcontentXtooluseinput Field required

นี่คือข้อผิดพลาดการตรวจสอบจากผู้ให้บริการ: โมเดลส่งบล็อก `tool_use` โดยไม่มี
`input` ที่จำเป็น โดยปกติหมายความว่าประวัติเซสชันเก่าหรือเสียหาย (มักเกิดหลังเธรดยาว
หรือมีการเปลี่ยนเครื่องมือ/สคีมา)

วิธีแก้: เริ่มเซสชันใหม่ด้วย `/new` (ส่งเป็นข้อความเดี่ยว)

### ทำไมฉันจึงได้รับข้อความ heartbeat ทุก ๆ 30 นาที

ค่าเริ่มต้น Heartbeat จะทำงานทุก **30m**. Tune or disable them:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // หรือ "0m" เพื่อปิด
      },
    },
  },
}
```

หากมี `HEARTBEAT.md` อยู่แต่แทบว่างเปล่า(มีเพียงบรรทัดว่างและหัวข้อmarkdownอย่าง `# Heading`)
OpenClawจะข้ามการรันHeartbeatเพื่อประหยัดการเรียกAPI หากไฟล์หายไป Heartbeatยังคงรัน
และโมเดลจะตัดสินใจเองว่าจะทำอะไร
หากไฟล์หายไป ฮาร์ตบีตยังคงรันและโมเดลจะตัดสินใจว่าจะทำอะไร

การ override ต่อเอเจนต์ใช้ `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Do I need to add a bot account to a WhatsApp group

ไม่. OpenClaw runs on **your own account**, so if you're in the group, OpenClaw can see it.
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

ตัวเลือกที่ 1 (เร็วที่สุด): tail logs และส่งข้อความทดสอบในกลุ่ม:

```bash
openclaw logs --follow --json
```

Look for `chatId` (or `from`) ending in `@g.us`, like:
`1234567890-1234567890@g.us`.

Option 2 (if already configured/allowlisted): list groups from config:

```bash
openclaw directory groups list --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### ทำไม OpenClaw ไม่ตอบในกลุ่ม

สาเหตุที่พบบ่อยสองประการ:

- Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
- You configured `channels.whatsapp.groups` without `"*"` and the group isn't allowlisted.

See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### Do groupsthreads share context with DMs

Direct chats collapse to the main session by default. กลุ่ม/แชนเนลมี session key ของตัวเอง และ Telegram topics / Discord threads เป็นเซสชันแยกกัน. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### How many workspaces and agents can I create

No hard limits. Dozens (even hundreds) are fine, but watch for:

- **Disk growth:** sessions + transcripts live under `~/.openclaw/agents/<agentId>/sessions/`.
- **Token cost:** more agents means more concurrent model usage.
- **Ops overhead:** per-agent auth profiles, workspaces, and channel routing.

เคล็ดลับ:

- Keep one **active** workspace per agent (`agents.defaults.workspace`).
- Prune old sessions (delete JSONL or store entries) if disk grows.
- Use `openclaw doctor` to spot stray workspaces and profile mismatches.

### Can I run multiple bots or chats at the same time Slack and how should I set that up

Yes. Use **Multi-Agent Routing** to run multiple isolated agents and route inbound messages by
channel/account/peer. Slack is supported as a channel and can be bound to specific agents.

Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can
still block automation. For the most reliable browser control, use the Chrome extension relay
on the machine that runs the browser (and keep the Gateway anywhere).

Best-practice setup:

- Always-on Gateway host (VPS/Mac mini).
- One agent per role (bindings).
- Slack channel(s) bound to those agents.
- Local browser via extension relay (or a node) when needed.

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## Models: defaults, selection, aliases, switching

### โมเดลเริ่มต้นคืออะไร

โมเดลเริ่มต้นของ OpenClaw คือสิ่งที่คุณตั้งค่าไว้เป็น:

```
agents.defaults.model.primary
```

โมเดลจะถูกอ้างอิงในรูปแบบ `provider/model` (ตัวอย่าง: `anthropic/claude-opus-4-6`). หากคุณละบุ provider ไป ปัจจุบัน OpenClaw จะถือว่าเป็น `anthropic` เป็นค่า fallback ชั่วคราวในช่วงเลิกใช้งาน — แต่คุณควรตั้งค่า `provider/model` อย่าง **ชัดเจน** เสมอ

### คุณแนะนำให้ใช้โมเดลใด

**ค่าเริ่มต้นที่แนะนำ:** `anthropic/claude-opus-4-6`.
**ทางเลือกที่ดี:** `anthropic/claude-sonnet-4-5`.
**เสถียร (คาแรกเตอร์น้อยกว่า):** `openai/gpt-5.2` — ดีเกือบเท่า Opus แค่มีบุคลิกน้อยกว่า.
**ประหยัดงบ:** `zai/glm-4.7`.

MiniMax M2.1 มีเอกสารของตัวเอง: [MiniMax](/providers/minimax) และ
[Local models](/gateway/local-models).

หลักคิดง่าย ๆ: ใช้ **โมเดลที่ดีที่สุดเท่าที่คุณจ่ายไหว** สำหรับงานที่มีความเสี่ยงสูง และใช้โมเดลที่ถูกกว่าสำหรับแชตทั่วไปหรือการสรุป. คุณสามารถกำหนดเส้นทางโมเดลต่อเอเจนต์ และใช้ซับเอเจนต์เพื่อ
ทำงานยาว ๆ แบบขนานได้ (ซับเอเจนต์แต่ละตัวจะใช้โทเคน). ดู [Models](/concepts/models) และ
[Sub-agents](/tools/subagents).

คำเตือนรุนแรง: โมเดลที่อ่อนแอหรือถูก over-quantize จะมีความเสี่ยงต่อ prompt injection และพฤติกรรมที่ไม่ปลอดภัยมากกว่า. ดู [Security](/gateway/security).

บริบทเพิ่มเติม: [Models](/concepts/models).

### ฉันสามารถใช้โมเดล self-hosted อย่าง llamacpp vLLM Ollama ได้หรือไม่

ได้. หากเซิร์ฟเวอร์โลคัลของคุณเปิดเผย API ที่เข้ากันได้กับ OpenAI คุณสามารถชี้ provider แบบกำหนดเองไปที่มันได้. Ollama รองรับโดยตรงและเป็นเส้นทางที่ง่ายที่สุด.

หมายเหตุด้านความปลอดภัย: โมเดลที่เล็กหรือถูก quantize หนัก ๆ จะเสี่ยงต่อ prompt injection มากกว่า. เราแนะนำอย่างยิ่งให้ใช้ **โมเดลขนาดใหญ่** สำหรับบอทใด ๆ ที่สามารถใช้เครื่องมือได้.
หากคุณยังต้องการใช้โมเดลขนาดเล็ก ให้เปิด sandboxing และตั้งค่า allowlist ของเครื่องมืออย่างเข้มงวด.

เอกสาร: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
[Model providers](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### ฉันจะสลับโมเดลโดยไม่ต้องล้างคอนฟิกได้อย่างไร

ใช้ **คำสั่งโมเดล** หรือแก้ไขเฉพาะฟิลด์ **model** เท่านั้น. หลีกเลี่ยงการแทนที่คอนฟิกทั้งหมด.

ตัวเลือกที่ปลอดภัย:

- `/model` ในแชต (รวดเร็ว ต่อเซสชัน)
- `openclaw models set ...` (อัปเดตเฉพาะคอนฟิกของโมเดล)
- `openclaw configure --section model` (โหมดโต้ตอบ)
- แก้ไข `agents.defaults.model` ใน `~/.openclaw/openclaw.json`

หลีกเลี่ยง `config.apply` ที่ใช้วัตถุบางส่วน เว้นแต่คุณตั้งใจจะแทนที่คอนฟิกทั้งหมด.
หากคุณเผลอเขียนทับคอนฟิก ให้กู้คืนจากแบ็กอัปหรือรัน `openclaw doctor` อีกครั้งเพื่อซ่อมแซม.

เอกสาร: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### OpenClaw, Flawd และ Krill ใช้โมเดลอะไร

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - ดูที่ [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) — ดู [MiniMax](/providers/minimax).

### ฉันจะสลับโมเดลแบบ on the fly โดยไม่ต้องรีสตาร์ทได้อย่างไร

ใช้คำสั่ง `/model` เป็นข้อความเดี่ยว:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

คุณสามารถแสดงรายการโมเดลที่มีได้ด้วย `/model`, `/model list` หรือ `/model status`.

`/model` (และ `/model list`) จะแสดงตัวเลือกแบบกระชับพร้อมหมายเลข. เลือกด้วยหมายเลข:

```
/model 3
```

คุณยังสามารถบังคับใช้โปรไฟล์การยืนยันตัวตนเฉพาะสำหรับ provider ได้ (ต่อเซสชัน):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

เคล็ดลับ: `/model status` จะแสดงว่าเอเจนต์ใดกำลังทำงาน ไฟล์ `auth-profiles.json` ใดที่กำลังใช้งาน และโปรไฟล์การยืนยันตัวตนใดจะถูกลองใช้ถัดไป.
นอกจากนี้ยังแสดง endpoint ของ provider ที่ตั้งค่าไว้ (`baseUrl`) และโหมด API (`api`) เมื่อมีให้ใช้งาน.

**ฉันจะยกเลิกการปักหมุดโปรไฟล์ที่ตั้งด้วย profile ได้อย่างไร**

Re-run `/model` **without** the `@profile` suffix:

```
/model anthropic/claude-opus-4-6
```

If you want to return to the default, pick it from `/model` (or send `/model <default provider/model>`).
Use `/model status` to confirm which auth profile is active.

### Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding

Yes. Set one as default and switch as needed:

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

Yes. Use **MiniMax as the default** and switch models **per session** when needed.
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

จากนั้น:

```
/model gpt
```

**Option B: separate agents**

- Agent A default: MiniMax
- Agent B default: OpenAI
- Route by agent or use `/agent` to switch

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Are opus sonnet gpt builtin shortcuts

Yes. OpenClaw ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

If you set your own alias with the same name, your value wins.

### How do I defineoverride model shortcuts aliases

Alias มาจาก `agents.defaults.models.<modelId>`.alias ตัวอย่าง:

```json5
1. {
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

2. จากนั้น `/model sonnet` (หรือ `/<alias>` เมื่อรองรับ) จะ resolve ไปยัง model ID นั้น

### 3. ฉันจะเพิ่มโมเดลจากผู้ให้บริการอื่นอย่าง OpenRouter หรือ ZAI ได้อย่างไร

OpenRouter (จ่ายตามจำนวนโทเคน; มีหลายโมเดล):

```json5
5. {
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

6. Z.AI (โมเดล GLM):

```json5
7. {
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

8. หากคุณอ้างอิงผู้ให้บริการ/โมเดล แต่ไม่มี provider key ที่จำเป็น คุณจะได้รับ runtime auth error (เช่น `No API key found for provider "zai"`).

**ไม่พบ API key สำหรับผู้ให้บริการหลังจากเพิ่มเอเจนต์ใหม่**

10. โดยปกติหมายความว่า **agent ใหม่** มี auth store ว่างเปล่า 11. การยืนยันตัวตนเป็นแบบต่อ-agent และ
    ถูกเก็บไว้ที่:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

ตัวเลือกการแก้ไข:

- 12. รัน `openclaw agents add <id>` และตั้งค่า auth ระหว่างตัวช่วย (wizard)
- 13. หรือคัดลอก `auth-profiles.json` จาก `agentDir` ของ agent หลัก ไปยัง `agentDir` ของ agent ใหม่

14. อย่าใช้ `agentDir` ร่วมกันระหว่างหลาย agent; จะทำให้เกิดการชนกันของ auth/session

## 15. การ failover ของโมเดลและ "All models failed"

### 16. failover ทำงานอย่างไร

17. Failover เกิดขึ้นสองขั้นตอน:

1. **การหมุนเวียนโปรไฟล์การยืนยันตัวตน (Auth profile rotation)** ภายในผู้ให้บริการเดียวกัน.
2. **การสลับโมเดลสำรอง** ไปยังโมเดลถัดไปใน `agents.defaults.model.fallbacks`

19) มีการใช้ cooldown กับโปรไฟล์ที่ล้มเหลว (exponential backoff) ดังนั้น OpenClaw ยังสามารถตอบสนองต่อไปได้ แม้ผู้ให้บริการจะถูกจำกัดอัตรา (rate-limited) หรือขัดข้องชั่วคราว

### 20. ข้อผิดพลาดนี้หมายความว่าอย่างไร

```
21. No credentials found for profile "anthropic:default"
```

หมายความว่าระบบพยายามใช้ auth profile ID `anthropic:default` แต่ไม่พบข้อมูลรับรองสำหรับมันใน auth store ที่คาดไว้.

### เช็กลิสต์การแก้ไขสำหรับ No credentials found for profile anthropicdefault

- 24. **ยืนยันตำแหน่งที่เก็บ auth profiles** (พาธใหม่ vs พาธเดิม)
  - 25. ปัจจุบัน: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (ย้ายโดย `openclaw doctor`)
- **ยืนยันว่า env var ของคุณถูกโหลดโดย Gateway**
  - 28. หากคุณตั้งค่า `ANTHROPIC_API_KEY` ใน shell แต่รัน Gateway ผ่าน systemd/launchd มันอาจไม่ได้รับค่านั้น ใส่ไว้ใน `~/.openclaw/.env` หรือเปิดใช้ `env.shellEnv`.
- **ตรวจสอบให้แน่ใจว่าคุณกำลังแก้ไขเอเจนต์ที่ถูกต้อง**
  - 31. การตั้งค่าแบบหลาย agent หมายความว่าอาจมีไฟล์ `auth-profiles.json` หลายไฟล์
- 32. **ตรวจสอบสถานะโมเดล/auth แบบ sanity-check**
  - 33. ใช้ `openclaw models status` เพื่อดูโมเดลที่ตั้งค่าไว้และว่าผู้ให้บริการได้รับการยืนยันตัวตนแล้วหรือไม่

34. **เช็กลิสต์การแก้ไขสำหรับ No credentials found for profile anthropic**

35. หมายความว่าการรันถูกผูก (pinned) กับ Anthropic auth profile แต่ Gateway
    ไม่พบมันใน auth store

- **ใช้ setup-token**
  - 37. รัน `claude setup-token` จากนั้นวางโทเค็นด้วย `openclaw models auth setup-token --provider anthropic`
  - 38. หากโทเค็นถูกสร้างบนเครื่องอื่น ให้ใช้ `openclaw models auth paste-token --provider anthropic`

- 39. **หากคุณต้องการใช้ API key แทน**
  - 40. ใส่ `ANTHROPIC_API_KEY` ใน `~/.openclaw/.env` บน **โฮสต์ gateway**
  - 41. ล้างลำดับที่ถูก pin ซึ่งบังคับใช้โปรไฟล์ที่ขาดหาย:

    ```bash
    42. openclaw models auth order clear --provider anthropic
    ```

- 43. **ยืนยันว่าคุณกำลังรันคำสั่งบนโฮสต์ gateway**
  - 44. ในโหมดรีโมต auth profiles จะอยู่บนเครื่อง gateway ไม่ใช่แล็ปท็อปของคุณ

### 45. ทำไมมันถึงพยายามใช้ Google Gemini ด้วยแล้วล้มเหลว

46. หากการตั้งค่าโมเดลของคุณมี Google Gemini เป็น fallback (หรือคุณสลับไปใช้ shorthand ของ Gemini) OpenClaw จะลองใช้มันระหว่างการ fallback ของโมเดล 47. หากคุณยังไม่ได้ตั้งค่า Google credentials คุณจะเห็น `No API key found for provider "google"`

48. วิธีแก้: ให้ตั้งค่า Google auth หรือเอา/หลีกเลี่ยงโมเดล Google ใน `agents.defaults.model.fallbacks` / aliases เพื่อไม่ให้ fallback วิ่งไปทางนั้น

49. **ข้อความ LLM request rejected message thinking signature required google antigravity**

50. สาเหตุ: ประวัติของเซสชันมี **thinking blocks ที่ไม่มี signature** (มักเกิดจากสตรีมที่ถูกยกเลิกหรือไม่สมบูรณ์) Google Antigravity ต้องการลายเซ็นสำหรับบล็อกการคิด (thinking blocks)

การแก้ไข: OpenClaw ตอนนี้จะตัด thinking blocks ที่ไม่ได้เซ็นออกสำหรับ Google Antigravity Claude. หากยังคงปรากฏ ให้เริ่ม **เซสชันใหม่** หรือ ตั้งค่า `/thinking off` สำหรับเอเจนต์นั้น

## Auth profiles: คืออะไรและจัดการอย่างไร

ที่เกี่ยวข้อง: [/concepts/oauth](/concepts/oauth) (OAuth flows, การจัดเก็บโทเค็น, รูปแบบหลายบัญชี)

### โปรไฟล์การยืนยันตัวตนคืออะไร

โปรไฟล์การยืนยันตัวตนคือระเบียนข้อมูลรับรองที่มีชื่อ (OAuth หรือ API key) ที่ผูกกับผู้ให้บริการ โปรไฟล์จะอยู่ใน:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### ตัวอย่าง ID ของโปรไฟล์ที่ใช้กันทั่วไปคืออะไร

OpenClaw ใช้ ID ที่มีคำนำหน้าผู้ให้บริการ เช่น:

- `anthropic:default` (พบบ่อยเมื่อไม่มีตัวตนอีเมล)
- `anthropic:<email>` สำหรับตัวตน OAuth
- ID แบบกำหนดเองที่คุณเลือก (เช่น `anthropic:work`)

### ฉันสามารถควบคุมได้หรือไม่ว่าจะลองใช้โปรไฟล์การยืนยันตัวตนใดก่อน

ได้ การตั้งค่ารองรับเมทาดาทาเสริมสำหรับโปรไฟล์และการจัดลำดับต่อผู้ให้บริการ (\`auth.order.<provider>\`\`)  สิ่งนี้ **ไม่** เก็บ secrets; มันทำการแมป ID กับผู้ให้บริการ/โหมด และตั้งค่าลำดับการหมุนเวียน.

OpenClaw อาจข้ามโปรไฟล์ชั่วคราวหากอยู่ในสถานะ **cooldown** ระยะสั้น (จำกัดอัตรา/หมดเวลา/การยืนยันตัวตนล้มเหลว) หรือสถานะ **disabled** ระยะยาว (การเรียกเก็บเงิน/เครดิตไม่เพียงพอ) เพื่อดูสถานะนี้ ให้รัน `openclaw models status --json` และตรวจสอบ `auth.unusableProfiles` การปรับแต่ง: `auth.cooldowns.billingBackoffHours*`

คุณยังสามารถตั้งค่าการจัดลำดับแบบแทนที่ **ต่อเอเจนต์** (เก็บไว้ใน `auth-profiles.json` ของเอเจนต์นั้น) ผ่าน CLI:

```bash
# ค่าเริ่มต้นคือเอเจนต์เริ่มต้นที่ตั้งค่าไว้ (ละเว้น --agent)
openclaw models auth order get --provider anthropic

# ล็อกการหมุนเวียนให้ใช้โปรไฟล์เดียว (ลองเฉพาะอันนี้)
openclaw models auth order set --provider anthropic anthropic:default

# หรือกำหนดลำดับอย่างชัดเจน (fallback ภายในผู้ให้บริการ)
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# ล้างการแทนที่ (กลับไปใช้ config auth.order / round-robin)
openclaw models auth order clear --provider anthropic
```

เพื่อกำหนดเป้าหมายไปยังเอเจนต์เฉพาะ:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth กับ API key แตกต่างกันอย่างไร

OpenClaw รองรับทั้งสองแบบ:

- **OAuth** มักใช้สิทธิ์การเข้าถึงจากการสมัครสมาชิก (เมื่อมีให้ใช้)
- **API keys** ใช้การเรียกเก็บเงินแบบจ่ายตามโทเค็น

ตัวช่วยตั้งค่ารองรับ Anthropic setup-token และ OpenAI Codex OAuth อย่างชัดเจน และสามารถจัดเก็บ API keys ให้คุณได้

## Gateway: พอร์ต, "กำลังทำงานอยู่แล้ว", และโหมดระยะไกล

### Gateway ใช้พอร์ตใด

`gateway.port` ควบคุมพอร์ตแบบมัลติเพล็กซ์เพียงพอร์ตเดียวสำหรับ WebSocket + HTTP (Control UI, hooks ฯลฯ)

ลำดับความสำคัญ:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > ค่าเริ่มต้น 18789
```

### ทำไม openclaw gateway status ถึงบอกว่า Runtime running แต่ RPC probe ล้มเหลว

เพราะ "running" คือมุมมองของ **supervisor** (launchd/systemd/schtasks) RPC probe คือการที่ CLI เชื่อมต่อกับ Gateway WebSocket จริง ๆ และเรียก `status`

ใช้ `openclaw gateway status` และเชื่อถือบรรทัดเหล่านี้:

- `Probe target:` (URL ที่ probe ใช้จริง)
- `Listening:` (สิ่งที่ถูก bind อยู่จริงบนพอร์ต)
- `Last gateway error:` (สาเหตุหลักที่พบบ่อยเมื่อโปรเซสยังมีชีวิตอยู่แต่พอร์ตไม่รับฟัง)

### ทำไม openclaw gateway status ถึงแสดง Config cli และ Config service ต่างกัน

คุณกำลังแก้ไขไฟล์คอนฟิกหนึ่ง แต่บริการกำลังรันอีกไฟล์หนึ่ง (มักเกิดจาก `--profile` / `OPENCLAW_STATE_DIR` ไม่ตรงกัน)

แก้ไขบั๊ก:

```bash
openclaw gateway install --force
```

รันคำสั่งนั้นจาก `--profile` / สภาพแวดล้อมเดียวกับที่คุณต้องการให้บริการใช้

### ข้อความ another gateway instance is already listening หมายความว่าอะไร

OpenClaw บังคับใช้ runtime lock โดยการ bind ตัวรับฟัง WebSocket ทันทีเมื่อเริ่มต้น (ค่าเริ่มต้น `ws://127.0.0.1:18789`) หากการ bind ล้มเหลวด้วย `EADDRINUSE` จะขว้าง `GatewayLockError` เพื่อระบุว่ามีอินสแตนซ์อื่นกำลังรับฟังอยู่แล้ว

วิธีแก้ไข: หยุดอินสแตนซ์อื่น, ปลดปล่อยพอร์ต, หรือรันด้วย `openclaw gateway --port <port>`

### ฉันจะรัน OpenClaw ในโหมดรีโมต โดยให้ไคลเอนต์เชื่อมต่อไปยัง Gateway ที่อยู่ที่อื่นได้อย่างไร

1. ตั้งค่า `gateway.mode: "remote"` และชี้ไปยัง URL WebSocket ระยะไกล โดยสามารถใส่โทเค็น/รหัสผ่านได้ตามต้องการ:

```json5
2. {
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

Notes:

- 3. `openclaw gateway` จะเริ่มทำงานเฉพาะเมื่อ `gateway.mode` เป็น `local` (หรือคุณส่งแฟล็ก override)
- 4. แอป macOS จะเฝ้าดูไฟล์คอนฟิก และสลับโหมดแบบเรียลไทม์เมื่อค่าพวกนี้เปลี่ยน

### [Control UI ขึ้น "unauthorized"(หรือรีคอนเน็กต์ซ้ำ) ทำอย่างไร?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)

5. Gateway ของคุณกำลังรันโดยเปิดใช้การยืนยันตัวตน (`gateway.auth.*`) แต่ UI ไม่ได้ส่งโทเค็น/รหัสผ่านที่ตรงกัน

6. ข้อเท็จจริง (จากโค้ด):

- 7. Control UI เก็บโทเค็นไว้ใน browser localStorage คีย์ `openclaw.control.settings.v1`

แก้ไขบั๊ก:

- 8. เร็วที่สุด: `openclaw dashboard` (พิมพ์และคัดลอก URL ของแดชบอร์ด พยายามเปิดให้ และจะแสดงคำแนะนำ SSH หากเป็นโหมด headless)
- 9. หากคุณยังไม่มีโทเค็น: `openclaw doctor --generate-gateway-token`
- 10. ถ้าเป็น remote ให้ทำ tunnel ก่อน: `ssh -N -L 18789:127.0.0.1:18789 user@host` แล้วเปิด `http://127.0.0.1:18789/`
- 11. ตั้งค่า `gateway.auth.token` (หรือ `OPENCLAW_GATEWAY_TOKEN`) บนโฮสต์ของ gateway
- 12. ในการตั้งค่า Control UI ให้วางโทเค็นเดียวกัน
- ยังติดอยู่ไหม? 13. รัน `openclaw status --all` และทำตาม [Troubleshooting](/gateway/troubleshooting) 14. ดู [Dashboard](/web/dashboard) สำหรับรายละเอียดการยืนยันตัวตน

### 15. ฉันตั้ง gatewaybind เป็น tailnet แต่ไม่สามารถ bind ได้ ไม่มีอะไรฟังอยู่

16. การ bind แบบ `tailnet` จะเลือก IP ของ Tailscale จากอินเทอร์เฟซเครือข่ายของคุณ (100.64.0.0/10) 17. หากเครื่องไม่ได้อยู่บน Tailscale (หรืออินเทอร์เฟซปิดอยู่) ก็จะไม่มีอะไรให้ bind

แก้ไขบั๊ก:

- 18. เริ่ม Tailscale บนโฮสต์นั้น (เพื่อให้มีที่อยู่ 100.x) หรือ
- 19. เปลี่ยนเป็น `gateway.bind: "loopback"` / `"lan"`

20. หมายเหตุ: `tailnet` เป็นการระบุแบบชัดเจน 21. `auto` จะเลือก loopback เป็นหลัก; ใช้ `gateway.bind: "tailnet"` เมื่อคุณต้องการ bind เฉพาะ tailnet

### 22. ฉันสามารถรัน Gateway หลายตัวบนโฮสต์เดียวกันได้ไหม

23. โดยปกติไม่ได้ - Gateway เดียวสามารถรันหลาย messaging channels และ agents ได้ 24. ใช้หลาย Gateway เฉพาะเมื่อคุณต้องการความซ้ำซ้อน (เช่น บอทกู้ภัย) หรือการแยกแบบเข้มงวด

25. ได้ แต่คุณต้องแยกให้ชัดเจน:

- 26. `OPENCLAW_CONFIG_PATH` (คอนฟิกแยกต่ออินสแตนซ์)
- 27. `OPENCLAW_STATE_DIR` (สถานะแยกต่ออินสแตนซ์)
- 28. `agents.defaults.workspace` (แยก workspace)
- 29. `gateway.port` (พอร์ตไม่ซ้ำกัน)

30. การตั้งค่าแบบรวดเร็ว (แนะนำ):

- 31. ใช้ `openclaw --profile <name> …` ต่ออินสแตนซ์ (สร้าง `~/.openclaw-<name>` อัตโนมัติ)
- 32. ตั้งค่า `gateway.port` ที่ไม่ซ้ำกันในคอนฟิกของแต่ละโปรไฟล์ (หรือส่ง `--port` สำหรับการรันแบบแมนนวล)
- 33. ติดตั้งบริการต่อโปรไฟล์: `openclaw --profile <name> gateway install`

34. โปรไฟล์ยังจะเติม suffix ให้ชื่อบริการด้วย (`bot.molt.<profile>`35. `; legacy `com.openclaw.\*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)\`)
35. คู่มือฉบับเต็ม: [Multiple gateways](/gateway/multiple-gateways)

### 37. รหัส invalid handshake 1008 หมายความว่าอะไร

38. Gateway เป็น **WebSocket server** และคาดหวังว่าข้อความแรกสุดจะเป็นเฟรม `connect` 39. หากได้รับอย่างอื่น จะปิดการเชื่อมต่อด้วย **รหัส 1008** (policy violation)

40. สาเหตุที่พบบ่อย:

- 41. คุณเปิด URL แบบ **HTTP** ในเบราว์เซอร์ (`http://...`) แทนที่จะใช้ไคลเอนต์ WS
- 42. คุณใช้พอร์ตหรือพาธไม่ถูกต้อง
- 43. พร็อกซีหรือท่อส่งข้อมูล (tunnel) ตัด header การยืนยันตัวตน หรือส่งคำขอที่ไม่ใช่ของ Gateway

44. วิธีแก้ไขอย่างรวดเร็ว:

1. 45. ใช้ URL แบบ WS: `ws://<host>:18789` (หรือ `wss://...` หากเป็น HTTPS)
2. 46. อย่าเปิดพอร์ต WS ในแท็บเบราว์เซอร์ปกติ
3. 47. หากเปิดใช้ auth ให้ใส่โทเค็น/รหัสผ่านในเฟรม `connect`

48) หากคุณใช้ CLI หรือ TUI รูปแบบ URL ควรเป็น:

```
49. openclaw tui --url ws://<host>:18789 --token <token>
```

รายละเอียดโปรโตคอล: [Gateway protocol](/gateway/protocol)

## 50. การบันทึกล็อกและการดีบัก

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

If you never installed the service, start it in the foreground:

```bash
openclaw gateway run
```

**2) Native Windows (not recommended):** the Gateway runs directly in Windows.

Open PowerShell and run:

```powershell
openclaw gateway status
openclaw gateway restart
```

If you run it manually (no service), use:

```powershell
openclaw gateway run
```

Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### The Gateway is up but replies never arrive What should I check

Start with a quick health sweep:

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

Common causes:

- Model auth not loaded on the **gateway host** (check `models status`).
- Channel pairing/allowlist blocking replies (check channel config + logs).
- WebChat/Dashboard is open without the right token.

If you are remote, confirm the tunnel/Tailscale connection is up and that the
Gateway WebSocket is reachable.

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### Disconnected from gateway no reason what now

This usually means the UI lost the WebSocket connection. ตรวจสอบ:

1. Is the Gateway running? `openclaw gateway status`
2. Is the Gateway healthy? `openclaw status`
3. Does the UI have the right token? `openclaw dashboard`
4. If remote, is the tunnel/Tailscale link up?

Then tail logs:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### [Telegram setMyCommands ล้มเหลวด้วย network errors ควรเช็กอะไร?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)

Start with logs and channel status:

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

If you are on a VPS or behind a proxy, confirm outbound HTTPS is allowed and DNS works.
If the Gateway is remote, make sure you are looking at logs on the Gateway host.

Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

### [TUI ไม่แสดงเอาต์พุต ควรเช็กอะไร?](#tui-shows-no-output-what-should-i-check)

First confirm the Gateway is reachable and the agent can run:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

ใน TUI ให้ใช้ `/status` เพื่อดูสถานะปัจจุบัน หากคุณคาดหวังว่าจะได้รับการตอบกลับในแชนแนลแชต ให้ตรวจสอบว่าได้เปิดการส่งแล้ว (`/deliver on`).

เอกสาร: [TUI](/web/tui), [คำสั่งแบบ Slash](/tools/slash-commands).

### ฉันจะหยุด Gateway ทั้งหมดแล้วเริ่มใหม่ได้อย่างไร

หากคุณติดตั้งเป็นบริการ:

```bash
openclaw gateway stop
openclaw gateway start
```

คำสั่งนี้จะหยุด/เริ่ม **บริการที่มีการกำกับดูแล** (launchd บน macOS, systemd บน Linux).
ใช้กรณีที่ Gateway ทำงานอยู่เบื้องหลังในรูปแบบ daemon

หากคุณกำลังรันแบบ foreground ให้หยุดด้วย Ctrl-C จากนั้น:

```bash
openclaw gateway run
```

เอกสาร: [Gateway service runbook](/gateway).

### อธิบายแบบ ELI5 ความแตกต่างระหว่าง openclaw gateway restart กับ openclaw gateway

- `openclaw gateway restart`: รีสตาร์ต **บริการเบื้องหลัง** (launchd/systemd).
- `openclaw gateway`: รัน gateway **แบบ foreground** สำหรับเซสชันเทอร์มินัลนี้.

หากคุณติดตั้งเป็นบริการ ให้ใช้คำสั่ง gateway ใช้ `openclaw gateway` เมื่อ
คุณต้องการรันแบบครั้งเดียวในโหมด foreground

### วิธีที่เร็วที่สุดในการดูรายละเอียดเพิ่มเติมเมื่อเกิดข้อผิดพลาดคืออะไร

เริ่ม Gateway ด้วย `--verbose` เพื่อดูรายละเอียดในคอนโซลมากขึ้น จากนั้นตรวจสอบไฟล์ log สำหรับปัญหาการยืนยันตัวตนของแชนแนล การกำหนดเส้นทางโมเดล และข้อผิดพลาด RPC

## สื่อและไฟล์แนบ

### สกิลของฉันสร้าง imagePDF แต่ไม่มีอะไรถูกส่งออกไป

ไฟล์แนบขาออกจากเอเจนต์ต้องมีบรรทัด `MEDIA:<path-or-url>` (อยู่ในบรรทัดของตัวเอง). ดู [การตั้งค่า OpenClaw assistant](/start/openclaw) และ [Agent send](/tools/agent-send).

การส่งผ่าน CLI:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

ตรวจสอบเพิ่มเติม:

- แชนแนลเป้าหมายรองรับการส่งสื่อขาออกและไม่ได้ถูกบล็อกด้วย allowlist
- ไฟล์อยู่ภายในขีดจำกัดขนาดของผู้ให้บริการ (รูปภาพจะถูกปรับขนาดสูงสุด 2048px).

ดู [Images](/nodes/images).

## ความปลอดภัยและการควบคุมการเข้าถึง

### ปลอดภัยหรือไม่ที่จะเปิด OpenClaw ให้รับ DM ขาเข้า

ให้ถือว่า DM ขาเข้าเป็นอินพุตที่ไม่น่าเชื่อถือ ค่าเริ่มต้นถูกออกแบบมาเพื่อลดความเสี่ยง:

- พฤติกรรมเริ่มต้นบนแชนแนลที่รองรับ DM คือ **การจับคู่ (pairing)**:
  - ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดจับคู่; บอทจะไม่ประมวลผลข้อความของพวกเขา
  - อนุมัติด้วย: `openclaw pairing approve <channel> <code>`
  - คำขอที่รอดำเนินการถูกจำกัดที่ **3 ต่อแชนแนล**; ตรวจสอบ `openclaw pairing list <channel>` หากโค้ดไม่มาถึง
- การเปิด DM ต่อสาธารณะต้องมีการเลือกเปิดอย่างชัดเจน (`dmPolicy: "open"` และ allowlist `"*"`).

รัน `openclaw doctor` เพื่อแสดงนโยบาย DM ที่มีความเสี่ยง

### Prompt injection เป็นปัญหาเฉพาะบอทสาธารณะเท่านั้นหรือไม่

ไม่ใช่. Prompt injection เกี่ยวข้องกับ **เนื้อหาที่ไม่น่าเชื่อถือ** ไม่ใช่แค่ว่าใครสามารถ DM บอทได้
หากผู้ช่วยของคุณอ่านเนื้อหาภายนอก (การค้นหา/ดึงข้อมูลเว็บ หน้าเบราว์เซอร์ อีเมล
เอกสาร ไฟล์แนบ บันทึกที่วางมา), เนื้อหาเหล่านั้นอาจมีคำสั่งที่พยายาม
ยึดการควบคุมโมเดล สิ่งนี้สามารถเกิดขึ้นได้แม้ว่า **คุณจะเป็นผู้ส่งเพียงคนเดียว**

ความเสี่ยงที่ใหญ่ที่สุดคือเมื่อมีการเปิดใช้เครื่องมือ: โมเดลอาจถูกหลอกให้
ดึงข้อมูลบริบทออกไปหรือเรียกใช้เครื่องมือในนามของคุณ ลดขอบเขตความเสียหายโดย:

- ใช้เอเจนต์ "reader" แบบอ่านอย่างเดียวหรือปิดเครื่องมือ เพื่อสรุปเนื้อหาที่ไม่น่าเชื่อถือ
- ปิด `web_search` / `web_fetch` / `browser` สำหรับเอเจนต์ที่เปิดใช้เครื่องมือ
- ทำ sandbox และกำหนด allowlist ของเครื่องมืออย่างเข้มงวด

รายละเอียด: [Security](/gateway/security).

### บอทของฉันควรมีอีเมล บัญชี GitHub หรือหมายเลขโทรศัพท์เป็นของตัวเองหรือไม่

ใช่ สำหรับการตั้งค่าส่วนใหญ่ การแยกบอทออกด้วยบัญชีและหมายเลขโทรศัพท์คนละชุด
จะช่วยลดขอบเขตความเสียหายหากมีอะไรผิดพลาด วิธีนี้ยังช่วยให้หมุนเวียนข้อมูลรับรองหรือเพิกถอนการเข้าถึงได้ง่ายขึ้น โดยไม่กระทบบัญชีส่วนตัวของคุณ

เริ่มจากเล็ก ๆ ให้สิทธิ์เข้าถึงเฉพาะเครื่องมือและบัญชีที่คุณจำเป็นต้องใช้จริง ๆ และค่อยขยายภายหลังหากจำเป็น.

เอกสาร: [Security](/gateway/security), [Pairing](/channels/pairing).

### ฉันสามารถให้มันมีอิสระในการจัดการข้อความของฉันได้หรือไม่ และปลอดภัยหรือไม่

เรา **ไม่แนะนำ** ให้มีอิสระเต็มรูปแบบเหนือข้อความส่วนตัวของคุณ รูปแบบที่ปลอดภัยที่สุดคือ:

- ให้ DM อยู่ใน **โหมดจับคู่ (pairing mode)** หรือใช้ allowlist ที่เข้มงวด
- ใช้ **หมายเลขหรือบัญชีแยกต่างหาก** หากคุณต้องการให้มันส่งข้อความแทนคุณ
- ให้มันร่างข้อความ แล้ว **อนุมัติก่อนส่ง**

หากต้องการทดลอง ให้ทำบนบัญชีเฉพาะและแยกออกจากกัน. ดู
[Security](/gateway/security).

### ฉันสามารถใช้โมเดลที่ถูกกว่าสำหรับงานผู้ช่วยส่วนตัวได้หรือไม่

ได้ **ถ้า** เอเจนต์เป็นแบบแชตอย่างเดียวและอินพุตเป็นแหล่งที่เชื่อถือได้ รุ่นระดับเล็กมีความเสี่ยงต่อการถูกจี้คำสั่งมากกว่า ดังนั้นควรหลีกเลี่ยงสำหรับเอเจนต์ที่เปิดใช้เครื่องมือ
หรือเมื่ออ่านเนื้อหาที่ไม่น่าเชื่อถือ หากจำเป็นต้องใช้โมเดลขนาดเล็ก ให้ล็อกดาวน์เครื่องมือและรันภายในแซนด์บ็อกซ์ ดู [Security](/gateway/security).

### ฉันรัน start ใน Telegram แล้วแต่ไม่ได้รับโค้ดจับคู่

โค้ดจับคู่จะถูกส่ง **เฉพาะ** เมื่อผู้ส่งที่ไม่รู้จักส่งข้อความถึงบอท และเปิดใช้
`dmPolicy: "pairing"` `/start` อย่างเดียวจะไม่สร้างโค้ด

ตรวจสอบคำขอที่รอดำเนินการ:

```bash
openclaw pairing list telegram
```

หากต้องการเข้าถึงทันที ให้เพิ่ม sender id ของคุณใน allowlist หรือกำหนด `dmPolicy: "open"`
สำหรับบัญชีนั้น

### WhatsApp จะส่งข้อความถึงผู้ติดต่อของฉันหรือไม่ การจับคู่ทำงานอย่างไร

ไม่ นโยบาย DM ของ WhatsApp ค่าเริ่มต้นคือ **pairing** ผู้ส่งที่ไม่รู้จักจะได้รับเพียงโค้ดจับคู่ และข้อความของพวกเขา **จะไม่ถูกประมวลผล** OpenClaw จะตอบกลับเฉพาะแชตที่ได้รับ หรือการส่งแบบชัดเจนที่คุณเป็นผู้กระตุ้น

อนุมัติการจับคู่ด้วย:

```bash
openclaw pairing approve whatsapp <code>
```

แสดงรายการคำขอที่รอดำเนินการ:

```bash
openclaw pairing list whatsapp
```

พรอมต์หมายเลขโทรศัพท์ในวิซาร์ด: ใช้เพื่อตั้งค่า **allowlist/owner** เพื่อให้ DM ของคุณเองได้รับอนุญาต ไม่ได้ใช้สำหรับการส่งอัตโนมัติ หากคุณรันบนหมายเลข WhatsApp ส่วนตัว ให้ใช้หมายเลขนั้นและเปิดใช้ `channels.whatsapp.selfChatMode`

## คำสั่งแชต การยกเลิกงาน และ "มันไม่ยอมหยุด"

### ฉันจะหยุดไม่ให้ข้อความระบบภายในแสดงในแชตได้อย่างไร

ข้อความภายในหรือข้อความจากเครื่องมือส่วนใหญ่จะแสดงเฉพาะเมื่อเปิด **verbose** หรือ **reasoning**
สำหรับเซสชันนั้น

แก้ไขในแชตที่คุณเห็นปัญหา:

```
/verbose off
/reasoning off
```

หากยังมีเสียงรบกวน ให้ตรวจสอบการตั้งค่าเซสชันใน Control UI และตั้งค่า verbose
เป็น **inherit** ตรวจสอบด้วยว่าคุณไม่ได้ใช้โปรไฟล์บอทที่ตั้งค่า `verboseDefault`
เป็น `on` ในคอนฟิก

เอกสาร: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### ฉันจะหยุด/ยกเลิกงานที่กำลังรันอยู่ได้อย่างไร

ส่งคำใดคำหนึ่งต่อไปนี้ **เป็นข้อความเดี่ยว ๆ** (ไม่มีสแลช):

```
stop
abort
esc
wait
exit
interrupt
```

สิ่งเหล่านี้คือทริกเกอร์สำหรับยกเลิก (ไม่ใช่คำสั่งแบบสแลช)

สำหรับกระบวนการเบื้องหลัง (จากเครื่องมือ exec) คุณสามารถขอให้เอเจนต์รัน:

```
process action:kill sessionId:XXX
```

ภาพรวมคำสั่งแบบสแลช: ดู [Slash commands](/tools/slash-commands).

คำสั่งส่วนใหญ่ต้องถูกส่งเป็นข้อความแบบ **เดี่ยว** ที่ขึ้นต้นด้วย `/` แต่มีทางลัดบางอย่าง (เช่น `/status`) ที่สามารถใช้แบบแทรกในบรรทัดได้สำหรับผู้ส่งที่อยู่ใน allowlist

### ฉันจะส่งข้อความ Discord จาก Telegram ได้อย่างไร ข้อความข้ามบริบทถูกปฏิเสธ

OpenClaw จะบล็อกการส่งข้อความ **ข้ามผู้ให้บริการ** โดยค่าเริ่มต้น หากการเรียกใช้เครื่องมือถูกผูกกับ Telegram จะไม่ส่งไปยัง Discord เว้นแต่คุณจะอนุญาตอย่างชัดเจน

เปิดใช้งานการส่งข้อความข้ามผู้ให้บริการสำหรับเอเจนต์:

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

รีสตาร์ตเกตเวย์หลังจากแก้ไขคอนฟิก หากต้องการใช้สิ่งนี้เฉพาะกับเอเจนต์เดียว ให้ตั้งค่าไว้ที่ `agents.list[].tools.message` แทน

### ทำไมถึงรู้สึกเหมือนบอทเพิกเฉยต่อข้อความที่ส่งถี่ๆ

โหมดคิวควบคุมว่าข้อความใหม่จะโต้ตอบกับการรันที่กำลังดำเนินอยู่อย่างไร ใช้ `/queue` เพื่อเปลี่ยนโหมด:

- `steer` - ข้อความใหม่จะเปลี่ยนทิศทางงานปัจจุบัน
- `followup` - ประมวลผลข้อความทีละรายการ
- `collect` - รวมข้อความเป็นชุดแล้วตอบครั้งเดียว (ค่าเริ่มต้น)
- `steer-backlog` - เปลี่ยนทิศทางทันที จากนั้นประมวลผลคิวค้าง
- `interrupt` - ยกเลิกการรันปัจจุบันและเริ่มใหม่

คุณสามารถเพิ่มตัวเลือกอย่าง `debounce:2s cap:25 drop:summarize` สำหรับโหมด followup ได้

## ตอบคำถามให้ตรงตามที่อยู่ในภาพหน้าจอ/บันทึกแชต

**Q: "โมเดลเริ่มต้นสำหรับ Anthropic เมื่อใช้ API key คืออะไร?"**

**A:** ใน OpenClaw การตั้งค่าข้อมูลรับรองและการเลือกโมเดลแยกจากกัน การตั้งค่า `ANTHROPIC_API_KEY` (หรือจัดเก็บ Anthropic API key ไว้ในโปรไฟล์การยืนยันตัวตน) จะเปิดใช้งานการยืนยันตัวตน แต่โมเดลเริ่มต้นจริงๆ คือสิ่งที่คุณกำหนดไว้ใน `agents.defaults.model.primary` (เช่น `anthropic/claude-sonnet-4-5` หรือ `anthropic/claude-opus-4-6`) หากคุณเห็น `No credentials found for profile "anthropic:default"` แสดงว่า Gateway ไม่พบข้อมูลรับรอง Anthropic ใน `auth-profiles.json` ที่คาดหวังไว้สำหรับเอเจนต์ที่กำลังรันอยู่

---

ยังติดอยู่ไหม? ถามใน [Discord](https://discord.com/invite/clawd) หรือเปิด [GitHub discussion](https://github.com/openclaw/openclaw/discussions)
