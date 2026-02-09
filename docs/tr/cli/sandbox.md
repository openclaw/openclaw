---
title: Sandbox CLI
summary: "Sandbox kapsayıcılarını yönetin ve etkin sandbox politikasını inceleyin"
read_when: "Sandbox kapsayıcılarını yönetiyor veya sandbox/araç-politikası davranışını hata ayıklıyorsanız."
status: active
---

# Sandbox CLI

Yalıtılmış ajan yürütmesi için Docker tabanlı sandbox kapsayıcılarını yönetin.

## Genel bakış

OpenClaw, güvenlik için ajanları yalıtılmış Docker kapsayıcılarında çalıştırabilir. `sandbox` komutları, özellikle güncellemeler veya yapılandırma değişikliklerinden sonra bu kapsayıcıları yönetmenize yardımcı olur.

## Komutlar

### `openclaw sandbox explain`

**Etkin** sandbox modu/kapsamı/çalışma alanı erişimini, sandbox araç politikasını ve yükseltilmiş geçitleri (düzeltme yapılandırma anahtarı yollarıyla) inceleyin.

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Tüm sandbox kapsayıcılarını durumları ve yapılandırmalarıyla birlikte listeleyin.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Çıktı şunları içerir:**

- Kapsayıcı adı ve durumu (çalışıyor/durduruldu)
- Docker imajı ve yapılandırmayla eşleşip eşleşmediği
- Yaş (oluşturulmasından bu yana geçen süre)
- Boşta kalma süresi (son kullanımdan bu yana geçen süre)
- İlişkili oturum/ajan

### `openclaw sandbox recreate`

Güncellenmiş imajlar/yapılandırmalarla yeniden oluşturmayı zorlamak için sandbox kapsayıcılarını kaldırın.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Seçenekler:**

- `--all`: Tüm sandbox kapsayıcılarını yeniden oluştur
- `--session <key>`: Belirli bir oturum için kapsayıcıyı yeniden oluştur
- `--agent <id>`: Belirli bir ajan için kapsayıcıları yeniden oluştur
- `--browser`: Yalnızca tarayıcı kapsayıcılarını yeniden oluştur
- `--force`: Onay istemini atla

**Önemli:** Kapsayıcılar, ajan bir sonraki kullanımda otomatik olarak yeniden oluşturulur.

## Kullanım Senaryoları

### Docker imajlarını güncelledikten sonra

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Sandbox yapılandırmasını değiştirdikten sonra

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### setupCommand değiştirdikten sonra

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Yalnızca belirli bir ajan için

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Bu neden gerekli?

**Sorun:** Sandbox Docker imajlarını veya yapılandırmayı güncellediğinizde:

- Mevcut kapsayıcılar eski ayarlarla çalışmaya devam eder
- Kapsayıcılar yalnızca 24 saatlik hareketsizlikten sonra temizlenir
- Düzenli kullanılan ajanlar eski kapsayıcıları süresiz olarak çalışır halde tutar

**Çözüm:** Eski kapsayıcıların kaldırılmasını zorlamak için `openclaw sandbox recreate` kullanın. Bir sonraki ihtiyaç duyulduğunda güncel ayarlarla otomatik olarak yeniden oluşturulurlar.

İpucu: Manuel `docker rm` yerine `openclaw sandbox recreate` tercih edin. Gateway’nin kapsayıcı adlandırmasını kullanır ve kapsam/oturum anahtarları değiştiğinde uyumsuzlukları önler.

## Yapılandırma

Sandbox ayarları `~/.openclaw/openclaw.json` içinde `agents.defaults.sandbox` altında bulunur (ajan başına geçersiz kılmalar `agents.list[].sandbox` içine gider):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## Ayrıca Bakınız

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - Sandbox kurulumunu kontrol edin
