---
summary: "Doctor komutu: sağlık kontrolleri, yapılandırma geçişleri ve onarım adımları"
read_when:
  - Doctor geçişleri eklerken veya değiştirirken
  - Kırıcı yapılandırma değişiklikleri sunarken
title: "Doctor"
---

# Doctor

`openclaw doctor`, OpenClaw için onarım + geçiş aracıdır. Bayat
yapılandırma/durumları düzeltir, sağlığı denetler ve uygulanabilir onarım adımları sunar.

## Hızlı başlangıç

```bash
openclaw doctor
```

### Headless / otomasyon

```bash
openclaw doctor --yes
```

Varsayılanları sormadan kabul et (uygun olduğunda yeniden başlatma/hizmet/sandbox onarım adımları dahil).

```bash
openclaw doctor --repair
```

Önerilen onarımları sormadan uygula (güvenliyse onarımlar + yeniden başlatmalar).

```bash
openclaw doctor --repair --force
```

Agresif onarımları da uygula (özel supervisor yapılandırmalarının üzerine yazar).

```bash
openclaw doctor --non-interactive
```

İstemler olmadan çalıştır ve yalnızca güvenli geçişleri uygula (yapılandırma normalizasyonu + disk üzerindeki durum taşımaları). İnsan onayı gerektiren yeniden başlatma/hizmet/sandbox eylemlerini atlar.
Eski durum geçişleri algılandığında otomatik çalışır.

```bash
openclaw doctor --deep
```

Sistem hizmetlerini ek gateway kurulumları için tara (launchd/systemd/schtasks).

Yazmadan önce değişiklikleri gözden geçirmek istiyorsanız, önce yapılandırma dosyasını açın:

```bash
cat ~/.openclaw/openclaw.json
```

## What it does (summary)

- Git kurulumları için isteğe bağlı ön uç güncellemesi (yalnızca etkileşimli).
- UI protokol güncelliği denetimi (protokol şeması daha yeniyse Control UI’yi yeniden oluşturur).
- Sağlık denetimi + yeniden başlatma istemi.
- Skills durum özeti (uygun/eksik/engelli).
- Eski değerler için yapılandırma normalizasyonu.
- OpenCode Zen sağlayıcı geçersiz kılma uyarıları (`models.providers.opencode`).
- Eski disk üzeri durum geçişi (oturumlar/ajan dizini/WhatsApp kimlik doğrulaması).
- Durum bütünlüğü ve izin denetimleri (oturumlar, dökümler, durum dizini).
- Yerel çalıştırmada yapılandırma dosyası izin denetimleri (chmod 600).
- Model kimlik doğrulama sağlığı: OAuth süresinin dolmasını denetler, süresi dolmak üzere olan belirteçleri yenileyebilir ve auth-profile bekleme/engelli durumlarını raporlar.
- Ek çalışma alanı dizini tespiti (`~/openclaw`).
- sandboxing etkinse sandbox imajı onarımı.
- Eski hizmet geçişi ve ek gateway tespiti.
- Gateway çalışma zamanı denetimleri (hizmet yüklü ama çalışmıyor; önbelleğe alınmış launchd etiketi).
- Kanal durum uyarıları (çalışan gateway’den yoklanır).
- Supervisor yapılandırma denetimi (launchd/systemd/schtasks) ve isteğe bağlı onarım.
- Gateway çalışma zamanı en iyi uygulama denetimleri (Node vs Bun, sürüm yöneticisi yolları).
- Gateway port çakışması tanılamaları (varsayılan `18789`).
- Açık DM politikaları için güvenlik uyarıları.
- `gateway.auth.token` ayarlanmadığında gateway kimlik doğrulama uyarıları (yerel mod; belirteç oluşturmayı önerir).
- Linux’ta systemd linger denetimi.
- Kaynak kurulum denetimleri (pnpm çalışma alanı uyumsuzluğu, eksik UI varlıkları, eksik tsx ikili dosyası).
- Güncellenmiş yapılandırmayı + sihirbaz meta verilerini yazar.

## Ayrıntılı davranış ve gerekçe

### 0. İsteğe bağlı güncelleme (git kurulumları)

Bu bir git checkout ise ve doctor etkileşimli çalışıyorsa, doctor’ı çalıştırmadan önce
güncelleme (fetch/rebase/build) teklif eder.

### 1. Yapılandırma normalizasyonu

Yapılandırma eski değer biçimleri içeriyorsa (örneğin kanal-özel geçersiz kılma olmadan `messages.ackReaction`),
doctor bunları geçerli şemaya normalize eder.

### 2. Eski yapılandırma anahtarı geçişleri

Yapılandırma kullanımdan kaldırılmış anahtarlar içerdiğinde, diğer komutlar çalışmayı reddeder ve
`openclaw doctor` çalıştırmanızı ister.

Doctor şunları yapar:

- Hangi eski anahtarların bulunduğunu açıklar.
- Uyguladığı geçişi gösterir.
- Güncellenmiş şema ile `~/.openclaw/openclaw.json` dosyasını yeniden yazar.

Gateway ayrıca, eski bir yapılandırma biçimi algıladığında başlatma sırasında doctor geçişlerini otomatik çalıştırır;
böylece bayat yapılandırmalar manuel müdahale olmadan onarılır.

Mevcut geçişler:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → üst seviye `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen sağlayıcı geçersiz kılmaları

`models.providers.opencode` (veya `opencode-zen`)’i elle eklediyseniz, bu
`@mariozechner/pi-ai`’den gelen yerleşik OpenCode Zen kataloğunu geçersiz kılar. Bu,
her modeli tek bir API’ye zorlayabilir veya maliyetleri sıfırlayabilir. Doctor,
geçersiz kılmayı kaldırıp model başına API yönlendirmesini + maliyetleri geri yükleyebilmeniz için uyarır.

### 3. Eski durum geçişleri (disk yerleşimi)

Doctor, eski disk yerleşimlerini geçerli yapıya taşıyabilir:

- Sessions store + transcripts:
  - `~/.openclaw/sessions/`’ten `~/.openclaw/agents/<agentId>/sessions/`’e
- Agent dir:
  - `~/.openclaw/agent/`’ten `~/.openclaw/agents/<agentId>/agent/`’ya
- WhatsApp kimlik doğrulama durumu (Baileys):
  - eski `~/.openclaw/credentials/*.json`’den (`oauth.json` hariç)
  - `~/.openclaw/credentials/whatsapp/<accountId>/...`’a (varsayılan hesap kimliği: `default`)

Bu geçişler en iyi çaba esaslı ve idempotenttir; doctor, yedek olarak geride bıraktığı
herhangi bir eski klasör olduğunda uyarı verir. Gateway/CLI ayrıca, başlatma sırasında
eski oturumlar + ajan dizinini otomatik taşır; böylece geçmiş/kimlik doğrulama/modeller
manuel bir doctor çalıştırmasına gerek kalmadan ajan başına yola yerleşir. WhatsApp
kimlik doğrulaması kasıtlı olarak yalnızca `openclaw doctor` aracılığıyla taşınır.

### 4. Durum bütünlüğü denetimleri (oturum kalıcılığı, yönlendirme ve güvenli kullanım)

Durum dizini operasyonel beyin sapıdır. Kaybolursa, oturumları, kimlik bilgilerini,
günlükleri ve yapılandırmayı kaybedersiniz (başka yerde yedekleriniz yoksa).

Doctor şunları denetler:

- **Durum dizini eksik**: felaket düzeyinde durum kaybı konusunda uyarır, dizini yeniden oluşturmayı ister
  ve kayıp verileri kurtaramayacağını hatırlatır.
- **Durum dizini izinleri**: yazılabilirliği doğrular; izinleri onarmayı önerir
  (sahip/grup uyumsuzluğu algılandığında `chown` ipucu verir).
- **Oturum dizinleri eksik**: geçmişin kalıcı olması ve `ENOENT` çökmelerinden
  kaçınmak için `sessions/` ve oturum deposu dizini gereklidir.
- **Döküm uyumsuzluğu**: yakın tarihli oturum girdilerinde eksik döküm dosyaları olduğunda uyarır.
- **Ana oturum “1 satırlık JSONL”**: ana dökümün yalnızca bir satırı olduğunda işaretler (geçmiş birikmiyor).
- **Birden fazla durum dizini**: ev dizinleri genelinde birden fazla `~/.openclaw` klasörü olduğunda
  veya `OPENCLAW_STATE_DIR` başka bir yeri gösterdiğinde uyarır (geçmiş kurulumlar arasında bölünebilir).
- **Uzak mod hatırlatıcısı**: `gateway.mode=remote` ise, doctor bunu uzak ana makinede çalıştırmanızı hatırlatır
  (durum orada yaşar).
- **Yapılandırma dosyası izinleri**: `~/.openclaw/openclaw.json` grup/dünya tarafından okunabilir ise uyarır
  ve `600`’a sıkılaştırmayı önerir.

### 5. Model kimlik doğrulama sağlığı (OAuth süresi dolması)

Doctor, kimlik doğrulama deposundaki OAuth profillerini inceler, belirteçler
dolmak üzereyken/dolduğunda uyarır ve güvenliyse yenileyebilir. Anthropic Claude Code
profili bayatsa, `claude setup-token` çalıştırmayı (veya bir setup-token yapıştırmayı) önerir.
Yenileme istemleri yalnızca etkileşimli (TTY) çalışırken görünür; `--non-interactive`
yenileme denemelerini atlar.

Doctor ayrıca, geçici olarak kullanılamaz olan kimlik doğrulama profillerini raporlar:

- kısa beklemeler (oran sınırları/zaman aşımları/kimlik doğrulama hataları)
- daha uzun süreli devre dışı bırakmalar (faturalama/kredi sorunları)

### 6. Hooks model doğrulaması

`hooks.gmail.model` ayarlıysa, doctor model referansını katalog ve izin listesine karşı
doğrular ve çözümlenemeyecek veya izin verilmeyen durumlarda uyarır.

### 7. Sandbox imajı onarımı

sandboxing etkin olduğunda, doctor Docker imajlarını denetler ve geçerli imaj
eksikse oluşturmayı veya eski adlara geçmeyi teklif eder.

### 8. Gateway hizmet geçişleri ve temizlik ipuçları

Doctor, eski gateway hizmetlerini (launchd/systemd/schtasks) algılar ve
bunları kaldırıp geçerli gateway portunu kullanarak OpenClaw hizmetini kurmayı
teklif eder. Ayrıca ek gateway-benzeri hizmetleri tarayabilir ve temizlik ipuçları yazdırabilir.
Profil adlandırmalı OpenClaw gateway hizmetleri birinci sınıf kabul edilir ve “ekstra”
olarak işaretlenmez.

### 9. Güvenlik uyarıları

Doctor, bir sağlayıcı izin listesi olmadan DM’lere açık olduğunda veya
bir politika tehlikeli bir şekilde yapılandırıldığında uyarılar üretir.

### 10. systemd linger (Linux)

systemd kullanıcı hizmeti olarak çalışıyorsa, doctor, oturum kapatıldıktan sonra
gateway’in ayakta kalması için linger’ın etkin olduğundan emin olur.

### 11. Skills durumu

Doctor, mevcut çalışma alanı için uygun/eksik/engelli skills’in hızlı bir özetini yazdırır.

### 12. Gateway kimlik doğrulama denetimleri (yerel belirteç)

Doctor, yerel bir gateway’de `gateway.auth` eksik olduğunda uyarır ve
bir belirteç oluşturmayı teklif eder. Otomasyonda belirteç oluşturmayı zorlamak için
`openclaw doctor --generate-gateway-token` kullanın.

### 13. Gateway sağlık denetimi + yeniden başlatma

Doctor bir sağlık denetimi çalıştırır ve sağlıksız göründüğünde gateway’i
yeniden başlatmayı teklif eder.

### 14. Kanal durum uyarıları

Gateway sağlıklıysa, doctor bir kanal durum yoklaması çalıştırır ve
önerilen düzeltmelerle birlikte uyarıları raporlar.

### 15. Supervisor yapılandırma denetimi + onarım

Doctor, yüklü supervisor yapılandırmasını (launchd/systemd/schtasks)
eksik veya güncel olmayan varsayılanlar için denetler (ör. systemd network-online
bağımlılıkları ve yeniden başlatma gecikmesi). Bir uyumsuzluk bulduğunda,
güncelleme önerir ve hizmet dosyasını/görevi geçerli varsayılanlara yeniden yazabilir.

Notlar:

- `openclaw doctor` supervisor yapılandırmasını yeniden yazmadan önce sorar.
- `openclaw doctor --yes` varsayılan onarım istemlerini kabul eder.
- `openclaw doctor --repair` önerilen düzeltmeleri sormadan uygular.
- `openclaw doctor --repair --force` özel supervisor yapılandırmalarının üzerine yazar.
- Her zaman `openclaw gateway install --force` ile tam bir yeniden yazmayı zorlayabilirsiniz.

### 16. Gateway çalışma zamanı + port tanılamaları

Doctor, hizmet çalışma zamanını (PID, son çıkış durumu) inceler ve
hizmet yüklü olup fiilen çalışmadığında uyarır. Ayrıca gateway portunda
(varsayılan `18789`) port çakışmalarını denetler ve olası nedenleri raporlar
(gateway’in zaten çalışıyor olması, SSH tüneli).

### 17. Gateway çalışma zamanı en iyi uygulamaları

Doctor, gateway hizmeti Bun üzerinde veya sürüm yöneticili bir Node yolunda
çalıştığında uyarır (`nvm`, `fnm`, `volta`, `asdf`, vb.). WhatsApp + Telegram kanalları Node gerektirir
ve sürüm yöneticisi yolları yükseltmelerden sonra bozulabilir; çünkü hizmet
kabuk başlatma dosyalarınızı yüklemez. Doctor, mümkün olduğunda
(Homebrew/apt/choco) sistem Node kurulumuna geçişi teklif eder.

### 18. Yapılandırma yazımı + sihirbaz meta verileri

Doctor, yapılandırma değişikliklerini kalıcı hale getirir ve doctor çalıştırmasını
kaydetmek için sihirbaz meta verilerini damgalar.

### 19. Çalışma alanı ipuçları (yedekleme + bellek sistemi)

Doctor, eksikse bir çalışma alanı bellek sistemi önerir ve çalışma alanı
zaten git altında değilse bir yedekleme ipucu yazdırır.

Çalışma alanı yapısı ve git yedekleme (önerilen özel GitHub veya GitLab) için
tam kılavuz olarak [/concepts/agent-workspace](/concepts/agent-workspace)’e bakın.
