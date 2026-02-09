---
summary: "npm + macOS အက်ပ်အတွက် အဆင့်လိုက် ထုတ်ပြန်မှု စစ်ဆေးစာရင်း"
read_when:
  - npm ထုတ်ပြန်မှု အသစ်တစ်ခု ပြုလုပ်နေချိန်
  - macOS အက်ပ် ထုတ်ပြန်မှု အသစ်တစ်ခု ပြုလုပ်နေချိန်
  - ထုတ်ပြန်မီ မီတာဒေတာများကို စစ်ဆေးနေချိန်
---

# ထုတ်ပြန်မှု စစ်ဆေးစာရင်း (npm + macOS)

repo root မှ `pnpm` (Node 22+) ကို အသုံးပြုပါ။ tagging/publishing မလုပ်မီ working tree ကို သန့်ရှင်းအောင် ထိန်းသိမ်းထားပါ။

## Operator trigger

Operator က “release” ဟု ပြောလာသောအခါ (တားဆီးမှုမရှိလျှင် မေးခွန်းမထပ်မံမေးဘဲ) အောက်ပါ preflight ကို ချက်ချင်း လုပ်ဆောင်ပါ။

- ဒီစာတမ်းနှင့် `docs/platforms/mac/release.md` ကို ဖတ်ပါ။
- `~/.profile` မှ env ကို load လုပ်ပြီး `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect ကိန်းရှင်များ သတ်မှတ်ထားကြောင်း အတည်ပြုပါ (SPARKLE_PRIVATE_KEY_FILE ကို `~/.profile` အောက်တွင် ထားရှိရမည်)။
- လိုအပ်ပါက `~/Library/CloudStorage/Dropbox/Backup/Sparkle` မှ Sparkle keys ကို အသုံးပြုပါ။

1. **ဗားရှင်း & မီတာဒေတာ**

- [ ] `package.json` ဗားရှင်းကို မြှင့်တင်ပါ (ဥပမာ `2026.1.29`)။
- [ ] extension package ဗားရှင်းများ + changelog များကို ကိုက်ညီအောင် `pnpm plugins:sync` ကို လုပ်ဆောင်ပါ။
- [ ] CLI/ဗားရှင်း စာကြောင်းများကို အပ်ဒိတ်လုပ်ပါ: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) နှင့် [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) ထဲရှိ Baileys user agent။
- [ ] package မီတာဒေတာများ (name, description, repository, keywords, license) ကို အတည်ပြုပြီး `bin` map သည် `openclaw` အတွက် [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) ကို ညွှန်ပြထားကြောင်း စစ်ဆေးပါ။
- [ ] dependencies ပြောင်းလဲခဲ့ပါက `pnpm install` ကို လုပ်ဆောင်၍ `pnpm-lock.yaml` ကို လက်ရှိအခြေအနေဖြစ်အောင် ပြုလုပ်ပါ။

2. **Build & artifacts**

- [ ] A2UI inputs ပြောင်းလဲခဲ့ပါက `pnpm canvas:a2ui:bundle` ကို လုပ်ဆောင်ပြီး အပ်ဒိတ်ဖြစ်သည့် [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) ကို commit လုပ်ပါ။
- [ ] `pnpm run build` ( `dist/` ကို ပြန်လည်ထုတ်လုပ်ပေးသည်)။
- [ ] npm package `files` ထဲတွင် လိုအပ်သော `dist/*` ဖိုလ်ဒါများ အားလုံး ပါဝင်ကြောင်း စစ်ဆေးပါ (အထူးသဖြင့် headless node + ACP CLI အတွက် `dist/node-host/**` နှင့် `dist/acp/**`)။
- [ ] `dist/build-info.json` ရှိကြောင်းနှင့် မျှော်မှန်းထားသော `commit` hash ပါဝင်ကြောင်း အတည်ပြုပါ (CLI banner သည် npm installs အတွက် ဤ hash ကို အသုံးပြုသည်)။
- [ ] မလိုအပ်ပါက: build ပြီးနောက် `npm pack --pack-destination /tmp` ကို လုပ်ဆောင်၍ tarball အကြောင်းအရာများကို စစ်ဆေးပြီး GitHub release အတွက် အသင့်ထားပါ (commit မလုပ်ရ)။

3. **Changelog & docs**

- [ ] `CHANGELOG.md` ကို အသုံးပြုသူ မျက်နှာပြင်အတွက် အထူးအချက်များဖြင့် အပ်ဒိတ်လုပ်ပါ (မရှိပါက ဖိုင်အသစ် ဖန်တီးပါ)၊ entry များကို ဗားရှင်းအလိုက် တင်းကျပ်စွာ အနိမ့်သို့ ဆင်းစီထားပါ။
- [ ] README ဥပမာများ/flags များသည် လက်ရှိ CLI အပြုအမူနှင့် ကိုက်ညီကြောင်း အတည်ပြုပါ (အထူးသဖြင့် command သို့မဟုတ် option အသစ်များ)။

4. **အတည်ပြုခြင်း**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (သို့မဟုတ် coverage output လိုအပ်ပါက `pnpm test:coverage`)
- [ ] `pnpm release:check` (npm pack အကြောင်းအရာများကို စစ်ဆေးသည်)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker install smoke test, fast path; ထုတ်ပြန်မီ မဖြစ်မနေ လိုအပ်)
  - ယခင် npm ထုတ်ပြန်မှု ချက်ချင်းမတိုင်မီ အလုပ်မလုပ်ကြောင်း သိထားပါက preinstall အဆင့်အတွက် `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` သို့မဟုတ် `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` ကို သတ်မှတ်ပါ။
- [ ] (Optional) Installer smoke အပြည့်အစုံ (non-root + CLI coverage ထည့်သွင်းသည်): `pnpm test:install:smoke`
- [ ] (Optional) Installer E2E (Docker, `curl -fsSL https://openclaw.ai/install.sh | bash` ကို လုပ်ဆောင်ပြီး onboarding ပြီးနောက် အမှန်တကယ် tool calls များကို လုပ်ဆောင်သည်):
  - `pnpm test:install:e2e:openai` (`OPENAI_API_KEY` လိုအပ်)
  - `pnpm test:install:e2e:anthropic` (`ANTHROPIC_API_KEY` လိုအပ်)
  - `pnpm test:install:e2e` (key နှစ်ခုလုံး လိုအပ်; provider နှစ်ခုလုံးကို လုပ်ဆောင်သည်)
- [ ] (Optional) သင့်ပြောင်းလဲမှုများက send/receive လမ်းကြောင်းများကို သက်ရောက်ပါက web gateway ကို အကျဉ်းချုပ် စစ်ဆေးပါ။

5. **macOS အက်ပ် (Sparkle)**

- [ ] macOS အက်ပ်ကို build + sign လုပ်ပြီး ဖြန့်ချိရန် zip ပြုလုပ်ပါ။
- [ ] Sparkle appcast ကို ထုတ်လုပ်ပါ (HTML မှတ်စုများကို [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) ဖြင့်) နှင့် `appcast.xml` ကို အပ်ဒိတ်လုပ်ပါ။
- [ ] GitHub release တွင် တွဲတင်ရန် app zip (နှင့် optional dSYM zip) ကို အသင့်ထားပါ။
- [ ] လိုအပ်သော command များနှင့် env vars များအတွက် [macOS release](/platforms/mac/release) ကို လိုက်နာပါ။
  - Sparkle က ဗားရှင်းများကို မှန်ကန်စွာ နှိုင်းယှဉ်နိုင်ရန် `APP_BUILD` သည် numeric + monotonic ဖြစ်ရမည် (`-beta` မပါ)။
  - notarize လုပ်ပါက App Store Connect API env vars များမှ ဖန်တီးထားသော `openclaw-notary` keychain profile ကို အသုံးပြုပါ ([macOS release](/platforms/mac/release) ကို ကြည့်ပါ)။

6. **Publish (npm)**

- [ ] git status သန့်ရှင်းကြောင်း အတည်ပြုပါ; လိုအပ်ပါက commit နှင့် push လုပ်ပါ။
- [ ] လိုအပ်ပါက `npm login` (2FA စစ်ဆေး)။
- [ ] `npm publish --access public` (pre-release များအတွက် `--tag beta` ကို အသုံးပြုပါ)။
- [ ] registry ကို စစ်ဆေးပါ: `npm view openclaw version`, `npm view openclaw dist-tags`, နှင့် `npx -y openclaw@X.Y.Z --version` (သို့မဟုတ် `--help`)။

### Troubleshooting (2.0.0-beta2 ထုတ်ပြန်မှုမှ မှတ်စုများ)

- **npm pack/publish ရပ်တန့်ခြင်း သို့မဟုတ် အလွန်ကြီးမားသော tarball ထွက်လာခြင်း**: `dist/OpenClaw.app` ထဲရှိ macOS app bundle (နှင့် release zips များ) ကို package ထဲသို့ ထည့်သွင်းသွားခြင်းကြောင့် ဖြစ်ပါသည်။ `package.json` ရှိ `files` ဖြင့် publish contents ကို whitelist လုပ်ခြင်းအားဖြင့် ပြင်ဆင်ပါ (dist subdirs, docs, skills များကို ထည့်ပြီး app bundles များကို ဖယ်ရှားပါ)။ `npm pack --dry-run` ဖြင့် `dist/OpenClaw.app` ကို စာရင်းမပါဝင်ကြောင်း အတည်ပြုပါ။
- **dist-tags အတွက် npm auth web loop**: OTP prompt ရရန် legacy auth ကို အသုံးပြုပါ—
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` စစ်ဆေးမှုသည် `ECOMPROMISED: Lock compromised` ဖြင့် မအောင်မြင်ခြင်း**: cache အသစ်ဖြင့် ထပ်မံကြိုးစားပါ—
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **နောက်ကျမှ ပြင်ဆင်မှုကြောင့် tag ကို ပြန်ညွှန်းရခြင်း**: tag ကို force-update လုပ်ပြီး push လုပ်ပါ၊ ထို့နောက် GitHub release assets များ ကိုက်ညီနေကြောင်း အတည်ပြုပါ—
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub release + appcast**

- [ ] Tag လုပ်ပြီး push လုပ်ပါ: `git tag vX.Y.Z && git push origin vX.Y.Z` (သို့မဟုတ် `git push --tags`)။
- [ ] `vX.Y.Z` အတွက် GitHub release ကို ဖန်တီး/ပြန်လည်ပြင်ဆင်ပါ၊ **ခေါင်းစဉ်ကို `openclaw X.Y.Z` အဖြစ် သတ်မှတ်ပါ** (tag သက်သက် မဟုတ်ရ)။ body ထဲတွင် အဆိုပါ ဗားရှင်းအတွက် **changelog အပြည့်အစုံ** (Highlights + Changes + Fixes) ကို inline ထည့်သွင်းရမည် (link သက်သက် မထားရ) နှင့် **body အတွင်း ခေါင်းစဉ်ကို ထပ်မံ မဖော်ပြရ**။
- [ ] artifacts များကို တွဲတင်ပါ: `npm pack` tarball (optional), `OpenClaw-X.Y.Z.zip`, နှင့် `OpenClaw-X.Y.Z.dSYM.zip` (ထုတ်လုပ်ထားပါက)။
- [ ] အပ်ဒိတ်လုပ်ထားသော `appcast.xml` ကို commit လုပ်ပြီး push လုပ်ပါ (Sparkle သည် main မှ feed လုပ်သည်)။
- [ ] သန့်ရှင်းသော temp directory မှ (`package.json` မရှိရ) `npx -y openclaw@X.Y.Z send --help` ကို လုပ်ဆောင်၍ install/CLI entrypoints များ အလုပ်လုပ်ကြောင်း အတည်ပြုပါ။
- [ ] ထုတ်ပြန်မှု သတင်းအချက်အလက်များကို ကြေညာ/မျှဝေပါ။

## Plugin publish scope (npm)

`@openclaw/*` scope အောက်တွင် **ရှိပြီးသား npm plugins များသာ** publish လုပ်ပါသည်။ npm ပေါ်တွင် မရှိသော Bundled plugins များကို **disk-tree only** အဖြစ် ထားရှိပါသည် (`extensions/**` ထဲတွင် ဆက်လက် ပို့ဆောင်ပေးပါသည်)။

စာရင်းကို ဆုံးဖြတ်ရန် လုပ်ငန်းစဉ်—

1. `npm search @openclaw --json` ကို လုပ်ဆောင်ပြီး package names များကို ရယူပါ။
2. `extensions/*/package.json` အမည်များနှင့် နှိုင်းယှဉ်ပါ။
3. **အနှစ်ချုပ်ထိပ်တိုက်ဖြတ်ဆုံမှု** (npm ပေါ်တွင် ရှိပြီးသား) ကိုသာ ထုတ်ပြန်ပါ။

လက်ရှိ npm plugin စာရင်း (လိုအပ်ပါက အပ်ဒိတ်လုပ်ပါ)—

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

Release notes တွင်လည်း **default အဖြစ် မဖွင့်ထားသော** **optional bundled plugins အသစ်များ** ကို သေချာ ဖော်ပြရပါမည် (ဥပမာ: `tlon`)။
