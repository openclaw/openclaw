---
summary: "Hub de rede: superfícies do gateway, pareamento, descoberta e segurança"
read_when:
  - Você precisa da visão geral de arquitetura de rede + segurança
  - Você está depurando acesso local vs tailnet ou pareamento
  - Você quer a lista canônica de documentos de rede
title: "Rede"
---

# Hub de rede

Este hub conecta a documentação principal sobre como o OpenClaw se conecta, faz pareamento e protege
dispositivos em localhost, LAN e tailnet.

## Modelo central

- [Arquitetura do Gateway](/concepts/architecture)
- [Protocolo do Gateway](/gateway/protocol)
- [Runbook do Gateway](/gateway)
- [Superfícies web + modos de bind](/web)

## Pareamento + identidade

- [Visão geral de pareamento (DM + nós)](/channels/pairing)
- [Pareamento de nós pertencentes ao Gateway](/gateway/pairing)
- [CLI de dispositivos (pareamento + rotação de token)](/cli/devices)
- [CLI de pareamento (aprovações de DM)](/cli/pairing)

Confiança local:

- Conexões locais (loopback ou o próprio endereço tailnet do host do Gateway) podem ser
  aprovadas automaticamente para pareamento, mantendo a UX no mesmo host fluida.
- Clientes tailnet/LAN não locais ainda exigem aprovação explícita de pareamento.

## Descoberta + transportes

- [Descoberta e transportes](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Acesso remoto (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nós + transportes

- [Visão geral de nós](/nodes)
- [Protocolo de bridge (nós legados)](/gateway/bridge-protocol)
- [Runbook de nós: iOS](/platforms/ios)
- [Runbook de nós: Android](/platforms/android)

## Segurança

- [Visão geral de segurança](/gateway/security)
- [Referência de configuração do Gateway](/gateway/configuration)
- [Solução de problemas](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
