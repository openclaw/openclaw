---
summary: "OpenClaw’ı güvenle güncelleme (global kurulum veya kaynaktan), ayrıca geri alma stratejisi"
read_when:
  - OpenClaw’ı güncelleme
  - Bir güncellemeden sonra bir şeyler bozulduğunda
title: "Güncelleme"
---

# Güncelleme

OpenClaw hızlı ilerliyor (1.0 öncesi). Güncellemeleri altyapı dağıtımı gibi ele alın: güncelle → kontrolleri çalıştır → yeniden başlat (veya yeniden başlatan `openclaw update` kullan) → doğrula.

## Önerilen: web sitesi yükleyicisini yeniden çalıştırın (yerinde yükseltme)

**Tercih edilen** güncelleme yolu, web sitesindeki yükleyiciyi yeniden çalıştırmaktır. Mevcut kurulumları algılar, yerinde yükseltir ve gerektiğinde `openclaw doctor` çalıştırır.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Notlar:

- Karşılama sihirbazının tekrar çalışmasını istemiyorsanız `--no-onboard` ekleyin.

- **Kaynaktan kurulumlar** için şunu kullanın:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  Yükleyici, depo temizse **yalnızca** `git pull --rebase` yapar.

- **Global kurulumlar** için betik, perde arkasında `npm install -g openclaw@latest` kullanır.

- Eski not: `clawdbot` bir uyumluluk katmanı olarak kullanılabilir durumda kalır.

## Güncellemeden önce

- Nasıl kurduğunuzu bilin: **global** (npm/pnpm) vs **kaynaktan** (git clone).
- Gateway’inizin nasıl çalıştığını bilin: **ön planda terminal** vs **denetimli servis** (launchd/systemd).
- Snapshot your tailoring:
  - Yapılandırma: `~/.openclaw/openclaw.json`
  - Kimlik bilgileri: `~/.openclaw/credentials/`
  - Çalışma alanı: `~/.openclaw/workspace`

## Güncelleme (global kurulum)

Global kurulum (birini seçin):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Gateway çalışma zamanı için Bun’u **önermiyoruz** (WhatsApp/Telegram hataları).

Güncelleme kanallarını değiştirmek için (git + npm kurulumları):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Tek seferlik bir kurulum etiketi/sürümü için `--tag <dist-tag|version>` kullanın.

Kanal anlamları ve sürüm notları için [Geliştirme kanalları](/install/development-channels) sayfasına bakın.

Not: npm kurulumlarında gateway, başlangıçta bir güncelleme ipucu günlüğe yazar (mevcut kanal etiketini kontrol eder). `update.checkOnStart: false` ile devre dışı bırakın.

Ardından:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Notlar:

- Gateway’iniz bir servis olarak çalışıyorsa, PID’leri öldürmek yerine `openclaw gateway restart` tercih edilir.
- Belirli bir sürüme sabitlenmişseniz, aşağıdaki “Geri alma / sabitleme” bölümüne bakın.

## Güncelleme (`openclaw update`)

**Kaynaktan kurulumlar** (git checkout) için tercih edilen:

```bash
openclaw update
```

Güvenli sayılabilecek bir güncelleme akışı çalıştırır:

- Temiz bir çalışma ağacı gerektirir.
- Seçilen kanala (etiket veya dal) geçer.
- Yapılandırılmış upstream’e (dev kanalı) karşı getirir + rebase eder.
- Bağımlılıkları kurar, derler, Control UI’yi derler ve `openclaw doctor` çalıştırır.
- Varsayılan olarak gateway’i yeniden başlatır (atlamak için `--no-restart` kullanın).

**npm/pnpm** ile kurduysanız (git meta verisi yok), `openclaw update` paket yöneticiniz üzerinden güncellemeyi dener. Kurulumu algılayamazsa, bunun yerine “Güncelleme (global kurulum)”u kullanın.

## Güncelleme (Control UI / RPC)

Control UI’de **Güncelle & Yeniden Başlat** (RPC: `update.run`) bulunur. Şunları yapar:

1. `openclaw update` ile aynı kaynak-güncelleme akışını çalıştırır (yalnızca git checkout).
2. Yapılandırılmış bir raporla (stdout/stderr kuyruğu) bir yeniden başlatma işareti yazar.
3. Gateway’i yeniden başlatır ve raporla son etkin oturumu ping’ler.

Rebase başarısız olursa, gateway güncellemeyi uygulamadan iptal eder ve yeniden başlatır.

## Güncelleme (kaynaktan)

Depo checkout’undan:

Tercih edilen:

```bash
openclaw update
```

Manuel (yaklaşık eşdeğer):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Notlar:

- Paketlenmiş `openclaw` ikilisini ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) çalıştırdığınızda veya Node ile `dist/` çalıştırdığınızda `pnpm build` önemlidir.
- Global kurulum olmadan bir depo checkout’undan çalışıyorsanız, CLI komutları için `pnpm openclaw ...` kullanın.
- Doğrudan TypeScript’ten (`pnpm openclaw ...`) çalıştırıyorsanız, yeniden derleme genellikle gerekmez; ancak **yapılandırma geçişleri yine de geçerlidir** → doctor çalıştırın.
- Global ve git kurulumları arasında geçiş yapmak kolaydır: diğer türü kurun, ardından gateway servis giriş noktası mevcut kuruluma yeniden yazılsın diye `openclaw doctor` çalıştırın.

## Her Zaman Çalıştırın: `openclaw doctor`

Doctor, “güvenli güncelleme” komutudur. Bilinçli olarak sıkıcıdır: onar + taşı + uyar.

Not: **kaynaktan kurulum** (git checkout) üzerindeyseniz, `openclaw doctor` önce `openclaw update` çalıştırmayı önerecektir.

Tipik olarak yaptıkları:

- Kullanımdan kaldırılmış yapılandırma anahtarlarını / eski yapılandırma dosyası konumlarını taşır.
- DM politikalarını denetler ve riskli “açık” ayarlarda uyarır.
- Gateway sağlığını kontrol eder ve yeniden başlatmayı önerebilir.
- Eski gateway servislerini (launchd/systemd; eski schtasks) mevcut OpenClaw servislerine algılar ve taşır.
- Linux’ta systemd kullanıcı kalıcılığını sağlar (Gateway’in oturum kapatmada hayatta kalması için).

Ayrıntılar: [Doctor](/gateway/doctor)

## Gateway’i başlat / durdur / yeniden başlat

CLI (işletim sisteminden bağımsız çalışır):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

If you’re supervised:

- macOS launchd (uygulama paketli LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (`bot.molt.<profile>` kullanın; eski `com.openclaw.*` hâlâ çalışır)
- Linux systemd kullanıcı servisi: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` yalnızca servis kuruluysa çalışır; aksi halde `openclaw gateway install` çalıştırın.

Çalıştırma kılavuzu + kesin servis etiketleri: [Gateway runbook](/gateway)

## Geri alma / sabitleme (bir şeyler bozulduğunda)

### Sabitle (global kurulum)

Bilinen, sorunsuz bir sürümü kurun (`<version>` yerine son çalışanı koyun):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

İpucu: yayımlanan mevcut sürümü görmek için `npm view openclaw version` çalıştırın.

Ardından yeniden başlatın + doctor’ı tekrar çalıştırın:

```bash
openclaw doctor
openclaw gateway restart
```

### Pin (source) by date

Bir tarihten bir commit seçin (örnek: “2026-01-01 itibarıyla main’in durumu”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Ardından bağımlılıkları yeniden kurun + yeniden başlatın:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Daha sonra tekrar en güncele dönmek isterseniz:

```bash
git checkout main
git pull
```

## Takılı kaldıysanız

- `openclaw doctor`’ü tekrar çalıştırın ve çıktıyı dikkatle okuyun (çoğu zaman çözümü söyler).
- Kontrol edin: [Sorun Giderme](/gateway/troubleshooting)
- Discord’da sorun: [https://discord.gg/clawd](https://discord.gg/clawd)
