---
summary: "خدمة تحكّم متكاملة في المتصفح + أوامر إجراءات"
read_when:
  - إضافة أتمتة متصفح يتحكّم بها الوكيل
  - تصحيح سبب تداخل openclaw مع Chrome الخاص بك
  - تنفيذ إعدادات المتصفح ودورة حياته في تطبيق macOS
title: "المتصفح (مُدار بواسطة OpenClaw)"
---

# المتصفح (مُدار بواسطة openclaw)

يمكن لـ OpenClaw تشغيل **ملف تعريف مخصّص لمتصفّحات Chrome/Brave/Edge/Chromium** يتحكّم به الوكيل.
وهو معزول عن متصفحك الشخصي ويُدار عبر خدمة تحكّم محلية صغيرة
داخل Gateway (حلقة محلية فقط).

عرض للمبتدئين:

- اعتبره **متصفحًا منفصلًا مخصّصًا للوكيل فقط**.
- ملف التعريف `openclaw` **لا** يمسّ ملف تعريف متصفحك الشخصي.
- يمكن للوكيل **فتح علامات تبويب وقراءة الصفحات والنقر والكتابة** ضمن مسار آمن.
- يستخدم ملف التعريف الافتراضي `chrome` **متصفح Chromium الافتراضي للنظام** عبر
  مرحّل الامتداد؛ بدّل إلى `openclaw` لاستخدام المتصفح المُدار المعزول.

## ما الذي تحصل عليه

- ملف تعريف متصفح منفصل باسم **openclaw** (بلمسة لونية برتقالية افتراضيًا).
- تحكّم حتمي في علامات التبويب (سرد/فتح/تركيز/إغلاق).
- إجراءات الوكيل (نقر/كتابة/سحب/تحديد)، لقطات، لقطات شاشة، ملفات PDF.
- دعم اختياري لملفات تعريف متعددة (`openclaw`، `work`، `remote`، ...).

هذا المتصفح **ليس** للاستخدام اليومي. إنه سطح آمن ومعزول
لأتمتة الوكيل والتحقق.

## البدء السريع

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

إذا ظهرت رسالة «Browser disabled»، فعِّله في التهيئة (انظر أدناه) وأعد تشغيل
Gateway.

## ملفات التعريف: `openclaw` مقابل `chrome`

- `openclaw`: متصفح مُدار ومعزول (لا يتطلب امتدادًا).
- `chrome`: مرحّل امتداد إلى **متصفح النظام** (يتطلب إرفاق امتداد OpenClaw
  بعلامة تبويب).

عيّن `browser.defaultProfile: "openclaw"` إذا كنت تريد وضع الإدارة افتراضيًا.

## التهيئة

توجد إعدادات المتصفح في `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

ملاحظات:

- ترتبط خدمة تحكّم المتصفح بحلقة محلية على منفذ مشتق من `gateway.port`
  (الافتراضي: `18791`، وهو gateway + 2). يستخدم المرحّل المنفذ التالي (`18792`).
- إذا تجاوزت منفذ Gateway (`gateway.port` أو `OPENCLAW_GATEWAY_PORT`)،
  فإن منافذ المتصفح المشتقة تتحرك للحفاظ على نفس «العائلة».
- افتراضيًا، يكون `cdpUrl` هو منفذ المرحّل عند عدم تعيينه.
- ينطبق `remoteCdpTimeoutMs` على فحوصات قابلية الوصول إلى CDP عن بُعد (غير حلقة محلية).
- ينطبق `remoteCdpHandshakeTimeoutMs` على فحوصات قابلية الوصول إلى WebSocket الخاص بـ CDP عن بُعد.
- يعني `attachOnly: true` «عدم إطلاق متصفح محلي أبدًا؛ الإرفاق فقط إذا كان يعمل بالفعل».
- يقوم `color` + `color` لكل ملف تعريف بتلوين واجهة المتصفح لتوضيح أي ملف تعريف نشط.
- ملف التعريف الافتراضي هو `chrome` (مرحّل الامتداد). استخدم `defaultProfile: "openclaw"` للمتصفح المُدار.
- ترتيب الاكتشاف التلقائي: متصفح النظام الافتراضي إذا كان قائمًا على Chromium؛ وإلا فـ Chrome → Brave → Edge → Chromium → Chrome Canary.
- تقوم ملفات تعريف `openclaw` المحلية بتعيين `cdpPort`/`cdpUrl` تلقائيًا — عيّنها فقط لـ CDP البعيد.

## استخدام Brave (أو متصفح آخر قائم على Chromium)

إذا كان **متصفح النظام الافتراضي** قائمًا على Chromium (Chrome/Brave/Edge/etc)،
فسيستخدمه OpenClaw تلقائيًا. عيّن `browser.executablePath` لتجاوز
الاكتشاف التلقائي:

مثال CLI:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## وحدة التحكم المحلية مقابل عن بعد

- **التحكّم المحلي (الافتراضي):** يقوم Gateway ببدء خدمة التحكّم بالحَلْقة المحلية ويمكنه إطلاق متصفح محلي.
- **التحكّم البعيد (مضيف عُقدة):** شغّل مضيف عُقدة على الجهاز الذي يحتوي المتصفح؛ يقوم Gateway بتمرير إجراءات المتصفح إليه.
- **CDP بعيد:** عيّن `browser.profiles.<name>.cdpUrl` (أو `browser.cdpUrl`) لـ
  الإرفاق بمتصفح قائم على Chromium عن بُعد. في هذه الحالة، لن يقوم OpenClaw بإطلاق متصفح محلي.

يمكن أن تتضمن عناوين URL الخاصة بـ CDP البعيد مصادقة:

- رموز الاستعلام (مثل `https://provider.example?token=<token>`)
- مصادقة HTTP Basic (مثل `https://user:pass@provider.example`)

يحافظ OpenClaw على المصادقة عند استدعاء نقاط النهاية `/json/*` وعند الاتصال
بـ WebSocket الخاص بـ CDP. يُفضّل استخدام متغيرات البيئة أو مديري الأسرار
للرموز بدلًا من تضمينها في ملفات التهيئة.

## وكيل متصفح العُقدة (افتراضي بلا تهيئة)

إذا شغّلت **مضيف عُقدة** على الجهاز الذي يحتوي متصفحك، يمكن لـ OpenClaw
توجيه استدعاءات أدوات المتصفح تلقائيًا إلى تلك العُقدة دون أي تهيئة إضافية للمتصفح.
هذا هو المسار الافتراضي لـ Gateways البعيدة.

ملاحظات:

- يكشف مضيف العُقدة عن خادم تحكّم المتصفح المحلي عبر **أمر وكيل**.
- تأتي ملفات التعريف من تهيئة `browser.profiles` الخاصة بالعُقدة (مثل المحلي).
- عطّله إذا لم تكن تريده:
  - على العُقدة: `nodeHost.browserProxy.enabled=false`
  - على Gateway: `gateway.nodes.browser.mode="off"`

## Browserless (CDP بعيد مُستضاف)

توفّر [Browserless](https://browserless.io) خدمة Chromium مُستضافة تكشف
نقاط نهاية CDP عبر HTTPS. يمكنك توجيه ملف تعريف متصفح OpenClaw إلى
نقطة نهاية إقليمية لـ Browserless والمصادقة باستخدام مفتاح API الخاص بك.

مثال:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

ملاحظات:

- استبدل `<BROWSERLESS_API_KEY>` برمز Browserless الحقيقي الخاص بك.
- اختر نقطة النهاية الإقليمية التي تطابق حساب Browserless لديك (انظر مستنداتهم).

## الأمان

أفكار أساسية:

- تحكّم المتصفح مقتصر على الحلقة المحلية؛ يمر الوصول عبر مصادقة Gateway أو اقتران العُقدة.
- أبقِ Gateway وأي مضيفي عُقدة على شبكة خاصة (Tailscale)؛ وتجنب التعريض العام.
- تعامل مع عناوين URL/رموز CDP البعيدة كأسرار؛ وفضّل متغيرات البيئة أو مدير أسرار.

نصائح CDP البعيد:

- فضّل نقاط نهاية HTTPS والرموز قصيرة العمر حيثما أمكن.
- تجنب تضمين رموز طويلة العمر مباشرة في ملفات التهيئة.

## ملفات التعريف (متعدد المتصفحات)

يدعم OpenClaw عدة ملفات تعريف مسمّاة (تهيئات توجيه). يمكن أن تكون ملفات التعريف:

- **openclaw-managed**: مثيل متصفح قائم على Chromium مخصّص مع دليل بيانات مستخدم خاص + منفذ CDP
- **remote**: عنوان URL صريح لـ CDP (متصفح قائم على Chromium يعمل في مكان آخر)
- **extension relay**: علامات تبويب Chrome الحالية لديك عبر المرحّل المحلي + امتداد Chrome

الافتراضيات:

- يتم إنشاء ملف التعريف `openclaw` تلقائيًا إذا كان مفقودًا.
- ملف التعريف `chrome` مدمج لمرحّل امتداد Chrome (يشير إلى `http://127.0.0.1:18792` افتراضيًا).
- يتم تخصيص منافذ CDP المحلية من **18800–18899** افتراضيًا.
- يؤدي حذف ملف تعريف إلى نقل دليل بياناته المحلي إلى سلة المهملات.

تقبل جميع نقاط نهاية التحكّم `?profile=<name>`؛ ويستخدم CLI `--browser-profile`.

## مرحّل امتداد Chrome (استخدم Chrome الحالي لديك)

يمكن لـ OpenClaw أيضًا قيادة **علامات تبويب Chrome الحالية لديك** (دون مثيل Chrome «openclaw» منفصل) عبر مرحّل CDP محلي + امتداد Chrome.

الدليل الكامل: [امتداد Chrome](/tools/chrome-extension)

التدفّق:

- يعمل Gateway محليًا (على نفس الجهاز) أو يعمل مضيف عُقدة على جهاز المتصفح.
- يستمع **خادم مرحّل** محلي عند حلقة محلية `cdpUrl` (الافتراضي: `http://127.0.0.1:18792`).
- تنقر أيقونة امتداد **OpenClaw Browser Relay** على علامة تبويب للإرفاق (لا يتم الإرفاق تلقائيًا).
- يتحكّم الوكيل بتلك العلامة عبر أداة `browser` المعتادة، باختيار ملف التعريف الصحيح.

إذا كان Gateway يعمل في مكان آخر، شغّل مضيف عُقدة على جهاز المتصفح حتى يتمكن Gateway من تمرير إجراءات المتصفح.

### جلسات sandboxed

إذا كانت جلسة الوكيل sandboxed، فقد تُعيَّن أداة `browser` افتراضيًا إلى `target="sandbox"` (متصفح sandbox).
يتطلب الاستيلاء عبر مرحّل امتداد Chrome تحكّمًا في متصفح المضيف، لذا إمّا:

- تشغيل الجلسة بدون sandbox، أو
- تعيين `agents.defaults.sandbox.browser.allowHostControl: true` واستخدام `target="host"` عند استدعاء الأداة.

### الإعداد

1. تحميل الامتداد (تطوير/غير مُعبّأ):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → تمكين «وضع المطوّر»
- «Load unpacked» → اختر الدليل الذي يطبعه `openclaw browser extension path`
- ثبّت الامتداد، ثم انقره على علامة التبويب التي تريد التحكّم بها (تُظهر الشارة `ON`).

2. الاستخدام:

- CLI: `openclaw browser --browser-profile chrome tabs`
- أداة الوكيل: `browser` مع `profile="chrome"`

اختياري: إذا أردت اسمًا مختلفًا أو منفذ مرحّل مختلفًا، أنشئ ملف تعريفك الخاص:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

ملاحظات:

- يعتمد هذا الوضع على Playwright-on-CDP لمعظم العمليات (لقطات شاشة/لقطات/إجراءات).
- افصل الإرفاق بالنقر على أيقونة الامتداد مرة أخرى.

## ضمانات العزل

- **دليل بيانات مستخدم مخصّص**: لا يلمس ملف تعريف متصفحك الشخصي.
- **منافذ مخصّصة**: تتجنب `9222` لمنع التعارض مع سير عمل التطوير.
- **تحكّم حتمي في علامات التبويب**: استهداف علامات التبويب عبر `targetId`، وليس «آخر علامة».

## اختيار المتصفح

عند الإطلاق محليًا، يختار OpenClaw أول متاح:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

يمكنك التجاوز باستخدام `browser.executablePath`.

المنصّات:

- macOS: يتحقق من `/Applications` و `~/Applications`.
- Linux: يبحث عن `google-chrome`، `brave`، `microsoft-edge`، `chromium`، إلخ.
- Windows: يتحقق من مواقع التثبيت الشائعة.

## تحكم API (اختياري)

للتكاملات المحلية فقط، يوفّر Gateway واجهة HTTP صغيرة على الحلقة المحلية:

- الحالة/البدء/الإيقاف: `GET /`، `POST /start`، `POST /stop`
- علامات التبويب: `GET /tabs`، `POST /tabs/open`، `POST /tabs/focus`، `DELETE /tabs/:targetId`
- لقطة/لقطة شاشة: `GET /snapshot`، `POST /screenshot`
- إجراءات: `POST /navigate`، `POST /act`
- Hooks: `POST /hooks/file-chooser`، `POST /hooks/dialog`
- التنزيلات: `POST /download`، `POST /wait/download`
- تصحيح: `GET /console`، `POST /pdf`
- تصحيح: `GET /errors`، `GET /requests`، `POST /trace/start`، `POST /trace/stop`، `POST /highlight`
- الشبكة: `POST /response/body`
- الحالة: `GET /cookies`، `POST /cookies/set`، `POST /cookies/clear`
- الحالة: `GET /storage/:kind`، `POST /storage/:kind/set`، `POST /storage/:kind/clear`
- الإعدادات: `POST /set/offline`، `POST /set/headers`، `POST /set/credentials`، `POST /set/geolocation`، `POST /set/media`، `POST /set/timezone`، `POST /set/locale`، `POST /set/device`

تقبل جميع نقاط النهاية `?profile=<name>`.

### متطلب Playwright

تتطلب بعض الميزات (التنقّل/الإجراء/لقطة AI/لقطة الدور، لقطات عناصر، PDF)
Playwright. إذا لم يكن Playwright مثبتًا، فستعيد تلك النقاط خطأ 501
واضحًا. تظل لقطات ARIA ولقطات الشاشة الأساسية تعمل لـ Chrome المُدار بواسطة openclaw.
وبالنسبة لمشغّل مرحّل امتداد Chrome، تتطلب لقطات ARIA ولقطات الشاشة Playwright.

إذا رأيت `Playwright is not available in this gateway build`، فقم بتثبيت
حزمة Playwright الكاملة (وليس `playwright-core`) وأعد تشغيل gateway، أو أعد تثبيت
OpenClaw مع دعم المتصفح.

#### تثبيت Playwright في Docker

إذا كان Gateway يعمل داخل Docker، فتجنب `npx playwright` (تعارضات تجاوز npm).
استخدم CLI المضمّن بدلًا من ذلك:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

للاحتفاظ بتنزيلات المتصفح، عيّن `PLAYWRIGHT_BROWSERS_PATH` (على سبيل المثال،
`/home/node/.cache/ms-playwright`) وتأكد من أن `/home/node` محفوظ عبر
`OPENCLAW_HOME_VOLUME` أو ربط مجلّد. انظر [Docker](/install/docker).

## كيف يعمل (داخليًا)

التدفّق عالي المستوى:

- يقبل **خادم تحكّم** صغير طلبات HTTP.
- يتصل بمتصفحات قائمة على Chromium (Chrome/Brave/Edge/Chromium) عبر **CDP**.
- للإجراءات المتقدمة (نقر/كتابة/لقطة/PDF)، يستخدم **Playwright** فوق
  CDP.
- عند غياب Playwright، تتوفر فقط العمليات غير المعتمدة على Playwright.

يحافظ هذا التصميم على واجهة مستقرة وحتمية للوكيل مع السماح
بتبديل المتصفحات والملفات التعريفية محليًا/عن بُعد.

## مرجع CLI السريع

تقبل جميع الأوامر `--browser-profile <name>` لاستهداف ملف تعريف محدد.
كما تقبل جميع الأوامر `--json` لإخراج قابل للقراءة آليًا (حِزم ثابتة).

الأساسيات:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

الفحص:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

الإجراءات:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

الحالة:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

ملاحظات:

- `upload` و `dialog` هما استدعاءات **تسليح**؛ شغّلهما قبل النقر/الضغط
  الذي يطلق أداة الاختيار/الحوار.
- يمكن لـ `upload` أيضًا تعيين مدخلات الملفات مباشرة عبر `--input-ref` أو `--element`.
- `snapshot`:
  - `--format ai` (الافتراضي عند تثبيت Playwright): يعيد لقطة AI مع مراجع رقمية (`aria-ref="<n>"`).
  - `--format aria`: يعيد شجرة إمكانية الوصول (بدون مراجع؛ للفحص فقط).
  - `--efficient` (أو `--mode efficient`): إعداد لقطة دور مدمجة (تفاعلية + مدمجة + عمق + حد أقصى أقل لـ maxChars).
  - الافتراضي في التهيئة (للأداة/CLI فقط): عيّن `browser.snapshotDefaults.mode: "efficient"` لاستخدام لقطات فعّالة عندما لا يمرّر المستدعي وضعًا (انظر [تهيئة Gateway](/gateway/configuration#browser-openclaw-managed-browser)).
  - خيارات لقطة الدور (`--interactive`، `--compact`، `--depth`، `--selector`) تفرض لقطة قائمة على الدور مع مراجع مثل `ref=e12`.
  - يحدّد `--frame "<iframe selector>"` نطاق لقطات الدور إلى iframe (يتزاوج مع مراجع الدور مثل `e12`).
  - ينتج `--interactive` قائمة مسطّحة سهلة الاختيار للعناصر التفاعلية (الأفضل لقيادة الإجراءات).
  - يضيف `--labels` لقطة شاشة للمنفذ المرئي فقط مع تسميات مراجع متراكبة (يطبع `MEDIA:<path>`).
- تتطلب `click`/`type`/إلخ وجود `ref` من `snapshot` (إما رقمية `12` أو مرجع دور `e12`).
  لا يتم دعم محددات CSS للإجراءات عمدًا.

## اللقطات والمراجع

يدعم OpenClaw نمطين من «اللقطات»:

- **لقطة AI (مراجع رقمية)**: `openclaw browser snapshot` (الافتراضي؛ `--format ai`)
  - المخرجات: لقطة نصية تتضمن مراجع رقمية.
  - الإجراءات: `openclaw browser click 12`، `openclaw browser type 23 "hello"`.
  - داخليًا، يُحل المرجع عبر `aria-ref` الخاص بـ Playwright.

- **لقطة الدور (مراجع دور مثل `e12`)**: `openclaw browser snapshot --interactive` (أو `--compact`، `--depth`، `--selector`، `--frame`)
  - المخرجات: قائمة/شجرة قائمة على الدور مع `[ref=e12]` (واختياريًا `[nth=1]`).
  - الإجراءات: `openclaw browser click e12`، `openclaw browser highlight e12`.
  - داخليًا، يُحل المرجع عبر `getByRole(...)` (بالإضافة إلى `nth()` للتكرارات).
  - أضف `--labels` لتضمين لقطة شاشة للمنفذ المرئي مع تسميات `e12` متراكبة.

سلوك المراجع:

- المراجع **غير مستقرة عبر عمليات التنقّل**؛ إذا فشل شيء، أعد تشغيل `snapshot` واستخدم مرجعًا جديدًا.
- إذا أُخذت لقطة الدور مع `--frame`، فستكون مراجع الدور ضمن نطاق ذلك iframe حتى لقطة الدور التالية.

## انتظر الطاقة

يمكنك الانتظار لأكثر من الوقت/النص:

- الانتظار لعنوان URL (يدعم الأنماط الشاملة بواسطة Playwright):
  - `openclaw browser wait --url "**/dash"`
- الانتظار لحالة التحميل:
  - `openclaw browser wait --load networkidle`
- الانتظار لشرط JavaScript:
  - `openclaw browser wait --fn "window.ready===true"`
- الانتظار لظهور محدد:
  - `openclaw browser wait "#main"`

يمكن دمج هذه:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## تصحيح مسار العمل

عندما يفشل إجراء (مثل «غير مرئي»، «انتهاك الوضع الصارم»، «مغطّى»):

1. `openclaw browser snapshot --interactive`
2. استخدم `click <ref>` / `type <ref>` (فضّل مراجع الدور في الوضع التفاعلي)
3. إذا استمر الفشل: `openclaw browser highlight <ref>` لمعرفة ما يستهدفه Playwright
4. إذا تصرفت الصفحة بغرابة:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. لتصحيح الأخطاء العميقة: تسجيل التتبع:
   - `openclaw browser trace start`
   - أعد إنتاج المشكلة
   - `openclaw browser trace stop` (يطبع `TRACE:<path>`)

## إخراج JSON

`--json` مخصّص للبرمجة والأدوات المهيكلة.

أمثلة:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

تتضمن لقطات الدور في JSON `refs` بالإضافة إلى كتلة `stats` صغيرة (أسطر/محارف/مراجع/تفاعلية) حتى تتمكن الأدوات من تقدير حجم وكثافة الحمولة.

## مفاتيح الحالة والبيئة

تفيد هذه في سير عمل «اجعل الموقع يتصرف مثل X»:

- ملفات تعريف الارتباط: `cookies`، `cookies set`، `cookies clear`
- التخزين: `storage local|session get|set|clear`
- دون اتصال: `set offline on|off`
- الرؤوس: `set headers --json '{"X-Debug":"1"}'` (أو `--clear`)
- مصادقة HTTP basic: `set credentials user pass` (أو `--clear`)
- تحديد الموقع الجغرافي: `set geo <lat> <lon> --origin "https://example.com"` (أو `--clear`)
- الوسائط: `set media dark|light|no-preference|none`
- المنطقة الزمنية / اللغة: `set timezone ...`، `set locale ...`
- الجهاز / المنفذ المرئي:
  - `set device "iPhone 14"` (إعدادات أجهزة Playwright)
  - `set viewport 1280 720`

## الأمان والخصوصية

- قد يحتوي ملف تعريف متصفح openclaw على جلسات مسجّلة الدخول؛ تعامل معه بحساسية.
- تنفّذ `browser act kind=evaluate` / `openclaw browser evaluate` و `wait --fn`
  تعليمات JavaScript عشوائية في سياق الصفحة. يمكن لحقن المطالبات توجيه
  ذلك. عطّله باستخدام `browser.evaluateEnabled=false` إذا لم تكن بحاجة إليه.
- لملاحظات تسجيل الدخول ومكافحة الروبوتات (X/Twitter، إلخ)، راجع [تسجيل الدخول للمتصفح + النشر على X/Twitter](/tools/browser-login).
- أبقِ Gateway/مضيف العُقدة خاصًا (حلقة محلية أو شبكة tailnet فقط).
- نقاط نهاية CDP البعيدة قوية؛ قم بتمريرها عبر نفق وحمايتها.

## استكشاف الأخطاء وإصلاحها

للمشكلات الخاصة بـ Linux (خصوصًا Chromium بنظام snap)، راجع
[استكشاف أخطاء المتصفح وإصلاحها](/tools/browser-linux-troubleshooting).

## أدوات الوكيل + كيفية عمل التحكّم

يحصل الوكيل على **أداة واحدة** لأتمتة المتصفح:

- `browser` — الحالة/البدء/الإيقاف/علامات التبويب/فتح/تركيز/إغلاق/لقطة/لقطة شاشة/تنقّل/إجراء

كيفية الربط:

- يعيد `browser snapshot` شجرة واجهة مستخدم مستقرة (AI أو ARIA).
- يستخدم `browser act` معرفات اللقطة `ref` للنقر/الكتابة/السحب/التحديد.
- يلتقط `browser screenshot` البكسلات (الصفحة كاملة أو عنصر).
- يقبل `browser`:
  - `profile` لاختيار ملف تعريف متصفح مسمّى (openclaw أو chrome أو CDP بعيد).
  - `target` (`sandbox` | `host` | `node`) لتحديد مكان المتصفح.
  - في الجلسات sandboxed، يتطلب `target: "host"` وجود `agents.defaults.sandbox.browser.allowHostControl=true`.
  - إذا تم حذف `target`: تُعيَّن الجلسات sandboxed افتراضيًا إلى `sandbox`، بينما تُعيَّن الجلسات غير sandbox افتراضيًا إلى `host`.
  - إذا كان متصلًا مضيف عُقدة قادر على المتصفح، فقد تُوجَّه الأداة تلقائيًا إليه ما لم تثبّت `target="host"` أو `target="node"`.

يحافظ هذا على حتمية الوكيل ويتجنب محددات هشة.
