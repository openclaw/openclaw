---
title: Sandbox vs Tool Policy vs Elevated
summary: "Bir aracın neden engellendiği: sandbox çalışma zamanı, araç izin/verme politikası ve elevated exec kapıları"
read_when: "'sandbox jail' ile karşılaştığınızda veya bir tool/elevated reddi gördüğünüzde ve değiştirmeniz gereken tam yapılandırma anahtarını istediğinizde."
status: active
---

# Sandbox vs Tool Policy vs Elevated

OpenClaw’da birbiriyle ilişkili (ancak farklı) üç denetim vardır:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) **araçların nerede çalıştığını** belirler (Docker vs host).
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) **hangi araçların mevcut/izinli olduğunu** belirler.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) sandbox içindeyken host üzerinde çalıştırmak için **yalnızca exec’e özel bir kaçış kapısıdır**.

## Hızlı hata ayıklama

OpenClaw’ın _gerçekte_ ne yaptığını görmek için inspector’ı kullanın:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Şunları yazdırır:

- etkin sandbox modu/kapsamı/çalışma alanı erişimi
- oturumun şu anda sandbox’ta olup olmadığı (main vs non-main)
- etkin sandbox araç izin/verme durumu (ve bunun agent/global/default kaynaklı olup olmadığı)
- elevated kapıları ve düzeltme anahtar yolları

## Sandbox: araçların nerede çalıştığı

Sandboxing, `agents.defaults.sandbox.mode` ile kontrol edilir:

- `"off"`: her şey host üzerinde çalışır.
- `"non-main"`: yalnızca non-main oturumlar sandbox’tadır (gruplar/kanallar için yaygın “sürpriz”).
- `"all"`: her şey sandbox’tadır.

Tam matris (kapsam, çalışma alanı bağlamaları, imajlar) için [Sandboxing](/gateway/sandboxing) bölümüne bakın.

### Bind mount’lar (güvenlik hızlı kontrolü)

- `docker.binds` sandbox dosya sistemini _deler_: bağladığınız her şey, ayarladığınız kip ile konteyner içinde görünür (`:ro` veya `:rw`).
- Kipi belirtmezseniz varsayılan okuma-yazmadır; kaynaklar/gizli bilgiler için `:ro` tercih edin.
- `scope: "shared"` agent başına bağlamaları yok sayar (yalnızca global bağlamalar geçerlidir).
- `/var/run/docker.sock` bağlamak, fiilen host denetimini sandbox’a vermek demektir; bunu yalnızca bilinçli olarak yapın.
- Çalışma alanı erişimi (`workspaceAccess: "ro"`/`"rw"`) bağlama kiplerinden bağımsızdır.

## Tool policy: hangi araçların var olduğu/çağrılabildiği

İki katman önemlidir:

- **Tool profile**: `tools.profile` ve `agents.list[].tools.profile` (temel izin listesi)
- **Provider tool profile**: `tools.byProvider[provider].profile` ve `agents.list[].tools.byProvider[provider].profile`
- **Global/agent başına tool policy**: `tools.allow`/`tools.deny` ve `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider tool policy**: `tools.byProvider[provider].allow/deny` ve `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox tool policy** (yalnızca sandbox’tayken geçerlidir): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` ve `agents.list[].tools.sandbox.tools.*`

Genel kurallar:

- `deny` her zaman kazanır.
- `allow` boş değilse, diğer her şey engellenmiş sayılır.
- Tool policy kesin engeldir: `/exec`, reddedilmiş bir `exec` aracını geçersiz kılamaz.
- `/exec` yalnızca yetkili gönderenler için oturum varsayılanlarını değiştirir; araç erişimi vermez.
  Provider tool anahtarları `provider` (örn. `google-antigravity`) veya `provider/model` (örn. `openai/gpt-5.2`) kabul eder.

### Tool grupları (kısayollar)

Tool policy’ler (global, agent, sandbox) birden çok araca genişleyen `group:*` girdilerini destekler:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Mevcut gruplar:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: tüm yerleşik OpenClaw araçları (provider eklentileri hariç)

## Elevated: exec-only “host üzerinde çalıştır”

Elevated **ek araçlar vermez**; yalnızca `exec`’ü etkiler.

- Sandbox’taysanız, `/elevated on` (veya `exec` ile `elevated: true`) host üzerinde çalışır (onaylar yine de uygulanabilir).
- Oturum için exec onaylarını atlamak üzere `/elevated full` kullanın.
- Zaten doğrudan çalışıyorsanız, elevated fiilen etkisizdir (yine de kapılıdır).
- Elevated **skill kapsamlı değildir** ve tool izin/verme kurallarını **geçersiz kılmaz**.
- `/exec`, elevated’dan ayrıdır. Yalnızca yetkili gönderenler için oturum başına exec varsayılanlarını ayarlar.

Kapılar:

- Etkinleştirme: `tools.elevated.enabled` (ve isteğe bağlı `agents.list[].tools.elevated.enabled`)
- Gönderen izin listeleri: `tools.elevated.allowFrom.<provider>` (ve isteğe bağlı `agents.list[].tools.elevated.allowFrom.<provider>`)

[Elevated Mode](/tools/elevated).

## Yaygın “sandbox jail” çözümleri

### “Tool X sandbox tool policy tarafından engellendi”

Düzeltme anahtarları (birini seçin):

- Sandbox’ı devre dışı bırakın: `agents.defaults.sandbox.mode=off` (veya agent başına `agents.list[].sandbox.mode=off`)
- Aracı sandbox içinde izinli yapın:
  - `tools.sandbox.tools.deny`’ten kaldırın (veya agent başına `agents.list[].tools.sandbox.tools.deny`)
  - veya `tools.sandbox.tools.allow`’e ekleyin (ya da agent başına izin verin)

### “Bunun main olduğunu sanıyordum, neden sandbox’ta?”

`"non-main"` modunda, grup/kanal anahtarları _main_ değildir. Ana oturum anahtarını ( `sandbox explain` tarafından gösterilir) kullanın veya modu `"off"` olarak değiştirin.
