---
summary: "OpenClaw sandboxing’in nasıl çalıştığı: modlar, kapsamlar, çalışma alanı erişimi ve imajlar"
title: Sandboxing
read_when: "Sandboxing için özel bir açıklamaya ihtiyaç duyduğunuzda veya agents.defaults.sandbox ayarını ince ayarlamanız gerektiğinde."
status: active
---

# Sandboxing

OpenClaw, etki alanını azaltmak için **araçları Docker konteynerleri içinde** çalıştırabilir.
Bu **isteğe bağlıdır** ve yapılandırma ile kontrol edilir (`agents.defaults.sandbox` veya
`agents.list[].sandbox`). Sandboxing kapalıysa, araçlar ana makinede çalışır.
Gateway ana makinede kalır; etkinleştirildiğinde araç yürütme izole bir sandbox içinde çalışır.

Bu kusursuz bir güvenlik sınırı değildir, ancak modelin hatalı bir şey yapması durumunda
dosya sistemi ve süreç erişimini anlamlı ölçüde sınırlar.

## What gets sandboxed

- Araç yürütme (`exec`, `read`, `write`, `edit`, `apply_patch`, `process` vb.).
- İsteğe bağlı sandbox’lanmış tarayıcı (`agents.defaults.sandbox.browser`).
  - Varsayılan olarak, tarayıcı aracı buna ihtiyaç duyduğunda sandbox tarayıcı otomatik başlar (CDP’nin erişilebilir olmasını sağlar).
    `agents.defaults.sandbox.browser.autoStart` ve `agents.defaults.sandbox.browser.autoStartTimeoutMs` ile yapılandırılır.
  - `agents.defaults.sandbox.browser.allowHostControl`, sandbox’lanmış oturumların ana makine tarayıcısını açıkça hedeflemesine izin verir.
  - İsteğe bağlı izin listeleri `target: "custom"`’yı sınırlar: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Sandbox’a alınmayanlar:

- Gateway sürecinin kendisi.
- Ana makinede çalışmasına açıkça izin verilen herhangi bir araç (ör. `tools.elevated`).
  - **Yükseltilmiş çalıştırma ana makinede çalışır ve sandboxing’i atlar.**
  - Sandboxing kapalıysa, `tools.elevated` yürütmeyi değiştirmez (zaten ana makinededir). Bkz. [Elevated Mode](/tools/elevated).

## Modlar

`agents.defaults.sandbox.mode`, sandboxing’in **ne zaman** kullanılacağını kontrol eder:

- `"off"`: sandboxing yok.
- `"non-main"`: yalnızca **ana olmayan** oturumlar sandbox’lanır (normal sohbetlerin ana makinede kalmasını istiyorsanız varsayılan).
- `"all"`: her oturum bir sandbox içinde çalışır.
  Not: `"non-main"`, ajan kimliğine değil `session.mainKey`’ye (varsayılan `"main"`) dayanır.
  Grup/kanal oturumları kendi anahtarlarını kullanır; bu nedenle ana olmayan sayılır ve sandbox’lanır.

## Kapsam

`agents.defaults.sandbox.scope`, **kaç konteyner** oluşturulacağını kontrol eder:

- `"session"` (varsayılan): oturum başına bir konteyner.
- `"agent"`: ajan başına bir konteyner.
- `"shared"`: tüm sandbox’lanmış oturumlar tarafından paylaşılan tek bir konteyner.

## Çalışma alanı erişimi

`agents.defaults.sandbox.workspaceAccess`, **sandbox’ın neyi görebileceğini** kontrol eder:

- `"none"` (varsayılan): araçlar `~/.openclaw/sandboxes` altında bir sandbox çalışma alanı görür.
- `"ro"`: ajan çalışma alanını `/agent` konumuna salt okunur olarak bağlar (`write`/`edit`/`apply_patch`’ı devre dışı bırakır).
- `"rw"`: ajan çalışma alanını `/workspace` konumuna okuma/yazma olarak bağlar.

Gelen medya etkin sandbox çalışma alanına kopyalanır (`media/inbound/*`).
Skills notu: `read` aracı sandbox köklüdür. `workspaceAccess: "none"` ile
OpenClaw, uygun Skills’leri okunabilmeleri için sandbox çalışma alanına (`.../skills`) yansıtır. `"rw"` ile çalışma alanı Skills’leri `/workspace/skills` konumundan okunabilir.

## Özel bind mount’lar

`agents.defaults.sandbox.docker.binds`, ek ana makine dizinlerini konteynere bağlar.
Biçim: `host:container:mode` (ör., `"/home/user/source:/source:rw"`).

Genel ve ajan başına bind’ler **birleştirilir** (değiştirilmez). `scope: "shared"` altında, ajan başına bind’ler yok sayılır.

Örnek (salt okunur kaynak + docker soketi):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Güvenlik notları:

- Bind’ler sandbox dosya sistemini atlar: ayarladığınız kip neyse (`:ro` veya `:rw`) o şekilde ana makine yollarını açığa çıkarır.
- Hassas mount’lar (ör., `docker.sock`, sırlar, SSH anahtarları) kesinlikle gerekmedikçe `:ro` olmalıdır.
- Çalışma alanına yalnızca okuma erişimi gerekiyorsa `workspaceAccess: "ro"` ile birlikte kullanın; bind kipleri bağımsız kalır.
- Bind’lerin araç politikası ve yükseltilmiş çalıştırma ile nasıl etkileştiği için [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) sayfasına bakın.

## İmajlar + kurulum

Varsayılan imaj: `openclaw-sandbox:bookworm-slim`

Bir kez derleyin:

```bash
scripts/sandbox-setup.sh
```

Not: varsayılan imaj **Node içermez**. Bir Skill Node’a (veya
diğer çalışma zamanlarına) ihtiyaç duyuyorsa, ya özel bir imaj oluşturun ya da
`sandbox.docker.setupCommand` üzerinden kurun (ağ çıkışı + yazılabilir kök +
root kullanıcı gerektirir).

Sandbox’lanmış tarayıcı imajı:

```bash
scripts/sandbox-browser-setup.sh
```

Varsayılan olarak, sandbox konteynerleri **ağsız** çalışır.
`agents.defaults.sandbox.docker.network` ile geçersiz kılın.

Docker kurulumları ve konteynerleştirilmiş gateway burada yer alır:
[Docker](/install/docker)

## setupCommand (tek seferlik konteyner kurulumu)

`setupCommand`, sandbox konteyneri oluşturulduktan sonra **bir kez** çalışır (her çalıştırmada değil).
Konteyner içinde `sh -lc` aracılığıyla yürütülür.

Yollar:

- Genel: `agents.defaults.sandbox.docker.setupCommand`
- Ajan başına: `agents.list[].sandbox.docker.setupCommand`

Common pitfalls:

- Varsayılan `docker.network` değeri `"none"`’dır (çıkış yok), bu nedenle paket kurulumları başarısız olur.
- `readOnlyRoot: true` yazmaları engeller; `readOnlyRoot: false` ayarlayın veya özel bir imaj oluşturun.
- Paket kurulumları için `user` root olmalıdır (`user`’u kaldırın veya `user: "0:0"` ayarlayın).
- Sandbox exec, ana makinenin `process.env`’sini **devralmaz**. Skill API anahtarları için `agents.defaults.sandbox.docker.env` (veya özel bir imaj) kullanın.

## Araç politikası + kaçış kapakları

Araç izin/verme-engelleme politikaları sandbox kurallarından önce hâlâ uygulanır. Bir araç genel veya ajan başına engelliyse, sandboxing onu geri getirmez.

`tools.elevated`, `exec`’i ana makinede çalıştıran açık bir kaçış kapağıdır.
`/exec` yönergeleri yalnızca yetkili gönderenler için geçerlidir ve oturum başına kalıcıdır; `exec`’yi kesin olarak devre dışı bırakmak için araç politikası engelini kullanın (bkz. [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Hata ayıklama:

- Etkin sandbox modu, araç politikası ve düzeltme yapılandırma anahtarlarını incelemek için `openclaw sandbox explain` kullanın.
- “Bu neden engellendi?” zihinsel modeli için [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) sayfasına bakın.
  Sıkı tutun.

## Multi-agent overrides

Her ajan sandbox + araçları geçersiz kılabilir:
`agents.list[].sandbox` ve `agents.list[].tools` (sandbox araç politikası için ayrıca `agents.list[].tools.sandbox.tools`).
Öncelik sırası için [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) sayfasına bakın.

## Minimal enable example

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## İlgili belgeler

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
