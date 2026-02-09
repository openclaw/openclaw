---
summary: "App de nó iOS: conexão com o Gateway, pareamento, canvas e solução de problemas"
read_when:
  - Pareamento ou reconexão do nó iOS
  - Executar o app iOS a partir do código-fonte
  - Depurar descoberta do gateway ou comandos de canvas
title: "App iOS"
---

# App iOS (Nó)

Disponibilidade: prévia interna. O app iOS ainda não é distribuído publicamente.

## O que ele faz

- Conecta-se a um Gateway via WebSocket (LAN ou tailnet).
- Expõe capacidades do nó: Canvas, Captura de tela, Captura de câmera, Localização, Modo de conversa, Ativação por voz.
- Recebe comandos `node.invoke` e reporta eventos de status do nó.

## Requisitos

- Gateway em execução em outro dispositivo (macOS, Linux ou Windows via WSL2).
- Caminho de rede:
  - Mesma LAN via Bonjour, **ou**
  - Tailnet via DNS-SD unicast (domínio de exemplo: `openclaw.internal.`), **ou**
  - Host/porta manual (fallback).

## Início rápido (parear + conectar)

1. Inicie o Gateway:

```bash
openclaw gateway --port 18789
```

2. No app iOS, abra Ajustes e escolha um gateway descoberto (ou ative Host Manual e informe host/porta).

3. Aprove a solicitação de pareamento no host do gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Verifique a conexão:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Caminhos de descoberta

### Bonjour (LAN)

O Gateway anuncia `_openclaw-gw._tcp` em `local.`. O app iOS lista esses automaticamente.

### Tailnet (entre redes)

Se o mDNS estiver bloqueado, use uma zona DNS-SD unicast (escolha um domínio; exemplo: `openclaw.internal.`) e DNS dividido do Tailscale.
Veja [Bonjour](/gateway/bonjour) para o exemplo do CoreDNS.

### Host/porta manual

Em Ajustes, ative **Host Manual** e informe o host + porta do gateway (padrão `18789`).

## Canvas + A2UI

O nó iOS renderiza um canvas WKWebView. Use `node.invoke` para controlá-lo:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Notas:

- O host de canvas do Gateway serve `/__openclaw__/canvas/` e `/__openclaw__/a2ui/`.
- O nó iOS navega automaticamente para o A2UI ao conectar quando um URL de host de canvas é anunciado.
- Retorne ao scaffold integrado com `canvas.navigate` e `{"url":""}`.

### Avaliação do canvas / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Ativação por voz + modo de conversa

- Ativação por voz e modo de conversa estão disponíveis em Ajustes.
- O iOS pode suspender o áudio em segundo plano; trate os recursos de voz como melhor esforço quando o app não estiver ativo.

## Erros comuns

- `NODE_BACKGROUND_UNAVAILABLE`: traga o app iOS para o primeiro plano (comandos de canvas/câmera/tela exigem isso).
- `A2UI_HOST_NOT_CONFIGURED`: o Gateway não anunciou um URL de host de canvas; verifique `canvasHost` em [Configuração do Gateway](/gateway/configuration).
- O prompt de pareamento nunca aparece: execute `openclaw nodes pending` e aprove manualmente.
- A reconexão falha após reinstalar: o token de pareamento do Keychain foi limpo; repareie o nó.

## Documentos relacionados

- [Pareamento](/gateway/pairing)
- [Descoberta](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
