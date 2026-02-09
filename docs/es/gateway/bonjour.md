---
summary: "Descubrimiento Bonjour/mDNS + depuración (balizas del Gateway, clientes y modos de falla comunes)"
read_when:
  - Depuración de problemas de descubrimiento Bonjour en macOS/iOS
  - Cambio de tipos de servicio mDNS, registros TXT o UX de descubrimiento
title: "Descubrimiento Bonjour"
---

# Descubrimiento Bonjour / mDNS

OpenClaw usa Bonjour (mDNS / DNS‑SD) como una **conveniencia solo para LAN** para descubrir
un Gateway activo (endpoint WebSocket). Es de mejor esfuerzo y **no** reemplaza SSH ni la
conectividad basada en Tailnet.

## Bonjour de área amplia (DNS‑SD unicast) sobre Tailscale

Si el nodo y el gateway están en redes diferentes, el mDNS multicast no cruzará el
límite. Puede mantener la misma UX de descubrimiento cambiando a **DNS‑SD unicast**
("Wide‑Area Bonjour") sobre Tailscale.

Pasos de alto nivel:

1. Ejecute un servidor DNS en el host del Gateway (accesible por Tailnet).
2. Publique registros DNS‑SD para `_openclaw-gw._tcp` bajo una zona dedicada
   (ejemplo: `openclaw.internal.`).
3. Configure **DNS dividido** de Tailscale para que su dominio elegido se resuelva a través
   de ese servidor DNS para los clientes (incluido iOS).

OpenClaw admite cualquier dominio de descubrimiento; `openclaw.internal.` es solo un ejemplo.
Los nodos iOS/Android exploran tanto `local.` como su dominio de área amplia configurado.

### Configuración del Gateway (recomendado)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Configuración única del servidor DNS (host del Gateway)

```bash
openclaw dns setup --apply
```

Esto instala CoreDNS y lo configura para:

- escuchar en el puerto 53 solo en las interfaces Tailscale del Gateway
- servir su dominio elegido (ejemplo: `openclaw.internal.`) desde `~/.openclaw/dns/<domain>.db`

Valide desde una máquina conectada a tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Configuración de DNS en Tailscale

En la consola de administración de Tailscale:

- Agregue un servidor de nombres que apunte a la IP de tailnet del Gateway (UDP/TCP 53).
- Agregue DNS dividido para que su dominio de descubrimiento use ese servidor de nombres.

Una vez que los clientes acepten el DNS de tailnet, los nodos iOS pueden explorar
`_openclaw-gw._tcp` en su dominio de descubrimiento sin multicast.

### Seguridad del listener del Gateway (recomendado)

El puerto WS del Gateway (predeterminado `18789`) se vincula a loopback de forma predeterminada. Para acceso por LAN/tailnet,
vincúlelo explícitamente y mantenga la autenticación habilitada.

Para configuraciones solo de tailnet:

- Establezca `gateway.bind: "tailnet"` en `~/.openclaw/openclaw.json`.
- Reinicie el Gateway (o reinicie la app de la barra de menús de macOS).

## Qué anuncia

Solo el Gateway anuncia `_openclaw-gw._tcp`.

## Tipos de servicio

- `_openclaw-gw._tcp` — baliza de transporte del gateway (usada por nodos macOS/iOS/Android).

## Claves TXT (pistas no secretas)

El Gateway anuncia pequeñas pistas no secretas para facilitar los flujos de la UI:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (solo cuando TLS está habilitado)
- `gatewayTlsSha256=<sha256>` (solo cuando TLS está habilitado y la huella está disponible)
- `canvasPort=<port>` (solo cuando el host del lienzo está habilitado; predeterminado `18793`)
- `sshPort=<port>` (predetermina a 22 cuando no se sobrescribe)
- `transport=gateway`
- `cliPath=<path>` (opcional; ruta absoluta a un punto de entrada `openclaw` ejecutable)
- `tailnetDns=<magicdns>` (pista opcional cuando Tailnet está disponible)

## Depuración en macOS

Herramientas integradas útiles:

- Explorar instancias:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Resolver una instancia (reemplace `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Si explorar funciona pero resolver falla, normalmente se trata de una política de LAN o
un problema del resolvedor mDNS.

## Depuración en los registros del Gateway

El Gateway escribe un archivo de registro rotativo (impreso al iniciar como
`gateway log file: ...`). Busque líneas `bonjour:`, especialmente:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Depuración en el nodo iOS

El nodo iOS usa `NWBrowser` para descubrir `_openclaw-gw._tcp`.

Para capturar registros:

- Configuración → Gateway → Avanzado → **Registros de depuración de descubrimiento**
- Configuración → Gateway → Avanzado → **Registros de descubrimiento** → reproducir → **Copiar**

El registro incluye transiciones de estado del explorador y cambios del conjunto de resultados.

## Modos de falla comunes

- **Bonjour no cruza redes**: use Tailnet o SSH.
- **Multicast bloqueado**: algunas redes Wi‑Fi deshabilitan mDNS.
- **Suspensión / cambios de interfaz**: macOS puede soltar temporalmente resultados mDNS; reintente.
- **Explorar funciona pero resolver falla**: mantenga los nombres de máquina simples (evite emojis o
  puntuación), luego reinicie el Gateway. El nombre de la instancia del servicio deriva del
  nombre del host, por lo que nombres excesivamente complejos pueden confundir a algunos resolvers.

## Nombres de instancia escapados (`\032`)

Bonjour/DNS‑SD a menudo escapa bytes en los nombres de instancia del servicio como secuencias
decimales `\DDD` (p. ej., los espacios se convierten en `\032`).

- Esto es normal a nivel de protocolo.
- Las UIs deben decodificar para la visualización (iOS usa `BonjourEscapes.decode`).

## Deshabilitación / configuración

- `OPENCLAW_DISABLE_BONJOUR=1` deshabilita la publicación (legado: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` en `~/.openclaw/openclaw.json` controla el modo de vinculación del Gateway.
- `OPENCLAW_SSH_PORT` sobrescribe el puerto SSH anunciado en TXT (legado: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publica una pista de MagicDNS en TXT (legado: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` sobrescribe la ruta de la CLI anunciada (legado: `OPENCLAW_CLI_PATH`).

## Documentos relacionados

- Política de descubrimiento y selección de transporte: [Discovery](/gateway/discovery)
- Emparejamiento de nodos + aprobaciones: [Gateway pairing](/gateway/pairing)
