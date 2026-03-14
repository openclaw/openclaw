---
summary: "Ağ merkezi: gateway yüzeyleri, eşleştirme, keşif ve güvenlik"
read_when:
  - Ağ mimarisi + güvenlik genel bakışa ihtiyacınız varsa
  - Yerel vs tailnet erişimi veya eşleştirme hatası ayıklıyorsanız
  - Ağ belgelerinin standart listesini istiyorsanız
title: "Ağ"
---

# Ağ Merkezi

Bu merkez, OpenClaw'un localhost, LAN ve tailnet genelinde
nasıl bağlandığını, eşleştirdiğini ve cihazları güvence altına aldığını
gösteren temel belgelere bağlantı sağlar.

## Temel Model

- [Gateway mimarisi](/concepts/architecture)
- [Gateway protokolü](/gateway/protocol)
- [Gateway çalışma rehberi](/gateway)
- [Web yüzeyleri + bind modları](/web)

## Eşleştirme + Kimlik

- [Eşleştirme genel bakışı (DM + nodes)](/channels/pairing)
- [Gateway'e ait node eşleştirme](/gateway/pairing)
- [Devices CLI (eşleştirme + token döndürme)](/cli/devices)
- [Pairing CLI (DM onayları)](/cli/pairing)

Yerel Güven:

- Yerel bağlantılar (loopback veya gateway host'unun kendi tailnet adresi), 
  aynı host deneyimini sorunsuz tutmak için eşleştirme için otomatik onaylanabilir.
- Yerel olmayan tailnet/LAN istemcileri hala açık eşleştirme onayı gerektirir.

## Keşif + Taşımalar

- [Keşif ve taşımalar](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Uzak erişim (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodes + Taşımalar

- [Nodes genel bakış](/nodes)
- [Bridge protokolü (eski nodes)](/gateway/bridge-protocol)
- [Node çalışma rehberi: iOS](/platforms/ios)
- [Node çalışma rehberi: Android](/platforms/android)

## Güvenlik

- [Güvenlik genel bakışı](/gateway/security)
- [Gateway yapılandırma referansı](/gateway/configuration)
- [Sorun giderme](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
