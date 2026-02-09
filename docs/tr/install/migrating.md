---
summary: "Bir OpenClaw kurulumunu bir makineden diğerine taşıyın (migrate edin)"
read_when:
  - OpenClaw’ı yeni bir dizüstü bilgisayara/sunucuya taşıyorsunuz
  - Oturumları, kimlik doğrulamayı ve kanal girişlerini (WhatsApp vb.) korumak istiyorsunuz
title: "Geçiş Kılavuzu"
---

# OpenClaw’ı yeni bir makineye taşıma

Bu kılavuz, **onboarding’i yeniden yapmadan** bir OpenClaw Gateway’i bir makineden diğerine taşır.

Geçiş kavramsal olarak basittir:

- **State dizinini** kopyalayın (`$OPENCLAW_STATE_DIR`, varsayılan: `~/.openclaw/`) — buna yapılandırma, kimlik doğrulama, oturumlar ve kanal durumu dahildir.
- **Çalışma alanınızı** kopyalayın (varsayılan olarak `~/.openclaw/workspace/`) — buna ajan dosyalarınız (hafıza, prompt’lar vb.) dahildir.

Ancak **profiller**, **izinler** ve **kısmi kopyalar** etrafında yaygın tuzaklar vardır.

## Başlamadan önce (neyi taşıyorsunuz)

### 1. State dizininizi belirleyin

Çoğu kurulum varsayılanı kullanır:

- **State dizini:** `~/.openclaw/`

Ancak şunları kullanıyorsanız farklı olabilir:

- `--profile <name>` (çoğu zaman `~/.openclaw-<profile>/` olur)
- `OPENCLAW_STATE_DIR=/some/path`

Emin değilseniz, **eski** makinede çalıştırın:

```bash
openclaw status
```

Çıktıda `OPENCLAW_STATE_DIR` / profile atıflarını arayın. Birden fazla gateway çalıştırıyorsanız, her profil için tekrarlayın.

### 2. Çalışma alanınızı belirleyin

Yaygın varsayılanlar:

- `~/.openclaw/workspace/` (önerilen çalışma alanı)
- oluşturduğunuz özel bir klasör

Çalışma alanınız; `MEMORY.md`, `USER.md` ve `memory/*.md` gibi dosyaların bulunduğu yerdir.

### 3. Neleri koruyacağınızı anlayın

Hem state dizinini **hem de** çalışma alanını kopyalarsanız şunları korursunuz:

- Gateway yapılandırması (`openclaw.json`)
- Kimlik doğrulama profilleri / API anahtarları / OAuth belirteçleri
- Session history + agent state
- Kanal durumu (ör. WhatsApp giriş/oturumu)
- Çalışma alanı dosyalarınız (hafıza, skills notları vb.)

Yalnızca çalışma alanını kopyalarsanız (ör. Git ile), **şunları korumazsınız**:

- oturumlar
- kimlik bilgileri
- kanal girişleri

Bunlar `$OPENCLAW_STATE_DIR` altında bulunur.

## Geçiş adımları (önerilen)

### Adım 0 — Yedek alın (eski makine)

**Eski** makinede, kopyalama sırasında dosyalar değişmesin diye önce gateway’i durdurun:

```bash
openclaw gateway stop
```

(İsteğe bağlı ancak önerilir) state dizinini ve çalışma alanını arşivleyin:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Birden fazla profil/state dizini varsa (ör. `~/.openclaw-main`, `~/.openclaw-work`), her birini arşivleyin.

### Adım 1 — Yeni makinede OpenClaw’ı kurun

**Yeni** makinede CLI’yi (gerekirse Node ile birlikte) kurun:

- Bkz: [Install](/install)

Bu aşamada onboarding’in yeni bir `~/.openclaw/` oluşturması sorun değildir — bir sonraki adımda üzerine yazacaksınız.

### Adım 2 — State dizinini + çalışma alanını yeni makineye kopyalayın

**Her ikisini de** kopyalayın:

- `$OPENCLAW_STATE_DIR` (varsayılan `~/.openclaw/`)
- çalışma alanınız (varsayılan `~/.openclaw/workspace/`)

Yaygın yaklaşımlar:

- tarball’ları `scp` ve çıkarmak
- SSH üzerinden `rsync -a`
- external drive

Kopyaladıktan sonra şunları doğrulayın:

- Gizli dizinlerin dahil edildiği (ör. `.openclaw/`)
- Dosya sahipliğinin gateway’i çalıştıran kullanıcıya ait olduğu

### Adım 3 — Doctor’ı çalıştırın (geçişler + servis onarımı)

**Yeni** makinede:

```bash
openclaw doctor
```

Doctor “güvenli ve sıkıcı” komuttur. Servisleri onarır, yapılandırma geçişlerini uygular ve uyumsuzluklar konusunda uyarır.

Ardından:

```bash
openclaw gateway restart
openclaw status
```

## Common footguns (and how to avoid them)

### Tuzak: profil / state-dizin uyumsuzluğu

Eski gateway’i bir profil (veya `OPENCLAW_STATE_DIR`) ile çalıştırdıysanız ve yeni gateway farklı bir tane kullanıyorsa, şu belirtileri görebilirsiniz:

- yapılandırma değişikliklerinin etkili olmaması
- kanalların eksik olması / çıkış yapmış görünmesi
- boş oturum geçmişi

Çözüm: Gateway’i/servisi, taşıdığınız **aynı** profil/state dizini ile çalıştırın, ardından tekrar çalıştırın:

```bash
openclaw doctor
```

### Tuzak: yalnızca `openclaw.json`’u kopyalamak

`openclaw.json` yeterli değildir. Birçok sağlayıcı durumu şu dizinlerde saklar:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Her zaman tüm `$OPENCLAW_STATE_DIR` klasörünü taşıyın.

### Tuzak: izinler / sahiplik

Root olarak kopyaladıysanız veya kullanıcı değiştirdiyseniz, gateway kimlik bilgilerini/oturumları okuyamayabilir.

Çözüm: State dizini + çalışma alanının, gateway’i çalıştıran kullanıcıya ait olduğundan emin olun.

### Tuzak: uzak/yerel modlar arasında geçiş

- UI’nız (WebUI/TUI) **uzak** bir gateway’e işaret ediyorsa, oturum deposu + çalışma alanı uzak ana makineye aittir.
- Dizüstü bilgisayarınızı taşımak, uzak gateway’in durumunu taşımaz.

Uzak moddaysanız, **gateway ana makinesini** taşıyın.

### Tuzak: yedeklerde gizli bilgiler

`$OPENCLAW_STATE_DIR` gizli bilgiler içerir (API anahtarları, OAuth belirteçleri, WhatsApp kimlik bilgileri). Yedekleri üretim sırları gibi ele alın:

- şifreli saklayın
- güvensiz kanallar üzerinden paylaşmaktan kaçının
- maruziyetten şüpheleniyorsanız anahtarları döndürün

## Doğrulama kontrol listesi

Yeni makinede şunları doğrulayın:

- `openclaw status` gateway’in çalıştığını gösteriyor
- Kanallarınız hâlâ bağlı (ör. WhatsApp yeniden eşleştirme gerektirmiyor)
- Kontrol paneli açılıyor ve mevcut oturumları gösteriyor
- Çalışma alanı dosyalarınız (hafıza, yapılandırmalar) mevcut

## İlgili

- [Doctor](/gateway/doctor)
- [Gateway sorun giderme](/gateway/troubleshooting)
- [OpenClaw verilerini nerede saklar?](/help/faq#where-does-openclaw-store-its-data)
