---
summary: "Arka plan exec yürütümü ve süreç yönetimi"
read_when:
  - Arka plan exec davranışı eklerken veya değiştirirken
  - Uzun süre çalışan exec görevlerini hata ayıklarken
title: "Arka Plan Exec ve Process Aracı"
---

# Arka Plan Exec + Process Aracı

OpenClaw, `exec` aracı üzerinden kabuk komutlarını çalıştırır ve uzun süre çalışan görevleri bellekte tutar. `process` aracı bu arka plan oturumlarını yönetir.

## exec aracı

Temel parametreler:

- `command` (gerekli)
- `yieldMs` (varsayılan 10000): bu gecikmeden sonra otomatik olarak arka plana al
- `background` (bool): hemen arka plana al
- `timeout` (saniye, varsayılan 1800): bu zaman aşımından sonra süreci sonlandır
- `elevated` (bool): yükseltilmiş mod etkin/izinliyse ana makinede çalıştır
- Gerçek bir TTY mi gerekiyor? `pty: true` ayarlayın.
- `workdir`, `env`

Davranış:

- Ön planda çalışanlar çıktıyı doğrudan döndürür.
- Arka plana alındığında (açıkça veya zaman aşımıyla), araç `status: "running"` + `sessionId` ve kısa bir kuyruk döndürür.
- Çıktı, oturum yoklanana veya temizlenene kadar bellekte tutulur.
- `process` aracı izinli değilse, `exec` eşzamanlı çalışır ve `yieldMs`/`background` yok sayılır.

## Child process bridging

exec/process araçları dışında uzun süre çalışan alt süreçler oluşturulurken (örneğin CLI yeniden başlatmaları veya gateway yardımcıları), sonlandırma sinyallerinin iletilmesi ve çıkış/hata durumunda dinleyicilerin ayrılması için alt süreç köprü yardımcısını ekleyin. Bu, systemd üzerinde yetim süreçleri önler ve platformlar arasında kapatma davranışını tutarlı kılar.

Environment overrides:

- `PI_BASH_YIELD_MS`: varsayılan yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: bellek içi çıktı üst sınırı (karakter)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: akış başına bekleyen stdout/stderr üst sınırı (karakter)
- `PI_BASH_JOB_TTL_MS`: tamamlanan oturumlar için TTL (ms, 1 dk–3 sa ile sınırlı)

Yapılandırma (tercih edilir):

- `tools.exec.backgroundMs` (varsayılan 10000)
- `tools.exec.timeoutSec` (varsayılan 1800)
- `tools.exec.cleanupMs` (varsayılan 1800000)
- `tools.exec.notifyOnExit` (varsayılan true): arka plana alınmış bir exec çıktığında bir sistem olayı kuyruğa al ve istek heartbeat’i talep et.

## process aracı

Eylemler:

- `list`: çalışan + tamamlanan oturumlar
- `poll`: bir oturum için yeni çıktıyı boşalt (çıkış durumunu da bildirir)
- `log`: birikmiş çıktıyı oku (`offset` + `limit` desteklenir)
- `write`: stdin gönder (`data`, isteğe bağlı `eof`)
- `kill`: bir arka plan oturumunu sonlandır
- `clear`: tamamlanan bir oturumu bellekten kaldır
- `remove`: çalışıyorsa öldür, aksi halde tamamlandıysa temizle

Notlar:

- Yalnızca arka plana alınmış oturumlar listelenir/bellekte tutulur.
- Süreç yeniden başlatıldığında oturumlar kaybolur (diskte kalıcılık yoktur).
- Oturum günlükleri yalnızca `process poll/log` çalıştırılır ve araç sonucu kaydedilirse sohbet geçmişine kaydedilir.
- `process` ajan başına kapsamlıdır; yalnızca o ajan tarafından başlatılan oturumları görür.
- `process list`, hızlı taramalar için türetilmiş bir `name` (komut fiili + hedef) içerir.
- `process log`, satır tabanlı `offset`/`limit` kullanır (son N satırı almak için `offset`’yı atlayın).

## Örnekler

Uzun bir görevi çalıştırın ve daha sonra yoklayın:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Hemen arka planda başlatın:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

stdin gönderin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
