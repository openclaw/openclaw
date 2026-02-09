---
summary: "Visão geral de suporte de plataformas (Gateway + aplicativos complementares)"
read_when:
  - Procurando suporte de SO ou caminhos de instalação
  - Decidindo onde executar o Gateway
title: "Plataformas"
---

# Plataformas

O núcleo do OpenClaw é escrito em TypeScript. **Node é o runtime recomendado**.
Bun não é recomendado para o Gateway (bugs no WhatsApp/Telegram).

Existem aplicativos complementares para macOS (app de barra de menus) e nós móveis (iOS/Android). Aplicativos complementares para Windows e
Linux estão planejados, mas o Gateway é totalmente suportado hoje.
Aplicativos complementares nativos para Windows também estão planejados; o Gateway é recomendado via WSL2.

## Escolha seu SO

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS e hospedagem

- Hub VPS: [Hospedagem VPS](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + proxy HTTPS): [exe.dev](/install/exe-dev)

## Links comuns

- Guia de instalação: [Primeiros passos](/start/getting-started)
- Runbook do Gateway: [Gateway](/gateway)
- Configuração do Gateway: [Configuração](/gateway/configuration)
- Status do serviço: `openclaw gateway status`

## Instalação do serviço do Gateway (CLI)

Use uma destas opções (todas suportadas):

- Assistente (recomendado): `openclaw onboard --install-daemon`
- Direto: `openclaw gateway install`
- Configurar fluxo: `openclaw configure` → selecione **Gateway service**
- Reparar/migrar: `openclaw doctor` (oferece instalar ou corrigir o serviço)

O destino do serviço depende do SO:

- macOS: LaunchAgent (`bot.molt.gateway` ou `bot.molt.<profile>`; legado `com.openclaw.*`)
- Linux/WSL2: serviço de usuário systemd (`openclaw-gateway[-<profile>].service`)
