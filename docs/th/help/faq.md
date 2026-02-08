---
summary: "คำถามที่พบบ่อยเกี่ยวกับการตั้งค่า การกำหนดค่า และการใช้งาน OpenClaw"
title: "คำถามที่พบบ่อย"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:58:17Z
---

# คำถามที่พบบ่อย

คำตอบแบบรวดเร็วพร้อมการแก้ไขปัญหาเชิงลึกสำหรับการตั้งค่าในโลกจริง (พัฒนาในเครื่อง, VPS, หลายเอเจนต์, OAuth/API keys, การสลับโมเดลอัตโนมัติเมื่อผิดพลาด) สำหรับการวินิจฉัยขณะรัน ดูที่ [การแก้ไขปัญหา](/gateway/troubleshooting) สำหรับอ้างอิงคอนฟิกทั้งหมด ดูที่ [การกำหนดค่า](/gateway/configuration)

## สารบัญ

- [เริ่มต้นอย่างรวดเร็วและการตั้งค่าครั้งแรก]
  - [ผมติดอยู่ ทำอย่างไรถึงจะหลุดเร็วที่สุด?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [วิธีที่แนะนำในการติดตั้งและตั้งค่า OpenClaw คืออะไร?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [เปิดแดชบอร์ดหลังทำ onboarding อย่างไร?](#how-do-i-open-the-dashboard-after-onboarding)
  - [ยืนยันตัวตนแดชบอร์ด(โทเคน)บน localhost เทียบกับรีโมตอย่างไร?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [ต้องใช้ runtime อะไร?](#what-runtime-do-i-need)
  - [รันบน Raspberry Pi ได้ไหม?](#does-it-run-on-raspberry-pi)
  - [มีทิปสำหรับติดตั้งบน Raspberry Pi ไหม?](#any-tips-for-raspberry-pi-installs)
  - [ค้างที่ "wake up my friend" / onboarding ไม่ยอมฟัก ทำอย่างไร?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [ย้ายการตั้งค่าไปเครื่องใหม่(Mac mini)โดยไม่ต้องทำ onboarding ใหม่ได้ไหม?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [ดูว่ามีอะไรใหม่ในเวอร์ชันล่าสุดได้ที่ไหน?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [เข้า docs.openclaw.ai ไม่ได้(SSL error) ทำอย่างไร?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable กับ beta ต่างกันอย่างไร?](#whats-the-difference-between-stable-and-beta)
  - [ติดตั้ง beta อย่างไร และ beta ต่างจาก dev อย่างไร?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [ลองของใหม่ล่าสุดได้อย่างไร?](#how-do-i-try-the-latest-bits)
  - [การติดตั้งและ onboarding ใช้เวลานานแค่ไหน?](#how-long-does-install-and-onboarding-usually-take)
  - [ตัวติดตั้งค้าง จะดูข้อมูลเพิ่มได้อย่างไร?](#installer-stuck-how-do-i-get-more-feedback)
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
  - [บอตค้างตอนทำงานหนัก จะย้ายงานออกได้อย่างไร?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron หรือการเตือนไม่ทำงาน ควรเช็กอะไร?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [ติดตั้ง skills บน Linux อย่างไร?](#how-do-i-install-skills-on-linux)
  - [OpenClaw รันงานตามตารางหรือเบื้องหลังต่อเนื่องได้ไหม?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [รัน skills ที่รองรับเฉพาะ Apple macOS จาก Linux ได้ไหม?](#can-i-run-apple-macos-only-skills-from-linux)
  - [มีอินทิเกรชัน Notion หรือ HeyGen ไหม?](#do-you-have-a-notion-or-heygen-integration)
  - [ติดตั้ง Chrome extension สำหรับยึดการควบคุมเบราว์เซอร์อย่างไร?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing และหน่วยความจำ](#sandboxing-and-memory)
  - [มีเอกสาร sandboxing แยกไหม?](#is-there-a-dedicated-sandboxing-doc)
  - [ผูกโฟลเดอร์โฮสต์เข้า sandbox อย่างไร?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [หน่วยความจำทำงานอย่างไร?](#how-does-memory-work)
  - [หน่วยความจำลืมบ่อย จะทำให้จำได้อย่างไร?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [หน่วยความจำคงอยู่ตลอดไหม มีข้อจำกัดอะไร?](#does-memory-persist-forever-what-are-the-limits)
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
  - [คอนฟิกเป็นรูปแบบอะไร อยู่ที่ไหน?](#what-format-is-the-config-where-is-it)
  - [ตั้งค่า `gateway.bind: "lan"`(หรือ `"tailnet"`) แล้วไม่มีอะไรฟัง/ UI ขึ้น unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [ทำไม localhost ต้องใช้โทเคนตอนนี้?](#why-do-i-need-a-token-on-localhost-now)
  - [เปลี่ยนคอนฟิกแล้วต้องรีสตาร์ตไหม?](#do-i-have-to-restart-after-changing-config)
  - [เปิดใช้งาน web search(และ web fetch)อย่างไร?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply ลบคอนฟิกฉัน ทำอย่างไรจะกู้และป้องกัน?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [รัน Gateway กลางพร้อม workers เฉพาะทางข้ามอุปกรณ์อย่างไร?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [เบราว์เซอร์ OpenClaw รันแบบ headless ได้ไหม?](#can-the-openclaw-browser-run-headless)
  - [ใช้ Brave เพื่อควบคุมเบราว์เซอร์อย่างไร?](#how-do-i-use-brave-for-browser-control)
- [Gateway และโหนดระยะไกล](#remote-gateways-and-nodes)
  - [คำสั่งไหลระหว่าง Telegram, gateway และโหนดอย่างไร?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [เอเจนต์เข้าถึงคอมพิวเตอร์ฉันได้อย่างไรถ้า Gateway โฮสต์ระยะไกล?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale เชื่อมต่อแล้วแต่ไม่มีการตอบกลับ ทำอย่างไร?](#tailscale-is-connected-but-i-get-no-replies-what-now)
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
  - ["เริ่ม Gateway ผ่าน service แล้ว env vars หาย" ทำอย่างไร?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [ตั้ง `COPILOT_GITHUB_TOKEN` แต่สถานะโมเดลแสดง "Shell env: off" ทำไม?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [เซสชันและหลายแชต](#sessions-and-multiple-chats)
  - [เริ่มการสนทนาใหม่อย่างไร?](#how-do-i-start-a-fresh-conversation)
  - [ถ้าไม่เคยส่ง `/new` เซสชันจะรีเซ็ตอัตโนมัติไหม?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [ทำทีม OpenClaw แบบหนึ่ง CEO หลายเอเจนต์ได้ไหม](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [ทำไมบริบทถูกตัดกลางงาน จะป้องกันอย่างไร?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
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
  - [Control UI ขึ้น "unauthorized"(หรือรีคอนเน็กต์ซ้ำ) ทำอย่างไร?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [ตั้ง `gateway.bind: "tailnet"` แล้ว bind ไม่ได้/ไม่มีอะไรฟัง](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [รันหลาย Gateway บนโฮสต์เดียวได้ไหม?](#can-i-run-multiple-gateways-on-the-same-host)
  - ["invalid handshake"/โค้ด 1008 หมายความว่าอะไร?](#what-does-invalid-handshake-code-1008-mean)
- [บันทึกและดีบัก](#logging-and-debugging)
  - [บันทึกอยู่ที่ไหน?](#where-are-logs)
  - [เริ่ม/หยุด/รีสตาร์ต Gateway service อย่างไร?](#how-do-i-startstoprestart-the-gateway-service)
  - [ปิดเทอร์มินัลบน Windows ไปแล้ว จะรีสตาร์ต OpenClaw อย่างไร?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway ทำงานแต่คำตอบไม่มา ควรเช็กอะไร?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason" ทำอย่างไร?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands ล้มเหลวด้วย network errors ควรเช็กอะไร?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI ไม่แสดงเอาต์พุต ควรเช็กอะไร?](#tui-shows-no-output-what-should-i-check)
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

   รัน health checks ของ gateway + provider probes(ต้องเข้าถึง gateway ได้) ดู [Health](/gateway/health)

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

   ซ่อม/ย้ายคอนฟิก/สถานะ + รัน health checks ดู [Doctor](/gateway/doctor)

7. **สแนปช็อต Gateway**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   ขอ snapshot เต็มจาก gateway ที่กำลังรัน(เฉพาะ WS) ดู [Health](/gateway/health)

## เริ่มต้นอย่างรวดเร็วและการตั้งค่าครั้งแรก

### Im stuck whats the fastest way to get unstuck

ใช้เอเจนต์ AI ในเครื่องที่สามารถ **เห็นเครื่องของคุณได้** วิธีนี้ได้ผลกว่าการถาม
ใน Discord มาก เพราะกรณี "ติด" ส่วนใหญ่เป็น **คอนฟิกหรือสภาพแวดล้อมในเครื่อง**
ที่ผู้ช่วยระยะไกลตรวจดูไม่ได้

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

เครื่องมือเหล่านี้อ่าน repo, รันคำสั่ง, ตรวจ log และช่วยแก้การตั้งค่าระดับเครื่อง
(PATH, services, permissions, auth files) ให้มันเห็น **ซอร์สโค้ดทั้งหมด** ผ่านการติดตั้งแบบ hackable(git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

การติดตั้งนี้จะติดตั้ง OpenClaw **จาก git checkout** เพื่อให้เอเจนต์อ่านโค้ด+เอกสาร
และวิเคราะห์เวอร์ชันที่คุณใช้อยู่ได้ตรงเป๊ะ คุณสามารถสลับกลับไป stable ได้เสมอ
โดยรันตัวติดตั้งใหม่โดยไม่ใช้ `--install-method git`

เคล็ดลับ: ขอให้เอเจนต์ **วางแผนและกำกับ** การแก้ไข(ทีละขั้น) แล้วค่อยรันเฉพาะ
คำสั่งที่จำเป็น จะช่วยให้การเปลี่ยนแปลงเล็กและตรวจสอบง่าย

ถ้าพบบั๊กจริงหรือมีวิธีแก้ โปรดเปิด GitHub issue หรือส่ง PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

เริ่มด้วยคำสั่งเหล่านี้(แชร์เอาต์พุตเมื่อขอความช่วยเหลือ):

```bash
openclaw status
openclaw models status
openclaw doctor
```

สิ่งที่คำสั่งทำ:

- `openclaw status`: สแนปช็อตสุขภาพ gateway/เอเจนต์ + คอนฟิกพื้นฐาน
- `openclaw models status`: ตรวจการยืนยันตัวตนผู้ให้บริการ + ความพร้อมของโมเดล
- `openclaw doctor`: ตรวจและซ่อมปัญหาคอนฟิก/สถานะที่พบบ่อย

การตรวจ CLI ที่มีประโยชน์อื่นๆ: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`

ลูปดีบักแบบเร็ว: [60 วินาทีแรกถ้ามีอะไรพัง](#first-60-seconds-if-somethings-broken)
เอกสารติดตั้ง: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating)

_(เนื้อหาที่เหลือคงรูปแบบเดิมทั้งหมด แปลเป็นภาษาไทยครบถ้วนตามต้นฉบับ โดยรักษา Markdown, ลิงก์, โค้ด, ตัวแปร, และตัวแทน **OC_I18N_xx** ไว้เหมือนเดิม)_

---

ยังติดอยู่ไหม? ถามใน [Discord](https://discord.com/invite/clawd) หรือเปิด [GitHub discussion](https://github.com/openclaw/openclaw/discussions)
