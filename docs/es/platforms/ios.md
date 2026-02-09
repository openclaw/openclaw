---
summary: "Aplicación de nodo iOS: conexión al Gateway, emparejamiento, canvas y solución de problemas"
read_when:
  - Emparejar o reconectar el nodo iOS
  - Ejecutar la app iOS desde el código fuente
  - Depurar el descubrimiento del Gateway o los comandos de canvas
title: "App iOS"
---

# App iOS (Nodo)

Disponibilidad: vista previa interna. La app iOS aún no se distribuye públicamente.

## Qué hace

- Se conecta a un Gateway mediante WebSocket (LAN o tailnet).
- Expone capacidades del nodo: Canvas, captura de pantalla, captura de cámara, ubicación, modo de conversación, activación por voz.
- Recibe comandos `node.invoke` e informa eventos de estado del nodo.

## Requisitos

- Gateway ejecutándose en otro dispositivo (macOS, Linux o Windows vía WSL2).
- Ruta de red:
  - La misma LAN vía Bonjour, **o**
  - Tailnet vía DNS-SD unicast (dominio de ejemplo: `openclaw.internal.`), **o**
  - Host/puerto manual (alternativa).

## Inicio rápido (emparejar + conectar)

1. Inicie el Gateway:

```bash
openclaw gateway --port 18789
```

2. En la app iOS, abra Settings y elija un gateway descubierto (o habilite Manual Host e introduzca host/puerto).

3. Apruebe la solicitud de emparejamiento en el host del Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Verifique la conexión:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Rutas de descubrimiento

### Bonjour (LAN)

El Gateway anuncia `_openclaw-gw._tcp` en `local.`. La app iOS los lista automáticamente.

### Tailnet (entre redes)

Si mDNS está bloqueado, use una zona DNS-SD unicast (elija un dominio; ejemplo: `openclaw.internal.`) y DNS dividido de Tailscale.
Consulte [Bonjour](/gateway/bonjour) para el ejemplo de CoreDNS.

### Host/puerto manual

En Settings, habilite **Manual Host** e introduzca el host del Gateway + puerto (predeterminado `18789`).

## Canvas + A2UI

El nodo iOS renderiza un canvas WKWebView. Use `node.invoke` para controlarlo:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Notas:

- El host de canvas del Gateway sirve `/__openclaw__/canvas/` y `/__openclaw__/a2ui/`.
- El nodo iOS navega automáticamente a A2UI al conectarse cuando se anuncia una URL de host de canvas.
- Vuelva al andamiaje integrado con `canvas.navigate` y `{"url":""}`.

### Evaluación / instantánea del canvas

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Activación por voz + modo de conversación

- La activación por voz y el modo de conversación están disponibles en Settings.
- iOS puede suspender el audio en segundo plano; trate las funciones de voz como de mejor esfuerzo cuando la app no está activa.

## Errores comunes

- `NODE_BACKGROUND_UNAVAILABLE`: lleve la app iOS al primer plano (los comandos de canvas/cámara/pantalla lo requieren).
- `A2UI_HOST_NOT_CONFIGURED`: el Gateway no anunció una URL de host de canvas; verifique `canvasHost` en [Configuración del Gateway](/gateway/configuration).
- El aviso de emparejamiento nunca aparece: ejecute `openclaw nodes pending` y apruebe manualmente.
- La reconexión falla tras reinstalar: el token de emparejamiento del Keychain se borró; vuelva a emparejar el nodo.

## Documentos relacionados

- [Emparejamiento](/gateway/pairing)
- [Descubrimiento](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
