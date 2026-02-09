---
summary: "Ajan çalışma alanı: konum, düzen ve yedekleme stratejisi"
read_when:
  - Ajan çalışma alanını veya dosya düzenini açıklamanız gerektiğinde
  - Bir ajan çalışma alanını yedeklemek veya taşımak istediğinizde
title: "Ajan çalışma alanı"
---

# concepts/agent-workspace.md

Çalışma alanı ajanın evidir. Dosya araçları ve çalışma alanı bağlamı için
kullanılan tek çalışma dizinidir. Gizli tutun ve onu bellek gibi ele alın.

Bu, yapılandırma, kimlik bilgileri ve oturumları saklayan `~/.openclaw/`’den
ayrıdır.

**Önemli:** çalışma alanı **varsayılan cwd**’dir, katı bir sandbox değildir. Araçlar göreli yolları çalışma alanına göre çözer; ancak sandboxing
etkinleştirilmediği sürece mutlak yollar ana makinede başka yerlere
erişebilir. Yalıtım gerekiyorsa
[`agents.defaults.sandbox`](/gateway/sandboxing) (ve/veya ajan başına sandbox yapılandırması)
kullanın.
Sandboxing etkinleştirildiğinde ve `workspaceAccess` `"rw"`
değilse, araçlar ana makine çalışma alanınızda değil, `~/.openclaw/sandboxes` altında
bir sandbox çalışma alanında çalışır.

## Varsayılan konum

- Varsayılan: `~/.openclaw/workspace`
- `OPENCLAW_PROFILE` ayarlanmışsa ve `"default"` değilse, varsayılan
  `~/.openclaw/workspace-<profile>` olur.
- `~/.openclaw/openclaw.json` içinde geçersiz kılın:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` veya `openclaw setup`, eksiklerse çalışma
alanını oluşturur ve bootstrap dosyalarını tohumlar.

Çalışma alanı dosyalarını zaten kendiniz yönetiyorsanız, bootstrap dosyası
oluşturmayı devre dışı bırakabilirsiniz:

```json5
{ agent: { skipBootstrap: true } }
```

## Ek çalışma alanı klasörleri

Eski kurulumlar `~/openclaw` oluşturmuş olabilir. Birden fazla çalışma alanı
dizinini tutmak, aynı anda yalnızca bir çalışma alanı etkin olduğundan,
kafa karıştırıcı kimlik doğrulama veya durum sapmasına yol açabilir.

**Öneri:** tek bir etkin çalışma alanı tutun. Ek klasörleri artık
kullanmıyorsanız, arşivleyin veya Çöp’e taşıyın (örneğin `trash ~/openclaw`).
Birden fazla çalışma alanını bilinçli olarak tutuyorsanız,
`agents.defaults.workspace`’ün etkin olana işaret ettiğinden emin olun.

`openclaw doctor`, ek çalışma alanı dizinleri tespit ettiğinde uyarır.

## Çalışma alanı dosya haritası (her dosya ne anlama gelir)

Bunlar OpenClaw’ın çalışma alanı içinde beklediği standart dosyalardır:

- `AGENTS.md`
  - Ajan için işletim talimatları ve belleği nasıl kullanması gerektiği.
  - Her oturumun başında yüklenir.
  - Kurallar, öncelikler ve “nasıl davranmalı” ayrıntıları için iyi bir yerdir.

- `SOUL.md`
  - Persona, ton ve sınırlar.
  - Her oturumda yüklenir.

- `USER.md`
  - Kullanıcının kim olduğu ve ona nasıl hitap edileceği.
  - Her oturumda yüklenir.

- `IDENTITY.md`
  - Ajanın adı, havası ve emojisi.
  - Bootstrap ritüeli sırasında oluşturulur/güncellenir.

- `TOOLS.md`
  - Notes about your local tools and conventions.
  - Araç kullanılabilirliğini kontrol etmez; yalnızca rehberliktir.

- `HEARTBEAT.md`
  - Heartbeat çalıştırmaları için isteğe bağlı küçük kontrol listesi.
  - Token tüketimini önlemek için kısa tutun.

- `BOOT.md`
  - İç kancalar etkin olduğunda gateway yeniden başlatıldığında yürütülen isteğe bağlı başlangıç kontrol listesi.
  - Kısa tutun; giden gönderimler için mesaj aracını kullanın.

- `BOOTSTRAP.md`
  - Tek seferlik ilk çalıştırma ritüeli.
  - Yalnızca yepyeni bir çalışma alanı için oluşturulur.
  - Ritüel tamamlandıktan sonra silin.

- `memory/YYYY-MM-DD.md`
  - Günlük bellek günlüğü (günde bir dosya).
  - Oturum başlangıcında bugün + dünü okumak önerilir.

- `MEMORY.md` (isteğe bağlı)
  - Küratörlü uzun vadeli bellek.
  - Yalnızca ana, özel oturumda yükleyin (paylaşılan/grup bağlamlarında değil).

İş akışı ve otomatik bellek boşaltma için [Memory](/concepts/memory) bölümüne bakın.

- `skills/` (isteğe bağlı)
  - Çalışma alanına özgü Skills.
  - Overrides managed/bundled skills when names collide.

- `canvas/` (isteğe bağlı)
  - Düğüm görünümleri için Canvas UI dosyaları (örneğin `canvas/index.html`).

Herhangi bir bootstrap dosyası eksikse, OpenClaw oturuma bir “eksik dosya”
işaretleyicisi ekler ve devam eder. Büyük bootstrap dosyaları enjekte edilirken
kısaltılır; sınırı `agents.defaults.bootstrapMaxChars` ile ayarlayın (varsayılan: 20000).
`openclaw setup`, mevcut dosyaların üzerine yazmadan eksik varsayılanları
yeniden oluşturabilir.

## What is NOT in the workspace

Bunlar `~/.openclaw/` altında bulunur ve çalışma alanı deposuna
kesinlikle commit edilmemelidir:

- `~/.openclaw/openclaw.json` (yapılandırma)
- `~/.openclaw/credentials/` (OAuth belirteçleri, API anahtarları)
- `~/.openclaw/agents/<agentId>/sessions/` (oturum dökümleri + meta veriler)
- `~/.openclaw/skills/` (yönetilen skills)

Oturumları veya yapılandırmayı taşımanız gerekiyorsa, bunları ayrı ayrı
kopyalayın ve sürüm denetiminin dışında tutun.

## Git yedeği (önerilir, gizli)

Çalışma alanını özel bellek olarak ele alın. Yedeklenebilir ve kurtarılabilir
olması için **özel** bir git deposuna koyun.

Bu adımları Gateway’in çalıştığı makinede çalıştırın (çalışma alanı oradadır).

### 1. Depoyu başlatın

Git yüklüyse, yepyeni çalışma alanları otomatik olarak başlatılır. Bu çalışma
alanı zaten bir depo değilse, çalıştırın:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Özel bir uzak depo ekleyin (başlangıç dostu seçenekler)

Seçenek A: GitHub web arayüzü

1. GitHub’da yeni bir **özel** depo oluşturun.
2. README ile başlatmayın (birleştirme çakışmalarını önler).
3. HTTPS uzak depo URL’sini kopyalayın.
4. Uzağı ekleyin ve gönderin:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Seçenek B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Seçenek C: GitLab web arayüzü

1. GitLab’da yeni bir **özel** depo oluşturun.
2. README ile başlatmayın (birleştirme çakışmalarını önler).
3. HTTPS uzak depo URL’sini kopyalayın.
4. Uzağı ekleyin ve gönderin:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Sürekli güncellemeler

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Gizli bilgileri commit etmeyin

Özel bir depoda bile, çalışma alanında gizli bilgiler saklamaktan kaçının:

- API anahtarları, OAuth belirteçleri, parolalar veya özel kimlik bilgileri.
- `~/.openclaw/` altındaki her şey.
- Sohbetlerin ham dökümleri veya hassas ekler.

Hassas referansları saklamanız gerekiyorsa, yer tutucular kullanın ve gerçek
sırrı başka bir yerde tutun (parola yöneticisi, ortam değişkenleri veya
`~/.openclaw/`).

Önerilen `.gitignore` başlangıç dosyası:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Çalışma alanını yeni bir makineye taşıma

1. Clone the repo to the desired path (default `~/.openclaw/workspace`).
2. `~/.openclaw/openclaw.json` içinde `agents.defaults.workspace`’yi bu yola ayarlayın.
3. Eksik dosyaları tohumlamak için `openclaw setup --workspace <path>` çalıştırın.
4. Oturumlara ihtiyacınız varsa, `~/.openclaw/agents/<agentId>/sessions/`’ü eski makineden
   ayrıca kopyalayın.

## Gelişmiş notlar

- Çoklu ajan yönlendirme, ajan başına farklı çalışma alanları kullanabilir. Yönlendirme yapılandırması için
  [Kanal yönlendirme](/channels/channel-routing) bölümüne bakın.
- `agents.defaults.sandbox` etkinse, ana olmayan oturumlar `agents.defaults.sandbox.workspaceRoot` altında
  oturum başına sandbox çalışma alanlarını kullanabilir.
