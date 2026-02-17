---
summary: "Aplicación de nodo iOS: conectar al Gateway, emparejamiento, lienzo y solución de problemas"
read_when:
  - Emparejando o reconectando el nodo iOS
  - Ejecutando la aplicación iOS desde código fuente
  - Depurando descubrimiento de gateway o comandos de lienzo
title: "Aplicación iOS"
---

# Aplicación iOS (Nodo)

Disponibilidad: vista previa interna. La aplicación iOS aún no está distribuida públicamente.

## Qué hace

- Se conecta a un Gateway a través de WebSocket (LAN o tailnet).
- Expone capacidades de nodo: Lienzo, Captura de pantalla, Captura de cámara, Ubicación, Modo conversación, Activación por voz.
- Recibe comandos `node.invoke` y reporta eventos de estado del nodo.

## Requisitos

- Gateway ejecutándose en otro dispositivo (macOS, Linux, o Windows vía WSL2).
- Ruta de red:
  - Misma LAN vía Bonjour, **o**
  - Tailnet vía DNS-SD unicast (dominio de ejemplo: `openclaw.internal.`), **o**
  - Host/puerto manual (respaldo).

## Inicio rápido (emparejar + conectar)

1. Inicia el Gateway:

```bash
openclaw gateway --port 18789
```

2. En la aplicación iOS, abre Configuración y selecciona un gateway descubierto (o habilita Host Manual e ingresa host/puerto).

3. Aprueba la solicitud de emparejamiento en el host del gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Verifica la conexión:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Rutas de descubrimiento

### Bonjour (LAN)

El Gateway anuncia `_openclaw-gw._tcp` en `local.`. La aplicación iOS lista estos automáticamente.

### Tailnet (entre redes)

Si mDNS está bloqueado, usa una zona DNS-SD unicast (elige un dominio; ejemplo: `openclaw.internal.`) y DNS dividido de Tailscale.
Ver [Bonjour](/es-ES/gateway/bonjour) para el ejemplo de CoreDNS.

### Host/puerto manual

En Configuración, habilita **Host Manual** e ingresa el host + puerto del gateway (predeterminado `18789`).

## Lienzo + A2UI

El nodo iOS renderiza un canvas WKWebView. Usa `node.invoke` para manejarlo:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

Notas:

- El host de lienzo del Gateway sirve `/__openclaw__/canvas/` y `/__openclaw__/a2ui/`.
- Se sirve desde el servidor HTTP del Gateway (mismo puerto que `gateway.port`, predeterminado `18789`).
- El nodo iOS navega automáticamente a A2UI al conectarse cuando se anuncia una URL de host de lienzo.
- Regresa al andamio incorporado con `canvas.navigate` y `{"url":""}`.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Activación por voz + modo conversación

- La activación por voz y el modo conversación están disponibles en Configuración.
- iOS puede suspender el audio en segundo plano; trata las características de voz como mejor esfuerzo cuando la aplicación no está activa.

## Errores comunes

- `NODE_BACKGROUND_UNAVAILABLE`: trae la aplicación iOS al primer plano (los comandos de lienzo/cámara/pantalla lo requieren).
- `A2UI_HOST_NOT_CONFIGURED`: el Gateway no anunció una URL de host de lienzo; verifica `canvasHost` en [Configuración del Gateway](/es-ES/gateway/configuration).
- El prompt de emparejamiento nunca aparece: ejecuta `openclaw nodes pending` y aprueba manualmente.
- La reconexión falla después de reinstalar: el token de emparejamiento del Keychain fue borrado; re-empareja el nodo.

## Documentación relacionada

- [Emparejamiento](/es-ES/gateway/pairing)
- [Descubrimiento](/es-ES/gateway/discovery)
- [Bonjour](/es-ES/gateway/bonjour)
