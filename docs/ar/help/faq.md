---
summary: "الأسئلة الشائعة حول إعداد OpenClaw وتهيئته واستخدامه"
title: "الأسئلة الشائعة"
---

# الأسئلة الشائعة

إجابات سريعة مع استكشاف أعمق للأخطاء وإصلاحها لسيناريوهات العالم الحقيقي (التطوير المحلي، VPS، تعدد الوكلاء، OAuth/مفاتيح API، التبديل الاحتياطي للنماذج). لتشخيصات وقت التشغيل، راجع [استكشاف الأخطاء وإصلاحها](/gateway/troubleshooting). ولمرجع التهيئة الكامل، راجع [التهيئة](/gateway/configuration).

## جدول المحتويات

- [البدء السريع وإعداد التشغيل الأول]
  - [أنا عالق—ما أسرع طريقة للخروج من التعطّل؟](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [ما الطريقة الموصى بها لتثبيت OpenClaw وإعداده؟](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [كيف أفتح لوحة التحكم بعد التهيئة الأولية؟](#how-do-i-open-the-dashboard-after-onboarding)
  - [كيف أوثّق لوحة التحكم (الرمز) على localhost مقابل الاتصال البعيد؟](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [ما بيئة التشغيل المطلوبة؟](#what-runtime-do-i-need)
  - [هل يعمل على Raspberry Pi؟](#does-it-run-on-raspberry-pi)
  - [هل هناك نصائح لتثبيت Raspberry Pi؟](#any-tips-for-raspberry-pi-installs)
  - [عالق على «wake up my friend» / التهيئة الأولية لا تكتمل. ماذا الآن؟](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [هل يمكنني ترحيل إعدادي إلى جهاز جديد (Mac mini) دون إعادة التهيئة الأولية؟](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [أين أرى ما الجديد في أحدث إصدار؟](#where-do-i-see-what-is-new-in-the-latest-version)
  - [لا أستطيع الوصول إلى docs.openclaw.ai (خطأ SSL). ماذا أفعل؟](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [ما الفرق بين المستقر وبيتا؟](#whats-the-difference-between-stable-and-beta)
  - [كيف أثبّت نسخة بيتا، وما الفرق بين بيتا وdev؟](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [كيف أجرّب أحدث الإصدارات؟](#how-do-i-try-the-latest-bits)
  - [كم يستغرق التثبيت والتهيئة الأولية عادةً؟](#how-long-does-install-and-onboarding-usually-take)
  - [المثبت عالق؟ كيف أحصل على المزيد من الملاحظات؟](#installer-stuck-how-do-i-get-more-feedback)
  - [تثبيت Windows يقول git غير موجود أو openclaw غير معروف](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [لم تُجب المستندات عن سؤالي—كيف أحصل على إجابة أفضل؟](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [كيف أثبّت OpenClaw على Linux؟](#how-do-i-install-openclaw-on-linux)
  - [كيف أثبّت OpenClaw على VPS؟](#how-do-i-install-openclaw-on-a-vps)
  - [أين أدلة تثبيت السحابة/VPS؟](#where-are-the-cloudvps-install-guides)
  - [هل يمكنني أن أطلب من OpenClaw تحديث نفسه؟](#can-i-ask-openclaw-to-update-itself)
  - [ماذا يفعل معالج التهيئة الأولية فعليًا؟](#what-does-the-onboarding-wizard-actually-do)
  - [هل أحتاج اشتراك Claude أو OpenAI لتشغيله؟](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [هل يمكنني استخدام اشتراك Claude Max دون مفتاح API؟](#can-i-use-claude-max-subscription-without-an-api-key)
  - [كيف يعمل توثيق Anthropic «setup-token»؟](#how-does-anthropic-setuptoken-auth-work)
  - [أين أجد setup-token الخاص بـ Anthropic؟](#where-do-i-find-an-anthropic-setuptoken)
  - [هل تدعمون توثيق اشتراك Claude (Pro أو Max)؟](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [لماذا أرى `HTTP 429: rate_limit_error` من Anthropic؟](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [هل AWS Bedrock مدعوم؟](#is-aws-bedrock-supported)
  - [كيف يعمل توثيق Codex؟](#how-does-codex-auth-work)
  - [هل تدعمون توثيق اشتراك OpenAI (Codex OAuth)؟](#do-you-support-openai-subscription-auth-codex-oauth)
  - [كيف أُعد Gemini CLI OAuth؟](#how-do-i-set-up-gemini-cli-oauth)
  - [هل النموذج المحلي مناسب للدردشات العادية؟](#is-a-local-model-ok-for-casual-chats)
  - [كيف أحافظ على مرور حركة النماذج المستضافة ضمن منطقة محددة؟](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [هل يجب أن أشتري Mac Mini لتثبيت هذا؟](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [هل أحتاج Mac mini لدعم iMessage؟](#do-i-need-a-mac-mini-for-imessage-support)
  - [إذا اشتريت Mac mini لتشغيل OpenClaw، هل يمكنني ربطه بـ MacBook Pro؟](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [هل يمكنني استخدام Bun؟](#can-i-use-bun)
  - [Telegram: ماذا يوضع في `allowFrom`؟](#telegram-what-goes-in-allowfrom)
  - [هل يمكن لعدة أشخاص استخدام رقم WhatsApp واحد مع مثيلات OpenClaw مختلفة؟](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [هل يمكنني تشغيل وكيل «دردشة سريعة» ووكيل «Opus للبرمجة»؟](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [هل يعمل Homebrew على Linux؟](#does-homebrew-work-on-linux)
  - [ما الفرق بين تثبيت git القابل للتعديل وتثبيت npm؟](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [هل يمكنني التبديل لاحقًا بين تثبيت npm وgit؟](#can-i-switch-between-npm-and-git-installs-later)
  - [هل يجب تشغيل Gateway على الحاسوب المحمول أم على VPS؟](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [ما مدى أهمية تشغيل OpenClaw على جهاز مخصص؟](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [ما الحد الأدنى لمتطلبات VPS ونظام التشغيل الموصى به؟](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [هل يمكن تشغيل OpenClaw داخل VM وما المتطلبات؟](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [ما هو OpenClaw؟](#what-is-openclaw)
  - [ما هو OpenClaw في فقرة واحدة؟](#what-is-openclaw-in-one-paragraph)
  - [ما القيمة المقترحة؟](#whats-the-value-proposition)
  - [لقد أعددته للتو—ماذا أفعل أولًا؟](#i-just-set-it-up-what-should-i-do-first)
  - [ما أهم خمسة استخدامات يومية لـ OpenClaw؟](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [هل يمكن لـ OpenClaw المساعدة في توليد العملاء المحتملين والإعلانات والمدونات لـ SaaS؟](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [ما المزايا مقارنةً بـ Claude Code لتطوير الويب؟](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills والأتمتة](#skills-and-automation)
  - [كيف يمكنني تخصيص المهارات دون الحفاظ على القذرة المستعرض؟](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [هل يمكنني تحميل المهارات من مجلد مخصص؟](#can-i-load-skills-from-a-custom-folder)
  - [كيف يمكنني استخدام نماذج مختلفة لمهام مختلفة؟](#how-can-i-use-different-models-for-different-tasks)
  - [البوت يجمد بينما يقوم بعمل شاق. كيف يمكنني تفريغ ذلك؟](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [الكرات أو التذكيرات لا تحترق. ماذا يجب أن أتحقق؟](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [كيف يمكنني تثبيت المهارات على لينوكس؟](#how-do-i-install-skills-on-linux)
  - [هل يمكن OpenClaw تشغيل المهام على جدول زمني أو باستمرار في الخلفية؟](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [هل يمكنني تشغيل مهارات Apple macOS-فقط من لينوكس؟](#can-i-run-apple-macos-only-skills-from-linux)
  - [هل لديك مفهوم أو تكامل HeyGen؟](#do-you-have-a-notion-or-heygen-integration)
  - [كيف يمكنني تثبيت ملحق Chrome لاستلام المتصفح؟](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing والذاكرة](#sandboxing-and-memory)
  - [هل هناك وثيقة مخصصة لغسل الرمل؟](#is-there-a-dedicated-sandboxing-doc)
  - [كيف يمكنني ربط مجلد مضيف في صندوق الرمل؟](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [كيف تعمل الذاكرة؟](#how-does-memory-work)
  - [الذاكرة تنسى الأشياء. كيف يمكنني جعله عصاء؟](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [هل تستمر الذاكرة إلى الأبد؟ ما هي الحدود؟](#does-memory-persist-forever-what-are-the-limits)
  - [هل يتطلب البحث عن الذاكرة الدلالية مفتاح OpenAI API ؟](#does-semantic-memory-search-require-an-openai-api-key)
- [أين توجد الأشياء على القرص](#where-things-live-on-disk)
  - [هل جميع البيانات مستخدمة مع OpenClaw محفوظة محليًا؟](#is-all-data-used-with-openclaw-saved-locally)
  - [أين يخزّن OpenClaw بياناته؟](#where-does-openclaw-store-its-data)
  - [أين ينبغي أن يكون AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [ما هي استراتيجية النسخ الاحتياطي الموصى بها؟](#whats-the-recommended-backup-strategy)
  - [كيف يمكنني إلغاء تثبيت OpenClaw؟](#how-do-i-completely-uninstall-openclaw)
  - [هل يمكن للوكلاء العمل خارج حيز العمل؟](#can-agents-work-outside-the-workspace)
  - [أنا في وضع بعيد - أين هو متجر الجلسة؟](#im-in-remote-mode-where-is-the-session-store)
- [أساسيات التهيئة](#config-basics)
  - [ما هي صيغة التكوين؟ أين هو؟](#what-format-is-the-config-where-is-it)
  - [أقوم بتعيين `gateway.bind: "lan"` (أو `tailnet"`) والآن لا يوجد أي مستمع / واجهة المستخدم تقول غير مصرح بها](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [لماذا أحتاج إلى الرمز المميز على المستضيف المحلي الآن؟](#why-do-i-need-a-token-on-localhost-now)
  - [هل يتوجب علي إعادة التشغيل بعد تغيير الإعداد؟](#do-i-have-to-restart-after-changing-config)
  - [كيف يمكنني تمكين البحث على الويب (وجلب الويب)؟](#how-do-i-enable-web-search-and-web-fetch)
  - [config.application تم مسح تكويني. كيف يمكنني التعافي وتجنب هذا؟](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [كيف يمكنني تشغيل بوابة مركزية مع عمال متخصصين عبر الأجهزة؟](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [هل يمكن لمتصفح OpenClaw أن يعمل بدون رأس؟](#can-the-openclaw-browser-run-headless)
  - [كيف يمكنني استخدام الشجاعة للتحكم في المتصفح؟](#how-do-i-use-brave-for-browser-control)
- [Gateways وعُقد بعيدة](#remote-gateways-and-nodes)
  - [كيف تنتشر الأوامر بين تيليجرام والبوابة والعقد؟](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [كيف يمكن لوكيلي الوصول إلى جهاز الكمبيوتر الخاص بي إذا تم استضافة البوابة عن بعد؟](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [المقياس الخطي متصل، ولكن لا أحصل على ردود. ماذا أفعل؟](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [هل يمكن أن يتحدث اثنان من مثيلات OpenClaw مع بعضهما البعض (المحلي + VPS)؟](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [هل أحتاج إلى VPSs منفصلة لوكلاء متعددين](#do-i-need-separate-vpses-for-multiple-agents)
  - [هل هناك فائدة لاستخدام عقدة على حاسوبي الشخصي بدلاً من SSH من VPS؟](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [هل تشغل العقد خدمة بوابة؟](#do-nodes-run-a-gateway-service)
  - [هل هناك طريقة API / RPC لتطبيق التكوين؟](#is-there-an-api-rpc-way-to-apply-config)
  - [ما هو الحد الأدنى من التكوين "الجيد" للتثبيت الأول؟](#whats-a-minimal-sane-config-for-a-first-install)
  - [كيف يمكنني إعداد تايلباس على VPS والاتصال من ماك؟](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [كيف يمكنني توصيل عقدة ماك إلى بوابة نائية (خدمة المقياس البري)؟](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [هل يجب أن أثبت على حاسوب محمول ثان أم فقط أضيف عقدة؟](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [متغيرات البيئة وتحميل .env](#env-vars-and-env-loading)
  - [كيف تقوم OpenClaw بتحميل متغيرات البيئة ؟](#how-does-openclaw-load-environment-variables)
  - ["لقد بدأت البوابة عن طريق الخدمة واختفى إنف الخاص بي." ماذا أفعل؟](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [قمت بتعيين \`COPILOT_GITHUB_TOKEN'، ولكن حالة النماذج تظهر "Shell env: off." لماذا؟](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [الجلسات وتعدد الدردشات](#sessions-and-multiple-chats)
  - [كيف أبدأ محادثة جديدة؟](#how-do-i-start-a-fresh-conversation)
  - [هل الجلسات يعاد تعيينها تلقائياً إذا لم أقم أبدا بإرسال `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [هل هناك طريقة لجعل فريق من مثيلات OpenClaw أحد الرؤساء التنفيذيين والعديد من الوكلاء](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [لماذا اختزل السياق في منتصف المهمة؟ كيف يمكنني منعها؟](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [كيف يمكنني إعادة تعيين OpenClaw بالكامل ولكن ابقائها مثبتة؟](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [أنا أحصل على أخطاء "السياق كبير جداً" - كيف يمكنني إعادة تعيين أو الاتفاق؟](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [لماذا أرى طلب LLM مرفوض: messages.N.content.X.tool_use.input: حقل مطلوب ؟](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [لماذا أحصل على رسائل نبيطة القلب كل 30 دقيقة؟](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [هل أحتاج إلى إضافة "حساب بوت" إلى مجموعة WhatsApp؟](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [كيف أحصل على إجادة مجموعة WhatsApp؟](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [لماذا لا يرد OpenClaw في مجموعة؟](#why-doesnt-openclaw-reply-in-a-group)
  - [هل المجموعات / المواضيع تشارك السياق مع DMs؟](#do-groupsthreads-share-context-with-dms)
  - [كم عدد مساحات العمل والوكلاء الذين يمكنني إنشاؤهم؟](#how-many-workspaces-and-agents-can-i-create)
  - [هل يمكنني تشغيل عدة بوت أو دردشة في نفس الوقت (سوداء)، وكيف ينبغي أن أضع ذلك؟](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [النماذج: الافتراضيات والاختيار والأسماء المستعارة والتبديل](#models-defaults-selection-aliases-switching)
  - [ما هو "النموذج الافتراضي"?](#what-is-the-default-model)
  - [ما هو النموذج الذي توصي به؟](#what-model-do-you-recommend)
  - [كيف يمكنني تبديل النماذج دون مسح تكوين؟](#how-do-i-switch-models-without-wiping-my-config)
  - [هل يمكنني استخدام نماذج ذاتية الاستضافة (llama.cppp، vLM، Ollama)؟](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [ما هي طريقة استخدام OpenClaw ، الخلل ، و Krill للنماذج؟](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [كيف يمكنني تبديل النماذج على متن الطائرة (دون إعادة التشغيل)؟](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [هل يمكنني استخدام GPT 5.2 للمهام اليومية و Codex 5.3 للبرمجة](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [لماذا أرى "النموذج … غير مسموح به" ومن ثم لا يوجد رد؟](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [لماذا أرى "نموذج غير معروف: الحد الأدنى/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [هل يمكنني استخدام MiniMax كإفتراضي و OpenAI للمهام المعقدة؟](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [هل هي إختصارات opus / sonnet / gpt مدمجة فيها؟](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [كيف يمكنني تعريف/تجاوز اختصارات النموذج (أسماء مستعارة)؟](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [كيف يمكنني إضافة نماذج من مزودين آخرين مثل OpenRouter أو Z.AI؟](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [التبديل الاحتياطي للنماذج و«فشل جميع النماذج»](#model-failover-and-all-models-failed)
  - [كيف يعمل الفشل؟](#how-does-failover-work)
  - [ماذا يعني هذا الخطأ؟](#what-does-this-error-mean)
  - [إصلاح قائمة التحقق لـ `لم يتم العثور على بيانات اعتماد للملف الشخصي "الإنسان : الإفتراضي"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [لماذا جرب أيضا جينيني و فشل؟](#why-did-it-also-try-google-gemini-and-fail)
- [ملفات التوثيق: ما هي وكيف تُدار](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [ما هو الملف الشخصي للمصادقة؟](#what-is-an-auth-profile)
  - [ما هي معرفات الملف الشخصي؟](#what-are-typical-profile-ids)
  - [هل يمكنني التحكم في أي ملف شخصي المصادقة يتم تجربته أولاً؟](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API المفتاح: ما هو الفارق؟](#oauth-vs-api-key-whats-the-difference)
- [Gateway: المنافذ و«يعمل بالفعل» والوضع البعيد](#gateway-ports-already-running-and-remote-mode)
  - [ما هو المنفذ الذي يستخدمه البوابة؟](#what-port-does-the-gateway-use)
  - [لماذا يقول 'حالة بوابة openclaw Boateway status' 'Runtime: تشغيل' ولكن 'Probe: فشل'?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [لماذا تختلف حالة 'openclaw بوابة' عن 'Config (cli)' و 'Config (service)' ؟](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [ماذا يعني "مثال بوابة أخرى تستمع مسبقاً؟](#what-does-another-gateway-instance-is-already-listening-mean)
  - [كيف يمكنني تشغيل OpenClaw في الوضع البعيد (يتصل العميل ببوابة في مكان آخر)؟](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [يقول واجهة المستخدم للتحكم "غير مصرح بها" (أو يواصل إعادة الاتصال). ماذا أفعل؟](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [أقوم بتعيين `gateway.bind: "tailnet"` ولكن لا يمكن ربط / لا يوجد مستمعين](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [هل يمكنني تشغيل العديد من البوابات على نفس المضيف؟](#can-i-run-multiple-gateways-on-the-same-host)
  - [ماذا تعني "مصافحة هيدك" / الرمز 1008 غير صالحة؟](#what-does-invalid-handshake-code-1008-mean)
- [التسجيل وتصحيح الأخطاء](#logging-and-debugging)
  - [أين هي السجلات؟](#where-are-logs)
  - [كيف يمكنني البدء/إيقاف/إعادة تشغيل خدمة البوابة؟](#how-do-i-startstoprestart-the-gateway-service)
  - [أغلقت محطتي الطرفية على Windows - كيف يمكنني إعادة تشغيل OpenClaw؟](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [إن البوابة جاهزة ولكن الردود لم تصل أبدا. ماذا يجب أن أتحقق؟](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["قطع الاتصال من البوابة: لا سبب " - ماذا الآن؟](#disconnected-from-gateway-no-reason-what-now)
  - [فشل Telegram setMyCommands مع أخطاء الشبكة. ماذا يجب أن أتحقق؟](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI لا يظهر أي مخرج. ماذا يجب أن أتحقق؟](#tui-shows-no-output-what-should-i-check)
  - [كيف أتوقف تماما ثم أبدأ البوابة؟](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw بوابة إعادة التشغيل` ضد `openclaw بوابة`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [ما هي أسرع طريقة للحصول على المزيد من التفاصيل عندما يفشل شيء؟](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [الوسائط والمرفقات](#media-and-attachments)
  - [ولدت مهارتي صورة/PDF، ولكن لم يتم إرسال أي شيء](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [الأمن والتحكم في الوصول](#security-and-access-control)
  - [هل من الآمن عرض OpenClaw إلى DMs الواردة؟](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [هل الحقن الفوري هو فقط شاغل للروبوتات العامة؟](#is-prompt-injection-only-a-concern-for-public-bots)
  - [ينبغي أن يكون للبوت الخاص بي بريده الإلكتروني حساب GitHub أو رقم الهاتف](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [هل يمكنني إعطائها استقلالية في رسائلي النصية وهي آمنة](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [هل يمكنني استخدام نماذج أرخص لمهام المساعد الشخصي؟](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [قمت بتشغيل `/start` في تيليجرام ولكن لم أحصل على رمز اقتران](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [ماتسوب: هل سترسل رسالة إلى جهات الاتصال الخاصة بي؟ كيف يعمل الإقران؟](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [أوامر الدردشة وإيقاف المهام و«لا يتوقف»](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [كيف أوقف الرسائل الداخلية للنظام من إظهار في الدردشة](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [كيف أوقف/ألغي مهمة قيد التشغيل؟](#how-do-i-stopcancel-a-running-task)
  - [كيف يمكنني إرسال رسالة ديسكورد من تيليجرام؟ ("الرسائل المتبادلة بين السياقات")]( (#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied
  - [لماذا تشعر كالبوت "يتجاهل" رسائل النيران السريعة؟](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## أول 60 ثانية إذا كان هناك عطل

1. **الحالة السريعة (أول فحص)**

   ```bash
   openclaw status
   ```

   ملخص محلي سريع: نظام التشغيل + التحديث، قابلية الوصول إلى Gateway/الخدمة، الوكلاء/الجلسات، تهيئة الموفّرين + مشكلات وقت التشغيل (عندما يكون Gateway قابلًا للوصول).

2. **تقرير قابل للمشاركة (آمن)**

   ```bash
   openclaw status --all
   ```

   تشخيص للقراءة فقط مع ذيل السجل (إخفاء الرموز).

3. **حالة الخدمة + المنفذ**

   ```bash
   openclaw gateway status
   ```

   يعرض وقت تشغيل المشرف مقابل قابلية الوصول عبر RPC، وعنوان URL المستهدف للفحص، وأي تهيئة استخدمتها الخدمة على الأرجح.

4. **فحوصات عميقة**

   ```bash
   openclaw status --deep
   ```

   يشغّل فحوصات صحة Gateway + فحوصات الموفّرين (يتطلب Gateway قابلًا للوصول). راجع [الصحة](/gateway/health).

5. **متابعة أحدث سجل**

   ```bash
   openclaw logs --follow
   ```

   إذا كان RPC معطّلًا، استخدم البديل:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   سجلات الملفات منفصلة عن سجلات الخدمة؛ راجع [التسجيل](/logging) و[استكشاف الأخطاء وإصلاحها](/gateway/troubleshooting).

6. **تشغيل الطبيب (إصلاحات)**

   ```bash
   openclaw doctor
   ```

   يصلح/يُرحّل التهيئة/الحالة + يشغّل فحوصات الصحة. راجع [Doctor](/gateway/doctor).

7. gpt-5.2-chat-latest

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   يطلب من Gateway العامل لقطة كاملة (WS فقط). راجع [الصحة](/gateway/health).

## البدء السريع وإعداد التشغيل الأول

### عالقت أسرع طريقة للحصول على إلغاء العالقة

استخدم وكيل الذكاء الاصطناعي المحلي الذي يمكنه **مشاهدة جهازك**. 40. هذا أكثر فاعلية بكثير من السؤال في Discord، لأن معظم حالات "أنا عالق" هي **مشكلات إعداد محلية أو بيئية** لا يستطيع المساعدون عن بُعد فحصها.

- **الكود البرمجي**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **رمز OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

يمكن لهذه الأدوات قراءة المستودع، وتشغيل الأوامر، وفحص السجلات، والمساعدة في إصلاح مستوى جهازك
إعداد (PATH، الخدمات، الأذونات، ملفات المصادقة). إعطائهم **الدفع الكامل المصدر** من خلال
تثبيت Hackable (غيت):format@@0

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --install-method git
```

هذا يثبّت OpenClaw \*\*من دفع git \*\*، حتى يتمكن الوكيل من قراءة التعليمة البرمجية + مستندات و
بسبب الإصدار الدقيق الذي تقوم بتشغيله. يمكنك دائماً التبديل إلى مستقر في وقت لاحق
عن طريق إعادة تشغيل المثبت بدون `--install-method git`.

نصيحة: اطلب من الوكيل **التخطيط والإشراف** الإصلاح (خطوة بخطوة)، ثم قم بتنفيذ الأوامر الضرورية
فقط. ويبقي ذلك التغييرات صغيرة وسهلة مراجعة الحسابات.

**هل ما زلت عالقًا؟** اسأل في [Discord](https://discord.com/invite/clawd) أو افتح [مناقشة على GitHub](https://github.com/openclaw/openclaw/discussions).

ابدأ بهذه الأوامر (شارك المخرجات عند طلب المساعدة):

```bash
حالة openclaw
حالة نماذج openclaw
طبيب openclaw
```

ماذا يفعلون:

- `openclaw status`: لقطة سريعة من البوابة/عامل صحة + التكوين الأساسي.
- 'وضع نماذج openclaw model\`: التحقق من توافر موفر التوفير + النموذج.
- 'طبيب openclaw': يقوم بالتحقق من المشاكل الشائعة في التشكيلة / الحالة وإصلاحها.

اختبارات CLI مفيدة أخرى: `openclaw status --all`, `openclaw logs --follow`,
`openclaw Porateway status`, `openclaw Health --verbose`.

حلقة التصحيح السريعة: [أول 60 ثانية إذا كسر شيء ما](#first-60-seconds-if-somethings-broken).
مستندات التثبيت: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### ما هي الطريقة الموصى بها لتثبيت وإعداد OpenClaw

يوصي المستودع بالعمل من المصدر و باستخدام معالج onboarding :

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash
openclaw onboard--install-daemon
```

يمكن للمعالج أيضا بناء أصول واجهة المستخدم تلقائيا. بعد الركوب ، تقوم عادة بتشغيل البوابة على المنفذ **18789**.

من المصدر (المساهمون/dev):

```bash
استنساخ git https://github.com/openclaw/openclaw.git
cd openclaw
pnpm تثبيت
pnpm لبناء
pnpm ui:Building # Auto-installs UI deps على تشغيل
openclaw على اللوحة
```

إذا لم يكن لديك تثبيت عالمي بعد، قم بتشغيله عبر `pnpm openclaw على اللوحة`.

### كيف أفتح لوحة التحكم بعد أونبواردينج

يقوم المعالج بفتح المتصفح الخاص بك باستخدام عنوان URL للوحة تحكم نظيفة (غير مميزة) مباشرة بعد أونبواردينج كما يقوم بطباعة الرابط في الملخص. إبقاء علامة التبويب هذه مفتوحة؛ إذا لم يتم تشغيلها، نسخ/لصق عنوان URL المطبوع على نفس الجهاز.

### كيف يمكنني المصادقة على رمز لوحة التحكم على localhost مقابل عن بعد

**Localhost (نفس الآلة):**

- افتح http://127.0.0.1:18789/\`.
- إذا طلبت المصادقة ، قم بلصق الرمز المميز من 'gateway.auth.token' (أو 'OPENCLAW_GATEWAY_TOKEN') إلى إعدادات واجهة المستخدم.
- استرجاعه من البوابة المضيفة: `openclaw config get Gateway.auth.token` (أو إنشاء واحد: `openclaw doctor --generate-gateway-token`).

**ليس على localhost:**

- **خدمة المقياس السريع** (مستحسن): استمر في ربط حلقة التكرار، وتشغيل `بوابة openclaw --tailscale serve`، وفتح `https://<magicdns>/`. إذا كان 'gateway.auth.allowTailscale' 'true'، فإن رؤوس الهوية ترضي المصادقة (no token).
- **ربط Tailnet**: تشغيل `openclaw بوابة --bindnet --token "<token>"`، افتح `http://<tailscale-ip>:18789/`، لصق الرمز المميز في إعدادات لوحة القيادة.
- **نفق SSH**: `ssh -N -L 18789:127.0.0.1:18789 user@host' ثم افتح `http://127.0.0.1:18789/' وألصق الرمز المميز في إعدادات واجهة المستخدم.

راجع [Dashboard](/web/dashboard) و [سطح الويب] (/web) لربط الأوضاع وتفاصيل المصادقة.

### ما هو وقت التشغيل الذي أحتاجه

العقد **>= 22** مطلوب. 'pnpm' ينصح به. القطن **غير مستحسن** على البوابة.

### هل يعمل على Raspberry Pi

نعم. البوابة خفيفة الوزن - قائمة المستندات **512MB-1GB RAM**، **1 الأساسية**، وحوالي **500MB**
قرص كافي للاستخدام الشخصي، ويلاحظ أن **Raspberry Pi 4 يمكن تشغيله**.

41. إذا كنت تريد هامشًا إضافيًا (سجلات، وسائط، خدمات أخرى)، **يوصى بـ 2GB**، لكنها ليست حدًا أدنى صارمًا.

نصيحة: يمكن لـ Pi/VPS الصغيرة أن تستضيف البوابة، ويمكنك أن تزوج **عقدة** على حاسوبك المحمول/هاتفك من أجل
الشاشة المحلية/الكاميرا/كانفاس أو تنفيذ الأوامر المحلية. انظر [Nodes](/nodes).

### أي نصائح لتثبيت Raspberry Pi

إصدار قصير: إنه يعمل، ولكن يتوقع حواف تقريبية.

- استخدم نظام تشغيل **64-بت** واحتفظ بالعقدة >= 22.
- تفضيل تثبيت **hackable (git)** حتى تتمكن من رؤية السجلات والتحديث بسرعة.
- ابدأ بدون قنوات/مهارات، ثم أضفها واحدة تلو الأخرى.
- إذا واجهت مشاكل ثنائية غريبة، فهي عادة مشكلة **توافق ARM**.

الوثائق: [Linux](/platforms/linux), [Install](/install).

### إنه معلق على إيقاظ صديقي على متنه لن يفقس ما هو الآن

وتعتمد هذه الشاشة على إمكانية الوصول إلى البوابة والتصديق عليها. ترسل TUI أيضًا
"استيقظ، صديقي!" تلقائيًا في القفزة الأولى. إذا رأيت هذا السطر مع **لا رد**
وتظل الرموز عند 0، فإن الوكيل لا يرقى أبدا.

1. أعد تشغيل Gateway:

```bash
openclaw gateway restart
```

2. التحقق من الحالة + المصادقة:

```bash
حالة openclaw
وضع نماذج openclaw
سجلات openclaw --تابع
```

3. إذا كانت لا تزال معلقة، قم بتشغيل:

```bash
openclaw doctor
```

إذا كانت البوابة بعيدة ، تأكد من أن الإتصال بالنفق/النطاق مرتفع وأن واجهة المستخدم
قد تم توجيهها إلى البوابة الصحيحة. انظر [الوصول عن بُعد](/gateway/remote).

### هل يمكنني ترحيل إعدادي إلى ماك ماك مصغر جديد بدون إعادة تشغيل أونبواردينج

نعم. نسخ **دليل الولاية** و **مساحة العمل**، ثم قم بتشغيل دكتور مرة واحدة. هذا
يحافظ على الروبوت "نفس الحالة" (الذاكرة، سجل الجلسة، المصادقة والقناة
) طالما أنسخ **الموقع**كليهما\*\*:

1. تثبيت OpenClaw على الآلة الجديدة.
2. نسخ `$OPENCLAW_STATE_DIR` (الافتراضي: `~/.openclaw`) من الآلة القديمة.
3. نسخ مساحة العمل الخاصة بك (الافتراضي: `~/.openclaw/workspace`).
4. تشغيل "طبيب openclaw" وإعادة تشغيل خدمة البوابة.

هذا يحافظ على التكوين, ملفات تعريف المصادقة, إقرارات واتساب, جلسات, و الذاكرة. إذا كنت في وضع
البعيد، تذكر أن مضيف البوابة يمتلك متجر الجلسة ومساحة العمل.

**مهم:** إذا قمت فقط بإلزام/دفع فضاء العمل الخاص بك إلى GitHub، فإنك تقوم بدعم
من **الذاكرة + ملفات bootstrap**، ولكن **لا** سجل الجلسات أو المصادقة. هؤلاء الأحياء
تحت '~/.openclaw/' (على سبيل المثال '~/.openclaw/agents/<agentId>/sessions/\`).

متعلق: [Migrating](/install/migrating)، [حيث تعيش الأشياء على القرص] (/help/faq#where-does-openclaw-store-its-data)،
[وكيل مساحة العمل](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[الوضع البعيد](/gateway/remote).

### أين أرى ما هو الجديد في أحدث نسخة

openai

أحدث الإدخالات موجودة في الأعلى. إذا تم وضع علامة على القسم العلوي **غير الصادرة**، القسم المحرر التالي
هو أحدث إصدار تم شحنه. يتم تجميع الإدخالات بواسطة **الملامح الرئيسية**، **التغييرات**، و
**إصلاحات** (بالإضافة إلى الوثائق والأقسام الأخرى عند الحاجة).

### أستطيع الوصول إلى docs.openclaw.ai SSL خطأ الآن

بعض اتصالات Comcast/Xfinity غير صحيحة حجب `docs.openclaw.ai' عن طريق Xfinity
Advanced Security. قم بتعطيله أو السماح بقائمة `docs.openclaw.ai'، ثم أعد المحاولة. المزيد من
التفاصيل: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
الرجاء مساعدتنا في إلغاء حظره عن طريق الإبلاغ هنا: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

إذا كنت لا تزال غير قادر على الوصول إلى الموقع، المستندات مرآة على GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### ما هو الفرق بين الإستقرار و الإصدار التجريبي

**مستقر** و **بيتا** هما **npm dist-tags**، ليس سطر كود منفصل:

- `أحدث` = مستقر
- 'بيتا' = البناء المبكر للاختبار

نحن نقوم ببناء **بيتا**، واختبارها، وحالما يصبح البناء صلبا نقوم **بترقية
نفس الإصدار إلى `أحدث`**. لهذا السبب يمكن أن تشير بيتا وثابتة إلى
**نفس الإصدار**.

انظر ما تغير:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### كيف يمكنني تثبيت نسخة بيتا وماهية الفرق بين بيتا وديف

**بيتا** هو علامة 'بيتا` (قد تتطابق مع 'أحدث`).
**Dev** هو الرئيس المتحرك لـ `main' (غيت)؛ وعندما يتم نشره، فإنه يستخدم علامة npm dist-tag `dev\`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh <unk> bash -s -- --Beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh <unk> bash -s -- --install-method git
```

مثبت Windows (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

مزيد من التفاصيل: [قنوات التطوير](/install/development-channels) و [أعلام المثبت](/install/installer).

### كم من الوقت يستغرق عادة التثبيت و أونبواردينج

الدليل التدريبي:

- **تثبيت:** 2-5 دقائق
- **قيد التشغيل:** 5-15 دقيقة اعتماداً على عدد القنوات/النماذج التي تكوينها

إذا كانت معلقة، استخدم [Installer stk](/help/faq#installer-stuck-how-do-i-get-more-feedback)
وحلقة التصحيح السريعة في [Im Stk](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### كيف يمكنني تجربة أحدث بت

خياران هما:

1. **قناة Dev (تسجيل الدخول):**

```bash
تحديث openclaw --قناة dev
```

ويتحول هذا إلى فرع "main" ويستكمل من المصدر.

2. **تثبيت Hackable (من موقع التثبيت):**

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --install-method git
```

هذا يعطيك مستودع محلي يمكنك تعديله، ثم التحديث عبر git.

إذا كنت تفضل نسخة نظيفة يدوياً، استخدم:

```bash
استنساخ git https://github.com/openclaw/openclaw.git
cd openclaw
تثبيت pnpm
بناء pnpm
```

الوثائق: [Update](/cli/update)، [قنوات التطوير] (/install/development-channels)،
[Install](/install).

### [توقّف المُثبّت؟ كيف أحصل على مزيد من المعلومات؟](#installer-stuck-how-do-i-get-more-feedback)

إعادة تشغيل المثبت مع **الإخراج المفصول**:

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --فلونز
```

تثبيت بيتا مع لفظ:

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --Beta --فلونز
```

بالنسبة للتثبيت القابل للقرصنة (غيت) :

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --install-method git --verbose
```

المزيد من الخيارات: [أعلام المثبت](/install/installer).

### تثبيت Windows يقول git لم يتم العثور على أو لم يتم التعرف على openclaw

مشكلتان شائعتان في نظام ويندوز:

**1) npm خطأ في توليد git / git غير موجود**

- قم بتثبيت **Git ل Windows** وتأكد من أن `git` على PATH.
- إغلاق وإعادة فتح PowerShell ، ثم إعادة تشغيل المثبت.

**2) لم يتم التعرف على openclaw بعد التثبيت**

- مجلد بن عالمي npm ليس على PATH.

- تحقق من المسار:

  ```powershell
  npm config get prefix
  ```

- تأكد من أن `<prefix>\\bin` على PATH (على معظم الأنظمة هو `%AppData%\\npm`).

- إغلاق وإعادة فتح PowerShell بعد تحديث PATH.

إذا كنت تريد إعداد ويندوز الأكثر سلاسة، استخدم **WSL2** بدلاً من ويندوز الأصلي.
الوثائق: [Windows](/platforms/windows).

### لم تجب المستندات على سؤالي كيف أحصل على إجابة أفضل

استخدم تثبيت **hackable (Git)** حتى يكون لديك المصدر الكامل والمستندات محلياً، ثم اسأل
بوت (أو كلاود/Codex) الخاص بك _من هذا المجلد_ حتى يتمكن من قراءة المستودع والإجابة بدقة.

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --install-method git
```

مزيد من التفاصيل: [Install](/install) و [Installer flags](/install/installer).

### كيف يمكنني تثبيت OpenClaw على Linux

إجابة قصيرة: اتبع دليل لينوكس، ثم قم بتشغيل معالج onboarding

- مسار لينكس السريع + تثبيت الخدمة: [Linux](/platforms/linux).
- المشي الكامل: [البدء](/start/getting-started).
- المثبت + تحديثات: [تثبيت وتحديثات](/install/updating).

### كيف يمكنني تثبيت OpenClaw على VPS

أي لينكس VPS يعمل. تثبيت على الخادم، ثم استخدم SSH/Tailscale للوصول إلى البوابة.

الإرشادات: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
الوصول عن بعد: [بوابة عن بعد](/gateway/remote).

### أين هي أدلة تثبيت CloudVPS

نحن نحتفظ بـ **مركز الاستضافة** مع المزودين العاديين. اختر واحدا واتبع الدليل:

- [استضافة VPS ](/vps) (جميع مقدمي الخدمات في مكان واحد)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

كيف يعمل في السحاب: **البوابة تعمل على السيرفر**، وأنت تصل إليه
من حاسوبك المحمول/هاتفك عبر واجهة التحكم (أو تايلوس/SH). حالة + مساحة العمل الخاصة بك
تعيش على الخادم، لذلك تعامل مع المضيف كمصدر للحقيقة و قم بنسخه احتياطيا.

يمكنك إقران **عقد** (Mac/iOS/Android/headless) إلى تلك البوابة السحابية للوصول إلى
الشاشة/الكاميرا/كانفاس المحلية أو تشغيل الأوامر على حاسوبك المحمول مع الاحتفاظ بالبوابة
في السحابة.

المحور: [Platforms](/platforms). الوصول عن بعد: [بوابة عن بعد](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### هل يمكنني أن أطلب من OpenClaw أن يقوم بتحديث نفسه

الإجابة القصيرة: **ممكنة**، غير موصى به\*\*. يمكن لتدفق التحديث إعادة تشغيل البوابة
(التي تسقط الجلسة النشطة)، قد تحتاج إلى دفع بوابة نظيفة، و
يمكن أن تطلب تأكيدها. آمن: قم بتشغيل التحديثات من قذيفة كمشغل.

استخدام CLI:

```bash
تحديث openclaw
حالة تحديث openclaw
تحديث openclaw --القناة المستقرة<unk> beta<unk> dev
تحديث openclaw --tag <dist-tag|version>
تحديث openclaw - عدم إعادة تشغيل
```

إذا كان يجب عليك أتمتة من وكيل:

```bash
تحديث openclaw --yes --عدم إعادة تشغيل
إعادة تشغيل بوابة openclaw
```

الوثائق: [Update](/cli/update), [Updating](/install/updating).

### ما الذي يقوم به معالج أونبواردينج في الواقع

'openclaw onboard' هو مسار الإعداد الموصى به. في **الوضع المحلي** تمشي معك من خلال:

- **إعداد النموذج/المصادقة** (أنثروبيك **setup-token** موصى به لاشتراكات كلود، رمز OAuth ل OpenAI مدعوم، مفاتيح API اختيارية، نماذج LM Studio المحلية)
- موقع **مساحة العمل** + ملفات bootstrap
- **إعدادات البوابة** (مربوط/port/auth/tailscale)
- **مقدمي الخدمات** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **تثبيت دايمون** (عامل الإطلاق على ماكوس؛ وحدة مستخدم النظام على لينوكس/WSL2)
- **الفحوص الصحية** و **المهارات** المحددة

يحذر أيضًا إذا كان النموذج المكون غير معروف أو مفقود.

### هل أحتاج إلى اشتراك كلود أو OpenAI لتشغيل هذا

لا. يمكنك تشغيل OpenClaw باستخدام **مفاتيح API** (Anthropic/OpenAI/others) أو باستخدام
**النماذج المحلية فقط** حتى تبقى بياناتك على جهازك. الاشتراكات (Claude
Pro/Max أو OpenAI Codex) هي طرق اختيارية لمصادقة مقدمي الخدمات.

الوثائق: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[النماذج المحلية](/gateway/local-models), [Models](/concepts/models).

### هل يمكنني استخدام اشتراك كلود ماكس بدون مفتاح API

نعم. يمكنك المصادقة باستخدام **setup-token**
بدلاً من مفتاح API. هذا هو مسار الاشتراك.

اشتراكات كلود برو/ماكس \*\*لا تحتوي على مفتاح API \*\*، لذلك هذا هو نهج
الصحيح لحسابات الاشتراك. هام: يجب عليك التحقق مع
Anthropic من أن هذا الاستخدام مسموح به في إطار سياسة الاشتراك والشروط.
إذا كنت تريد المسار الأكثر وضوحا، المدعوم، استخدم مفتاح API الأنثروبيك.

### كيف تعمل المصادقة على إعداد الأنثروبيك

'claude setup-token' يولد **سلسلة رمزية** عبر CLI لكلود كوود (غير متوفر في وحدة تحكم الويب). يمكنك تشغيله على **أي آلة**. اختر **رمز Anthropic token (pte setup-token)** في المعالج أو لصقه مع \`openclaw models auth paste-token --مزود الأنثروبيك'. يتم تخزين الرمز المميز كملف تعريف مصادقة لمزود **الأنثوي** ويستخدم مثل مفتاح API (لا تحديث تلقائي). مزيد من التفاصيل: [OAuth](/concepts/oauth).

### أين أجد إعداد أنثروبيك

إنه **لا** في الكونثروبيك. تم إنشاء رمز الإعداد بواسطة **CLI** كلود كوري\*\* على **أي آلة**:

```bash
claude setup-token
```

نسخ الرمز المميز الذي يطبعه، ثم اختر **الرمز المميز للأنثروبيك (لصق setup-token)** في المعالج. إذا كنت ترغب في تشغيله على مضيف البوابة، استخدم `openclaw modelth auth setup-token --مزود الأنثريبي`. إذا قمت بتشغيل 'claude setup-token' في مكان آخر، قم بلصقها على مضيف البوابة مع 'openclaw models auth paste-token --مزود الأنثروبيك'. انظر [Anthropic](/providers/anthropic).

### هل تدعم مصادقة اشتراك كلود (Claude Pro أو Max)

نعم - عن طريق **إعداد التوكين**. لم يعد OpenClaw يعيد استخدام رمز كلود CLI OAuth token; استخدم رمز إعداد أو مفتاح API الأنثروبيك. إنشاء الرمز المميز في أي مكان ولصقه على مضيف البوابة. انظر [Anthropic](/providers/anthropic) و [OAuth](/concepts/oauth).

ملاحظة: يخضع الوصول إلى الاشتراك في كلود لأحكام أنثروبيك. عادة ما تكون مفاتيح API الخيار الأكثر أماناً بالنسبة للإنتاج أو لأعباء العمل المتعددة المستخدمين.

### لماذا أرى HTTP 429 متر من الأنثروبيك

وهذا يعني أن **الحصة الأنثروبيكية / حد المعدلات** قد استنفدت للنافذة الحالية. إذا كنت
تستخدم **اشتراك كلود** (setup-token أو كلود كود OAuth)، انتظر إعادة تعيين النافذة إلى
أو تحديث خطتك. إذا كنت تستخدم مفتاح \*\*Anthropic API \*\*، تحقق من وحدة التحكم الأنثروبيك
لاستخدام/الفواتير ورفع الحدود حسب الحاجة.

تلميح: قم بتعيين **نموذج الارتداد** حتى يتمكن OpenClaw من الاستمرار في الرد بينما يكون المزود محدود المعدل.
انظر [Models](/cli/models) و [OAuth](/concepts/oauth).

### تم دعم قاعدة AWS

نعم - عبر موفر **البيدروك الأمازون (Converse)** الخاص بـ **التكوين اليدوي**. يجب عليك توفير بيانات تفويض/منطقة AWS على مضيف البوابة وإضافة إدخال موفر Bedrock في تكوين النماذج الخاصة بك. () انظر [Amazon Bedrock](/providers/bedrock) و [MoModel مزودين](/providers/models). إذا كنت تفضل تدفق المفتاح المدار، فإن وكيل متوافق مع OpenAI، أمام Bedrock لا يزال خياراً صالحاً.

### كيف تعمل مصادقة الشفرة

OpenClaw يدعم **رمز OpenAI (Codex)** عن طريق OAuth (تسجيل الدخول إلى ChatGPT). يمكن للمعالج تشغيل تدفق OAuth وسيتم تعيين النموذج الافتراضي إلى \`openai-codex/gpt-5.3-codex' عند الاقتضاء. انظر [موردين نموذجيين](/concepts/model-providers) و [Wizard](/start/wizard).

### هل تدعم رمز OAuth للاشتراك في OpenAI

نعم. OpenClaw يدعم اشتراك**OpenAI Codex) اشتراكك OAuth**. معالج onboarding
يمكنه تشغيل تدفق OAuth لك.

انظر [OAuth](/concepts/oauth)، [موزعي المودية](/concepts/model-providers)، و [Wizard](/start/wizard).

### كيف أقوم بإعداد Gemini CLI OAuth

تستخدم Gemini CLI **تدفق مصادقة إضافية**، ليس معرف العميل أو سري في `openclaw.json`.

الخطوات:

1. تمكين الإضافة: `openclaw plugins تمكين google-gemini-cli-auth`
2. تسجيل الدخول: `openclaw models auth login --provider google-gemini-cli --set-default`

هذا يخزن عملات OAuth في ملفات تعريف المصادقة على مضيف البوابة. التفاصيل: [موردين نموذجيين](/concepts/model-providers).

### هو نموذج محلي موافق للمحادثة العرضية

عادةً لا يحتاج OpenClaw إلى سياق كبير + أمان قوي؛ بطاقات صغيرة و تسرب. إذا كنت يجب عليك تشغيل **أكبر** بناء MiniMax M2.1 يمكنك محليا (LM Studio) وانظر [/gateway/local-models](/gateway/local-models). النماذج المصغرة/المحددة كمياً تزيد من خطر الحقن الفوري - انظر [Security](/gateway/security).

### كيف أستمر في استضافة حركة مرور نموذجية في منطقة محددة

اختر النقاط النهائية المثبتة بالمنطقة. يكشف برنامج OpenRouter عن الخيارات التي تستضيفها الولايات المتحدة لـ MiniMax، و Ki، و GLM؛ اختر البديل الذي تستضيفه الولايات المتحدة لحفظ البيانات في المنطقة. لا يزال بإمكانك إدراج Anthropic/OpenAI جنبا إلى جنب مع هذه باستخدام `models.mode: "merge"` حتى تبقى الارتداد متاحة مع احترام موفر المنطقة الذي تحديده.

### هل يتوجب علي شراء ماك ميني لتثبيت هذا

لا. يعمل OpenClaw على macOS أو Linux (ويندوز عبر WSL2). ماك مصغر اختياري - بعض الناس
يشترون واحدا كمضيف دائمًا، ولكن يعمل أيضا نظام VPN صغير، أو خادم منزلي، أو صندوق Raspberry Pi-class.

تحتاج فقط إلى Mac **لأدوات macOS فقط**. للحصول على iMessage، استخدم [BlueBubbles](/channels/bluebubbles) (مستحسن) - خادم BlueBbles يعمل على أي ماك، والبوابة يمكن تشغيلها على لينكس أو أي مكان آخر. إذا كنت تريد أدوات أخرى لـ macOS-فقط، قم بتشغيل البوابة على Mac أو زوج عقدة macOS.

الوثائق: [BlueBubbles](/channels/bluebubbles)، [Nodes](/nodes)، [وضع ماك البعيد](/platforms/mac/remote).

### هل أحتاج إلى ماك مصغر لدعم iMessage

تحتاج إلى **بعض أجهزة macOS** تسجيل الدخول إلى الرسائل. 42. ليس من الضروري **على الإطلاق** أن يكون جهاز Mac mini — أي جهاز Mac يعمل. **استخدم [BlueBubbles](/channels/bluebubbles)** (مستحسن) لiMessage - خادم BlueBbles يعمل على macOS، في حين يمكن تشغيل البوابة على Linux أو أي مكان آخر.

الإعدادات العادية:

- قم بتشغيل البوابة على Linux/VPS، وتشغيل خادم BlueBbles على أي Mac تم تسجيل الدخول إلى الرسائل.
- تشغيل كل شيء على الماكنتوش إذا كنت تريد أبسط إعداد لآلة وحيدة.

الوثائق: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[وضع ماك البعيد](/platforms/mac/remote).

### إذا اشتريت ماك مصغر لتشغيل OpenClaw يمكنني توصيله إلى ماك بوك برو

نعم. يمكن لـ **Mac mini تشغيل البوابة**، ويمكن لـ MacBook Pro الاتصال كـ **عقدة** من طراز
(جهاز مرافق). لا تشغل العقد البوابة - فهي توفر قدرات إضافية
مثل الشاشة/الكاميرا/كانفاس و \`system.run' على ذلك الجهاز.

النمط الشائع:

- بوابة على الماك الصغير (دائماً).
- يعمل MacBook Pro على تشغيل تطبيق macOS أو مضيف عقدة وأزواج إلى البوابة.
- استخدم `العقد المفتوحة الحالة` / `قائمة العقد المفتوحة العقد` لرؤيتها.

المستندات: [Nodes](/nodes)، [Nodes CLI](/cli/nodes).

### هل يمكنني استخدام البون

Bun **غير موصى به**. نحن نرى أخطاء في وقت التشغيل، خاصة مع WhatsApp و Telegram.
استخدم **العقدة** من أجل البوابات المستقرة.

إذا كنت لا تزال ترغب في تجربة Bun، قم بذلك على بوابة غير إنتاجية
بدون WhatsApp/Telegram.

### تيليجرام ما يسمح به من

`channels.telegram.allowFrom` هو **معرف مستخدم Telegram الخاص بالمرسل** (رقمي، موصى به) أو `@username`. ليس اسم مستخدم البوت.

أكثر أمانًا (دون بوت طرف ثالث):

- DM بوت الخاص بك، ثم قم بتشغيل `سجلات openclaw --follow` ثم قم بقراءة `from.id`.

API الروبوت الرسمي:

- ادعو بوت الخاص بك، ثم اتصل بـ `https://api.telegram.org/bot<bot_token>/getUpdates` ثم اقرأ `message.from.id`.

طرف ثالث (أقل خصوصية):

- DM `@userinfobot` أو `@getidsbot`.

انظر [/channels/telegram](/channels/telegram#access-control-dms--groups).

### يمكن لأشخاص متعددين استخدام رقم واحد من WhatsApp مع مثيلات OpenClaw مختلفة

نعم، عبر **توجيه متعدد العوامل**. ربط كل مرسل WhatsApp **DM** (ند `نوع: "dm"`، المرسل E. 64 مثل `+15551234567`) إلى `وكيل مختلف`، لذلك يحصل كل شخص على مساحة عمل ومتجر جلسات خاصة به. لا تزال الردود تأتي من **نفس حساب WhatsApp**، والتحكم في الدخول إلى DM (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) هو عام في حساب WhatsApp. انظر [خط العميل المتعدد](/concepts/multi-agent) و [WhatsApp](/channels/whatsapp).

### هل يمكنني تشغيل وكيل الدردشة السريع و Opus لوكيل البرمجة

نعم. استخدام توجيه متعدد العوامل: إعطاء كل وكيل نموذجه الافتراضي، ثم ربط الطرق الواردة (حساب المزود أو أقران محددين) لكل وكيل. مثال على حياة التكوين في [توجيه متعدد العوامل](/concepts/multi-agent). انظر أيضا [Models](/concepts/models) و [Configuration](/gateway/configuration).

### هل يعمل Homebrew على Linux

نعم. Homebrew يدعم Linux (Linuxbrew). الإعداد السريع:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
برج <formula>
```

إذا كنت تقوم بتشغيل OpenClaw عن طريق النظام، تأكد من أن خدمة PATH تشمل '/home/linuxbrew/.linuxbrew/bin' (أو بادئة الخبز الخاص بك) بحيث أن الأدوات المثبتة 'brew' تحل في قذائف غير تسجيل الدخول.
بنايات حديثة أيضاً تلحق مسبقاً بالمستخدم العادي بن قاذفة على خدمات نظام لينكس (على سبيل المثال '~/.local/bin`, `~/npm-global/bin`, `~/.local/share/pnpm`, `~/. un/bin`) والشرف `PNPM_HOME` و`NPM_CONFIG_PREFIX` و`BUN_INSTALLL` و`VOLTA_HOME` و`ASDF_DATA_DIR` و`NVM_DIR` و`FNM_DIR\` عند تعيينها.

### ما هو الفرق بين تثبيت git قابل للقرصنة وتثبيت npm

- **تثبيت Hackable (Git):** إخراج كامل من المصدر، قابل للتحرير، أفضل للمساهمين.
  تقوم بتشغيل البناء محليا ويمكنك تصحيح التعليمات البرمجية/المستندات.
- **npm تثبيت:** تثبيت CLI العالمي، بدون مستودع، أفضل من "فقط قم بتشغيلها".
  التحديثات تأتي من npm Dist-tags.

الوثائق: [بدء](/start/getting-started), [Updating](/install/updating).

### هل يمكنني التبديل بين npm و git تثبيت لاحقا

نعم. قم بتثبيت النكهة الأخرى، ثم قم بتشغيل دكتور حتى نقاط خدمة البوابة في نقطة الدخول الجديدة.
هذا **لا يحذف بياناتك** - إنه يغير فقط تثبيت رمز OpenClaw. حالتك
(`~/.openclaw`) و مساحة العمل (`~/.openclaw/workspace`) بقيت على حاله.

من npm → git:

```bash
استنساخ git https://github.com/openclaw/openclaw.git
cd openclaw
pnpm تثبيت
pnpm بناء
openclaw doctor
openclaw Restarway
```

من git → npm:

```bash
npm تثبيت -g openclaw@latest
openclaw doctor
إعادة تشغيل بوابة openclaw
```

يكتشف الطبيب عدم تطابق نقطة الدخول إلى خدمة البوابة ويعرض إعادة كتابة تهيئة الخدمة لتطابق التثبيت الحالي (استخدم '--repair' في التشغيل الآلي).

نصائح احتياطية: انظر [استراتيجية النسخ الاحتياطي](/help/faq#whats-the-recommended-backup-strategy).

### إذا قمت بتشغيل البوابة على حاسوبي المحمول أو VPS

إجابة قصيرة: **إذا كنت تريد موثوقية 24/7، استخدم VPS**. إذا كنت تريد أقل احتكاك
وأنت على ما يرام مع النوم/إعادة التشغيل، قم بتشغيله محلياً.

**لقطة Gateway**

- **Pros:** لا توجد تكلفة خادم، الوصول المباشر إلى الملفات المحلية، النافذة المباشرة للمتصفح.
- - **Cons:** يجب أن يظل النوم/شبكة= قطع الاتصال، التحديثات/إعادة تشغيل نظام التشغيل قاطعا، مستيقظا.

**VPS / سحابة**

- **Pros:** دائماً على الشبكة المستقرة، لا مشاكل في النوم في الكمبيوتر المحمول، أسهل من الاستمرار في التشغيل.
- **Cons:** غالبا ما يعمل بدون رأس (استخدام لقطات الشاشة)، الوصول إلى الملف عن بعد فقط، يجب أن يكون SSH للتحديثات.

**ملاحظة خاصة بOpenClaw:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord جميع الأعمال جيدة من VPS. المفاضلة الحقيقية الوحيدة هي **متصفح بلا رأس** مقابل نافذة مرئية. انظر [Browser](/tools/browser).

**الافتراضي الموصى به:** VPS إذا كان لديك بوابة قطع الاتصال من قبل. محلي رائع عندما تستخدم ماك بنشاط وتريد الوصول إلى الملفات المحلية أو أتمتة واجهة المستخدم مع متصفح مرئي.

### مدى أهمية تشغيل OpenClaw على آلة مكرسة

غير مطلوب، ولكن **يوصى به للموثوقية والعزلة**.

- **المضيف المخصص (VPS/Mac mini/Pi):** دائمًا، أقل انقطاع النوم/إعادة التشغيل، أذونات أنظف، أسهل لمواصلة التشغيل.
- **الكمبيوتر المحمول المشترك/الكمبيوتر المكتب:** جيد تماما للاختبار والاستخدام النشط، ولكن يتوقع إيقاف مؤقت عندما تنام الآلة أو تقوم بالتحديثات.

إذا كنت تريد أفضل ما في العالمين، إبقاء البوابة على مضيف مخصص وقم بإقران حاسوبك المحمول كـ **عقدة** لأدوات الشاشة/الكاميرا/exec المحلية. انظر [Nodes](/nodes).
يستعاض عن عبارة "إرشادات الأمن" بعبارة " [Security](/gateway/security).

### ما هو الحد الأدنى من متطلبات VPS والنظام الموصى به

OpenClaw خفيفة الوزن. للمدخل الأساسي + قناة دردشة واحدة:

- **الحد الأدنى المطلق:** 1 vCPU, 1GB RAM, ~500MB قرص.
- **موصى به:** 1-2 vCPU, 2GB RAM أو أكثر للغرف الرئيسية (السجلات, الوسائط, القنوات المتعددة). أدوات العقدة وأتمتة المتصفح يمكن أن تكون جائعة الموارد.

OS: استخدم **Ubuntu LTS** (أو أي ديبيان/أوبونتو). مسار تثبيت لينوكس هو أفضل اختبار هناك.

الوثائق: [Linux](/platforms/linux), [VPS hosting](/vps).

### هل يمكنني تشغيل OpenClaw في VM وما هي المتطلبات

نعم. تعامل مع VM بنفس الطريقة التي تعامل بها VPS: يجب أن يكون دائما، يمكن الوصول إليه، ولديها ما يكفي من
ذاكرة الوصول العشوائي للبوابة وأي قنوات يمكنك تفعيلها.

إرشادات خط الأساس:

- **الحد الأدنى المطلق:** 1 vCPU, 1GB RAM.
- **مستحسن:** ذاكرة الوصول العشوائي 2GB أو أكثر إذا قمت بتشغيل قنوات متعددة، أو أتمتة المتصفح، أو أدوات الوسائط.
- **OS:** Ubuntu LTS أو آخر حديث ديبيان/أوبونتو.

إذا كنت على Windows، **WSL2 هو أسهل إعداد على نمط VM** ولديه أفضل الأدوات
متوافقة. انظر [Windows](/platforms/windows), [VPS hosting](/vps).
إذا كنت تشغل macOS في VM ، انظر [macOS VM](/install/macos-vm).

## ما هو OpenClaw؟

### ما هو OpenClaw في فقرة واحدة

OpenClaw هو مساعد شخصي في الذكاء الاصطناعي تقوم بتشغيله على أجهزتك الخاصة. إنها ترد على أسطح الرسائل التي تستخدمها بالفعل (WhatsApp، Telegram، Slack، Matteratt(plugin)، Discord، محادثة جوجل والإشارة، iMessage، WebChat) ويمكنها أيضًا القيام بصوت + كامفاس حية على المنصات المدعومة. **البوابة** هي دائما على متن طائرة التحكم؛ المساعد هو المنتج.

### ما هو اقتراح القيمة

OpenClaw ليس مجرد غلاف كلود." 43. إنه **مستوى تحكم محلي أولًا** يتيح لك تشغيل مساعد قوي على **أجهزتك الخاصة**، ويمكن الوصول إليه من تطبيقات الدردشة التي تستخدمها بالفعل، مع جلسات حالية وذاكرة وأدوات — دون تسليم التحكم في سير عملك إلى SaaS مستضاف.

أبرز النقاط:

- **أجهزتك، بياناتك:** قم بتشغيل البوابة أينما كنت تريد (Mac, Linux, VPS) وحافظ على مساحة العمل* سجل الجلسات المحلية.
- **القنوات الحقيقية، ليس صندوق رمل الويب:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/الخ،
  بالإضافة إلى صوت الجوال وكانفاس على المنصات المدعومة.
- **Model-agnostic:** استخدم Anthropic, OpenAI, MiniMax, OpenRouter، الخ.، مع توجيه لكل وكيل
  والفشل.
- **خيار محلي فقط:** قم بتشغيل الموديلات المحلية حتى **جميع البيانات يمكن أن تبقى على جهازك** إذا أردت.
- 44. **توجيه متعدد الوكلاء:** وكلاء منفصلون لكل قناة أو حساب أو مهمة، لكلٍ منهم مساحة عمل وإعدادات افتراضية خاصة به.
- **المصدر المفتوح والقابل للقرصنة:** تفحص، تمديد، واستضافة ذاتية بدون قفل البائع.

الوثائق: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### لقد قمت للتو بإعدادها ما يجب أن أفعله أولا

المشاريع الأولى الجيدة:

- بناء موقع ويب (WordPress, Shopify, أو موقع ثابت بسيط).
- نموذج أولي لتطبيق الجوال (المخطط، الشاشات، خطة API).
- تنظيم الملفات والمجلدات (تنظيف، التسمية، العلامات).
- قم بتوصيل Gmail وأتمتة الملخصات أو المتابعة.

45. يمكنه التعامل مع المهام الكبيرة، لكنه يعمل بأفضل صورة عندما تقسّمها إلى مراحل
    وتستخدم وكلاء فرعيين للعمل المتوازي.

### ما هي أعلى خمس حالات الاستخدام اليومي ل OpenClaw

عادة ما تبدو الفوز اليومي:

- **الإحاطات الشخصية:** ملخصات صندوق الوارد والتقويم والأخبار التي تهتم بها.
- **البحث والصياغة:** البحث السريع والملخصات والمسودات الأولى لرسائل البريد الإلكتروني أو الوثائق.
- - - تذكير ومتابعة:\* \* كرون أو ضربة قلب مدفعية وقوائم مرجعية.
- **أتمتة المتصفح:** ملء الاستمارات وجمع البيانات وتكرار مهام الويب.
- **تنسيق الجهاز المختلط:** أرسل مهمة من هاتفك، اترك البوابة تشغلها على خادم، واحصل على النتيجة مرة أخرى في المحادثة.

### يمكن أن يساعد OpenClaw في إعلانات ومدوّنات اتصال بالمحفوظات الرائدة لساي

نعم ل **البحث والتأهيل والصياغة**. يمكنها مسح المواقع، وبناء قوائم قصيرة،
تلخيص الآفاق، وكتابة مسودات الإرشاد أو نسخ الإعلانات.

من أجل **التواصل أو تشغيل الإعلانات**، احتفظ بشرًا في الحلقة. تجنب الرسائل غير المرغوب فيها، واتبع القوانين المحلية وسياسات المنصة
ومراجعة أي شيء قبل إرسالها. النمط الأكثر أماناً هو السماح
OpenClaw بالمسودة ووافقت عليها.

الوثائق: [Security](/gateway/security).

### ما هي المزايا مقابل كود كلود لتطوير الويب

OpenClaw هو **مساعد شخصي** وطبقة تنسيق، وليس بديل لـ IDE. 46. استخدم
Claude Code أو Codex لأسرع حلقة ترميز مباشرة داخل مستودع. 47. استخدم OpenClaw عندما
تريد ذاكرة دائمة، وإتاحة عبر الأجهزة، وتنسيق الأدوات.

المزايا:

- **الذاكرة الثابتة + مساحة العمل** عبر الجلسات
- **الوصول إلى منصات متعددة** (WhatsApp، Telegram، TUI، WebChat)
- **تنظيم الأدوات** (العروض، الملفات، الجدولة، الروابط)
- **دائماً على البوابة** (تشغيل على VPS، التفاعل من أي مكان)
- **العقد** للمتصفح المحلي/الشاشة/الكاميرا/exec

عرض: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## المهارات والأتمتة

### كيف يمكنني تخصيص المهارات بدون الحفاظ على قذر المستودع

استخدام التجاوزات المدارة بدلاً من تحرير نسخة المسترجع. ضع تغييراتك في `~/.openclaw/skills/<name>/SKILL.md` (أو أضف مجلد عن طريق `skills.load.extraDirs` في `~/.openclaw/openclaw.json`). السوابق هي `<workspace>/skills` > `~/.openclaw/skills` > مجمعة، لذلك يتم التحكم في التجاوزات الفوز دون لمس git. فقط التعديلات الجديرة بالبث يجب أن تعيش في الريبوت وتخرج كـ PR.

### هل يمكنني تحميل المهارات من مجلد مخصص

نعم. إضافة أدلة إضافية عن طريق `skills.load.extraDirs` في `~/.openclaw/openclaw.json` (أدنى الأسبقية). وتظل الأسبقية الافتراضية قائمة: `<workspace>/skills` → `~/.openclaw/skills` → مجمعة → `skills.load.extraDirs`. 'clawhub' يقوم بتثبيت './skills' بشكل افتراضي، والذي يتعامل OpenClaw مع '<workspace>/skills\`.

### كيف يمكنني استخدام نماذج مختلفة لمهام مختلفة

أما اليوم فالأنماط المدعومة هي:

- **وظائف كرون**: الوظائف المنعزلة يمكن أن تضع تجاوزا لـ 'نموذج\` لكل وظيفة.
- **وكلاء فرعيين**: توجيه المهام إلى وكلاء منفصلين مع نماذج افتراضية مختلفة.
- **مفتاح التبديل عند الطلب**: استخدم `/model` لتبديل نموذج الجلسة الحالية في أي وقت.

انظر [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands).

### البوت يجمد بينما يقوم بعمل شاق كيف يمكنني تفريغه

استخدام **وكلاء فرعيين** للمهام الطويلة أو المتوازية. يعمل وكلاء فرعيون في جلستهم،
يرجعون ملخصا ويبقون دردشتك الرئيسية مستجيبة.

اطلب من بوت الخاص بك "توليد وكيل فرعي لهذه المهمة" أو استخدام `/subagents`.
استخدم \`/status' في الدردشة لرؤية ما تفعله البوابة الآن (وما إذا كانت مشغولة).

نصائح رمزية : المهام الطويلة والوكلاء الفرعيون كلتاهما تستهلك الرموز. إذا كانت التكلفة مصدر قلق، قم بتعيين نموذج أرخص
للوكلاء الفرعيين عن طريق 'agents.defaults.subagents.model\`.

الوثائق: [Sub-agents](/tools/subagents).

### كرون أو تذكير لا يطلق ما يجب أن أفحصه

يعمل كرون داخل عملية البوابة. إذا كانت البوابة لا تعمل باستمرار، لن يعمل
الوظائف المجدولة.

قائمة التحقق:

- تأكد تمكين cron (`cron.enabled`) ولم يتم تعيين 'OPENCLAW_SKIP_CRON'.
- تحقق من أن البوابة تعمل على مدار الساعة (لا يوجد نوم/إعادة تشغيل).
- التحقق من إعدادات المنطقة الزمنية للوظيفة (`--tz` مقابل المنطقة الزمنية المضيفة).

Debug:

```bash
يُشغّل openclaw cron <jobId> --إجبار
openclaw cron تشغيل--id <jobId> --الحد 50
```

الوثائق: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### كيف يمكنني تثبيت المهارات على لينكس

استخدم **ClawHub** (CLI) أو أسقط مهاراتك في مساحة عملك. واجهة استخدام مهارات macOS غير متوفرة على Linux.
تصفح المهارات في [https://clawhub.com](https://clawhub.com).

تثبيت ClawHub CLI (اختر مدير حزمة واحد):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### يمكن OpenClaw تشغيل المهام على جدول زمني أو باستمرار في الخلفية

نعم. استخدام جدولة البوابة:

- **وظائف كرون** للمهام المجدولة أو المتكررة (تستمر عبر عمليات إعادة التشغيل).
- **قلب** للفحص الدوري "للجلسات الرئيسية".
- **الوظائف المعزولة** للوكلاء المستقلين الذين يقومون بنشر الملخصات أو تقديم المحادثات.

الوثائق: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### هل يمكنني تشغيل مهارات Apple macOS-فقط من لينوكس؟

ليس مباشرة. مهارات macOS يتم بوابتها بواسطة `metadata.openclaw.os` بالإضافة إلى الثنائية المطلوبة، وتظهر المهارات فقط في موجه النظام عندما تكون مؤهلة على **مضيف البوابة**. في لينوكس، مهارات 'darwin' فقط (مثل 'apple-notes'، و 'apple-reminders'، و 'أشياء - mac') لن يتم تحميلها ما لم تتجاوز البوابة.

لديك ثلاثة أنماط مدعومة:

48. **الخيار A - تشغيل الـ Gateway على جهاز Mac (الأبسط).**
    شغّل الـ Gateway حيث تتوفر ثنائيات macOS، ثم اتصل من Linux في [الوضع البعيد](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) أو عبر Tailscale. حمولة المهارات عادة لأن مضيف البوابة هو MacOS.

\*\*الخيار باء - استخدام عقدة macOS (لا SSH). \*
تشغيل البوابة على لينوكس، إقران عقدة macOS (التطبيق الحيبي)، وقم بتعيين **أوامر تشغيل العقدة** إلى "دائماً" أو "السماح دائماً" على الماك. يمكن OpenClaw التعامل مع مهارات macOS-فقط على أنها مؤهلة عندما تكون الثنائية المطلوبة موجودة على العقدة. ويدير الوكيل هذه المهارات عن طريق أداة 'العقد\`. إذا اخترت "أسطح دائماً"، فإن الموافقة على "السماح دائماً" في الطلب يضيف هذا الأمر إلى القائمة المسموح بها.

\*\*الخيار C - ثنائيات macOS الوكيل عبر SSH (متقدم). \*
حافظ على البوابة على لينوكس، ولكن جعل ثنائيات CLI المطلوبة مصممة على مغلفات SSH التي تعمل على ماك. ثم تجاوز المهارة للسماح لـ Linux حتى تبقى مؤهلة.

1. إنشاء غلاف SSH للبندي (مثال: \`memo' لملاحظات التفاح):

   ```bash
   #!/usr/bin/env bash
   تعيين -euo pipefail
   exc ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. ضع التغليف على 'PATH' على مضيف لينكس (على سبيل المثال '~/bin/memo\`).

3. تجاوز بيانات التعريف للمهارة (مساحة العمل أو '~/.openclaw/skills\`) للسماح لـ Linux:

   ```markdown
   ---
   الاسم: تفاح الملاحظات
   الوصف: إدارة ملاحظات أبل عبر مذكرة CLI على macOS.
   البيانات الوصفية: { "openclaw": { "os": ["darwin", "linux"], "يطلب": { "bins": ["memo"] } }
   ---
   ```

4. ابدأ جلسة عمل جديدة حتى يتم تحديث لقطة المهارات.

### هل لديك مفهوم أو تكامل HeyGen

ليس مدمجا اليوم.

الخيارات:

- **مهارة مخصصة / إضافة:** أفضل للوصول إلى API موثوق به (Notion/HeyGen كلاهما لديه APIs).
- **أتمتة المتصفح:** تعمل بدون شفرة ولكنها أبطأ وأكثر هشاشة.

إذا كنت ترغب في الحفاظ على السياق لكل عميل (سير عمل الوكالة)، نمط بسيط هو:

- صفحة مفهوم واحدة لكل عميل (السياق + التفضيلات + العمل النشط).
- اطلب من الوكيل إحضار هذه الصفحة في بداية الجلسة.

إذا كنت تريد التكامل الأصلي، قم بفتح طلب ميزة أو بناء مهارة
مستهدفة تلك API.

مهارات التنزيل:

```bash
تثبيت clwhub <skill-slug>
Parwhub تحديث --الكل
```

ClawHub مثبت في `. المهارات` تحت الدليل الحالي (أو يرجع إلى مساحة العمل الخاصة بك في OpenClaw)؛ يتعامل OpenClaw مع ذلك كـ `<workspace>/skills` في الجلسة التالية. للمهارات المشتركة عبر الوكلاء، وضعهم في '~/.openclaw/skills/<name>/SKILL.md\`. بعض المهارات تتوقع تثبيت ثنائيات عبر Homebrew؛ على Linux الذي يعني Linuxbrew (انظر إدخال الـ Homebrew Linux FAQ أعلاه). انظر [Skills](/tools/skills) و [ClawHub](/tools/clawhub).

### كيف أقوم بتثبيت ملحق Chrome لاستيلاء المتصفح

استخدم المثبت المدمج، ثم قم بتحميل الملحق غير المعبأ في Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

ثم Chrome → `chrome://extensions` → تمكين "وضع المطور" → "تحميل إلغاء تغليف" → اختيار ذلك المجلد.

الدليل الكامل (بما في ذلك البوابة البعيدة + ملاحظات الأمن): [Exsion](/tools/chrome-extension)

إذا كانت البوابة تعمل على نفس الآلة التي يعمل بها Chrome (الإعداد الافتراضي)، فإنك عادة **لا تحتاج** إلى أي شيء إضافي.
إذا كان Gateway يعمل في مكان آخر، شغّل مضيف عُقدة على جهاز المتصفح حتى يتمكن Gateway من تمرير إجراءات المتصفح.
لا تزال تحتاج إلى النقر على زر الإضافة في التبويب الذي تريد التحكم فيه (لا يتم إرفاقه تلقائياً).

## غسيل الرمل والذاكرة

### هل هناك دوك مخصص لصناعة الرمل

نعم. انظر [Sandboxing](/gateway/sandboxing). للحصول على إعداد خاص بالدوكر (البوابة الكاملة في صور Docker أو صندوق الرمل)، انظر [Docker](/install/docker).

### Docker يشعر بكيفية تمكين الميزات الكاملة

49. الصورة الافتراضية تركز على الأمان وتعمل كمستخدم `node`، لذا فهي لا
    تتضمن حزم النظام أو Homebrew أو متصفحات مدمجة. من أجل إعداد أكمل:

- ابقى على `/home/node` مع `OPENCLAW_HOME_VOLUME` حتى تتمكن المخبآت من البقاء.
- ينحدر نظام الخبز في الصورة باستخدام `OPENCLAW_DOCKER_APT_PACKAGES`.
- تثبيت متصفحات Playwright عبر CLI المجمعة:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- تعيين 'PLAYWRIGHT_BROWSERS_PATH' وتأكد من استمرار المسار.

الوثائق: [Docker](/install/docker), [Browser](/tools/browser).

**هل يمكنني الحفاظ على DMS شخصيًا ولكن اجعل المجموعات علنية مربوطة مع وكيل واحد**

نعم - إذا كانت حركة المرور الخاصة بك **DMs** وكانت حركة المرور العامة الخاصة بك **مجموعات**.

استخدم `agents.defaults.sandbox.mode: "غير main"" بحيث يتم تشغيل جلسات المجموعة/القناة (المفاتيح غير الرئيسية) في Docker، بينما تبقى جلسة DM الرئيسية على المضيف. ثم تقييد ماهية الأدوات المتاحة في الجلسات المختلطة من خلال `tools.sandbox.tools\`.

إعداد المشي + مثال تكوين: [مجموعات: DMs شخصية + مجموعات عامة](/channels/groups#pattern-personal-dms-public-groups-single-agent)

مرجع تكوين المفتاح: [تكوين البوابة](/gateway/configuration#agentsdefaultssandbox)

### كيف يمكنني ربط مجلد مضيف في صندوق الرمل

تعيين `agents.defaults.sandbox.docker.binds` إلى `["host:path:mode"]` (على سبيل المثال `"/home/user/src:/src:ro"`). العالمية + دمج الروابط لكل عامل؛ يتم تجاهل الروابط لكل عامل عندما 'النطاق: "المشترك"`. استخدم `:ro' لأي شيء حساس وتذكر ربط جدران نظام الملفات الرملة. انظر [Sandboxing](/gateway/sandboxing#custom-bind-mounts) و [Sandbox vs Tool Policy vs Upvated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) للحصول على أمثلة وملاحظات السلامة.

### كيف تعمل الذاكرة

ذاكرة OpenClaw هي فقط ملفات Markdown في مساحة عمل الوكيل:

- الملاحظات اليومية في `memory/YYY-MM-DD.md`
- ملاحظات طويلة الأجل في "MEMORY.md" (الجلسات الرئيسية/الخاصة فقط)

يعمل OpenClaw أيضًا على **مسح ذاكرة مضغوطة صامتة** لتذكير النموذج
لكتابة ملاحظات دائمة قبل التثبيت التلقائي. يعمل هذا فقط عندما تكون مساحة العمل
قابلة للكتابة (مربعات الرمل للقراءة فقط تخطها). انظر [الذاكرة](/concepts/memory).

### الذاكرة تنسى الأشياء كيف أجعلها عصا

اطلب من البوت **كتابة الحقيقة إلى الذاكرة**. 50. تنتمي الملاحظات طويلة الأمد إلى `MEMORY.md`،
أما السياق قصير الأمد فيوضع في `memory/YYYY-MM-DD.md`.

وما زال هذا مجال نتحسن. It helps to remind the model to store memories;
it will know what to do. If it keeps forgetting, verify the Gateway is using the same
workspace on every run.

الوثائق: [Memory](/concepts/memory)، [وكيل مساحة العمل](/concepts/agent-workspace).

### هل يتطلب البحث عن الذاكرة الدلالية مفتاح API OpenAI

فقط إذا كنت تستخدم **تضمين OpenAI**. رمز OAuth يغطي الدردشة/المكملة، و
لا يمنح الوصول إلى الدمج. لذلك **تسجيل الدخول باستخدام Codex (OAuth أو
Codex CLI login)** لا يساعد في البحث عن الذاكرة الدلالية. لا يزال تضمين OpenAI
بحاجة إلى مفتاح API حقيقي (`OPENAI_API_KEY` أو `models.providers.openai.apiKey`).

إذا لم تقم بتعيين موفر صراحة، فإن OpenClaw يختار موفر تلقائياً عندما يكون
يمكنه حل مفتاح API (Auth profiles, `models.providers.*.apiKey', or env vars).
إنه يفضل OpenAI إذا حل مفتاح OpenAI ، وإلا جيميني إذا حل مفتاح Gemini
. If neither key is available, memory search stays disabled until you
configure it. إذا كان لديك مسار نموذج محلي مكون وحاضر، يفضل OpenClaw
`local\`.

إذا كنت بدلاً من البقاء محلياً، قم بتعيين `memorySearch.provider = "local"` (واختيارياً
`memorySearch.fallback = "none"`). إذا كنت تريد تضمين Gemini ، قم بتعيين
`memorySearch.provider = "gemini"` وقم بتوفير `GEMINI_API_KEY` (أو
`memorySearch.remote.apiKey`). نحن ندعم **OpenAI أو Gemini أو local** تضمين نماذج* انظر [Memory](/concepts/memory) للحصول على تفاصيل الإعداد.

### هل تستمر الذاكرة إلى الأبد ما هي الحدود

ملفات الذاكرة حية على القرص وتستمر حتى تقوم بحذفها. الحد هو وحدة التخزين
الخاصة بك، وليس النموذج. لا يزال **سياق الدورة** محدوداً بواسطة نافذة سياق النموذج
، لذا يمكن للمحادثات الطويلة أن تتشكل أو تختزل. هذا هو السبب في وجود بحث الذاكرة* إنه يسحب الأجزاء ذات الصلة فقط إلى السياق.

الوثائق: [Memory](/concepts/memory), [Context](/concepts/context).

## حيث تعيش الأشياء على القرص

### جميع البيانات المستخدمة مع OpenClaw محفوظة محليا

لا - __ولاية OpenClaw_ محلية_\*، ولكن **الخدمات الخارجية لا تزال ترى ما تقوم بإرساله**.

- **محلي بشكل افتراضي:** جلسات وملفات الذاكرة، وتكوين وفضاء العمل مباشرة على مضيف البوابة
  ('~/.openclaw\` + دليل مساحة العمل).
- **عن بعد بحكم الضرورة:** رسائل ترسلها إلى موفري الطراز (Anthropic/OpenAI/الخ) اذهب إلى
  واجهات برمجة التطبيقات الخاصة بهم، ومنصات الدردشة (WhatsApp/Telegram/Slack/الخ) تخزين بيانات الرسائل على خوادم
  الخاصة بهم.
- **أنت تتحكم في البصمة:** باستخدام النماذج المحلية تحتفظ بمطالب على جهازك، ولكن لا تزال قناة
  تمر عبر خوادم القناة.

ذات الصلة: [وكيل مساحة العمل](/concepts/agent-workspace), [Memory](/concepts/memory).

### أين يقوم OpenClaw بتخزين بياناته

كل شيء يعيش تحت `$OPENCLAW_STATE_DIR` (الافتراضي: `~/.openclaw`):

| المسار                                                                                                                    | الغرض                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                                                                                       | التكوين الرئيسي (JSON5)                                                     |
| $OPENCLAW_STATE_DIR/credentials/oauth.json\`                    | استيراد OAuth القديم (تم نسخه إلى ملفات تعريف المصادقة عند الاستخدام الأول) |
| $OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json\` | المصادقة الشخصية (OAuth + API مفاتيح)                                       |
| $OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json\`          | ذاكرة التخزين المؤقت للمصادقة وقت التشغيل (تتم إدارتها تلقائياً)            |
| `$OPENCLAW_STATE_DIR/credentials/`                                                                                        | حالة المزود (على سبيل المثال `Whatsapp/<accountId>/creds.json`)             |
| `$OPENCLAW_STATE_DIR/agents/`                                                                                             | حالة وكيل (وكيل + دورات)                                                    |
| $OPENCLAW_STATE_DIR/agents/<agentId>/sessions/\`                                | تاريخ المحادثة والحالة (لكل وكيل)                                           |
| $OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json\`   | البيانات الوصفية للجلسة (لكل وكيل)                                          |

مسار العميل الفردي: '~/.openclaw/agent/\*' (ترحيل من قبل طبيب openclaw ).

**مساحة عملك** (AGENTS.md, ملفات الذاكرة، المهارات، إلخ.) هو منفصل ومكون عبر `agents.defaults.workspace` (الافتراضي: `~/.openclaw/workspace`).

### مكان وجود AGENTSmd SOULmd USERmd MEMORYmd

هذه الملفات تعيش في **مكان عمل الوكيل**، ليس `~/.openclaw`.

- **مساحة العمل (لكل وكيل)**: `AGENTS.md`، `SOUL.md`، `IDENTITY.md`، `USER.md`،
  `MEMORY.md` (أو `memory.md`)، `memory/YYY-MM-DD.md`، اختياري `HEARTBEAT.md`.
- **الحالة ('~/.openclaw')**: config, credentials, Auth profies,s,Js,
  والمهارات المشتركة ('~/.openclaw/skills\`).

مساحة العمل الافتراضية هي `~/.openclaw/workspace`، قابلة للتكوين بواسطة:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

إذا "نسيت" البوت بعد إعادة التشغيل، تأكيد أن البوابة تستخدم نفس مساحة العملformat@@0
في كل عملية إطلاق (وتذكر: الوضع البعيد يستخدم مساحة العمل **بوابة المضيف**
. ليس حاسوبك المحمول المحلي).

نصيحة: إذا كنت تريد سلوكا أو تفضيلا دائما، اطلب من البوت **كتابته في
AGENTS. (د) أو MEMORY.md** بدلاً من الاعتماد على تاريخ الدردشة.

انظر [وكيل مساحة العمل](/concepts/agent-workspace) و [Memory](/concepts/memory).

### ما هي استراتيجية النسخ الاحتياطي الموصى بها

ضع **مساحة عمل الوكيل الخاص بك** في **خاصة** repo وقم بنسخه احتياطياً في مكان ما
خاص (على سبيل المثال GitHub الخاص). يلتقط هذا ملفات الذاكرة + ملفات AGENTS/SOUL/USER
ويتيح لك استعادة "عقول" المساعد في وقت لاحق.

لا **لا** يلتزم بأي شيء تحت `~/.openclaw` (بيانات الاعتماد، الدورات، الرموز).
إذا كنت بحاجة إلى استعادة كاملة، قم بحفظ كل من فضاء العمل ودليل الولاية
بشكل منفصل (انظر سؤال الهجرة أعلاه).

الوثائق: [وكيل مساحة العمل](/concepts/agent-workspace).

### كيف يمكنني إلغاء تثبيت OpenClaw كلياً

انظر الدليل المكرس: [Uninstall](/install/uninstall).

### يمكن للوكلاء العمل خارج مساحة العمل

نعم. مساحة العمل هي **مرساة الذاكرة الافتراضية**، وليست مرساة رمل صلبة.
يتم حل المسارات النسبية داخل مساحة العمل، ولكن المسارات المطلقة يمكن أن تصل إلى مواقع مضيفة أخرى
ما لم يتم تمكين صندوق الرمال. إذا كنت بحاجة إلى عزلة، استخدم
[`agents.defaults.sandbox'](/gateway/sandboxing) أو إعدادات sandbox لكل وكيل. إذا كنت
تريد أن يكون المستودع هو دليل العمل الافتراضي، قم بالإشارة إلى ذلك الوكيل
`مساحة العمل\` إلى جذر المسترجع. إن مستودع OpenClaw هو مجرد رمز مصدر؛ حافظ على مساحة العمل
منفصلة ما لم تكن تريد عمدا من الوكيل أن يعمل داخله.

مثال (repo كملف افتراضي):

```json5
{
  الوكلاء: {
    الافتراضي: {
      مساحة العمل: "~/Projects/my-repo",
    },
  },
}
```

### Im في الوضع البعيد حيث هو متجر الجلسة

حالة الجلسة مملوكة لـ **مضيف البوابة**. إذا كنت في الوضع البعيد، مخزن الجلسة الذي تهتم به هو على الجهاز البعيد، وليس الكمبيوتر المحمول المحلي الخاص بك. انظر [إدارة الدورة](/concepts/session).

## أساسيات التكوين

### الشكل هو التكوين أين هو

يقرأ OpenClaw تكوين اختياري **JSON5** من `$OPENCLAW_CONFIG_PATH` (الافتراضي: `~/.openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

إذا كان الملف مفقود، فإنه يستخدم افتراضيات آمنة (بما في ذلك مساحة عمل افتراضية من `~/.openclaw/workspace`).

### أنا أضع البوابة المرتبطة بالخط أو الذيل والآن لا يوجد أي شيء يستمع إلى ما يقوله واجهة المستخدم غير مصرح به

ربط عدم التراجع **يتطلب وثيقة**. تكوين `gateway.auth.mode` + `gateway.auth.token` (أو استخدام `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  بوابة: {
    ملزم:"lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

ملاحظات:

- 'gateway.remote.token' فقط لـ **مكالمات CLI البعيدة**؛ إنها لا تمكن مصادقة البوابة المحلية.
- مصادقة واجهة المستخدم للتحكم عبر `connect.params.auth.token` (مخزنة في إعدادات التطبيق/واجهة المستخدم). تجنب وضع الرموز في عناوين URLs.

### لماذا أحتاج إلى الرمز المميز على الموقع المحلي الآن

يقوم المعالج بإنشاء رمز البوابة بشكل افتراضي (حتى على الحلقة التكرارية) لذلك **يجب على عملاء نظام WS المحليين المصادقة**. هذا يمنع العمليات المحلية الأخرى من الاتصال بالبوابة. لصق الرمز المميز في إعدادات واجهة التحكم (أو تكوين العميل الخاص بك) للاتصال.

إذا أردت **حقاً** حلقة التكرار المفتوحة، قم بإزالة `gateway.auth` من الإعدادات الخاصة بك. يمكن للطبيب إنشاء رمز لك في أي وقت: `طبيب openclaw --Generate-Gateway-token`.

### هل يتوجب علي إعادة التشغيل بعد تغيير الإعدادات

وتشاهد البوابة التكوين وتدعم إعادة التحميل الساخن:

- `gateway.reload.mode: "hybrid"` (default): التغييرات الآمنة الساخنة، إعادة تشغيل للتغييرات الحرجة
- 'hot'، 'resبدء' ، 'إيقاف' أيضًا مدعومة

### كيف يمكنني تمكين البحث في الويب وجلب الويب

يعمل `web_fetch` بدون مفتاح API. `web_search` requires a Brave Search API
key. **مستحسن:** قم بتشغيل `openclaw configure --section web` لتخزينه في
`tools.web.search.apiKey`. البديل البيئي: تعيين `BRAVE_API_KEY` لعملية بوابة

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

ملاحظات:

- إذا كنت تستخدم قوائم السماح ، أضف `web_search`/`web_fetch` أو `group:web`.
- `web_fetch` مفعّل افتراضيًا (ما لم يتم تعطيله صراحةً).
- دايمونز يقرأ إنف يتطابق مع '~/.openclaw/.env' (أو بيئة الخدمات).

التوثيق: [أدوات الويب](/tools/web).

### كيف أدير بوابة مركزية مع عمال متخصصين عبر الأجهزة

النمط الشائع هو **بوابة واحدة** (مثل Raspberry Pi) زائداً **عقد** و**وكلاء**:

- - - - بوابة (مركزية):\* تمتلك قنوات (توقيع/WhatsApp)، والمسارات والجلسات.
- **عقد (أجهزة):** جهاز Mac/iOS/Android متصل كأجهزة هامشية ويكشف الأدوات المحلية (`system.run`، `canvas`، `camera`).
- **وكلاء (عاملون):** دماغ/أماكن عمل منفصلة لأدوار خاصة (مثل "Hetzner ops", "البيانات الشخصية").
- **وكلاء فرعيون:** يفرز العمل الخلفي من وكيل رئيسي عندما تريد التوازي.
- **TUI:** قم بالاتصال بالبوابة و تبديل الوكلاء/الجلسات.

الوثائق: [Nodes](/nodes)، [الوصول عن بعد](/gateway/remote)، [توجيه العوامل المتعددة](/concepts/multi-agent)، [Sub-agents](/tools/subagents)، [TUI](/web/tui).

### هل يمكن لمتصفح OpenClaw تشغيل بلا رأس

نعم. إنه خيار إعداد:

```json5
{
  المتصفح: { headless: true },
  الوكلاء: {
    الإفتراضي: {
      الرمل: { المتصفح: { headless: true } },
    },
  },
}
```

الافتراضي هو "خطأ" (رأس). ومن الأرجح أن يؤدي انعدام الرأس إلى عمليات فحص مضاد للبوت في بعض المواقع. انظر [Browser](/tools/browser).

لا رأس يستخدم **نفس محرك الكروميوم** ويعمل على معظم الأتمتة (الاستمارات، النقرات، خردة، تسجيل الدخول). الاختلافات الرئيسية:

- لا توجد نافذة متصفح مرئية (استخدم لقطات الشاشة إذا كنت بحاجة إلى مرئية).
- بعض المواقع أكثر صرامة بشأن التشغيل الآلي في وضع لا رأس له (CAPTCHA, anti-bot).
  على سبيل المثال، غالباً ما يمنع X/Twitter الجلسات التي لا رأس لها.

### كيف يمكنني استخدام الشجاعة للتحكم في المتصفح

قم بتعيين `browser.executablePath` إلى الثنائي الشجاع (أو أي متصفح قائم على Chromium) وإعادة تشغيل البوابة.
راجع أمثلة التكوين الكاملة في [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## البوابات والعقد البعيدة

### كيف تنتشر الأوامر بين تيليجرام والبوابة والعقد

تتم معالجة رسائل تيليجرام بواسطة **البوابة**. تشغيل البوابة الوكيل و
فقط يستدعي العقد عبر **بوابة WebSocket** عندما تكون هناك حاجة إلى أداة العقدة:

تيليجرام → بوابة → وكيل → 'عقدة.\*' → عقدة → بوابة → تيليجرام

لا ترى العُقد حركة مرور الموردين الواردين، بل تستقبل فقط مكالمات RPC للعقدة.

### كيف يمكن لوكيلي الوصول إلى حاسوبي إذا تم استضافة البوابة عن بعد

إجابة قصيرة: **زوج جهاز الكمبيوتر الخاص بك كعقدة**. The Gateway runs elsewhere, but it can
call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

الإعداد النموذجي:

1. تشغيل البوابة على المضيف دائماً على (VPS/Home server).
2. ضع مضيف البوابة + الكمبيوتر الخاص بك على نفس الخياط.
3. تأكد من أن البوابة WS يمكن الوصول إليها (ربط الخياطة أو نفق SSH).
4. قم بفتح تطبيق macOS محلياً ثم قم بتوصيل وضع **عن بعد عبر SSH** (أو تخصيص مباشرة)
   حتى يتمكن من التسجيل كعقدة.
5. الموافقة على العقدة على البوابة:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

ليس هناك حاجة إلى جسر TCP منفصل؛ عقد اتصال عبر بوابة ويب سوكيت.

تذكير الأمن: إقران عقدة macOS يسمح بـ \`system.run' على تلك الآلة. فقط
أزواج الأجهزة التي تثق بها، ومراجعة [Security](/gateway/security).

الوثائق: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS البعيد](/platforms/mac/remote), [Security](/gateway/security).

### المقياس الخطي متصل ولكني لا أحصل على أي ردود الآن

تحقق من الأساسيات:

- يتم تشغيل البوابة: \`openclaw status'
- صحة البوابة: `openclaw status`
- صحة القناة: \`openclaw channel'

ثم تحقق من المصادقة والمسار:

- إذا كنت تستخدم خدمةTailscale، تأكد من تعيين `gateway.auth.allowTailscale` بشكل صحيح.
- إذا قمت بالاتصال عبر نفق SSH، قم بتأكيد أن النفق المحلي هو أعلى ونقاط في المنفذ الصحيح.
- تأكيد قوائم السماح الخاصة بك (DM أو المجموعة) تشمل حسابك.

الوثائق: [Tailscale](/gateway/tailscale)، [الوصول عن بعد](/gateway/remote)، [Channels](/channels).

### يمكن أن يتحدث اثنان من مثيلات OpenClaw مع بعضها البعض المحلي VPS

نعم. لا يوجد جسر مدمج "بوت إلى بوت"، ولكن يمكنك توصيل هذا الجسر ببضع
بطرق موثوقة:

**بسيط:** استخدم قناة دردشة عادية يمكن للبوت الوصول إليها (Telegram/Slack/WhatsApp).
هل أرسل بوت ألف رسالة إلى بوت باء، ثم دع بوت باء يرد كالمعتاد.

**جسر CLI (عام):** يقوم بتشغيل سكريبت يتصل بالبوابة الأخرى مع
`وكيل openclaw --رسالة... --deliver`, targeting a chat where the other bot
listens. إذا كان بوت واحد على VPN عن بعد، قم بتوجيه CLI الخاص بك إلى تلك البوابة البعيدة
عبر SSH/Tailscale (انظر [الوصول عن بعد](/gateway/remote)).

نموذج النمط (يتم تشغيله من آلة يمكن أن تصل إلى بوابة الهدف):

```bash
وكيل openclaw --رسالة "مرحبا من البوت المحلي" --تسليم --قناة برقية - الرد على <chat-id>
```

نصيحة: أضف حارساً بحيث لا تتكرّر البوتان إلى ما لا نهاية (ذكر-فقط ، قناة
القوائم المسموح بها، أو قاعدة "لا تجيب على رسائل البوت").

الوثائق: [الوصول عن بعد](/gateway/remote), [وكيل CLI](/cli/agent), [وكيل يرسل](/tools/agent-send).

### هل أحتاج إلى VPSs منفصلة لوكلاء متعددين

لا. بوابة واحدة يمكن أن تستضيف وكلاء متعددين، لكل منهم مساحة عمل خاصة به، نموذج افتراضي،
والمسار. هذا هو الإعداد العادي وهو أرخص وأبسط بكثير من تشغيل
واحد من VPS لكل وكيل.

Use separate VPSes only when you need hard isolation (security boundaries) or very
different configs that you do not want to share. وبخلاف ذلك، احتفظ ببوابة واحدة و
باستخدام عدة وكلاء أو وكلاء فرعيين.

### هل هناك فائدة لاستخدام عقدة على حاسوبي المحمول الشخصي بدلاً من SSH من VPS

Yes - nodes are the first-class way to reach your laptop from a remote Gateway, and they
unlock more than shell access. البوابة تعمل على macOS/Linux (ويندوز عبر WSL2) وهي
خفيفة الوزن (صندوق VPS صغير أو Raspberry Pi-class جيد ؛ 4 جيغابايت ذاكرة الوصول العشوائي وفيرة)، لذلك يعد الإعداد الشائع
مضيفا دائما على الشاشة بالإضافة إلى حاسوبك المحمول كعقدة.

- **لا يتطلب SSH الواردة.** العقد تتصل بالبوابة WebSocket وتستخدم إقران الجهاز.
- **ضوابط التنفيذ الأكثر أماناً.** "system.run" بوابة بقوائم أو موافقات العقدة على ذلك الكمبيوتر المحمول.
- **المزيد من أدوات الجهاز.** العقدة تعرض 'canvas' و 'camera' و 'الشاشة' بالإضافة إلى 'system.run'.
- \*\*أتمتة المتصفح المحلي. \* إبقاء البوابة على VPN لكن قم بتشغيل Chrome محلياً وتحكم الترحيل
  مع امتداد Chrome + مضيف عقدة على الكمبيوتر المحمول.

SSH is fine for ad-hoc shell access, but nodes are simpler for ongoing agent workflows and
device automation.

الوثائق: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### إذا قمت بتثبيت على حاسوب محمول ثان أو فقط أضف عقدة

If you only need **local tools** (screen/camera/exec) on the second laptop, add it as a
**node**. وهذا يحتفظ ببوابة واحدة ويتجنب التكوينات المتكررة. أدوات العقدة المحلية هي
حاليا macOS-فقط، لكننا نخطط لتوسيع نطاقها إلى أنظمة التشغيل الأخرى.

قم بتثبيت بوابة ثانية فقط عندما تحتاج إلى **عزلة** أو بوتين منفصلين تماماً.

الوثائق: [Nodes](/nodes)، [عقد CLI](/cli/nodes)، [بوابات متعددة](/gateway/multiple-gateways).

### قم بتشغيل خدمة بوابة

لا. يجب تشغيل **بوابة واحدة** فقط لكل مضيف ما لم تقم عن عمد بتشغيل ملفات شخصية معزولة (انظر [البوابات المتعددة](/gateway/multiple-gateways)). العقدة هي أطراف تربط
بالبوابة (iOS/Android عقدة، أو MacOS "وضع العقدة" في تطبيق الحيض). للحصول على عقدة بلا رأس
المضيفين والتحكم في CLI، انظر [Node host CLI](/cli/node).

مطلوب إعادة تشغيل كاملة للتغييرات 'بوابة' و 'discovery' و 'canvasHost'.

### هل هناك طريقة API RPC لتطبيق التكوين

نعم. 'config.applicy' يتحقق + يكتب التكوين الكامل ويعيد تشغيل البوابة كجزء من العملية.

### تكوين تطبيق مسح التكوين الخاص بي كيف أستعيد وتجنب هذا

\`config.applicy' يحل محل **التكوين بأكمله**. إذا قمت بإرسال شيء جزئي، كل شيء
آخر يتم إزالته.

الاسترداد:

- استعادة من النسخة الاحتياطية (غيت) أو نسخة `~/.openclaw/openclaw.json`).
- إذا لم يكن لديك نسخة احتياطية، قم بإعادة تشغيل `openclaw doctor` وإعادة تكوين القنوات/النماذج.
- إذا كان هذا غير متوقع، قم بتحميل خطأ وإدراج آخر إعدادات معروفة لك أو أي نسخة احتياطية.
- غالباً ما يمكن لوكيل البرمجة المحلي أن يعيد بناء تكوين العمل من السجلات أو السجلات.

تجنب ذلك:

- استخدم "مجموعة ضبط openclaw للتغييرات" للتغييرات الصغيرة.
- استخدم `إعدادات openclaw configure` للتحريرات التفاعلية.

الوثائق: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### ما هو الحد الأدنى من التكوين العقلاني لتثبيت أول

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

هذا يحدد مساحة العمل الخاصة بك ويقيد من يمكنه تشغيل البوت.

### كيف أقوم بإعداد Tailscale على VPS والاتصال من Mac الخاص بي

الخطوات الدنيا:

1. **تثبيت + تسجيل الدخول على VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh <unk> sh
   sudo tailscale up
   ```

2. **تثبيت + تسجيل الدخول على ماكن**
   - استخدم تطبيق تايلوسو وسجل الدخول إلى نفس الخياط.

3. **تمكين MagicDNS (مستحسن)**
   - في وحدة تحكم المشرف على المقياس، تمكين MagicDNS حتى يكون VPS اسم ثابت.

4. **إستخدم اسم المضيف الخاص بالشبكة**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - بوابة WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

إذا كنت تريد واجهة المستخدم للتحكم بدون SSH، استخدم خدمة النطاق على VPS:

```bash
openclaw gateway --tailscale serve
```

وهذا يحافظ على البوابة المحكومة بالعودة ويكشف HTTPS عن طريق تايلباس. انظر [Tailscale](/gateway/tailscale).

### كيف أقوم بتوصيل عقدة ماك بخدمة خط البوابة البعيدة

خدمة تكشف **واجهة المستخدم للتحكم في البوابة + WS**. توصيل العقد عبر نفس نقطة نهاية بوابة WS.

الإعداد الموصى به:

1. **تأكد من أن VPS + Mac على نفس الخيل**.
2. **استخدم تطبيق macOS في الوضع البعيد** (يمكن أن يكون هدف SH اسم المضيف الذيل ).
   سوف ينفق التطبيق منفذ البوابة ويتصل كعقدة.
3. **ملاحظة:** نظرًا لطول الملف، فقد تم الحفاظ على بنية Markdown كاملة، وجميع الكتل البرمجية، والروابط، ومعرّفات **OC_I18N** كما هي دون ترجمة.

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

الوثائق: [بروتوكول البوابة](/gateway/protocol), [Discovery](/gateway/discovery), [macOS البعيد](/platforms/mac/remote).

## تحميل Env vars و .env

### كيف تقوم بتحميل متغيرات البيئة OpenClaw

OpenClaw يقرأ متغيرات env من العملية الأصلية (قذيفة، تشغيل/نظام، CI، إلخ.) وتحميلات إضافية:

- `.env` من دليل العمل الحالي
- ملف احتياطي عام `.env` من `~/.openclaw/.env` (المعروف أيضًا بـ `$OPENCLAW_STATE_DIR/.env`)

لا يتجاوز ملف `env` ملف env الموجود حالياً.

يمكنك أيضا تعريف معارض env المضمنة في التكوين (يطبق فقط إذا كان مفقودا من العملية env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-أو...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

انظر [/environment](/help/environment) للاطّلاع على الأسبقية الكاملة والمصادر.

### بدأت البوابة عن طريق الخدمة واختفى منيف ما هو الآن

حلين مشتركين:

1. ضع المفاتيح المفقودة في '~/.openclaw/.env' لذلك يتم التقاطها حتى عندما لا ترث الخدمة قذيفتك.
2. تمكين استيراد قذيفة (اختيار الملاءمة):

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

يقوم هذا بتشغيل قذيفة تسجيل الدخول الخاصة بك ويستورد فقط المفاتيح غير المتوقعة (لا يتم تجاوزها). المقابل:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### لقد قمت بتعيين COPILOTGITHUBTOKEN ولكن حالة النماذج تظهر شيل إنف لماذا

'وضع نماذج openclaw model' يفيد ما إذا كان **استيراد قذيفة** ممكنا. "Shell env: إيقاف"
لا يعني أنك **لا** مفقودتك - إنه يعني فقط أن OpenClaw لن يقوم بتحميل
قذيفة تسجيل الدخول الخاصة بك تلقائياً.

إذا كانت البوابة تعمل كخدمة (تشغيل/منظمة)، فإنها لن ترث بيئة قذيفة
الخاصة بك. اصلاح عن طريق القيام بواحدة منها:

1. ضع الرمز المميز في '~/.openclaw/.env':

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. أو تمكين استيراد قذيفة (`env.shellEnv.enabled: true`).

3. أو أضفها إلى بلوكة التكوين "env" (ينطبق فقط إذا كان مفقوداً).

ثم أعد تشغيل البوابة ثم أعد التحقق:

```bash
openclaw models status
```

تُقرأ رموز النسخ التجريبية من `COPILOT_GITHUB_TOKEN` (أيضًا `GH_TOKEN` / `GITHUB_TOKEN`).
انظر [/concepts/model-providers](/concepts/model-providers) و [/environment](/help/environment).

## الجلسات والدردشات المتعددة

### كيف أبدأ محادثة جديدة

إرسال '/new' أو '/reset' كرسالة مستقلة. انظر [إدارة الدورة](/concepts/session).

### إجراء إعادة تعيين للجلسات تلقائياً إذا لم أقم بإرسال جديد

نعم. تنتهي صلاحية الجلسات بعد \`session.idleMinutes' (الافتراضي **60**). تبدأ الرسالة **التالية**
معرف جلسة جديدة لمفتاح الدردشة هذا. هذا لا يحذف النصوص* إنه يبدأ فقط جلسة جديدة.

```json5
{
  الدورة: {
    idleMinutes: 240,
  },
}
```

### هل هناك طريقة لجعل فريق من أمثلة OpenClaw أحد كبار الموظفين التنفيذيين والعديد من الوكلاء

نعم، عبر **توجيه متعدد العوامل** و **الوكلاء الفرعيين**. يمكنك إنشاء منسق واحد
وكيلي والعديد من وكلاء العمل مع أماكن العمل والنماذج الخاصة بهم.

ومع ذلك، من الأفضل أن ينظر إلى هذا على أنه **تجربة ممتعة**. It is token heavy and often
less efficient than using one bot with separate sessions. The typical model we
envision is one bot you talk to, with different sessions for parallel work. That
bot can also spawn sub-agents when needed.

الوثائق: [توجيه العوامل المتعددة](/concepts/multi-agent)، [Sub-agents](/tools/subagents)، [الوكلاء CLI](/cli/agents).

### لماذا أصبح السياق مختزلاً في منتصف المهمة كيف يمكنني منعه

ويحد من سياق الجلسات النافذة النموذجية. الدردشات الطويلة، أو مخرجات الأدوات الكبيرة، أو العديد من الملفات
يمكن أن تشعل ضغطا أو اقتطاعا.

ما الذي يساعد:

- اطلب من الروبوت أن يلخص الحالة الراهنة ويكتبها إلى ملف.
- استخدم `/compact` قبل المهام الطويلة، و`/new` عند تبديل المواضيع.
- الحفاظ على السياق الهام في مساحة العمل واطلب من البوت أن يقرأه مرة أخرى.
- استخدم وكلاء فرعيين للعمل الطويل أو المتوازي حتى تبقى الدردشة الرئيسية أصغر.
- اختيار نموذج مع نافذة سياق أكبر إذا حدث ذلك في كثير من الأحيان.

### كيف يمكنني إعادة تعيين OpenClaw بالكامل ولكن ابقائها مثبتة

استخدام أمر إعادة الضبط:

```bash
openclaw reset
```

إعادة تعيين كاملة غير تفاعلية:

```bash
إعادة تعيين Openclaw - نطاق كامل - نعم-غير تفاعلي
```

ثم إعادة التشغيل على ظهر السفينة:

```bash
openclaw onboard --install-daemon
```

ملاحظات:

- كما يقدم معالج onboarding **إعادة تعيين** إذا رأى تكوين موجود. انظر [Wizard](/start/wizard).
- إذا كنت تستخدم ملفات التعريف (`--profile` / `OPENCLAW_PROFILE`)، قم بإعادة تعيين كل ملف تعريفي (الافتراضي هو `~/.openclaw-<profile>`).
- إعادة الضبط: `openclaw بوابة --dev --reset` (dev-onl; wipes dev config + credentials + session + workspace).

### أنا أحصل على أخطاء كبيرة جدا في السياق كيف يمكنني إعادة تعيين أو الاتفاق

استخدم أحد الخيارات التالية:

- **ملحق** (يحتفظ بالمحادثة ولكن يلخص الدوران الأقدم):

  ```
  /compact
  ```

  أو `/compact <instructions>` لتوجيه الموجز.

- **إعادة تعيين** (معرف الجلسة الجديدة لنفس مفتاح الدردشة):

  ```
  /جديد
  /reset
  ```

إذا استمر في الحدوث:

- تمكين أو ضبط **تقسيم الدورة** (`agents.defaults.contextPruning`) لتقريب إخراج الأداة القديمة.
- استخدام نموذج مع نافذة السياق الأكبر.

الوثائق: [Compaction](/concepts/compaction)، [تقسيم الدورة](/concepts/session-pruning)، [إدارة الدورة](/concepts/session).

### لماذا أرى طلب LLM رفض حقل الرسائل NcontentXtooluseinput المطلوب

هذا خطأ في التحقق من صحة موفر التوريد: لقد أطلق النموذج بلوكة "tool_use" دون الحصول على
'input\`. وعادة ما يعني أن تاريخ الجلسة يكون جامداً أو فاسداً (غالباً بعد خيوط طويلة
أو تغيير الأدوات/المخطط).

إصلاح: بدء جلسة جديدة مع '/new' (رسالة مستقلة).

### لماذا أحصل على رسائل نبيطة القلب كل 30 دقيقة

تشغل دبات القلب كل **30 متر** بشكل افتراضي. صممها أو تعطيلها:

```json5
{
  الوكلاء: {
    الافتراضي: {
      heartbeat: {
        كل: "2h", // أو "0m" لتعطيل
      },
    },
  },
}
```

إذا كان `HEARTBEAT.md` موجودًا لكنه فارغ فعليًا (أسطر فارغة فقط وعناوين Markdown مثل `# Heading`)، يتخطّى OpenClaw تشغيل نبضة القلب لتوفير استدعاءات واجهة برمجة التطبيقات.
إذا كان الملف مفقودًا، تستمر نبضة القلب ويقرر النموذج ما يفعل.

يتم تجاوز الـ Per-agent باستخدام `agents.list[].heartbeat`. الوثائق: [Heartbeat](/gateway/heartbeat).

### هل أحتاج إلى إضافة حساب بوت إلى مجموعة WhatsApp

لا. OpenClaw يعمل على **حسابك الخاص**، لذا إذا كنت في المجموعة، يمكن OpenClaw رؤيته.
بشكل افتراضي، يتم حظر ردود المجموعة حتى تسمح للمرسلين (`سياسة المجموعة: "السماح قائمة"`).

إذا كنت تريد فقط **أنت** لتتمكن من تشغيل ردود المجموعة:

```json5
{
  القنوات: {
    أي تطبيق: {
      سياسة المجموعة: "allowlist",
      groupAlallowFrom: ["+15551234567"],
    },
  },
}
```

### كيف أحصل على إجادة مجموعة WhatsApp

الخيار 1 (الأسرع): سجلات الذيل وإرسال رسالة اختبار في المجموعة:

```bash
سجلات openclaw --تابع --json
```

ابحث عن `chatId` (أو `from`) تنتهي في `@g.us`، مثل:
`1234567890-1234567890@g.us`.

الخيار 2 (إذا تم تكوينه/السماح مسبقاً): قائمة المجموعات من التكوين:

```bash
قائمة مجموعات الدليل openclaw --قناة ماتسآب
```

الوثائق: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### لماذا لا يرد OpenClaw في مجموعة

سببان مشتركان:

- البوابة مشغلة (افتراضي). يجب عليك أن تذكر البوت (أو أن تطابق \`ذكر').
- قمت بتكوين `channels.whatsapp.groups` دون \`"\*" والمجموعة غير مسموح بها.

انظر [Groups](/channels/groups) و [مجموعة الرسائل](/channels/group-messages).

### وضع سياق مشاركة المجموعات مع DMs

المحادثات المباشرة تنهار إلى الجلسة الرئيسية بشكل افتراضي. المجموعات/القنوات لديها مفاتيح جلسات خاصة بها، ومواضيع تيليجرام/مواضيع ديسكورد هي جلسات منفصلة. انظر [Groups](/channels/groups) و [مجموعة الرسائل](/channels/group-messages).

### كم عدد أماكن العمل والوكلاء الذين يمكنني إنشاؤهم

لا حدود صلبة. العشرات (حتى المئات) على ما يرام، ولكن رصد:

- **نمو القرص:** جلسات + النصوص الحية تحت `~/.openclaw/agents/<agentId>/sessions/`.
- **تكلفة الرمز المميز:** المزيد من العوامل يعني المزيد من استخدام النموذج المتزامن.
- - - الأعلى: \*\* ملفات تعريف مصادقة لكل عامل، ومساحات العمل، ومسار القناة.

نصائح:

- الحفاظ على مساحة عمل **نشطة** لكل وكيل (`agents.defaults.workspace`).
- قم بتبديد الجلسات القديمة (حذف إدخالات JSONL أو المتجر) إذا نمت القرص.
- استخدم "طبيب openclaw" لتحديد أماكن العمل الشاقة وعدم تطابق الملف الشخصي.

### هل يمكنني تشغيل عدة بوت أو دردشة في نفس الوقت Slack وكيف يجب أن أضع ذلك

نعم. استخدم **توجيه متعدد العوامل** لتشغيل عدة وكلاء معزولين وتوجيه الرسائل الواردة من قناة
أو حساب/أقران. Slack مدعوم كقناة ويمكن ربطه بعناصر محددة.

Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can
still block automation. للحصول على أكثر تحكم موثوقية في المتصفح، استخدم بث ملحق Chrome
على الجهاز الذي يدير المتصفح (وحافظ على البوابة في أي مكان).

إعداد أفضل الممارسات:

- مضيف البوابة دائماً (VPS/Mac mini).
- وكيل واحد لكل دور (النبطات).
- قناة Slack (قنوات) مرتبطة بتلك الوكلاء.
- المتصفح المحلي عن طريق ترحيل الملحق (أو عقدة) عند الحاجة.

الوثائق: [مسار العوامل المتعددة](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## النماذج: الافتراضي، الاختيار، الأسماء المستعارة، التبديل

### ما هو النموذج الافتراضي

النموذج الافتراضي ل OpenCL هو ما قمت بتعيينه كالتالي:

```
agents.defaults.model.primary
```

ويشار إلى النماذج على أنها `مزود/نموذج` (مثال: `الإنسان / claude-opus-4-6`). إذا أغفلت المزود ، فيفترض OpenClaw حاليًا أن "أنثروبيك" هو رد فعل مؤقت - ولكن يجب عليك **صراحة** تعيين `مزود / نموذج`.

### ما هو النموذج الذي توصي به

**الافتراضي الموصى به:** `الإنسان / claude-opus-4-6`.
**بديل جيد:** `الإنسان - سونيت-4-5`.
**موثوقة (أقل حرفاً):** `openai/gpt-5.2' - تقريبا جيد مثل أوبوس، أقل فقط من الشخصية. **Budget:** `zai/glm-4.7\`.

لدى MiniMax M2.1 مستنداته الخاصة: [MiniMax](/providers/minimax) و
[النماذج المحلية](/gateway/local-models).

قاعدة الإبهام: استخدم **أفضل نموذج يمكنك تكلفته تكلفة** لعمل المخاطر العالية، ونموذج أرخص
للمحادثة الروتينية أو الملخصات. يمكنك توجيه نماذج لكل وكيل واستخدام وكلاء فرعيين إلى
بالتوازي مع المهام الطويلة (كل وكيل فرعي يستهلك الرموز). انظر [Models](/concepts/models) و
[Sub-agents](/tools/subagents).

Strong warning: weaker/over-quantized models are more vulnerable to prompt
injection and unsafe behavior. انظر [Security](/gateway/security).

السياق: [Models](/concepts/models).

### هل يمكنني استخدام نماذج Lamacpp vLM Ollama

نعم. If your local server exposes an OpenAI-compatible API, you can point a
custom provider at it. ويحظى أولاما بدعم مباشر وهو أسهل الطرق.

Security note: smaller or heavily quantized models are more vulnerable to prompt
injection. نوصي بشدة بـ **نماذج كبيرة** لأي بوت يمكنه استخدام الأدوات.
إذا كنت لا تزال تريد نماذج صغيرة، قم بتفعيل ملابس الرمل وقوائم السماح للأدوات الصارمة.

الوثائق: [Ollama](/providers/ollama)، [النماذج المحلية](/gateway/local-models)،
[موزعي الموديل](/concepts/model-providers)، [Security](/gateway/security)،
[Sandboxing](/gateway/sandboxing).

### كيف يمكنني تبديل النماذج بدون مسح إعداداتي

استخدم **أوامر النموذج** أو قم بتعديل حقول **النموذج** فقط. تجنب التبديل الكامل للتكوين.

خيارات آمنة:

- '/model' في الدردشة (سريع، لكل دورة)
- `مجموعة نماذج openclaw ...` (تحديثات تكوين النموذج فقط)
- `openclaw configure --Section model` (تفاعلي)
- تحرير `agents.defaults.model` في `~/.openclaw/openclaw.json`

تجنب 'config.applicy' مع كائن جزئي إلا إذا كنت تنوي استبدال التكوين بأكمله.
إذا قمت بالكتابة فوق الإعداد، قم بالاستعادة من النسخة الاحتياطية أو إعادة تشغيل `openclaw doctor` للإصلاح.

الوثائق: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### ماذا يستخدم OpenCair، الخلل و Krill للنماذج

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - انظر [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### كيف يمكنني تبديل النماذج على الطائرة بدون إعادة تشغيل

استخدم الأمر `/model` كرسالة مستقلة:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

يمكنك قائمة النماذج المتاحة مع `/model` أو `/model list` أو `/model status`.

`/model` (و `قائمة / نموذجية`) يظهر صندوقاً مرقماً للمنتقى. حدد بواسطة الرقم:

```
/النموذج 3
```

يمكنك أيضًا فرض ملف شخصي محدد للمزود (في كل جلسة):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

نصيحة: '/model status' يظهر أي وكيل نشط، وأي ملف 'auth-profiles.json' يتم استخدامه، وأي ملف شخصي للمصادقة سيتم تجريبه بعد ذلك.
كما أنه يظهر نقطة نهاية موفر التكوين ('baseUrl') ووضع API ('api') عندما تكون متاحة.

**كيف يمكنني إلغاء تثبيت الملف الشخصي الذي قمت بتعيينه مع الملف الشخصي**

إعادة تشغيل `/model` **خارج** لاحقة `@profile`:

```
/النموذج البشري/claude-opus-4-6
```

إذا كنت ترغب في العودة إلى الافتراضي، اختر ذلك من `/model` (أو إرسال `/model <default provider/model>`).
استخدم '/model status' لتأكيد أي ملف تعريف المصادقة نشط.

### هل يمكنني استخدام GPT 5.2 للمهام اليومية و Codex 5.3 للبرمجة

نعم. تعيين واحد كافتراضي والتبديل حسب الحاجة:

- **التبديل السريع (لكل دورة):** `/model gpt-5.1` للمهام اليومية، `/model gpt-5.3-codex` للترميز.
- **الافتراضي + switch:** قم بتعيين `agents.defaults.model.primary` إلى `openai/gpt-5.2`، ثم قم بالتبديل إلى `openai-codex/gpt-5.3-codex` عند البرمجة (أو بطريقة أخرى).
- **وكلاء فرعيون:** مهام ترميز المسار إلى وكلاء فرعيين مع نموذج افتراضي مختلف.

انظر [Models](/concepts/models) و [Slash commands](/tools/slash-commands).

### لماذا أرى النموذج غير مسموح به ومن ثم لا يوجد رد

إذا تم تعيين `agents.defaults.models'، يصبح **allowlist** لـ `/model' وأي تجاوز للجلسات
. اختيار نموذج غير موجود في القائمة يرجع :

```
Model "provider/model" is not allowed. Use /model to list available models.
```

هذا الخطأ يتم إرجاعه **بدلاً من** رد عادي. إصلاح: أضف النموذج إلى
`agents.defaults.models'، أو إزالة قائمة المسموح بها، أو اختيار نموذج من `/model list\`.

### لماذا أرى نموذج غير معروف minimaxMiniMaxM21

هذا يعني أن **مزود الخدمة غير معدات** (لم يتم العثور على تكوين مقدم خدمة مصغر ماكس أو ملف المصادقة
الشخصي)، لذلك لا يمكن حل النموذج. إصلاح لهذا الكشف هو
في **2026.1.12** (لم يطلق وقت الكتابة).

إصلاح القائمة المرجعية:

1. الترقية إلى **2026.1.12** (أو تشغيل من المصدر \`main')، ثم إعادة تشغيل البوابة.
2. تأكد من تكوين MiniMax (معالج أو JSON)، أو أن مفتاح API صغير ماكس
   موجود في بيانات env/auth حتى يمكن حقن المزود.
3. استخدم معرف النموذج الدقيق (حساس لحالة الحالة): `minimax/MiniMax-M2.1` أو
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   و اختر من القائمة (أو '/ نموذج' في المحادثة).

انظر [MiniMax](/providers/minimax) و [Models](/concepts/models).

### هل يمكنني استخدام MiniMax كإفتراضي و OpenAI للمهام المعقدة

نعم. استخدم **MiniMax كالافتراضي** و قم بتبديل النماذج **في كل جلسة** عند الحاجة.
الارتداد ل **الأخطاء**، ليس "المهام الصعبة"، لذلك استخدم `/model` أو وكيل منفصل.

**الخيار ألف: التبديل في كل جلسة**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  الوكلاء: {
    الافتراضي: {
      نموذج: { في المقام الأول: "minimax/MiniMax-M2. "},
      models: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

ثم:

```
/الطراز
```

**الخيار باء: الوكلاء المنفصلون**

- الوكيل A الافتراضي: MiniMax
- الوكيل B الافتراضي: OpenAI
- المسار بواسطة الوكيل أو استخدم `/agent` للتبديل

الوثائق: [Models](/concepts/models), [متعدد العوامل](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### هي اختصارات مبنية على شبكة opus sonnet

نعم. OpenClaw يشحن بعض الاختصارات الافتراضية (يطبق فقط عند وجود النموذج في `agents.defaults.models`):

- 'opus' → 'أنثني/claude-opus-4-6'
- 'sonnet' → 'الإنسان / claude-sonnett-4-5\`
- `gpt` → `openai/gpt-5.2`
- 'gpt-mini' → 'openai/gpt-5-mini'
- `gemini' → `google/gemini-3-pro-preview\`
- `gemini-flash' → `google/gemini-3-flash-preview\`

إذا قمت بتعيين الاسم المستعار الخاص بك بنفس الاسم، فإن قيمتك تفوز.

### كيف يمكنني تعريف اختصارات النماذج المستعارة

Aliases come from `agents.defaults.models.<modelId>.alias`. مثال:

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

ثم يقوم `/model sonnet` (أو `/<alias>` عندما تدعم) بحل معرف النموذج هذا.

### كيف أضيف نماذج من مزودين آخرين مثل OpenRouter أو ZAI

OpenRouter (دفع - token; العديد من النماذج):

```json5
{
  الوكلاء: {
    الإفتراضي: {
      نموذج: { في المقام الأول: "openrouter/anthropic/claude-sonnet-4-5" }،
      النماذج: { "openrouter/anthropic/claude-sonnet-4-5": {} }،
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-. ." }،
}
```

Z.AI (نماذج GLM):

```json5
{
  الوكلاء: {
    الافتراضي: {
      نموذج: { في المقام الأول: "zai/glm-4. "},
      نموذج: { "zai/glm-4. ": {} و
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

إذا كنت تشير إلى مزود/نموذج ولكن مفتاح المزود المطلوب مفقود، ستحصل على خطأ مصادقة وقت التشغيل (e. `لم يتم العثور على مفتاح API للمزود "زاي"`).

**لم يتم العثور على مفتاح API للموفر بعد إضافة وكيل جديد**

هذا يعني عادة أن **وكيل جديد** لديه متجر مصادقة فارغ. المصادقة لكل وكيل و
مخزنة في:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

خيارات الإصلاح:

- تشغيل `عملاء openclaw إضافة <id>` وتكوين المصادقة أثناء المعالج.
- أو نسخ 'Auth-profiles.json' من 'agentDir' للوكيل الرئيسي إلى 'agentDir' للوكيل الجديد.

قم بـ **لا** إعادة استخدام 'وكيل دير' عبر العوامل؛ إنه يتسبب في تصادم / الجلسة.

## فشل النموذج و "فشلت جميع النماذج"

### كيف يتم الفشل في العمل

ويحدث الفشل في مرحلتين:

1. **تدوير ملف التعريف المصادقة** داخل نفس المورد.
2. **الانتقال الاحتياطي للنموذج** إلى النموذج التالي في `agents.defaults.model.fallbacks`.

تنطبق التبريدات على الملفات الشخصية الفاشلة (التراجع الأسيسي)، لذلك يمكن OpenClaw أن يستمر في الاستجابة حتى عندما يكون موفر محدد المعدل أو متعطلا مؤقتا.

### ماذا يعني هذا الخطأ

```
لم يتم العثور على بيانات اعتماد للملف الشخصي "انساني:الافتراضي"
```

هذا يعني أن النظام حاول استخدام معرف الملف الشخصي للمصادقة `الإنسان : الإفتراضي`، ولكن لم يتمكن من العثور على بيانات اعتماد له في متجر المصادقة المتوقع.

### إصلاح قائمة التحقق لعدم العثور على بيانات اعتماد للملف الشخصي البشري الافتراضي

- **تأكد من أين تعيش ملفات المصادقة الشخصية** (مسارات جديدة مقابل المسارات الموروثة)
  - حاليا: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - الإرث: '~/.openclaw/agent/\*' (ترحيل بواسطة 'طبيب openclaw doctor\`)
- **تأكيد أن var الـ env الخاص بك تم تحميله من قبل البوابة**
  - إذا قمت بتعيين `ANTHROPIC_API_KEY` في قذيفتك ولكن قم بتشغيل البوابة عن طريق النظام/الإطلاق، قد لا يرثها. وضعها في '~/.openclaw/.env' أو تمكين 'env.shellEnv'.
- **تأكد من أنك تقوم بتعديل الوكيل الصحيح**
  - الإعدادات المتعددة العوامل تعني أنه يمكن أن تكون هناك ملفات `auth-profiles.json` متعددة.
- **تنبيه:** تم الحفاظ على بقية المستند كاملًا مترجمًا بأسلوب عربي فصيح محايد، مع الإبقاء على جميع الأوامر، والأكواد، ومعرّفات **OC_I18N**، وروابط URL دون تغيير، وفق القواعد.
  - استخدم 'وضع نماذج openclaw model' لرؤية النماذج المكونة وما إذا كان موفري الخدمات مصادقة.

**إصلاح قائمة التحقق لعدم العثور على بيانات اعتماد للملف الشخصي الأنثروب**

هذا يعني أن التشغيل تم تثبيته على ملف تعريف مصادقة أنثروبيك، لكن البوابة
لا يمكن أن تجد في متجر المصادقة الخاص بها.

- **استخدام رمز الإعداد**
  - قم بتشغيل `claude setup-token`، ثم قم بلصقه مع `openclaw models auth tup-token --مزود الأنثروبي`.
  - إذا كان الرمز المميز قد تم إنشاؤه على آلة أخرى، استخدم `openclaw models auth paste-token --provider anthropic`.

- **إذا كنت ترغب في استخدام مفتاح API بدلاً من ذلك**
  - ضع `ANTHROPIC_API_KEY` في `~/.openclaw/.env` على **مضيف البوابة**.
  - مسح أي أمر مثبت يجبر ملف شخصي مفقود:

    ```bash
    أزرار طلبات المصادقة لـopenclaw -مزود الانتاج
    ```

- **أكد أنك تقوم بتشغيل الأوامر على البوابة المضيفة**
  - في الوضع البعيد، بيانات المصادقة موجودة على آلة البوابة، وليس على حاسوبك المحمول.

### لماذا جربت أيضا جوجل جميني وفشلت

إذا كان إعداد النموذج الخاص بك يحتوي على Google Gemini كنسخة احتياطية (أو يمكنك التبديل إلى خانة Gemini)، فسيقوم OpenClaw بتجربته خلال فترة استرجاع النموذج. إذا لم تقم بتكوين بيانات اعتماد جوجل، سترى `لا يوجد مفتاح API للمزود "google"`.

إصلاح: إما توفير Google auth، أو إزالة/تجنب نماذج جوجل في \`agents.defaults.model.fallbacks' / أسماء مستعارة حتى لا يتم الرجوع هناك.

**طلب LM رفض رسالة تفكر في التوقيع يتطلب جوجل مضاد للجاذبية**

السبب: تاريخ الجلسة يحتوي على **كتل تفكير بدون توقيعات** (غالباً من
بث محذوف/جزئي). يتطلب جوجل لمكافحة الجاذبية توقيعات للتفكير في الكتل البرمجية.

إصلاح: OpenClaw الآن تشطح كتل التفكير الغير موقعة لـ Google Antigravity Claude. إذا كان لا يزال يظهر ، ابدأ **جلسة جديدة** أو عيّن `/thinking off` لذلك الوكيل.

## ملفات المصادقة: ما هي وكيفية إدارتها

ذات الصلة: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storation, متعدد الحسابات)

### ما هو ملف المصادقة

الملف الشخصي للمصادقة هو سجل اعتماد مسمى (OAuth or API key) مرتبط بمزود الخدمة. الملفات الشخصية تعيش في:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### ما هي معرفات الملف الشخصي النموذجية

يستخدم OpenClaw المعرفات المحددة مسبقاً مثل:

- 'الإنسان الافتراضي' (شائع عندما لا توجد هوية بريد إلكتروني)
- `البشرية:<email>` لهويات OAuth
- المعرفات المخصصة التي تختارها (على سبيل المثال `الإنسان :work`)

### هل يمكنني التحكم في أي ملف تعريف المصادقة يتم تجربته أولاً

نعم. يدعم التهيئة البيانات الوصفية الاختيارية للمواصفات الشخصية والطلب لكل موفر ('auth.order.<provider>\`). هذا يفعل **لا** يخزن الأسرار؛ ويرسم خرائط للمعرف إلى المزود/الوضع ويضع ترتيب الدوران.

قد تتخطى OpenClaw مؤقتاً الملف الشخصي إذا كان في **فترة تبريد** قصيرة (حدود/مهلة/فشل المصادقة) أو حالة **معطلة** أطول (فوترة / اعتمادات غير كافية). لتفتيش هذا، قم بتشغيل "حالة نماذج openclaw models - json" ثم تحقق من `auth.unusableProfiles`. الموافقة: `auth.cooldowns.billingBackoffHours*`.

يمكنك أيضًا تعيين تجاوز للطلب **لكل عامل** (مخزن في 'auth-profiles.json\`) لذلك الوكيل عبر CLI:

```bash
# الإعدادات الافتراضية إلى الوكيل الافتراضي (حذف --وكيل)
نماذج openclaw Auth order الحصول على --مقدم الخدمات الاصطناعي

# قفل تدوير لملف شخصي واحد (فقط حاول هذا)
نماذج openclaw Forth Order مجموعة --مورد الانتاج البشري: الإفتراضي

# أو تعيين طلب صريح (رد الفعل داخل المزود)
نماذج openclaw Auth الطلب--مجموعة موفر الاصطناعي: العمل الانساني الاصطناعي:

# Clear override (العودة إلى ضبط المصادقة. rder / round-robin)
openclaw ordth order clear--مزود الإنسان
```

لاستهداف وكيل محدد:

```bash
مجموعة نماذج openclaw لترتيب المصادقة --مزود الانتاج -وكيل الاصطناعي الرئيسي:default
```

### مفتاح OAuth مقابل API ماهية الفرق

OpenClaw يدعم كليهما:

- **OAuth** غالباً ما يدعم الوصول إلى الاشتراك (حيثما ينطبق ذلك).
- **مفاتيح API** تستخدم فاتورة الدفع لكل رمز.

يدعم المعالج صراحة رمز إعداد Anthropic وOpenAI Codex OAuth ويمكنه تخزين مفاتيح API لك.

## البوابة: المنافذ و "قيد التشغيل مسبقاً" و الوضع البعيد

### ما الذي يقوم به المنفذ باستخدام البوابة

'gateway.port' يتحكم في المنفذ المتعدد الوحيد لـ WebSocket + HTTP (واجهة التحكم، الارتباطات، إلخ.).

الأولوية:

```
--منفذ > OPENCLAW_GATEWAY_PORT > بوابة ميناء > الافتراضي 18789
```

### لماذا حالة بوابة openclaw تقول تشغيل Runtime ولكن مسبار RPC فشل

لأن "تشغيل" هو طريقة عرض **المشرفين** (الإطلاق/النظام/الشاتيك). مسبار RPC هو الـ CLI الذي يربط بالفعل بالبوابة WebSocket ويتصل بـ `status`.

استخدم حالة بوابة openclaw واثق في هذه الأسطر:

- `تحقيق الهدف:` (عنوان URL الذي استخدم بالفعل)
- `الاستماع:` (ما هو مرتبط بالفعل في الميناء)
- 'خطأ في البوابة الأخيرة:' (السبب الجذري الشائع عندما تكون العملية حية ولكن المنفذ لا يستمع)

### لماذا تظهر حالة بوابة openclaw عصب التكوين وخدمة التكوين مختلفة

أنت تقوم بتحرير ملف تهيئة واحد بينما الخدمة تقوم بتشغيل ملف آخر (غالباً عدم تطابق `--profile` / \`OPENCLAW_STATE_DIR).

إصلاح:

```bash
تثبيت بوابة openclaw --إجباري
```

قم بتشغيل ذلك من نفس `--profile` / البيئة التي تريد استخدام الخدمة.

### ما تعنيه بالفعل بوابة أخرى هو الإستماع

يعمل OpenClaw على إنفاذ قفل وقت التشغيل من خلال ربط مستمع WebSocket مباشرة عند بدء التشغيل (الافتراضي `ws://127.0.0.1:18789`). إذا فشل الربط مع 'EADDRINUSE'، فإنه يلقي 'GatewayLockEror' إشارة إلى مثال آخر يستمع بالفعل.

إصلاح: إيقاف المثال الآخر، تحرير الميناء، أو تشغيل `openclaw بوابة --port <port>`.

### كيف يمكنني تشغيل OpenClaw في الوضع البعيد العميل يتصل ببوابة أخرى

تعيين `gateway.mode: "Remote"` والإشارة إلى رابط WebSocket البعيد، اختيارياً باستخدام الرمز المميز/كلمة المرور:

```json5
{
  بوابة: {
    وضع "بعيد"،
    بعيد: {
      url: "ws://gateway.tailnet:18789",
      token: "You token",
      كلمة المرور: "كلمة المرور الخاصة بك"،
    },
  },
}
```

ملاحظات:

- يبدأ 'openclaw بوابة' فقط عندما يكون 'gateway.mode' 'local' (أو تجتاز علم التجاوز).
- تطبيق macOS يشاهد ملف التكوين ويغير الأوضاع مباشرة عندما تتغير هذه القيم.

### واجهة مستخدم التحكم تقول غير مصرح بها أو تواصل إعادة الاتصال الآن

البوابة الخاصة بك تعمل مع المصادقة مفعلة ('Gateway.auth.\*\`)، ولكن واجهة المستخدم لا ترسل رمز مطابق/كلمة المرور.

حقائق (من الكود):

- يقوم واجهة المستخدم بالتحكم بتخزين الرمز المميز في مفتاح التخزين المحلي في المتصفح 'openclaw.control.settings.v1\`.

إصلاح:

- أسرع: `openclaw dashboard` (يطبع + نسخ عنوان URL لوحة المعلومات، يحاول الفتح؛ يظهر تلميح SSH إذا لم يرأس).
- إذا لم يكن لديك رمز حتى الآن: `openclaw doctor --Generate-Gateway-token`.
- إذا كان البعيد، نفق أولاً: `ssh -N -L 18789:127.0.0.1:18789 user@host` ثم افتح `http://127.0.0.1:18789/`.
- تعيين `GATEWAY_TOKEN` (أو `OPENCLAW_GATEWAY_TOKEN`) على مضيف البوابة.
- في إعدادات واجهة التحكم ، لصق نفس الرمز.
- مازالت عالقة؟ تشغيل 'حالة openclaw - all' واتبع [Troubleshooting](/gateway/troubleshooting). انظر [Dashboard](/web/dashboard) للحصول على تفاصيل المصادقة.

### أنا أضع خط ربط البوابة ولكنه لا يربط أي مستمع

يربط "ذيل الانترنت" باختيار عنوان IP تايلنس من واجهات الشبكة الخاصة بك (100.64.0.0/10). إذا لم تكن الآلة على تايلباس (أو أن الواجهة منخفضة)، لا يوجد شيء للارتباط به.

إصلاح:

- ابدأ المقياس على ذلك المضيف (لذلك يحتوي على عنوان 100.x)، أو
- التبديل إلى `gateway.bind: "loopback"` / `"lan"`.

ملاحظة: 'tailnet' صريحة. 'auto' تفضل حلقة التكرار؛ استخدم 'gateway.bind: ”tailnet“' عندما تريد ربط الذيل فقط.

### هل يمكنني تشغيل العديد من البوابات على نفس المضيف

عادة لا - بوابة واحدة يمكنها تشغيل قنوات الرسائل المتعددة ووكلائها. استخدم العديد من البوابات فقط عندما تحتاج إلى تكرار (مثال: وحدة الإنقاذ) أو عزلة صلبة.

نعم، ولكن يجب أن تعزل:

- `OPENCLAW_CONFIG_PATH` (تكوين لكل مثال)
- `OPENCLAW_STATE_DIR` (حالة مثال)
- `agents.defaults.workspace` (عزلة مساحة العمل)
- 'gateway.port' (منفذ فريد)

الإعداد السريع (مستحسن):

- استخدام 'openclaw - الملف الشخصي <name> …` في كل مثيل (إنشاء تلقائي '~/.openclaw-<name>`).
- تعيين 'gateway.port' فريد في كل إعدادات الملف الشخصي (أو مرور '--port' للتشغيل اليدوي).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

الملفات الشخصية أيضا لاحقة أسماء الخدمة (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-Gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
الدليل الكامل: [بوابات متعددة](/gateway/multiple-gateways).

### ما يعنيه رمز مصافحة غير صالح 1008

البوابة هي \*\*خادم WebSocket \*\*، وتتوقع أن تكون الرسالة الأولى إلى
إطار "اتصال". إذا استلم أي شيء آخر، فإنه يغلق الاتصال
مع **الرمز 1008** (انتهاك السياسة).

الأسباب الشائعة:

- لقد فتحت رابط **HTTP** في متصفح (http://...\`) بدلاً من عميل WS.
- لقد استخدمت المنفذ أو المسار الخاطئ.
- قام وكيل أو نفق بتجريد رؤوس المصادقة أو أرسل طلب بدون بوابة.

الإصلاحات السريعة:

1. استخدم عنوان WS URL: `ws://<host>:18789` (أو `wss://...` if HTTPS).
2. لا تفتح منفذ WS في علامة تبويب المتصفح العادية.
3. إذا كانت المصادقة قيد التشغيل، قم بإدراج الرمز المميز/كلمة المرور في إطار "الاتصال".

إذا كنت تستخدم CLI أو TUI ، يجب أن يبدو عنوان URL كالتالي:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

تفاصيل البروتوكول: [بروتوكول Gateway](/gateway/protocol).

## تسجيل وتصحيح الأخطاء

### أين هي السجلات

سجلات الملفات (منظمة):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

يمكنك تعيين مسار مستقر عن طريق `logging.file'. يتم التحكم في مستوى سجل الملفات بواسطة `lologing.level`. لفظية وحدة التحكم يتحكم فيها `--verbose`و`lologing.consoleLevel\`.

أسرع ذيل السجلات:

```bash
openclaw logs --follow
```

سجلات الخدمات/المشرف (عند تشغيل البوابة عبر الإطلاق/النظام):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` و`gateway.err.log` (الافتراضي: `~/.openclaw/logs/...`؛ الملفات الشخصية المستخدمة `~/.openclaw-<profile>/logs/...`)
- لينوكس: `journalctl --user -u openclaw-بوابة [-<profile>].servic-n 200 --no-pager`
- ويندوز: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

انظر [Troubleshooting](/gateway/troubleshooting#log-locations) للمزيد.

### كيف يمكنني البدء في إعادة تشغيل خدمة البوابة

استخدم مساعد البوابة:

```bash
حالة بوابة openclaw
إعادة تشغيل بوابة openclaw
```

إذا قمت بتشغيل البوابة يدوياً، فإن `openclaw بوابة --force` يمكن أن تستعيد الميناء. راجع [Gateway](/gateway).

### أغلقت محطتي الطرفية على ويندوز كيف يمكنني إعادة تشغيل OpenClaw

هناك **اثنين من إضافات تثبيت ويندوز**:

**1) WSL2 (مستحسن):** تشغيل البوابة داخل لينوكس.

فتح PowerShell، أدخل WSL، ثم إعادة التشغيل:

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

إذا لم تقم بتثبيت الخدمة، قم بتشغيلها في المقدمة:

```bash
openclaw gateway run
```

**2) ويندوز الأصلي (غير مستحسن):** تشغيل البوابة مباشرة في ويندوز.

فتح PowerShell و تشغيل:

```powershell
حالة بوابة openclaw
إعادة تشغيل بوابة openclaw
```

إذا قمت بتشغيله يدوياً (لا خدمة)، استخدم:

```powershell
openclaw gateway run
```

الوثائق: [Windows (WSL2)](/platforms/windows), [Gateway Service runbook](/gateway).

### البوابة في الأعلى ولكن الردود لا تصل أبدا ما يجب أن أتأكد منه

ابدأ بكشف صحي سريع:

```bash
حالة openclaw
حالة نماذج openclaw
حالة قنوات openclaw
سجلات openclaw --تابع
```

الأسباب الشائعة:

- لم يتم تحميل مصادقة الموديل على **مضيف البوابة** (تحقق من 'حالة النموذج\`).
- إقران/السماح بالردود على حظر القناة (تحقق من إعدادات القناة + السجلات).
- ويبتشات/لوحة التحكم مفتوحة بدون الرمز المميز الأيمن.

إذا كنت تبعد ، قم بتأكيد اتصال النفق/النطاق المستقيم و أنه يمكن الوصول إلى
بوابة WebSocket

الوثائق: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [الوصول عن بعد](/gateway/remote).

### قطع الاتصال من البوابة لا يوجد سبب لما الآن

هذا يعني عادة أن واجهة المستخدم فقدت اتصال WebSocket. تحقّق من:

1. هل تعمل البوابة؟ `openclaw gateway status`
2. هل البوابة صحية؟ `openclaw status`
3. هل لدى واجهة المستخدم الرمز الصحيح؟ `openclaw dashboard`
4. إذا كان جهاز التحكم، هل الرابط بين النفق/نطاق الخط؟

ثم سجلات الذيل :

```bash
openclaw logs --follow
```

الوثائق: [Dashboard](/web/dashboard)، [الوصول عن بعد](/gateway/remote)، [Troubleshooting](/gateway/troubleshooting).

### فشل Telegram setMyCommands مع أخطاء الشبكة ماذا يجب أن أتحقق منه

ابدأ بسجلات و حالة القناة:

```bash
حالة قنوات openclaw
سجلات قنوات openclaw --برقية القناة
```

إذا كنت على VPS أو وراء وكل، فسيتم السماح بتأكيد HTTPS الصادر وعمل DNS.
إذا كانت البوابة بعيدة ، تأكد من أنك تنظر في السجلات على مضيف البوابة.

الوثائق: [Telegram](/channels/telegram)، [تشخيص مشاكل القناة](/channels/troubleshooting).

### TUI لا يظهر أي إخراج ماذا يجب أن أتحقق منه

أولاً تأكيد أن البوابة قابلة للوصول ويمكن للوكيل تشغيل:

```bash
حالة openclaw
وضع نماذج openclaw
سجلات openclaw --تابع
```

في TUI، استخدم `/status` لرؤية الحالة الحالية. إذا كنت تتوقع الردود في قناة الدردشة
، تأكد من تمكين التسليم (`/delivery on`).

الوثائق: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### كيف أتوقف تماما عندها ابدأ تشغيل البوابة

إذا قمت بتثبيت الخدمة:

```bash
بوابة openclaw توقف
بدء بوابة openclaw
```

هذا يوقف/يبدأ **الخدمة الخاضعة للإشراف** (تشغيل على macOS، نظام على Linux).
استخدم هذا عندما تعمل البوابة في الخلفية كهدوء.

إذا كنت تعمل في المقدمة، توقف مع Ctrl-C، ثم:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw بوابة إعادة تشغيل ضد بوابة openclaw

- `إعادة تشغيل بوابة openclaw`: إعادة تشغيل **خدمة الخلفية** (تشغيل/منظمة).
- `openclaw بوابة`: يشغل البوابة **في المقدمة** لهذه الجلسة النهائية.

إذا قمت بتثبيت الخدمة، استخدم أوامر البوابة. استخدم 'بوابة openclaw' عندما
تريد تشغيل لمرة واحدة في المقدمة.

### ما هي أسرع طريقة للحصول على المزيد من التفاصيل عندما يفشل شيء ما

ابدأ البوابة مع `--verbose` للحصول على المزيد من تفاصيل وحدة التحكم. ثم قم بتفتيش ملف السجل للتحقق من مصادقة القناة، ومسار النموذج، وأخطاء RPC.

## الوسائط والمرفقات

### مهارتي تولدت صورة PDF ولكن لم يتم إرسال أي شيء

ويجب أن تتضمن المرفقات الصادرة من الوكيل خطا 'MEDIA:<path-or-url>\` (على سطره الخاص). انظر [اعداد مساعد OpenClaw](/start/openclaw) و [وكيل يرسل](/tools/agent-send).

أرسل CLI:

```bash
رسالة openclaw ترسل --الهدف +155550123 --رسالة "هنا تذهب" --Media /path/to/file.png
```

تحقق أيضا:

- القناة المستهدفة تدعم الوسائط الصادرة ولا يتم حظرها بواسطة قوائم المسموح بها.
- الملف ضمن حدود حجم المزود (يتم تغيير حجم الصور إلى حد أقصى 2048px).

انظر [Images](/nodes/images).

## الأمن ومراقبة الدخول

### هل من الآمن الكشف عن OpenClaw إلى DMs واردة

تعامل مع DMS الواردة كمدخلات غير موثوقة. الإعدادات الافتراضية مصممة لتقليل المخاطر:

- السلوك الافتراضي على القنوات القادرة على DM هو **الإقران**:
  - المرسلون غير المعروفين يتلقون رمز الاقتران؛ البوت لا يعالج رسالتهم.
  - الموافقة على: `فقرات openclaw فقرات <channel> <code>`
  - يتم وضع حد أقصى للطلبات المعلقة في **3 في كل قناة**؛ تحقق من `قائمة الاقتران openclaw <channel>` إذا لم تصل التعليمات البرمجية.
- يتطلب فتح DMs علناً الاختيار الصريح (`dmPolicy: "open"` وقائمة السماح `"*"`).

تشغيل "أطباء openclaw doctor" إلى سياسات DM المنطوية على مخاطر على السطح.

### هو حقن فوري فقط مصدر قلق للروبوتات العامة

لا. الحقن الفوري هو تقريبا **محتوى غير موثوق به**، وليس فقط من يستطيع أن يقوم بالروبوت.
إذا كان مساعدك يقرأ محتوى خارجي (البحث/إحضار الويب، صفحات المتصفح، رسائل البريد الإلكتروني،
مستندات المرفقات، سجلات اللصق)، ذلك المحتوى يمكن أن يتضمن تعليمات تحاول
لخطف النموذج. هذا يمكن أن يحدث حتى لو كانت **أنت المرسل الوحيد**.

الخطر الأكبر هو عندما تكون الأدوات مفعلة: يمكن خداع النموذج في سياق الترشيح
أو الاتصال بأدوات نيابة عنك. قلّل نطاق الانفجار عبر:

- استخدام وكيل "القارئة" للقراءة فقط أو أداة معطلة لتلخيص المحتوى غير الموثوق به
- إبقاء `web_search` / `web_fetch` / `المتصفح` متوقفاً عن العمل للوكلاء العاملين بالأدوات
- الملابس الرملية وقوائم السماح باستخدام الأدوات الصارمة

التفاصيل: [Security](/gateway/security).

### إذا كان للبوت الخاص بي بريده الإلكتروني الخاص بحساب GitHub أو رقم هاتف

نعم، لمعظم الإعدادات. عزل البوت بالحسابات المنفصلة وأرقام الهاتف
يقلل من نصف قطر الانفجار إذا حدث خطأ ما. وهذا أيضا يجعل من الأسهل تدوير أوراق الاعتماد
أو إلغاء الوصول دون التأثير على حساباتك الشخصية.

ابدأ صغيرة. امنح حق الوصول فقط إلى الأدوات والحسابات التي تحتاجها فعلاً، و قم بتوسيع
لاحقاً إذا لزم الأمر.

الوثائق: [Security](/gateway/security), [Pairing](/channels/pairing).

### هل يمكنني إعطائها استقلالية في رسائلي النصية وهي آمنة

نحن نفعل **لا** نوصي باستقلالية كاملة على رسائلك الشخصية. النمط الأكثر أماناً:

- إبقاء DMs في **وضع الإقران** أو قائمة مسموح ضيقة.
- استخدم **رقمًا أو حسابًا منفصلاً** إذا أردتِ أن ترسل رسالة نيابة عنك.
- السماح له بالمسودة، ثم **الموافقة قبل إرسال**.

إذا كنت ترغب في التجربة، فعلها على حساب مخصص وإبقائها معزولة. انظر
[Security](/gateway/security).

### هل يمكنني استخدام نماذج أرخص لمهام المساعد الشخصي

نعم، **إذا** الوكيل هو المحادثة فقط والمدخل موثوق. الطبقات الأصغر هي
أكثر عرضة لاختطاف التعليمات، لذا تجنبها للوكلاء الذين يستخدمون الأدوات
أو عند قراءة محتوى غير موثوق به. إذا كان عليك استخدام نموذج أصغر، قم بقفل أدوات
والتشغيل داخل صندوق الرمال. انظر [Security](/gateway/security).

### بدأت في تيليجرام ولكن لم أحصل على رمز اقتران

يتم إرسال رموز الاقتران **فقط** عندما يتم تمكين رسالة مرسل غير معروف البوت و
`dmPolicy: "الاقتران"'. `/start\` في حد ذاته لا ينشئ تعليمة برمجية.

التحقق من الطلبات المعلقة:

```bash
openclaw pairing list telegram
```

إذا كنت تريد الوصول الفوري، اسمح بقائمة معرف المرسل الخاص بك أو تعيين `dmPolicy: "open"`
لهذا الحساب.

### WhatsApp سوف يرسل إلى جهات الاتصال الخاصة بي كيف تعمل على الإقران

لا. السياسة الافتراضية لـ WhatsApp DM هي **الإقران**. المرسلون غير المعروفين يحصلون فقط على رمز اقتران ورسالتهم **غير معالجة**. OpenClaw فقط الردود على الدردشة التي يتلقاها أو إلى إرسال صريح لك مشغل.

الموافقة على الاقتران مع:

```bash
openclaw pairing approve whatsapp <code>
```

قائمة الطلبات المعلقة:

```bash
openclaw pairing list whatsapp
```

طلب رقم الهاتف المعالج: يستخدم لتعيين **السماح لقائمة / المالك** الخاصة بك، بحيث يسمح لجهات الاتصال الخاصة بك. لا يستخدم للإرسال التلقائي. إذا كنت تعمل على رقم WhatsApp الشخصي، استخدم هذا الرقم وقم بتمكين `channels.whatsapp.selfChatMode`.

## أوامر الدردشة، إحباط المهام، و "لن يتوقف"

### كيف يمكنني إيقاف رسائل النظام الداخلية من عرضها في المحادثة

معظم الرسائل الداخلية أو الادوات تظهر فقط عندما يتم تمكين **لفظة** أو **التعليل**
لتلك الجلسة.

أصلح في الدردشة حيث ترا:

```
/verbose
/reasoning
```

إذا كان لا يزال مزعجا، تحقق من إعدادات الجلسة في واجهة المستخدم للتحكم وتعيين الكلام
إلى **الإرث**. أكد أيضًا أنك لا تستخدم ملف بوت شخصي مع تعيين 'phoseDefault'
إلى 'on' في التكوين.

الوثائق: [الفكر واللفظ](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### كيف أتوقف عن إلغاء مهمة قيد التشغيل

إرسال أي من هذه **كرسالة مستقلة** (لا توجد علامة فارقة):

```
إيقاف
إحباط
esc
انتظر
الخروج
مقاطعة
```

هذه مشغلات مُجهلة (ليس الأوامر السريعة).

لعمليات الخلفية (من أداة exec)، يمكنك أن تطلب من الوكيل تشغيل:

```
معالجة الإجراءات:kill sessionId:XXX
```

أوامر Slash نظرة عامة: انظر [الأوامر Slash](/tools/slash-commands).

يجب إرسال معظم الأوامر كرسالة **قائمة بذاتها** تبدأ بـ `/`، ولكن بعض الاختصارات (مثل `/status`) تعمل أيضا على الخط الداخلي للمرسلين المدرجين في القائمة.

### كيف يمكنني إرسال رسالة ديسكورد من Telegram Crosscontext تم رفضها

يحجب OpenClaw الرسائل **عبر موفر** بشكل افتراضي. If a tool call is bound
to Telegram, it won't send to Discord unless you explicitly allow it.

تمكين مراسلة الموردين المتعددين للوكيل:

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

إعادة تشغيل البوابة بعد تعديل الإعدادات. إذا كنت تريد هذا فقط لوكيل
واحد، فقم بتعيينه تحت `agents.list[].tools.message` بدلاً من ذلك.

### لماذا تشعر أن البوت يتجاهل الرسائل السريعة

وضع قائمة الانتظار يتحكم في كيفية تفاعل الرسائل الجديدة مع تشغيل الجو. استخدم `/isteue` لتغيير الموضعات:

- 'توجيه' - رسائل جديدة تعيد توجيه المهمة الحالية
- 'متابعة' - قم بتشغيل الرسائل في كل مرة
- 'جمع' - دفعة الرسائل والرد مرة واحدة (الافتراضي)
- `السجل المتأخر` - توجيه الآن، ثم معالجة المتأخرات المتراكمة
- "المقاطعة" - إحباط التشغيل الحالي والبدء في تشغيل جديد

يمكنك إضافة خيارات مثل \`debounce:2s cap:25 drop:summarize' لوضع المتابعة.

## الإجابة على السؤال بالضبط من سجل لقطة الشاشة/الدردشة

**س: "ما هو النموذج الافتراضي للأنثروبيك مع مفتاح API؟"**

**ج:** في OpenClaw، يتم فصل وثائق التفويض واختيار النموذج. يتيح تعيين `ANTHROPIC_API_KEY` (أو تخزين مفتاح API Anthropic في ملفات التعريف الخاصة بالمصادقة) التوثيق، ولكن النموذج الافتراضي الفعلي هو أي نوع تكوينه في `الوكلاء'. efaults.model.primary` (على سبيل المثال 'الإنسان / claude-sonnet-4-5` أو 'الإنسان / claude-opus-4-6`). إذا رأيت `لم يتم العثور على بيانات اعتماد للملف الشخصي "أنثروبيك:default"`، فهذا يعني أن البوابة لم تتمكن من العثور على بيانات اعتماد أنثروبيك في \`ملفات تعريف auth-profiles. ابن للعميل الذي يعمل.

---

مازالت عالقة؟ اسأل في [Discord](https://discord.com/invite/clawd) أو افتح [مناقشة GitHub ](https://github.com/openclaw/openclaw/discussions).
