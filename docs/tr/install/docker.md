---
summary: "OpenClaw için isteğe bağlı Docker tabanlı kurulum ve işe alım"
read_when:
  - Yerel kurulumlar yerine kapsayıcılı bir gateway istiyorsunuz
  - Docker akışını doğruluyorsunuz
title: "Docker"
---

# Docker (isteğe bağlı)

Docker **isteğe bağlıdır**. Yalnızca kapsayıcılı bir gateway istiyorsanız veya Docker akışını doğrulamak istiyorsanız kullanın.

## Docker benim için uygun mu?

- **Evet**: izole, atılabilir bir gateway ortamı istiyorsunuz ya da OpenClaw’ı yerel kurulumlar olmadan bir ana makinede çalıştırmak istiyorsunuz.
- **Hayır**: kendi makinenizde çalışıyorsunuz ve yalnızca en hızlı geliştirme döngüsünü istiyorsunuz. Bunun yerine normal kurulum akışını kullanın.
- **Sandboxing notu**: ajan sandboxing de Docker kullanır, ancak tam gateway’in Docker’da çalışmasını **gerektirmez**. [Sandboxing](/gateway/sandboxing).

Bu kılavuz şunları kapsar:

- Kapsayıcılı Gateway (Docker’da tam OpenClaw)
- Oturum başına Agent Sandbox (ana makinede gateway + Docker ile izole ajan araçları)

Sandboxing ayrıntıları: [Sandboxing](/gateway/sandboxing)

## Gereksinimler

- Docker Desktop (veya Docker Engine) + Docker Compose v2
- İmajlar + günlükler için yeterli disk alanı

## Kapsayıcılı Gateway (Docker Compose)

### Hızlı başlangıç (önerilen)

Depo kökünden:

```bash
./docker-setup.sh
```

Bu betik:

- gateway imajını oluşturur
- işe alım sihirbazını çalıştırır
- isteğe bağlı sağlayıcı kurulum ipuçlarını yazdırır
- Docker Compose üzerinden gateway’i başlatır
- bir gateway belirteci üretir ve bunu `.env` dosyasına yazar

Tüm kapsayıcı ana dizinini kalıcı hale getir (isteğe bağlı)

- `OPENCLAW_DOCKER_APT_PACKAGES` — derleme sırasında ek apt paketleri yükler
- `OPENCLAW_EXTRA_MOUNTS` — ek ana makine bağlama (bind mount) ekler
- `OPENCLAW_HOME_VOLUME` — `/home/node`’yi adlandırılmış bir birimde kalıcı hale getirir

Tamamlandıktan sonra:

- Tarayıcınızda `http://127.0.0.1:18789/`’ü açın.
- Belirteci Control UI’ye yapıştırın (Ayarlar → token).
- URL’ye tekrar mı ihtiyacınız var? `docker compose run --rm openclaw-cli dashboard --no-open` çalıştırın.

Ana makinede yapılandırma/çalışma alanı yazar:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Bir VPS üzerinde mi çalışıyorsunuz? [Hetzner (Docker VPS)](/install/hetzner).

### Manuel akış (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Not: `docker compose ...` komutunu depo kökünden çalıştırın. Eğer
`OPENCLAW_EXTRA_MOUNTS` veya `OPENCLAW_HOME_VOLUME`’u etkinleştirdiyseniz, kurulum betiği
`docker-compose.extra.yml` yazar; başka bir yerde Compose çalıştırırken bunu dahil edin:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI belirteci + eşleştirme (Docker)

“unauthorized” veya “disconnected (1008): pairing required” görürseniz, yeni bir
kontrol paneli bağlantısı alın ve tarayıcı cihazını onaylayın:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Daha fazla ayrıntı: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Ek bağlamalar (isteğe bağlı)

Ek ana makine dizinlerini kapsayıcılara bağlamak istiyorsanız,
`OPENCLAW_EXTRA_MOUNTS`’i `docker-setup.sh` çalıştırmadan önce ayarlayın. Bu,
virgülle ayrılmış bir Docker bind mount listesi kabul eder ve her ikisine de
`openclaw-gateway` ve `openclaw-cli` için `docker-compose.extra.yml` oluşturarak uygular.

Örnek:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notlar:

- Yollar macOS/Windows’ta Docker Desktop ile paylaşılmış olmalıdır.
- `OPENCLAW_EXTRA_MOUNTS`’yı düzenlerseniz, ek compose dosyasını yeniden üretmek için
  `docker-setup.sh`’yi yeniden çalıştırın.
- `docker-compose.extra.yml` oluşturulmuştur. Elle düzenlemeyin.

### Salt okunur araçlar + salt okunur çalışma alanı (aile/iş ajanı)

`/home/node`’un kapsayıcı yeniden oluşturma boyunca kalıcı olmasını istiyorsanız,
`OPENCLAW_HOME_VOLUME` üzerinden adlandırılmış bir birim ayarlayın. Bu, bir Docker birimi
oluşturur ve `/home/node`’e bağlar; standart yapılandırma/çalışma alanı bind
mount’larını korur. Burada adlandırılmış bir birim kullanın (bind yolu değil);
bind mount’lar için `OPENCLAW_EXTRA_MOUNTS` kullanın.

Örnek:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Bunu ek bağlamalarla birleştirebilirsiniz:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notlar:

- `OPENCLAW_HOME_VOLUME`’ü değiştirirseniz, ek compose dosyasını yeniden üretmek için
  `docker-setup.sh`’ü yeniden çalıştırın.
- Adlandırılmış birim, `docker volume rm <name>` ile kaldırılana kadar kalıcıdır.

### Ek apt paketleri yükleme (isteğe bağlı)

İmaj içinde sistem paketlerine ihtiyacınız varsa (örneğin, derleme araçları veya
medya kütüphaneleri), `OPENCLAW_DOCKER_APT_PACKAGES`’yı `docker-setup.sh` çalıştırmadan önce ayarlayın.
Bu, paketleri imaj derlemesi sırasında yükler; böylece kapsayıcı silinse bile
kalıcı olurlar.

Örnek:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Notlar:

- Bu, boşlukla ayrılmış apt paket adları listesini kabul eder.
- `OPENCLAW_DOCKER_APT_PACKAGES`’i değiştirirseniz, imajı yeniden derlemek için
  `docker-setup.sh`’u yeniden çalıştırın.

### Güç kullanıcıları / tam özellikli kapsayıcı (isteğe bağlı)

Varsayılan Docker imajı **güvenlik öncelikli**dir ve root olmayan `node`
kullanıcısı olarak çalışır. Bu, saldırı yüzeyini küçük tutar; ancak şu anlamlara gelir:

- çalışma zamanında sistem paketi kurulumu yok
- varsayılan olarak Homebrew yok
- paketlenmiş Chromium/Playwright tarayıcıları yok

Daha tam özellikli bir kapsayıcı istiyorsanız, bu isteğe bağlı ayarları kullanın:

1. **`/home/node`’u kalıcı hale getirin**; böylece tarayıcı indirmeleri ve araç
   önbellekleri korunur:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Sistem bağımlılıklarını imaja gömün** (tekrarlanabilir + kalıcı):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx` olmadan Playwright tarayıcılarını yükleyin**
   (npm override çakışmalarını önler):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Playwright’ın sistem bağımlılıklarını yüklemesi gerekiyorsa, çalışma zamanında
`--with-deps` kullanmak yerine imajı `OPENCLAW_DOCKER_APT_PACKAGES` ile yeniden derleyin.

4. **Playwright tarayıcı indirmelerini kalıcı hale getirin**:

- `docker-compose.yml` içinde `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`’i ayarlayın.
- `/home/node`’nin `OPENCLAW_HOME_VOLUME` ile kalıcı olduğundan emin olun veya
  `/home/node/.cache/ms-playwright`’yi `OPENCLAW_EXTRA_MOUNTS` ile bağlayın.

### İzinler + EACCES

İmaj `node` (uid 1000) olarak çalışır. `/home/node/.openclaw` üzerinde izin
hataları görürseniz, ana makine bind mount’larınızın uid 1000’e ait olduğundan emin olun.

Örnek (Linux ana makine):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Kolaylık için root olarak çalıştırmayı seçerseniz, güvenlik ödününü kabul edersiniz.

### Daha hızlı yeniden derlemeler (önerilen)

Yeniden derlemeleri hızlandırmak için Dockerfile’ınızı bağımlılık katmanları
önbelleğe alınacak şekilde sıralayın.
Bu, kilit dosyaları değişmedikçe
`pnpm install`’ün yeniden çalıştırılmasını önler:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Kanal kurulumu (isteğe bağlı)

Kanal yapılandırmak için CLI kapsayıcısını kullanın, ardından gerekirse gateway’i
yeniden başlatın.

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (bot belirteci):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (bot belirteci):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Belgeler: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (başsız Docker)

Sihirbazda OpenAI Codex OAuth’u seçerseniz, bir tarayıcı URL’si açar ve
`http://127.0.0.1:1455/auth/callback` üzerinde bir geri çağrıyı yakalamaya çalışır. Docker’da veya
başsız kurulumlarda bu geri çağrı bir tarayıcı hatası gösterebilir. Ulaştığınız
tam yönlendirme URL’sini kopyalayın ve kimlik doğrulamayı tamamlamak için
sihirbaza geri yapıştırın.

### Sağlık denetimi

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E duman testi (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR içe aktarma duman testi (Docker)

```bash
pnpm test:docker:qr
```

### Notlar

- Gateway bind, kapsayıcı kullanımı için varsayılan olarak `lan`’e bağlanır.
- Dockerfile CMD, `--allow-unconfigured` kullanır; `local` yerine `gateway.mode` ile
  bağlanmış yapılandırma yine de başlar. Koruyucuyu zorlamak için CMD’yi geçersiz kılın.
- Gateway kapsayıcısı, oturumlar için tek doğruluk kaynağıdır (`~/.openclaw/agents/<agentId>/sessions/`).

## Agent Sandbox (ana makinede gateway + Docker araçları)

Derinlemesine: [Sandboxing](/gateway/sandboxing)

### Ne yapar

`agents.defaults.sandbox` etkinleştirildiğinde, **ana olmayan oturumlar** araçları bir Docker
kapsayıcısı içinde çalıştırır. Gateway ana makinede kalır, ancak araç yürütümü izoledir:

- kapsam: varsayılan olarak `"agent"` (ajan başına bir kapsayıcı + çalışma alanı)
- kapsam: oturum başına izolasyon için `"session"`
- kapsam başına çalışma alanı klasörü `/workspace`’e bağlanır
- isteğe bağlı ajan çalışma alanı erişimi (`agents.defaults.sandbox.workspaceAccess`)
- izin/verme araç politikası (reddetme kazanır)
- gelen medya, araçların okuyabilmesi için etkin sandbox çalışma alanına kopyalanır
  (`workspaceAccess: "rw"` ile bu, ajan çalışma alanına düşer) (`media/inbound/*`)

Uyarı: `scope: "shared"` oturumlar arası izolasyonu devre dışı bırakır. Tüm oturumlar
tek bir kapsayıcıyı ve tek bir çalışma alanını paylaşır.

### Ajan başına sandbox profilleri (çoklu ajan)

Çoklu ajan yönlendirmesi kullanıyorsanız, her ajan sandbox + araç ayarlarını
`agents.list[].sandbox` ve `agents.list[].tools` (artı `agents.list[].tools.sandbox.tools`) ile geçersiz kılabilir. Bu, tek bir gateway’de karışık erişim seviyeleri çalıştırmanıza olanak tanır:

- Tam erişim (kişisel ajan)
- Ajan başına bir kapsayıcı
- Dosya sistemi/kabuk araçları yok (genel ajan)

Örnekler, öncelik ve sorun giderme için
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)’a bakın.

### Varsayılan davranış

- İmaj: `openclaw-sandbox:bookworm-slim`
- Özel tarayıcı imajı:
- Ajan çalışma alanı erişimi: `workspaceAccess: "none"` (varsayılan) `~/.openclaw/sandboxes` kullanır
  - `"ro"`, sandbox çalışma alanını `/workspace`’te tutar ve ajan
    çalışma alanını `/agent`’ya salt-okunur bağlar
    (`write`/`edit`/`apply_patch`’u devre dışı bırakır)
  - `"rw"`, ajan çalışma alanını `/workspace`’e okuma/yazma bağlar
- Otomatik budama: boşta > 24s VEYA yaş > 7g
- Ağ: varsayılan olarak `none` (çıkış gerekiyorsa açıkça etkinleştirin)
- Varsayılan izin verilenler: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Varsayılan reddedilenler: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Sandboxing’i etkinleştirme

`setupCommand` içine paketler kurmayı planlıyorsanız, şunları not edin:

- Varsayılan `docker.network`, `"none"`’dir (çıkış yok).
- `readOnlyRoot: true`, paket kurulumlarını engeller.
- `user`, `apt-get` için root olmalıdır
  (`user`’i atlayın veya `user: "0:0"`’yı ayarlayın).
  OpenClaw, `setupCommand` (veya docker yapılandırması) değiştiğinde kapsayıcıları
  otomatik olarak yeniden oluşturur; kapsayıcı **yakın zamanda kullanılmışsa**
  (yaklaşık 5 dakika içinde) hariçtir. Sıcak kapsayıcılar, tam
  `openclaw sandbox recreate ...` komutuyla bir uyarı günlüğe yazar.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Sertleştirme ayarları `agents.defaults.sandbox.docker` altında bulunur:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Çoklu ajan: `agents.defaults.sandbox.{docker,browser,prune}.*`’i, ajan başına `agents.list[].sandbox.{docker,browser,prune}.*` üzerinden geçersiz kılın
(`agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` `"shared"` olduğunda yok sayılır).

### Varsayılan sandbox imajını derleme

```bash
scripts/sandbox-setup.sh
```

Bu, `Dockerfile.sandbox` kullanarak `openclaw-sandbox:bookworm-slim`’yı derler.

### Sandbox ortak imajı (isteğe bağlı)

Ortak derleme araçları (Node, Go, Rust, vb.) içeren bir sandbox imajı istiyorsanız,
ortak imajı derleyin:

```bash
scripts/sandbox-common-setup.sh
```

Bu, `openclaw-sandbox-common:bookworm-slim`’yı derler. Kullanmak için:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Sandbox tarayıcı imajı

Tarayıcı aracını sandbox içinde çalıştırmak için tarayıcı imajını derleyin:

```bash
scripts/sandbox-browser-setup.sh
```

Bu, `Dockerfile.sandbox-browser` kullanarak `openclaw-sandbox-browser:bookworm-slim`’yı derler. Kapsayıcı, CDP etkin
Chromium ve isteğe bağlı bir noVNC gözlemcisiyle (Xvfb üzerinden başlı) çalışır.

Notlar:

- Başlı (Xvfb), başsız olana kıyasla bot engellemeyi azaltır.
- Başsız, `agents.defaults.sandbox.browser.headless=true` ayarlanarak yine de kullanılabilir.
- Tam bir masaüstü ortamı (GNOME) gerekmez; Xvfb ekranı sağlar.

Yapılandırmayı kullanın:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

Etkinleştirildiğinde, ajan şunları alır:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Durumu hacimde kalıcı hale getirir

- sandbox tarayıcı kontrol URL’si ( `browser` aracı için)
- noVNC URL’si (etkinse ve headless=false)

Unutmayın: araçlar için bir izin listesi kullanıyorsanız, `browser`’ü ekleyin
(ve reddedenlerden kaldırın) yoksa araç engelli kalır.
Budama kuralları (`agents.defaults.sandbox.prune`) tarayıcı kapsayıcıları için de geçerlidir.

### Özel sandbox imajı

Kendi imajınızı oluşturun ve yapılandırmayı ona yönlendirin:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### Araç politikası (izin/verme)

- `deny`, `allow`’ya üstün gelir.
- `allow` boşsa: tüm araçlar (reddedilenler hariç) kullanılabilir.
- `allow` boş değilse: yalnızca `allow` içindeki araçlar
  (reddedilenler çıkarılarak) kullanılabilir.

### Budama stratejisi

İki ayar:

- `prune.idleHours`: X saat kullanılmayan kapsayıcıları kaldır (0 = devre dışı)
- `prune.maxAgeDays`: X günden eski kapsayıcıları kaldır (0 = devre dışı)

Örnek:

- Yoğun oturumları tut ama ömrü sınırla:
  `idleHours: 24`, `maxAgeDays: 7`
- Asla budama:
  `idleHours: 0`, `maxAgeDays: 0`

### Güvenlik notları

- Sert duvar yalnızca **araçlar** için geçerlidir (exec/read/write/edit/apply_patch).
- Tarayıcı/kamera/canvas gibi ana makineye özgü araçlar varsayılan olarak engellidir.
- Sandbox’ta `browser`’e izin vermek **izolasyonu bozar** (tarayıcı ana makinede çalışır).

## Sorun Giderme

- İmaj eksik: [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) ile derleyin veya `agents.defaults.sandbox.docker.image`’i ayarlayın.
- Kapsayıcı çalışmıyor: talep üzerine oturum başına otomatik oluşturulur.
- Sandbox’ta izin hataları: `docker.user`’u, bağladığınız çalışma alanının
  sahipliğiyle eşleşen bir UID:GID’ye ayarlayın (veya çalışma alanı klasörünü chown edin).
- Özel araçlar bulunamıyor: OpenClaw komutları `sh -lc` (login shell) ile
  çalıştırır; bu, `/etc/profile`’yi kaynak alır ve PATH’i sıfırlayabilir. Özel araç yollarınızı başa eklemek için `docker.env.PATH`’yi ayarlayın
  (örn., `/custom/bin:/usr/local/share/npm-global/bin`), ya da Dockerfile’ınızda `/etc/profile.d/` altında
  bir betik ekleyin.
