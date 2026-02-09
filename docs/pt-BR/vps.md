---
summary: "Hub de hospedagem VPS para OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Você quer executar o Gateway na nuvem
  - Você precisa de um mapa rápido de guias de VPS/hospedagem
title: "Hospedagem VPS"
---

# Hospedagem VPS

Este hub reúne links para os guias de VPS/hospedagem suportados e explica, em alto nível, como funcionam as implantações na nuvem.

## Escolha um provedor

- **Railway** (um clique + configuração no navegador): [Railway](/install/railway)
- **Northflank** (um clique + configuração no navegador): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — US$ 0/mês (Always Free, ARM; capacidade/cadastro podem ser instáveis)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + proxy HTTPS): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/camada gratuita)**: também funciona bem. Guia em vídeo:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Como funcionam as configurações na nuvem

- O **Gateway roda no VPS** e mantém o estado + workspace.
- Você se conecta do seu laptop/celular pela **Control UI** ou via **Tailscale/SSH**.
- Trate o VPS como a fonte da verdade e **faça backup** do estado + workspace.
- Padrão seguro: mantenha o Gateway em loopback e acesse via túnel SSH ou Tailscale Serve.
  Se você fizer bind em `lan`/`tailnet`, exija `gateway.auth.token` ou `gateway.auth.password`.

Acesso remoto: [Gateway remote](/gateway/remote)  
Hub de plataformas: [Platforms](/platforms)

## Usando nodes com um VPS

Você pode manter o Gateway na nuvem e parear **nodes** nos seus dispositivos locais
(Mac/iOS/Android/headless). Os nodes fornecem tela/câmera/canvas locais e recursos `system.run`,
enquanto o Gateway permanece na nuvem.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
