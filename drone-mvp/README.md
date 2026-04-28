# Drone MVP

Isaac Sim + Isaac Lab tabanlı otonom drone MVP iskeleti.

## Hedef

Bu proje şu temel demo senaryosunu hedefler:

- Drone spawn olur
- Takeoff yapar
- Waypoint'leri takip eder
- Basit engelden kaçınır
- Anomali tespit edince investigate moduna geçer
- Görev bitince home konumuna dönüp iniş yapar

## Modüller

- `apps/sim_runner`: Yerel demo çalıştırıcı
- `apps/evaluation`: Senaryo değerlendirme araçları
- `configs`: Sensör, görev, ortam ve drone ayarları
- `core/control`: Uçuş kontrol soyutlamaları
- `core/navigation`: Waypoint ve avoidance mantığı
- `core/perception`: Anomali/event üretimi
- `core/mission`: Görev FSM
- `core/safety`: Güvenlik kuralları
- `core/telemetry`: Log ve event modeli
- `isaac/sim`: Isaac Sim entegrasyonu
- `isaac/lab`: Isaac Lab entegrasyonu

## Not

Bu workspace içinde şu an Isaac Sim kurulu görünmüyor. Kurulum tamamlanınca `isaac/sim` ve `isaac/lab` katmanları gerçek entegrasyonla doldurulabilir.
