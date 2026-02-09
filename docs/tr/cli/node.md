---
summary: "`openclaw node` için CLI başvurusu (başsız node ana makinesi)"
read_when:
  - Başsız node ana makinesini çalıştırırken
  - system.run için macOS olmayan bir node’u eşleştirirken
title: "node"
---

# `openclaw node`

Gateway WebSocket’e bağlanan ve bu makinede
`system.run` / `system.which` sağlayan bir **başsız node ana makinesi** çalıştırır.

## Neden bir node ana makinesi kullanmalısınız?

Ağınızdaki **diğer makinelerde komut çalıştırmak** istediğinizde ve oralara tam bir macOS yardımcı uygulaması kurmak istemediğinizde bir node ana makinesi kullanın.

Yaygın kullanım örnekleri:

- Uzak Linux/Windows makinelerinde komut çalıştırma (derleme sunucuları, laboratuvar makineleri, NAS).
- Exec işlemlerini gateway üzerinde **sandboxed** tutup, onaylanmış çalıştırmaları diğer ana makinelere devretme.
- Otomasyon veya CI node’ları için hafif, başsız bir çalıştırma hedefi sağlama.

Çalıştırma, node ana makinesindeki **exec onayları** ve ajan başına izin listeleriyle korunmaya devam eder; böylece komut erişimini kapsamlı ve açık tutabilirsiniz.

## Tarayıcı proxy’si (sıfır yapılandırma)

Node ana makineleri, node üzerinde `browser.enabled` devre dışı bırakılmamışsa otomatik olarak bir tarayıcı proxy’si duyurur. Bu, ajanın ek yapılandırma olmadan o node üzerinde tarayıcı otomasyonu kullanmasını sağlar.

Gerekirse node üzerinde devre dışı bırakın:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Çalıştır (ön planda)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Seçenekler:

- `--host <host>`: Gateway WebSocket ana makinesi (varsayılan: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket portu (varsayılan: `18789`)
- `--tls`: Gateway bağlantısı için TLS kullan
- `--tls-fingerprint <sha256>`: Beklenen TLS sertifika parmak izi (sha256)
- `--node-id <id>`: Node kimliğini geçersiz kıl (eşleştirme belirtecini temizler)
- `--display-name <name>`: Node görünen adını geçersiz kıl

## Servis (arka planda)

Başsız bir node ana makinesini kullanıcı servisi olarak kurun.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Seçenekler:

- `--host <host>`: Gateway WebSocket ana makinesi (varsayılan: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket portu (varsayılan: `18789`)
- `--tls`: Gateway bağlantısı için TLS kullan
- `--tls-fingerprint <sha256>`: Beklenen TLS sertifika parmak izi (sha256)
- `--node-id <id>`: Node kimliğini geçersiz kıl (eşleştirme belirtecini temizler)
- `--display-name <name>`: Node görünen adını geçersiz kıl
- `--runtime <runtime>`: Servis çalışma zamanı (`node` veya `bun`)
- `--force`: Zaten kuruluysa yeniden kur/üzerine yaz

Servisi yönetin:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Ön planda bir node ana makinesi (servis olmadan) için `openclaw node run` kullanın.

Servis komutları, makine tarafından okunabilir çıktı için `--json` kabul eder.

## Pairing

İlk bağlantı, Gateway üzerinde beklemede olan bir node eşleştirme isteği oluşturur.
Şuradan onaylayın:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Node ana makinesi, node kimliğini, belirtecini, görünen adını ve gateway bağlantı bilgilerini
`~/.openclaw/node.json` içinde saklar.

## Exec onayları

`system.run`, yerel exec onaylarıyla sınırlandırılmıştır:

- `~/.openclaw/exec-approvals.json`
- [Exec onayları](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (Gateway’den düzenleyin)
