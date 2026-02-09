---
summary: "„Wie sich Gateway, Nodes und Canvas-Host verbinden.“"
read_when:
  - Sie möchten eine knappe Übersicht über das Netzwerkmodell des Gateway
title: "„Netzwerkmodell“"
---

Die meisten Vorgänge laufen über das Gateway (`openclaw gateway`), einen einzelnen, langfristig laufenden
Prozess, der Kanalverbindungen und die WebSocket-Kontroll­ebene besitzt.

## Grundregeln

- Ein Gateway pro Host wird empfohlen. Es ist der einzige Prozess, der die WhatsApp-Web-Sitzung besitzen darf. Für Rescue-Bots oder strikte Isolation führen Sie mehrere Gateways mit isolierten Profilen und Ports aus. Siehe [Multiple gateways](/gateway/multiple-gateways).
- Loopback zuerst: Das Gateway-WS verwendet standardmäßig `ws://127.0.0.1:18789`. Der Assistent erzeugt standardmäßig ein Gateway-Token, auch für Loopback. Für den Tailnet-Zugriff führen Sie `openclaw gateway --bind tailnet --token ...` aus, da für Nicht-Loopback-Bindings Tokens erforderlich sind.
- Nodes verbinden sich je nach Bedarf über LAN, Tailnet oder SSH mit dem Gateway-WS. Die Legacy-TCP-Bridge ist veraltet.
- Der Canvas-Host ist ein HTTP-Dateiserver auf `canvasHost.port` (Standard `18793`), der `/__openclaw__/canvas/` für Node-WebViews bereitstellt. Siehe [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Remote-Nutzung erfolgt typischerweise über SSH-Tunnel oder Tailnet-VPN. Siehe [Remote access](/gateway/remote) und [Discovery](/gateway/discovery).
