# OpenClaw Portable (Taşınabilir) Kurulum Planı ve Bootstrap

Bu belge, OpenClaw sisteminin tamamen bağımsız ve herhangi bir bilgisayarda (Windows/Linux) USB bellekten veya ZIP'ten çıkar çıkmaz anında çalışabilmesi için gerekli "Portable Bundle" mimarisini ve bootstrap adımlarını tanımlar.

## 1. Portable Dizin ve İzolasyon Stratejisi

Tüm sistem sıfır dış bağımlılık varsayımıyla (mümkün olduğunca) tek klasörde toplanmalıdır:

```text
OpenClaw-Portable-v1.0/
├── workspace/                # Kullanıcı verileri, hedeflenen projeler ve kuyruk
│   └── .openclaw/gemini-queue/
├── env/                      # Taşınabilir (relocatable) ortamlar
│   ├── python/               # Embedded Python veya Relocatable venv
│   └── node/                 # Taşınabilir Node.js (Gemini CLI için gerekirse)
├── config/                   # Ortama özel ayarlar
│   ├── settings.json
│   └── secrets.template.env  # İlk kurulumda .env'ye kopyalanacak
├── bin/                      # Çalıştırılabilir dosyalar ve araçlar
│   └── gemini-cli            # Binary olarak derlenmiş veya paketlenmiş CLI
├── bootstrap.bat             # Windows için ilk kurulum/başlatıcı
├── bootstrap.sh              # Linux/Mac için ilk kurulum/başlatıcı
└── start-agent.bat/.sh       # Sistemi başlatma komutu (Watcher+UI)
```

## 2. Gerekli Bileşenler ve Hazırlık

1. **Gemini CLI İzolasyonu:** Gemini CLI, global Node.js kurulumuna bağımlı olmak yerine, proje içine gömülü (`npx` veya bundled executable) olarak paketlenmelidir.
2. **Python Bağımlılıkları:** Python için `venv` doğrudan taşınabilir değildir (absolute path içerir). Çözüm olarak:
   - Hedef makinede `bootstrap` sırasında `venv`'in anında oluşturulması (`python -m venv env && pip install -r requirements.txt`).
   - Veya Windows için _Python Embeddable_ paketinin kullanılması.
3. **Ortam Değişkenleri Yönetimi:** Hiçbir global ortam değişkenine (`PATH`) dokunulmamalıdır. Başlatıcı betikler kendi oturumları içinde PATH'i `OpenClaw-Portable/bin` ve `env` klasörlerine göre ayarlamalıdır.

## 3. Kurulum ve Taşıma Adımları (Deployment)

1. **Paketleme (Bundle):** Mevcut repo temizlenir, `env/` ve `.env` (gizli anahtarlar içeren) dosyaları hariç tutularak `.zip` veya `.tar.gz` haline getirilir.
2. **Taşıma:** Arşiv hedef bilgisayara (örn. tamamen internetsiz veya kısıtlı bir ağdaki Windows makineye) aktarılır ve klasöre çıkartılır.
3. **İlk Kurulum (Bootstrap):** Kullanıcı `bootstrap.bat` veya `bootstrap.sh` çalıştırır.

## 4. Bootstrap ve Çalıştırma Kontrol Listesi (Checklist)

- [ ] **Bootstrap Script'i Geliştirme:**
  - `secrets.template.env` kopyalanıp `.env` yapılıyor mu? (Kullanıcıdan kurulum anında sadece API anahtarı istenecek).
  - Python/Node.js yüklü mü kontrolü yapıp, yoksa portable olanları kullanacak veya otomatik olarak izole `venv` kuracak mekanizmanın eklenmesi.
- [ ] **Yol (PATH) İzolasyonu:** `start-agent` betikleri çalıştığında CLI komutlarının (python, pip, gemini vb.) sadece proje klasöründeki çalıştırılabilir dosyalara işaret ettiğinden emin olunması.
- [ ] **Test:** Temiz bir sanal makinede (VM) sadece klasör kopyalanıp `bootstrap` çalıştırılarak sistemin pürüzsüz ayağa kalktığının doğrulanması.
