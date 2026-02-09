---
summary: "OpenClaw macOS uygulaması üzerinde çalışan geliştiriciler için kurulum kılavuzu"
read_when:
  - macOS geliştirme ortamının kurulumu
title: "macOS Geliştirici Kurulumu"
---

# macOS Geliştirici Kurulumu

Bu kılavuz, OpenClaw macOS uygulamasını kaynak koddan derlemek ve çalıştırmak için gerekli adımları kapsar.

## Ön Koşullar

Uygulamayı derlemeden önce aşağıdakilerin yüklü olduğundan emin olun:

1. **Xcode 26.2+**: Swift geliştirme için gereklidir.
2. **Node.js 22+ & pnpm**: gateway, CLI ve paketleme betikleri için gereklidir.

## 1) Bağımlılıkları Yükleyin

Proje genelindeki bağımlılıkları yükleyin:

```bash
pnpm install
```

## 2. Uygulamayı Derleyin ve Paketleyin

macOS uygulamasını derlemek ve `dist/OpenClaw.app` içine paketlemek için şunu çalıştırın:

```bash
./scripts/package-mac-app.sh
```

Bir Apple Developer ID sertifikanız yoksa, betik otomatik olarak **ad-hoc signing** (`-`) kullanacaktır.

Geliştirme çalıştırma modları, imzalama bayrakları ve Team ID sorun giderme için macOS uygulaması README dosyasına bakın:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Not**: Ad-hoc imzalanmış uygulamalar güvenlik uyarılarını tetikleyebilir. Uygulama "Abort trap 6" ile hemen çöküyorsa, [Troubleshooting](#troubleshooting) bölümüne bakın.

## 3. CLI'yi Yükleyin

macOS uygulaması, arka plan görevlerini yönetmek için global bir `openclaw` CLI kurulumunu bekler.

**Yüklemek için (önerilir):**

1. OpenClaw uygulamasını açın.
2. **General** ayarları sekmesine gidin.
3. **"Install CLI"** düğmesine tıklayın.

Alternatif olarak, manuel olarak yükleyin:

```bash
npm install -g openclaw@<version>
```

## Sorun Giderme

### Derleme Başarısız: Toolchain veya SDK Uyumsuzluğu

macOS uygulaması derlemesi, en son macOS SDK’sını ve Swift 6.2 toolchain’ini bekler.

**Sistem bağımlılıkları (gerekli):**

- **Software Update’te mevcut olan en son macOS sürümü** (Xcode 26.2 SDK’ları tarafından gereklidir)
- **Xcode 26.2** (Swift 6.2 toolchain)

**Kontroller:**

```bash
xcodebuild -version
xcrun swift --version
```

Sürümler eşleşmiyorsa, macOS/Xcode’u güncelleyin ve derlemeyi yeniden çalıştırın.

### İzin Verildiğinde Uygulama Çöküyor

Uygulama **Speech Recognition** veya **Microphone** erişimine izin vermeye çalıştığınızda çöküyorsa, bunun nedeni bozulmuş bir TCC önbelleği veya imza uyumsuzluğu olabilir.

**Çözüm:**

1. TCC izinlerini sıfırlayın:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Bu işe yaramazsa, macOS’te “temiz bir başlangıç” zorlamak için [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) dosyasında `BUNDLE_ID` değerini geçici olarak değiştirin.

### Gateway sonsuza kadar "Starting..." durumunda

gateway durumu "Starting..." üzerinde kalıyorsa, portu tutan bir zombie sürecin olup olmadığını kontrol edin:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Manuel bir çalıştırma portu tutuyorsa, bu süreci durdurun (Ctrl+C). Son çare olarak, yukarıda bulduğunuz PID’yi sonlandırın.
