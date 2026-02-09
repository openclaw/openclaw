---
summary: "npm + macOS uygulaması için adım adım sürüm kontrol listesi"
read_when:
  - Yeni bir npm sürümü çıkarırken
  - Yeni bir macOS uygulama sürümü çıkarırken
  - Yayınlamadan önce meta verileri doğrularken
---

# Sürüm Kontrol Listesi (npm + macOS)

Depo kökünden `pnpm` (Node 22+) kullanın. Etiketleme/yayınlama öncesinde çalışma ağacını temiz tutun.

## Operatör tetikleyicisi

Operatör “release” dediğinde, şu ön uç kontrollerini derhal yapın (engel yoksa ek soru sormayın):

- Bu dokümanı ve `docs/platforms/mac/release.md`’i okuyun.
- `~/.profile`’den ortam değişkenlerini yükleyin ve `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect değişkenlerinin ayarlı olduğunu doğrulayın (SPARKLE_PRIVATE_KEY_FILE, `~/.profile` içinde bulunmalıdır).
- Gerekirse `~/Library/CloudStorage/Dropbox/Backup/Sparkle`’ten Sparkle anahtarlarını kullanın.

1. **Sürüm & meta veriler**

- [ ] `package.json` sürümünü artırın (ör. `2026.1.29`).
- [ ] Uzantı paket sürümlerini + değişiklik günlüklerini hizalamak için `pnpm plugins:sync` çalıştırın.
- [ ] CLI/sürüm dizgelerini güncelleyin: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) ve [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) içindeki Baileys kullanıcı aracısı.
- [ ] Paket meta verilerini (ad, açıklama, depo, anahtar kelimeler, lisans) ve `bin` eşlemesinin `openclaw` için [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)’ye işaret ettiğini doğrulayın.
- [ ] Bağımlılıklar değiştiyse, `pnpm-lock.yaml`’in güncel olması için `pnpm install` çalıştırın.

2. **Derleme & çıktılar**

- [ ] A2UI girdileri değiştiyse, `pnpm canvas:a2ui:bundle` çalıştırın ve güncellenen [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) dosyasını commit edin.
- [ ] `pnpm run build` (`dist/`’yi yeniden üretir).
- [ ] npm paketi `files`’nin gerekli tüm `dist/*` klasörlerini içerdiğini doğrulayın (özellikle başsız node + ACP CLI için `dist/node-host/**` ve `dist/acp/**`).
- [ ] `dist/build-info.json`’ün mevcut olduğunu ve beklenen `commit` hash’ini içerdiğini doğrulayın (CLI afişi bunu npm kurulumları için kullanır).
- [ ] İsteğe bağlı: Derlemeden sonra `npm pack --pack-destination /tmp`; tarball içeriğini inceleyin ve GitHub sürümü için elinizin altında tutun (**commit etmeyin**).

3. **Değişiklik günlüğü & dokümantasyon**

- [ ] Kullanıcıya yönelik öne çıkanlarla `CHANGELOG.md`’yi güncelleyin (eksikse dosyayı oluşturun); girdileri sürüme göre kesinlikle azalan sırada tutun.
- [ ] README örneklerinin/flag’lerinin mevcut CLI davranışıyla uyumlu olduğundan emin olun (özellikle yeni komutlar veya seçenekler).

4. **Doğrulama**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (kapsam çıktısı gerekiyorsa `pnpm test:coverage`)
- [ ] `pnpm release:check` (npm pack içeriğini doğrular)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker kurulum duman testi, hızlı yol; sürümden önce zorunlu)
  - Hemen önceki npm sürümünün bozuk olduğu biliniyorsa, ön kurulum adımı için `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` veya `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` ayarlayın.
- [ ] (İsteğe bağlı) Tam yükleyici duman testi (root olmayan + CLI kapsamı ekler): `pnpm test:install:smoke`
- [ ] (İsteğe bağlı) Yükleyici E2E (Docker, `curl -fsSL https://openclaw.ai/install.sh | bash` çalıştırır, onboarding yapar, ardından gerçek araç çağrılarını çalıştırır):
  - `pnpm test:install:e2e:openai` (`OPENAI_API_KEY` gerektirir)
  - `pnpm test:install:e2e:anthropic` (`ANTHROPIC_API_KEY` gerektirir)
  - `pnpm test:install:e2e` (her iki anahtarı da gerektirir; her iki sağlayıcıyı da çalıştırır)
- [ ] (İsteğe bağlı) Değişiklikleriniz gönderme/alma yollarını etkiliyorsa web gateway’i noktasal kontrol edin.

5. **macOS uygulaması (Sparkle)**

- [ ] macOS uygulamasını derleyin + imzalayın, ardından dağıtım için zipleyin.
- [ ] Sparkle appcast’ini üretin (HTML notları [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) ile) ve `appcast.xml`’ü güncelleyin.
- [ ] Uygulama zip’ini (ve isteğe bağlı dSYM zip’ini) GitHub sürümüne eklemek için hazır tutun.
- [ ] Kesin komutlar ve gerekli ortam değişkenleri için [macOS release](/platforms/mac/release)’i izleyin.
  - `APP_BUILD` sayısal + monotonik olmalıdır (Sparkle’ın sürümleri doğru karşılaştırması için `-beta` yok).
  - Noterleme yapılıyorsa, App Store Connect API ortam değişkenlerinden oluşturulan `openclaw-notary` anahtarlık profilini kullanın (bkz. [macOS release](/platforms/mac/release)).

6. **Yayınlama (npm)**

- [ ] git durumunun temiz olduğunu doğrulayın; gerekirse commit ve push yapın.
- [ ] Gerekirse `npm login` (2FA doğrulaması).
- [ ] `npm publish --access public` (ön sürümler için `--tag beta` kullanın).
- [ ] Kayıt defterini doğrulayın: `npm view openclaw version`, `npm view openclaw dist-tags` ve `npx -y openclaw@X.Y.Z --version` (veya `--help`).

### Sorun Giderme (2.0.0-beta2 sürümünden notlar)

- **npm pack/publish takılıyor veya çok büyük tarball üretiyor**: `dist/OpenClaw.app` içindeki macOS uygulama paketi (ve sürüm zip’leri) pakete dahil ediliyor. `package.json` `files` ile yayın içeriğini beyaz listeleyerek düzeltin (dist alt dizinleri, dokümanlar, skills dahil; uygulama paketlerini hariç tutun). `npm pack --dry-run` ile `dist/OpenClaw.app`’un listelenmediğini doğrulayın.
- **dist-tags için npm auth web döngüsü**: OTP istemi almak için eski kimlik doğrulamayı kullanın:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` doğrulaması `ECOMPROMISED: Lock compromised` ile başarısız oluyor**: temiz bir önbellekle yeniden deneyin:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Geç bir düzeltmeden sonra etiketin yeniden işaretlenmesi gerekiyor**: etiketi zorla güncelleyin ve push edin, ardından GitHub sürüm varlıklarının hâlâ eşleştiğinden emin olun:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub sürümü + appcast**

- [ ] Etiketleyin ve push edin: `git tag vX.Y.Z && git push origin vX.Y.Z` (veya `git push --tags`).
- [ ] `vX.Y.Z` için GitHub sürümünü oluşturun/yenileyin; **başlık `openclaw X.Y.Z` olmalıdır** (sadece etiket değil). Gövde, o sürüm için **tam** değişiklik günlüğü bölümünü (Öne Çıkanlar + Değişiklikler + Düzeltmeler) satır içi olarak içermeli (çıplak bağlantılar yok) ve **gövde içinde başlık tekrarlanmamalıdır**.
- [ ] Varlıkları ekleyin: `npm pack` tarball (isteğe bağlı), `OpenClaw-X.Y.Z.zip` ve `OpenClaw-X.Y.Z.dSYM.zip` (oluşturulduysa).
- [ ] Güncellenmiş `appcast.xml`’yi commit edin ve push edin (Sparkle ana daldan beslenir).
- [ ] Temiz bir geçici dizinden (`package.json` yok), kurulum/CLI giriş noktalarının çalıştığını doğrulamak için `npx -y openclaw@X.Y.Z send --help` çalıştırın.
- [ ] Sürüm notlarını duyurun/paylaşın.

## Eklenti yayın kapsamı (npm)

Yalnızca `@openclaw/*` kapsamı altındaki **mevcut npm eklentilerini** yayınlıyoruz. npm’de olmayan paketli
eklentiler **yalnızca disk ağacı** olarak kalır (yine de
`extensions/**` içinde gönderilir).

Listeyi türetme süreci:

1. `npm search @openclaw --json` ve paket adlarını yakalayın.
2. `extensions/*/package.json` adlarıyla karşılaştırın.
3. Yalnızca **kesişimi** (zaten npm’de olanlar) yayınlayın.

Mevcut npm eklenti listesi (gerektikçe güncelleyin):

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

Sürüm notları ayrıca **varsayılan olarak açık olmayan** **yeni isteğe bağlı paketli eklentileri** de belirtmelidir (örnek: `tlon`).
