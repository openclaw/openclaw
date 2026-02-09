---
summary: "Refactorización de Clawnet: unificar protocolo de red, roles, autenticación, aprobaciones e identidad"
read_when:
  - Planificar un protocolo de red unificado para nodos + clientes de operador
  - Replantear aprobaciones, emparejamiento, TLS y presencia entre dispositivos
title: "Refactorización de Clawnet"
---

# Refactorización de Clawnet (unificación de protocolo + autenticación)

## Hola

Hola Peter — excelente dirección; esto desbloquea una UX más simple y una seguridad más sólida.

## Propósito

Documento único y riguroso para:

- Estado actual: protocolos, flujos, límites de confianza.
- Puntos de dolor: aprobaciones, enrutamiento multi‑salto, duplicación de UI.
- Nuevo estado propuesto: un protocolo, roles con alcance, autenticación/emparejamiento unificados, pinning de TLS.
- Modelo de identidad: IDs estables + slugs simpáticos.
- Plan de migración, riesgos y preguntas abiertas.

## Objetivos (de la discusión)

- Un protocolo para todos los clientes (app mac, CLI, iOS, Android, nodo headless).
- Cada participante de la red autenticado + emparejado.
- Claridad de roles: nodos vs operadores.
- Aprobaciones centrales enrutadas hacia donde está el usuario.
- Cifrado TLS + pinning opcional para todo el tráfico remoto.
- Mínima duplicación de código.
- Una sola máquina debe aparecer una vez (sin entrada duplicada de UI/nodo).

## No‑objetivos (explícitos)

- Eliminar la separación de capacidades (aún se necesita mínimo privilegio).
- Exponer el plano de control completo del gateway sin verificaciones de alcance.
- Hacer que la autenticación dependa de etiquetas humanas (los slugs siguen sin ser de seguridad).

---

# Estado actual (as‑is)

## Dos protocolos

### 1. Gateway WebSocket (plano de control)

- Superficie completa de API: configuración, canales, modelos, sesiones, ejecuciones de agentes, logs, nodos, etc.
- Enlace predeterminado: loopback. Acceso remoto vía SSH/Tailscale.
- Autenticación: token/contraseña vía `connect`.
- Sin pinning de TLS (depende de loopback/túnel).
- Código:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (transporte de nodos)

- Superficie reducida con lista de permitidos, identidad del nodo + emparejamiento.
- JSONL sobre TCP; TLS opcional + pinning de huella de certificado.
- TLS anuncia la huella en TXT de descubrimiento.
- Código:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Clientes del plano de control hoy

- CLI → Gateway WS vía `callGateway` (`src/gateway/call.ts`).
- UI de app macOS → Gateway WS (`GatewayConnection`).
- UI de Control Web → Gateway WS.
- ACP → Gateway WS.
- El control desde navegador usa su propio servidor HTTP de control.

## Nodos hoy

- App macOS en modo nodo se conecta al Bridge del Gateway (`MacNodeBridgeSession`).
- Apps iOS/Android se conectan al Bridge del Gateway.
- Emparejamiento + token por nodo almacenado en el gateway.

## Flujo de aprobación actual (exec)

- El agente usa `system.run` vía Gateway.
- El Gateway invoca al nodo a través del bridge.
- El runtime del nodo decide la aprobación.
- El aviso de UI lo muestra la app mac (cuando el nodo == app mac).
- El nodo devuelve `invoke-res` al Gateway.
- Multi‑salto, UI ligada al host del nodo.

## Presencia + identidad hoy

- Entradas de presencia del Gateway desde clientes WS.
- Entradas de presencia de nodos desde el bridge.
- La app mac puede mostrar dos entradas para la misma máquina (UI + nodo).
- Identidad del nodo almacenada en el almacén de emparejamiento; identidad de UI separada.

---

# Problemas / puntos de dolor

- Dos pilas de protocolo para mantener (WS + Bridge).
- Aprobaciones en nodos remotos: el aviso aparece en el host del nodo, no donde está el usuario.
- El pinning de TLS solo existe para el bridge; WS depende de SSH/Tailscale.
- Duplicación de identidad: la misma máquina aparece como múltiples instancias.
- Roles ambiguos: capacidades de UI + nodo + CLI no claramente separadas.

---

# Nuevo estado propuesto (Clawnet)

## Un protocolo, dos roles

Un único protocolo WS con rol + alcance.

- **Rol: node** (host de capacidades)
- **Rol: operator** (plano de control)
- **Alcance** opcional para operador:
  - `operator.read` (estado + visualización)
  - `operator.write` (ejecución de agentes, envíos)
  - `operator.admin` (configuración, canales, modelos)

### Comportamientos por rol

**Node**

- Puede registrar capacidades (`caps`, `commands`, permisos).
- Puede recibir comandos `invoke` (`system.run`, `camera.*`, `canvas.*`, `screen.record`, etc).
- Puede enviar eventos: `voice.transcript`, `agent.request`, `chat.subscribe`.
- No puede llamar a APIs del plano de control de configuración/modelos/canales/sesiones/agentes.

**Operator**

- API completa del plano de control, protegida por alcance.
- Recibe todas las aprobaciones.
- No ejecuta acciones del SO directamente; enruta a nodos.

### Regla clave

El rol es por conexión, no por dispositivo. Un dispositivo puede abrir ambos roles, por separado.

---

# Autenticación + emparejamiento unificados

## Identidad del cliente

Cada cliente proporciona:

- `deviceId` (estable, derivado de la clave del dispositivo).
- `displayName` (nombre humano).
- `role` + `scope` + `caps` + `commands`.

## Flujo de emparejamiento (unificado)

- El cliente se conecta sin autenticar.
- El Gateway crea una **solicitud de emparejamiento** para ese `deviceId`.
- El operador recibe el aviso; aprueba/deniega.
- El Gateway emite credenciales vinculadas a:
  - clave pública del dispositivo
  - rol(es)
  - alcance(s)
  - capacidades/comandos
- El cliente persiste el token y se reconecta autenticado.

## Autenticación ligada al dispositivo (evitar replay de bearer tokens)

Preferido: pares de claves del dispositivo.

- El dispositivo genera un par de claves una sola vez.
- `deviceId = fingerprint(publicKey)`.
- El Gateway envía un nonce; el dispositivo firma; el Gateway verifica.
- Los tokens se emiten a una clave pública (prueba de posesión), no a una cadena.

Alternativas:

- mTLS (certificados de cliente): más fuerte, más complejidad operativa.
- Bearer tokens de corta duración solo como fase temporal (rotar + revocar pronto).

## Aprobación silenciosa (heurística SSH)

Defínala con precisión para evitar un eslabón débil. Prefiera una:

- **Solo local**: emparejar automáticamente cuando el cliente se conecta vía loopback/socket Unix.
- **Desafío vía SSH**: el Gateway emite un nonce; el cliente prueba SSH al obtenerlo.
- **Ventana de presencia física**: tras una aprobación local en la UI del host del Gateway, permitir auto‑emparejamiento por una ventana corta (p. ej., 10 minutos).

Siempre registrar y guardar las auto‑aprobaciones.

---

# TLS en todas partes (dev + prod)

## Reutilizar TLS existente del bridge

Usar el runtime TLS actual + pinning de huella:

- `src/infra/bridge/server/tls.ts`
- lógica de verificación de huella en `src/node-host/bridge-client.ts`

## Aplicar a WS

- El servidor WS admite TLS con el mismo cert/clave + huella.
- Los clientes WS pueden fijar la huella (opcional).
- El descubrimiento anuncia TLS + huella para todos los endpoints.
  - El descubrimiento es solo pistas de localización; nunca un ancla de confianza.

## Por qué

- Reducir la dependencia de SSH/Tailscale para confidencialidad.
- Hacer seguras por defecto las conexiones móviles remotas.

---

# Rediseño de aprobaciones (centralizado)

## Actual

La aprobación ocurre en el host del nodo (runtime del nodo de la app mac). El aviso aparece donde corre el nodo.

## Propuesto

La aprobación es **alojada en el Gateway**, con UI entregada a clientes operador.

### Nuevo flujo

1. El Gateway recibe la intención `system.run` (agente).
2. El Gateway crea el registro de aprobación: `approval.requested`.
3. La(s) UI de operador muestran el aviso.
4. La decisión de aprobación se envía al Gateway: `approval.resolve`.
5. El Gateway invoca el comando del nodo si se aprueba.
6. El nodo ejecuta y devuelve `invoke-res`.

### Semántica de aprobación (endurecimiento)

- Difundir a todos los operadores; solo la UI activa muestra un modal (las otras reciben un toast).
- La primera resolución gana; el Gateway rechaza resoluciones posteriores como ya resueltas.
- Tiempo de espera predeterminado: denegar tras N segundos (p. ej., 60 s), registrar motivo.
- La resolución requiere alcance `operator.approvals`.

## Beneficios

- El aviso aparece donde está el usuario (mac/teléfono).
- Aprobaciones consistentes para nodos remotos.
- El runtime del nodo permanece headless; sin dependencia de UI.

---

# Ejemplos de claridad de roles

## App iPhone

- **Rol node** para: micrófono, cámara, chat de voz, ubicación, push‑to‑talk.
- **operator.read** opcional para estado y vista de chat.
- **operator.write/admin** opcional solo cuando se habilita explícitamente.

## App macOS

- Rol operator por defecto (UI de control).
- Rol node cuando se habilita “Mac node” (system.run, pantalla, cámara).
- Mismo deviceId para ambas conexiones → entrada de UI combinada.

## CLI

- Rol operator siempre.
- Alcance derivado por subcomando:
  - `status`, `logs` → lectura
  - `agent`, `message` → escritura
  - `config`, `channels` → admin
  - aprobaciones + emparejamiento → `operator.approvals` / `operator.pairing`

---

# Identidad + slugs

## ID estable

Requerido para autenticación; nunca cambia.
Preferido:

- Huella del par de claves (hash de la clave pública).

## Slug simpático (tema langosta)

Etiqueta solo humana.

- Ejemplo: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Almacenado en el registro del Gateway, editable.
- Manejo de colisiones: `-2`, `-3`.

## Agrupación en UI

Mismo `deviceId` entre roles → una sola fila de “Instancia”:

- Insignia: `operator`, `node`.
- Muestra capacidades + última vez visto.

---

# Estrategia de migración

## Fase 0: Documentar + alinear

- Publicar este documento.
- Inventariar todas las llamadas de protocolo + flujos de aprobación.

## Fase 1: Agregar roles/alcances a WS

- Extender parámetros de `connect` con `role`, `scope`, `deviceId`.
- Agregar control por lista de permitidos para el rol node.

## Fase 2: Compatibilidad con Bridge

- Mantener el bridge en ejecución.
- Agregar soporte de nodo por WS en paralelo.
- Proteger funciones detrás de un flag de configuración.

## Fase 3: Aprobaciones centrales

- Agregar eventos de solicitud y resolución de aprobación en WS.
- Actualizar la UI de la app mac para mostrar avisos y responder.
- El runtime del nodo deja de mostrar UI.

## Fase 4: Unificación de TLS

- Agregar configuración TLS para WS usando el runtime TLS del bridge.
- Agregar pinning a los clientes.

## Fase 5: Deprecar bridge

- Migrar nodos iOS/Android/mac a WS.
- Mantener bridge como respaldo; eliminar cuando esté estable.

## Fase 6: Autenticación ligada al dispositivo

- Requerir identidad basada en claves para todas las conexiones no locales.
- Agregar UI de revocación + rotación.

---

# Notas de seguridad

- Rol/lista de permitidos aplicados en el límite del Gateway.
- Ningún cliente obtiene la API “completa” sin alcance de operador.
- Emparejamiento requerido para _todas_ las conexiones.
- TLS + pinning reduce el riesgo MITM para móviles.
- La aprobación silenciosa por SSH es una conveniencia; aun así se registra y es revocable.
- El descubrimiento nunca es un ancla de confianza.
- Las declaraciones de capacidades se verifican contra listas de permitidos del servidor por plataforma/tipo.

# Streaming + cargas grandes (medios de nodo)

El plano de control WS es adecuado para mensajes pequeños, pero los nodos también hacen:

- clips de cámara
- grabaciones de pantalla
- streams de audio

Opciones:

1. Tramas binarias WS + fragmentación + reglas de backpressure.
2. Endpoint de streaming separado (aún con TLS + autenticación).
3. Mantener el bridge por más tiempo para comandos pesados de medios y migrar al final.

Elija uno antes de implementar para evitar deriva.

# Política de capacidades + comandos

- Los mayúsculas/comandos reportados por nodos son tratados como **reclamos**.
- El Gateway aplica listas de permitidos por plataforma.
- Cualquier comando nuevo requiere aprobación del operador o un cambio explícito en la lista de permitidos.
- Auditar cambios con marcas de tiempo.

# Auditoría + limitación de tasa

- Registrar: solicitudes de emparejamiento, aprobaciones/denegaciones, emisión/rotación/revocación de tokens.
- Limitar la tasa de spam de emparejamiento y avisos de aprobación.

# Higiene del protocolo

- Versión de protocolo explícita + códigos de error.
- Reglas de reconexión + política de heartbeat.
- TTL de presencia y semántica de última vez visto.

---

# Preguntas abiertas

1. Un solo dispositivo ejecutando ambos roles: modelo de tokens
   - Recomendar tokens separados por rol (node vs operator).
   - Mismo deviceId; alcances distintos; revocación más clara.

2. Granularidad de alcance del operador
   - lectura/escritura/admin + aprobaciones + emparejamiento (mínimo viable).
   - Considerar alcances por función más adelante.

3. UX de rotación + revocación de tokens
   - Rotar automáticamente al cambiar de rol.
   - UI para revocar por deviceId + rol.

4. Descubrimiento
   - Extender el TXT Bonjour actual para incluir huella TLS de WS + pistas de rol.
   - Tratar solo como pistas de localización.

5. Aprobación entre redes
   - Difundir a todos los clientes operador; la UI activa muestra el modal.
   - La primera respuesta gana; el Gateway garantiza atomicidad.

---

# Resumen (TL;DR)

- Hoy: plano de control WS + transporte de nodos Bridge.
- Dolor: aprobaciones + duplicación + dos pilas.
- Propuesta: un protocolo WS con roles + alcances explícitos, emparejamiento unificado + pinning de TLS, aprobaciones alojadas en el Gateway, IDs de dispositivo estables + slugs simpáticos.
- Resultado: UX más simple, seguridad más fuerte, menos duplicación, mejor enrutamiento móvil.
