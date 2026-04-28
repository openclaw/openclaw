# Setup Notes

## Mevcut Durum

Bu OpenClaw oturumunda şu anda:

- Isaac Sim binary/path görünmüyor
- Isaac Lab kurulumu görünmüyor
- `nvidia-smi` komutu erişilebilir değil

Bu yüzden gerçek Isaac Sim ortamı burada doğrudan ayağa kaldırılamadı.

## Donanım Yorumu

5070 Ti + 32 GB RAM, Isaac Sim ve Isaac Lab tabanlı tek drone MVP için genel olarak uygun görünüyor.
Ancak pratikte kritik olanlar şunlar:

- NVIDIA driver sürümü
- CUDA uyumluluğu
- Vulkan/OpenGL erişimi
- WSL yerine yerel Linux/Windows kurulumu kullanılıp kullanılmadığı
- Isaac Sim sürüm uyumluluğu

## Sonraki Adım

Isaac Sim'in bu makinede nasıl kurulu olduğunu netleştir:

- Yerel Linux kurulum mu?
- Windows üzerinde native kurulum mu?
- WSL içinden mi erişmeye çalışıyoruz?
- Omniverse Launcher dışı standalone kurulum mu var?

Bu netleşince `isaac/sim/bootstrap.py` gerçek başlatma koduyla doldurulabilir.
