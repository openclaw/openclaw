---
summary: "Descubrimiento Bonjour/mDNS + debugging (beacons del Gateway, clientes y modos comunes de fallo)"
read_when:
  - Debugging de problemas de descubrimiento Bonjour en macOS/iOS
  - Cambio de tipos de servicio mDNS, registros TXT o UX de descubrimiento
title: "Descubrimiento Bonjour"
---

# Descubrimiento Bonjour / mDNS

OpenClaw usa Bonjour (mDNS / DNS-SD) como una **conveniencia solo LAN** para descubrir
un Gateway activo (endpoint WebSocket). Es best-effort y **no** reemplaza la conectividad basada en SSH o
Tailnet.

## Bonjour de área amplia (Unicast DNS-SD) sobre Tailscale

Si el nodo y el gateway están en diferentes redes, el mDNS multicast no cruzará el
límite. Puedes mantener el mismo UX de descubrimiento cambiando a **unicast DNS-SD**
("Bonjour de Área Amplia") sobre Tailscale.

Pasos de alto nivel:

1. Ejecuta un servidor DNS en el host del gateway (alcanzable sobre Tailnet).
2. Publica registros DNS-SD para `_openclaw-gw._tcp` bajo una zona dedicada
   (ejemplo: `openclaw.internal.`).
3. Configura **split DNS** de Tailscale para que tu dominio elegido se resuelva vía ese
   servidor DNS para clientes (incluyendo iOS).

OpenClaw soporta cualquier dominio de descubrimiento; `openclaw.internal.` es solo un ejemplo.
Los nodos iOS/Android navegan tanto `local.` como tu dominio de área amplia configurado.

### Config del Gateway (recomendado)

```json5
{
  gateway: { bind: "tailnet" }, // solo tailnet (recomendado)
  discovery: { wideArea: { enabled: true } }, // habilita publicación DNS-SD de área amplia
}
```

### Configuración única del servidor DNS (host del gateway)

```bash
openclaw dns setup --apply
```

Esto instala CoreDNS y lo configura para:

- escuchar en el puerto 53 solo en las interfaces Tailscale del gateway
- servir tu dominio elegido (ejemplo: `openclaw.internal.`) desde `~/.openclaw/dns/<domain>.db`

Valida desde una máquina conectada a tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Configuración DNS de Tailscale

En la consola de administración de Tailscale:

- Agrega un nameserver apuntando a la IP tailnet del gateway (UDP/TCP 53).
- Agrega split DNS para que tu dominio de descubrimiento use ese nameserver.

Una vez que los clientes acepten DNS de tailnet, los nodos iOS pueden navegar
`_openclaw-gw._tcp` en tu dominio de descubrimiento sin multicast.

### Seguridad del listener del Gateway (recomendado)

El puerto WS del Gateway (predeterminado `18789`) se vincula a loopback por defecto. Para acceso LAN/tailnet,
vincula explícitamente y mantén la auth habilitada.

Para configuraciones solo tailnet:

- Establece `gateway.bind: "tailnet"` en `~/.openclaw/openclaw.json`.
- Reinicia el Gateway (o reinicia la app de barra de menú de macOS).

## Qué anuncia

Solo el Gateway anuncia `_openclaw-gw._tcp`.

## Tipos de servicio

- `_openclaw-gw._tcp` — beacon de transporte del gateway (usado por nodos macOS/iOS/Android).

## Claves TXT (pistas no secretas)

El Gateway anuncia pequeñas pistas no secretas para hacer convenientes los flujos de UI:

- `role=gateway`
- `displayName=<nombre amigable>`
- `lanHost=<hostname>.local`
- `gatewayPort=<puerto>` (Gateway WS + HTTP)
- `gatewayTls=1` (solo cuando TLS está habilitado)
- `gatewayTlsSha256=<sha256>` (solo cuando TLS está habilitado y la huella está disponible)
- `canvasPort=<puerto>` (solo cuando el canvas host está habilitado; actualmente igual que `gatewayPort`)
- `sshPort=<puerto>` (predeterminado 22 cuando no se sobreescribe)
- `transport=gateway`
- `cliPath=<ruta>` (opcional; ruta absoluta a un punto de entrada `openclaw` ejecutable)
- `tailnetDns=<magicdns>` (pista opcional cuando Tailnet está disponible)

Notas de seguridad:

- Los registros TXT Bonjour/mDNS **no están autenticados**. Los clientes no deben tratar TXT como enrutamiento autoritativo.
- Los clientes deben enrutar usando el endpoint de servicio resuelto (SRV + A/AAAA). Trata `lanHost`, `tailnetDns`, `gatewayPort` y `gatewayTlsSha256` solo como pistas.
- El pinning TLS nunca debe permitir que un `gatewayTlsSha256` anunciado sobrescriba un pin previamente almacenado.
- Los nodos iOS/Android deben tratar las conexiones directas basadas en descubrimiento como **solo TLS** y requerir confirmación explícita del usuario antes de confiar en una huella por primera vez.

## Debugging en macOS

Herramientas built-in útiles:

- Navega instancias:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Resuelve una instancia (reemplaza `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Si la navegación funciona pero la resolución falla, generalmente estás encontrando una política LAN o
problema del resolver mDNS.

## Debugging en logs del Gateway

El Gateway escribe un archivo de log rotativo (impreso en inicio como
`gateway log file: ...`). Busca líneas `bonjour:`, especialmente:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Debugging en nodo iOS

El nodo iOS usa `NWBrowser` para descubrir `_openclaw-gw._tcp`.

Para capturar logs:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → reproduce → **Copy**

El log incluye transiciones de estado del navegador y cambios de conjunto de resultados.

## Modos comunes de fallo

- **Bonjour no cruza redes**: usa Tailnet o SSH.
- **Multicast bloqueado**: algunas redes Wi-Fi deshabilitan mDNS.
- **Sleep / churn de interfaz**: macOS puede soltar temporalmente resultados mDNS; reintenta.
- **Browse funciona pero resolve falla**: mantén los nombres de máquina simples (evita emojis o
  puntuación), luego reinicia el Gateway. El nombre de instancia del servicio deriva del
  nombre de host, por lo que nombres demasiado complejos pueden confundir algunos resolvers.

## Nombres de instancia escapados (`\032`)

Bonjour/DNS-SD a menudo escapa bytes en nombres de instancia de servicio como secuencias decimales `\DDD`
(por ejemplo, los espacios se convierten en `\032`).

- Esto es normal a nivel de protocolo.
- Las UIs deben decodificar para mostrar (iOS usa `BonjourEscapes.decode`).

## Deshabilitación / configuración

- `OPENCLAW_DISABLE_BONJOUR=1` deshabilita el anuncio (legacy: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` en `~/.openclaw/openclaw.json` controla el modo de vinculación del Gateway.
- `OPENCLAW_SSH_PORT` sobreescribe el puerto SSH anunciado en TXT (legacy: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publica una pista MagicDNS en TXT (legacy: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` sobreescribe la ruta CLI anunciada (legacy: `OPENCLAW_CLI_PATH`).

## Docs relacionados

- Política de descubrimiento y selección de transporte: [Discovery](/es-ES/gateway/discovery)
- Pairing de nodo + aprobaciones: [Gateway pairing](/es-ES/gateway/pairing)
