---
summary: "npm + macOS ایپ کے لیے مرحلہ وار ریلیز چیک لسٹ"
read_when:
  - نئی npm ریلیز جاری کرتے وقت
  - نئی macOS ایپ ریلیز جاری کرتے وقت
  - شائع کرنے سے پہلے میٹاڈیٹا کی تصدیق کرتے وقت
---

# ریلیز چیک لسٹ (npm + macOS)

ریپو روٹ سے `pnpm` (Node 22+) استعمال کریں۔ ٹیگ/پبلش کرنے سے پہلے ورکنگ ٹری کو صاف رکھیں۔

## آپریٹر ٹرگر

جب آپریٹر “release” کہے، فوراً یہ پری فلائٹ کریں (جب تک رکاوٹ نہ ہو کوئی اضافی سوال نہ کریں):

- اس دستاویز اور `docs/platforms/mac/release.md` کو پڑھیں۔
- `~/.profile` سے env لوڈ کریں اور تصدیق کریں کہ `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect ویری ایبلز سیٹ ہیں (SPARKLE_PRIVATE_KEY_FILE کو `~/.profile` میں ہونا چاہیے)۔
- اگر ضرورت ہو تو `~/Library/CloudStorage/Dropbox/Backup/Sparkle` سے Sparkle کیز استعمال کریں۔

1. **ورژن اور میٹاڈیٹا**

- [ ] `package.json` ورژن بڑھائیں (مثلاً `2026.1.29`)۔
- [ ] ایکسٹینشن پیکیج ورژنز + چینج لاگز ہم آہنگ کرنے کے لیے `pnpm plugins:sync` چلائیں۔
- [ ] CLI/ورژن اسٹرنگز اپڈیٹ کریں: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) اور Baileys یوزر ایجنٹ [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) میں۔
- [ ] پیکیج میٹاڈیٹا (نام، تفصیل، ریپوزٹری، کی ورڈز، لائسنس) کی تصدیق کریں اور یہ کہ `bin` میپ `openclaw` کے لیے [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) کی طرف اشارہ کرتا ہے۔
- [ ] اگر ڈیپنڈنسیز بدلی ہیں تو `pnpm install` چلائیں تاکہ `pnpm-lock.yaml` تازہ ہو۔

2. **بلڈ اور آرٹی فیکٹس**

- [ ] اگر A2UI ان پٹس بدلے ہیں تو `pnpm canvas:a2ui:bundle` چلائیں اور کسی بھی اپڈیٹ شدہ [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) کو کمیٹ کریں۔
- [ ] `pnpm run build` (جس سے `dist/` دوبارہ بنتا ہے)۔
- [ ] تصدیق کریں کہ npm پیکیج `files` میں تمام مطلوبہ `dist/*` فولڈرز شامل ہیں (خصوصاً `dist/node-host/**` اور `dist/acp/**` ہیڈلیس نوڈ + ACP CLI کے لیے)۔
- [ ] تصدیق کریں کہ `dist/build-info.json` موجود ہے اور اس میں متوقع `commit` ہیش شامل ہے (CLI بینر npm انسٹالز کے لیے یہی استعمال کرتا ہے)۔
- [ ] اختیاری: بلڈ کے بعد `npm pack --pack-destination /tmp`؛ ٹاربال کے مواد کا معائنہ کریں اور GitHub ریلیز کے لیے محفوظ رکھیں (اسے **کمیٹ نہ کریں**)۔

3. **چینج لاگ اور دستاویزات**

- [ ] `CHANGELOG.md` کو صارف کے سامنے نمایاں نکات کے ساتھ اپڈیٹ کریں (اگر فائل موجود نہ ہو تو بنائیں)؛ اندراجات کو ورژن کے لحاظ سے سختی سے نزولی ترتیب میں رکھیں۔
- [ ] یقینی بنائیں کہ README کی مثالیں/فلگز موجودہ CLI رویے سے مطابقت رکھتے ہیں (خاص طور پر نئی کمانڈز یا اختیارات)۔

4. **تصدیق**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (یا اگر کوریج آؤٹ پٹ درکار ہو تو `pnpm test:coverage`)
- [ ] `pnpm release:check` (npm pack کے مواد کی تصدیق کرتا ہے)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker انسٹال اسموک ٹیسٹ، فاسٹ پاتھ؛ ریلیز سے پہلے لازم)
  - اگر فوراً پچھلی npm ریلیز معلوم طور پر خراب ہو تو پری انسٹال مرحلے کے لیے `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` یا `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` سیٹ کریں۔
- [ ] (اختیاری) مکمل انسٹالر اسموک (نان روٹ + CLI کوریج شامل کرتا ہے): `pnpm test:install:smoke`
- [ ] (اختیاری) انسٹالر E2E (Docker، `curl -fsSL https://openclaw.ai/install.sh | bash` چلاتا ہے، آن بورڈ کرتا ہے، پھر حقیقی ٹول کالز چلاتا ہے):
  - `pnpm test:install:e2e:openai` (درکار: `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (درکار: `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (دونوں کیز درکار؛ دونوں فراہم کنندگان چلاتا ہے)
- [ ] (اختیاری) اگر تبدیلیاں send/receive راستوں کو متاثر کرتی ہوں تو ویب گیٹ وے کی اسپاٹ چیک کریں۔

5. **macOS ایپ (Sparkle)**

- [ ] macOS ایپ بلڈ + سائن کریں، پھر تقسیم کے لیے zip بنائیں۔
- [ ] Sparkle ایپ کاسٹ بنائیں (HTML نوٹس [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) کے ذریعے) اور `appcast.xml` اپڈیٹ کریں۔
- [ ] ایپ zip (اور اختیاری dSYM zip) کو GitHub ریلیز کے ساتھ منسلک کرنے کے لیے تیار رکھیں۔
- [ ] درست کمانڈز اور مطلوبہ env vars کے لیے [macOS release](/platforms/mac/release) پر عمل کریں۔
  - `APP_BUILD` لازماً عددی + یکساں بڑھتا ہوا ہو (کوئی `-beta` نہیں) تاکہ Sparkle ورژنز کا درست موازنہ کرے۔
  - اگر نوٹریائزیشن کر رہے ہوں تو App Store Connect API env vars سے بنے ہوئے `openclaw-notary` کی چین پروفائل استعمال کریں (دیکھیں [macOS release](/platforms/mac/release))۔

6. **شائع کریں (npm)**

- [ ] تصدیق کریں کہ git اسٹیٹس صاف ہے؛ ضرورت کے مطابق کمیٹ اور پُش کریں۔
- [ ] ضرورت ہو تو `npm login` (2FA کی تصدیق)۔
- [ ] `npm publish --access public` (پری ریلیزز کے لیے `--tag beta` استعمال کریں)۔
- [ ] رجسٹری کی تصدیق کریں: `npm view openclaw version`، `npm view openclaw dist-tags`، اور `npx -y openclaw@X.Y.Z --version` (یا `--help`)۔

### خرابیوں کا ازالہ (2.0.0-beta2 ریلیز سے نوٹس)

- **npm pack/publish لٹک جاتا ہے یا بہت بڑا ٹاربال بناتا ہے**: `dist/OpenClaw.app` میں موجود macOS ایپ بنڈل (اور ریلیز زپس) پیکیج میں شامل ہو جاتے ہیں۔ حل: `package.json` کے `files` کے ذریعے پبلش مواد کو وائٹ لسٹ کریں (dist سب ڈائریکٹریز، ڈاکس، اسکلز شامل کریں؛ ایپ بنڈلز خارج کریں)۔ `npm pack --dry-run` کے ذریعے تصدیق کریں کہ `dist/OpenClaw.app` درج نہیں ہے۔
- **dist-tags کے لیے npm auth ویب لوپ**: OTP پرامپٹ حاصل کرنے کے لیے لیگیسی auth استعمال کریں:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` کی تصدیق `ECOMPROMISED: Lock compromised` کے ساتھ ناکام ہوتی ہے**: تازہ کیش کے ساتھ دوبارہ کوشش کریں:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **دیر سے فکس کے بعد ٹیگ کو دوبارہ پوائنٹ کرنا ہو**: ٹیگ کو فورس اپڈیٹ کریں اور پُش کریں، پھر یقینی بنائیں کہ GitHub ریلیز کے اثاثے اب بھی مطابقت رکھتے ہیں:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub ریلیز + ایپ کاسٹ**

- [ ] ٹیگ کریں اور پُش کریں: `git tag vX.Y.Z && git push origin vX.Y.Z` (یا `git push --tags`)۔
- [ ] `vX.Y.Z` کے لیے GitHub ریلیز بنائیں/تازہ کریں جس کا **عنوان `openclaw X.Y.Z`** ہو (صرف ٹیگ نہیں)؛ باڈی میں اس ورژن کے لیے **مکمل** چینج لاگ سیکشن (Highlights + Changes + Fixes) شامل ہونا چاہیے، inline (خالی لنکس نہیں)، اور **باڈی کے اندر عنوان دوبارہ نہ دہرایا جائے**۔
- [ ] اثاثے منسلک کریں: `npm pack` ٹاربال (اختیاری)، `OpenClaw-X.Y.Z.zip`، اور `OpenClaw-X.Y.Z.dSYM.zip` (اگر بنائے گئے ہوں)۔
- [ ] اپڈیٹ شدہ `appcast.xml` کو کمیٹ کریں اور پُش کریں (Sparkle main سے فیڈ لیتا ہے)۔
- [ ] ایک صاف عارضی ڈائریکٹری سے (کوئی `package.json` نہیں)، `npx -y openclaw@X.Y.Z send --help` چلائیں تاکہ انسٹال/CLI انٹری پوائنٹس کی تصدیق ہو سکے۔
- [ ] اعلان کریں/ریلیز نوٹس شیئر کریں۔

## پلگ اِن پبلش اسکوپ (npm)

ہم صرف **موجودہ npm پلگ اِنز** کو `@openclaw/*` اسکوپ کے تحت شائع کرتے ہیں۔ وہ بنڈلڈ
پلگ اِنز جو npm پر نہیں ہیں **صرف ڈسک ٹری** رہتے ہیں (پھر بھی
`extensions/**` میں بھیجے جاتے ہیں)۔

فہرست اخذ کرنے کا عمل:

1. `npm search @openclaw --json` چلائیں اور پیکیج نام حاصل کریں۔
2. `extensions/*/package.json` ناموں کے ساتھ موازنہ کریں۔
3. صرف **انٹرسیکشن** (جو پہلے سے npm پر ہیں) شائع کریں۔

موجودہ npm پلگ اِن فہرست (ضرورت کے مطابق اپڈیٹ کریں):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

ریلیز نوٹس میں **نئے اختیاری بنڈل پلگ اِنز** کا بھی ذکر ہونا چاہیے جو **بطورِ طے شدہ فعال نہیں** ہوتے (مثال: `tlon`)۔
