---
summary: "Como o Gateway, os nós e o host do canvas se conectam."
read_when:
  - Você quer uma visão concisa do modelo de rede do Gateway
title: "Modelo de rede"
---

A maioria das operações flui pelo Gateway (`openclaw gateway`), um único
processo de longa duração que possui as conexões de canal e o plano de controle WebSocket.

## Regras principais

- Recomenda-se um Gateway por host. É o único processo autorizado a possuir a sessão do WhatsApp Web. Para bots de resgate ou isolamento rigoroso, execute vários gateways com perfis e portas isolados. Veja [Vários gateways](/gateway/multiple-gateways).
- Loopback primeiro: o WS do Gateway usa por padrão `ws://127.0.0.1:18789`. O assistente gera um token do gateway por padrão, mesmo para loopback. Para acesso via tailnet, execute `openclaw gateway --bind tailnet --token ...`, pois tokens são obrigatórios para binds fora de loopback.
- Os nós se conectam ao WS do Gateway via LAN, tailnet ou SSH conforme necessário. A ponte TCP legada está obsoleta.
- O host do canvas é um servidor de arquivos HTTP em `canvasHost.port` (padrão `18793`) servindo `/__openclaw__/canvas/` para WebViews dos nós. Veja [Configuração do Gateway](/gateway/configuration) (`canvasHost`).
- O uso remoto normalmente é via túnel SSH ou VPN tailnet. Veja [Acesso remoto](/gateway/remote) e [Descoberta](/gateway/discovery).
