---
summary: "Ağ merkezi: gateway yüzeyleri, eşleştirme, keşif ve güvenlik"
read_when:
  - Ağ mimarisi ve güvenliğe genel bakışa ihtiyacınız var
  - Yerel ile tailnet erişimi veya eşleştirmeyi hata ayıklıyorsunuz
  - Ağ dokümanlarının kanonik listesini istiyorsunuz
title: "Ağ"
---

# Ağ merkezi

Bu merkez, OpenClaw’ın localhost, LAN ve tailnet genelinde cihazları nasıl
bağladığı, eşleştirdiği ve güvenliğini sağladığına ilişkin temel dokümanlara bağlantı verir.

## Temel model

- [Gateway mimarisi](/concepts/architecture)
- [Gateway protokolü](/gateway/protocol)
- [Gateway runbook](/gateway)
- [Web yüzeyleri + bağlama modları](/web)

## Eşleştirme + kimlik

- [Eşleştirmeye genel bakış (DM + düğümler)](/channels/pairing)
- [Gateway sahipli düğüm eşleştirme](/gateway/pairing)
- [Cihazlar CLI (eşleştirme + belirteç rotasyonu)](/cli/devices)
- [Eşleştirme CLI (DM onayları)](/cli/pairing)

Yerel güven:

- Yerel bağlantılar (loopback veya gateway ana makinesinin kendi tailnet adresi),
  aynı ana makinede UX’i akıcı tutmak için eşleştirme açısından otomatik olarak onaylanabilir.
- Yerel olmayan tailnet/LAN istemcileri yine de açık eşleştirme onayı gerektirir.

## Keşif + taşıma katmanları

- [Keşif ve taşıma katmanları](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Uzaktan erişim (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Düğümler + taşıma katmanları

- [Düğümlere genel bakış](/nodes)
- [Köprü protokolü (eski düğümler)](/gateway/bridge-protocol)
- [Düğüm runbook: iOS](/platforms/ios)
- [Düğüm runbook: Android](/platforms/android)

## Güvenlik

- [Güvenliğe genel bakış](/gateway/security)
- [Gateway yapılandırma başvuru dokümanı](/gateway/configuration)
- [Sorun Giderme](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
