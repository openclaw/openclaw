---
summary: "Linux’te OpenClaw tarayıcı denetimi için Chrome/Brave/Edge/Chromium CDP başlatma sorunlarını giderin"
read_when: "Linux’te tarayıcı denetimi başarısız olduğunda, özellikle snap Chromium ile"
title: "Tarayıcı Sorun Giderme"
---

# Tarayıcı Sorun Giderme (Linux)

## Sorun: "18800 portunda Chrome CDP başlatılamadı"

OpenClaw’ın tarayıcı denetim sunucusu, Chrome/Brave/Edge/Chromium’u şu hata ile başlatamaz:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Kök Neden

Ubuntu’da (ve birçok Linux dağıtımında) varsayılan Chromium kurulumu bir **snap paketi**dir. Snap’in AppArmor kısıtlaması, OpenClaw’ın tarayıcı sürecini başlatma ve izleme biçimine müdahale eder.

`apt install chromium` komutu, snap’e yönlendiren bir stub paket kurar:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Bu gerçek bir tarayıcı DEĞİLDİR — yalnızca bir sarmalayıcıdır.

### Çözüm 1: Google Chrome Kurun (Önerilen)

Snap tarafından sandbox’lanmamış resmi Google Chrome `.deb` paketini kurun:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Ardından OpenClaw yapılandırmanızı güncelleyin (`~/.openclaw/openclaw.json`):

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Çözüm 2: Ek-Attach Modu ile Snap Chromium Kullanın

Snap Chromium kullanmanız gerekiyorsa, OpenClaw’ı elle başlatılan bir tarayıcıya bağlanacak şekilde yapılandırın:

1. Yapılandırmayı güncelleyin:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Chromium’u elle başlatın:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. İsteğe bağlı olarak Chrome’u otomatik başlatmak için bir systemd kullanıcı servisi oluşturun:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Şununla etkinleştirin: `systemctl --user enable --now openclaw-browser.service`

### 12. Tarayıcının Çalıştığını Doğrulama

Durumu kontrol edin:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Gezintiyi test edin:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Yapılandırma Referansı

| Seçenek                  | Açıklama                                                                                            | Varsayılan                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `browser.enabled`        | Tarayıcı denetimini etkinleştir                                                                     | `true`                                                                                        |
| `browser.executablePath` | Chromium tabanlı bir tarayıcı ikili dosyasının yolu (Chrome/Brave/Edge/Chromium) | otomatik algılanır (Chromium tabanlıysa varsayılan tarayıcıyı tercih eder) |
| `browser.headless`       | GUI olmadan çalıştır                                                                                | `false`                                                                                       |
| `browser.noSandbox`      | `--no-sandbox` bayrağını ekle (bazı Linux kurulumları için gereklidir)           | `false`                                                                                       |
| `browser.attachOnly`     | Tarayıcıyı başlatma, yalnızca mevcut olana bağlan                                                   | `false`                                                                                       |
| `browser.cdpPort`        | Chrome DevTools Protocol portu                                                                      | `18800`                                                                                       |

### Sorun: "Chrome uzantı aktarımı çalışıyor, ancak hiçbir sekme bağlı değil"

`chrome` profilini (uzantı aktarımı) kullanıyorsunuz. Bu, OpenClaw
tarayıcı uzantısının canlı bir sekmeye eklenmesini bekler.

Düzeltme seçenekleri:

1. **Yönetilen tarayıcıyı kullanın:** `openclaw browser start --browser-profile openclaw`
   (veya `browser.defaultProfile: "openclaw"` ayarlayın).
2. **Uzantı aktarımını kullanın:** uzantıyı kurun, bir sekme açın ve
   bağlamak için OpenClaw uzantı simgesine tıklayın.

Notlar:

- `chrome` profili, mümkün olduğunda **sistem varsayılan Chromium tarayıcınızı** kullanır.
- Yerel `openclaw` profilleri `cdpPort`/`cdpUrl`’i otomatik atar; bunları yalnızca uzak CDP için ayarlayın.
