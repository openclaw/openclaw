---
summary: "Refactorización de Clawnet: unificar protocolo de red, roles, autenticación, aprobaciones, identidad"
read_when:
  - Planeando un protocolo de red unificado para nodos + clientes operadores
  - Reelaborando aprobaciones, emparejamiento, TLS y presencia entre dispositivos
title: "Refactorización de Clawnet"
---

# Refactorización de Clawnet (unificación de protocolo + autenticación)

## Hola

Hola Peter — excelente dirección; esto desbloquea una UX más simple + seguridad más fuerte.

## Propósito

Documento único y riguroso para:

- Estado actual: protocolos, flujos, límites de confianza.
- Puntos débiles: aprobaciones, enrutamiento multi-salto, duplicación de UI.
- Nuevo estado propuesto: un protocolo, roles con alcance, autenticación/emparejamiento unificados, anclaje TLS.
- Modelo de identidad: IDs estables + slugs amigables.
- Plan de migración, riesgos, preguntas abiertas.

## Objetivos (de la discusión)

- Un protocolo para todos los clientes (app mac, CLI, iOS, Android, nodo sin interfaz).
- Cada participante de la red autenticado + emparejado.
- Claridad de roles: nodos vs operadores.
- Aprobaciones centrales enrutadas a donde está el usuario.
- Cifrado TLS + anclaje opcional para todo el tráfico remoto.
- Duplicación mínima de código.
- Una sola máquina debe aparecer una vez (sin entrada duplicada UI/nodo).

## No-objetivos (explícitos)

- Eliminar separación de capacidades (aún se necesita privilegio mínimo).
- Exponer plano de control completo del gateway sin verificaciones de alcance.
- Hacer que la autenticación dependa de etiquetas humanas (los slugs siguen sin ser de seguridad).

---

# Estado actual (tal como está)

## Dos protocolos

### 1) Gateway WebSocket (plano de control)

- Superficie API completa: config, canales, modelos, sesiones, ejecuciones de agentes, registros, nodos, etc.
- Bind predeterminado: loopback. Acceso remoto vía SSH/Tailscale.
- Autenticación: token/contraseña vía `connect`.
- Sin anclaje TLS (depende de loopback/túnel).
- Código:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge (transporte de nodos)

- Superficie de lista permitida estrecha, identidad de nodo + emparejamiento.
- JSONL sobre TCP; TLS opcional + anclaje de huella digital de certificado.
- TLS anuncia huella digital en TXT de descubrimiento.
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
- Control del navegador usa su propio servidor de control HTTP.

## Nodos hoy

- App macOS en modo nodo se conecta al bridge del Gateway (`MacNodeBridgeSession`).
- Apps iOS/Android se conectan al bridge del Gateway.
- Emparejamiento + token por nodo almacenado en el gateway.

## Flujo de aprobación actual (exec)

- Agente usa `system.run` vía Gateway.
- Gateway invoca nodo sobre bridge.
- Runtime del nodo decide aprobación.
- Prompt de UI mostrado por app mac (cuando nodo == app mac).
- Nodo retorna `invoke-res` al Gateway.
- Multi-salto, UI vinculada al host del nodo.

## Presencia + identidad hoy

- Entradas de presencia del Gateway desde clientes WS.
- Entradas de presencia de nodos desde bridge.
- App mac puede mostrar dos entradas para la misma máquina (UI + nodo).
- Identidad del nodo almacenada en almacén de emparejamiento; identidad de UI separada.

---

# Problemas / puntos débiles

- Dos pilas de protocolos a mantener (WS + Bridge).
- Aprobaciones en nodos remotos: el prompt aparece en el host del nodo, no donde está el usuario.
- Anclaje TLS solo existe para bridge; WS depende de SSH/Tailscale.
- Duplicación de identidad: la misma máquina se muestra como múltiples instancias.
- Roles ambiguos: capacidades UI + nodo + CLI no están claramente separadas.

---

# Nuevo estado propuesto (Clawnet)

## Un protocolo, dos roles

Protocolo WS único con rol + alcance.

- **Rol: node** (host de capacidades)
- **Rol: operator** (plano de control)
- **Alcance** opcional para operador:
  - `operator.read` (estado + visualización)
  - `operator.write` (ejecución de agente, envíos)
  - `operator.admin` (config, canales, modelos)

### Comportamientos de roles

**Node**

- Puede registrar capacidades (`caps`, `commands`, permisos).
- Puede recibir comandos `invoke` (`system.run`, `camera.*`, `canvas.*`, `screen.record`, etc).
- Puede enviar eventos: `voice.transcript`, `agent.request`, `chat.subscribe`.
- No puede llamar APIs del plano de control config/models/channels/sessions/agent.

**Operator**

- API del plano de control completa, con puertas según alcance.
- Recibe todas las aprobaciones.
- No ejecuta directamente acciones del SO; enruta a nodos.

### Regla clave

El rol es por conexión, no por dispositivo. Un dispositivo puede abrir ambos roles, por separado.

---

# Autenticación unificada + emparejamiento

## Identidad del cliente

Cada cliente proporciona:

- `deviceId` (estable, derivado de clave del dispositivo).
- `displayName` (nombre humano).
- `role` + `scope` + `caps` + `commands`.

## Flujo de emparejamiento (unificado)

- Cliente se conecta sin autenticar.
- Gateway crea una **solicitud de emparejamiento** para ese `deviceId`.
- Operador recibe prompt; aprueba/niega.
- Gateway emite credenciales vinculadas a:
  - clave pública del dispositivo
  - rol(es)
  - alcance(s)
  - capacidades/comandos
- Cliente persiste token, se reconecta autenticado.

## Autenticación vinculada a dispositivo (evitar repetición de token portador)

Preferido: pares de claves de dispositivo.

- Dispositivo genera par de claves una vez.
- `deviceId = fingerprint(publicKey)`.
- Gateway envía nonce; dispositivo firma; gateway verifica.
- Los tokens se emiten a una clave pública (prueba de posesión), no a una cadena.

Alternativas:

- mTLS (certificados de cliente): más fuerte, más complejidad operativa.
- Tokens portadores de corta duración solo como fase temporal (rotar + revocar temprano).

## Aprobación silenciosa (heurística SSH)

Definirla con precisión para evitar un eslabón débil. Preferir una:

- **Solo local**: emparejar automáticamente cuando el cliente se conecta vía loopback/socket Unix.
- **Desafío vía SSH**: gateway emite nonce; cliente demuestra SSH al recuperarlo.
- **Ventana de presencia física**: después de una aprobación local en la UI del host gateway, permitir emparejamiento automático por una ventana corta (ej. 10 minutos).

Siempre registrar + grabar aprobaciones automáticas.

---

# TLS en todas partes (dev + prod)

## Reutilizar TLS del bridge existente

Usar runtime TLS actual + anclaje de huella digital:

- `src/infra/bridge/server/tls.ts`
- lógica de verificación de huella digital en `src/node-host/bridge-client.ts`

## Aplicar a WS

- Servidor WS soporta TLS con mismo cert/key + huella digital.
- Clientes WS pueden anclar huella digital (opcional).
- Descubrimiento anuncia TLS + huella digital para todos los endpoints.
  - Descubrimiento es solo pistas de localizador; nunca un ancla de confianza.

## Por qué

- Reducir dependencia en SSH/Tailscale para confidencialidad.
- Hacer que las conexiones móviles remotas sean seguras por defecto.

---

# Rediseño de aprobaciones (centralizadas)

## Actual

La aprobación ocurre en el host del nodo (runtime del nodo de app mac). El prompt aparece donde corre el nodo.

## Propuesto

La aprobación es **hospedada en el gateway**, UI entregada a clientes operadores.

### Nuevo flujo

1. Gateway recibe intención de `system.run` (agente).
2. Gateway crea registro de aprobación: `approval.requested`.
3. UI(s) de operador muestran prompt.
4. Decisión de aprobación enviada al gateway: `approval.resolve`.
5. Gateway invoca comando del nodo si es aprobado.
6. Nodo ejecuta, retorna `invoke-res`.

### Semántica de aprobaciones (endurecimiento)

- Broadcast a todos los operadores; solo la UI activa muestra un modal (otros obtienen una notificación).
- Primera resolución gana; gateway rechaza resoluciones subsecuentes como ya resueltas.
- Timeout predeterminado: negar después de N segundos (ej. 60s), registrar razón.
- La resolución requiere alcance `operator.approvals`.

## Beneficios

- El prompt aparece donde está el usuario (mac/teléfono).
- Aprobaciones consistentes para nodos remotos.
- Runtime del nodo permanece sin interfaz; sin dependencia de UI.

---

# Ejemplos de claridad de roles

## App iPhone

- **Rol de nodo** para: mic, cámara, chat de voz, ubicación, pulsar para hablar.
- **operator.read** opcional para vista de estado y chat.
- **operator.write/admin** opcional solo cuando se habilite explícitamente.

## App macOS

- Rol de operador por defecto (UI de control).
- Rol de nodo cuando "nodo Mac" está habilitado (system.run, pantalla, cámara).
- Mismo deviceId para ambas conexiones → entrada UI fusionada.

## CLI

- Rol de operador siempre.
- Alcance derivado por subcomando:
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - aprobaciones + emparejamiento → `operator.approvals` / `operator.pairing`

---

# Identidad + slugs

## ID estable

Requerido para autenticación; nunca cambia.
Preferido:

- Huella digital de par de claves (hash de clave pública).

## Slug amigable (temático de langosta)

Solo etiqueta humana.

- Ejemplo: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Almacenado en registro del gateway, editable.
- Manejo de colisiones: `-2`, `-3`.

## Agrupación de UI

Mismo `deviceId` entre roles → fila única de "Instancia":

- Insignia: `operator`, `node`.
- Muestra capacidades + última vez visto.

---

# Estrategia de migración

## Fase 0: Documentar + alinear

- Publicar este documento.
- Inventariar todas las llamadas de protocolo + flujos de aprobación.

## Fase 1: Agregar roles/alcances a WS

- Extender parámetros de `connect` con `role`, `scope`, `deviceId`.
- Agregar puertas de lista permitida para rol de nodo.

## Fase 2: Compatibilidad con Bridge

- Mantener bridge corriendo.
- Agregar soporte WS de nodo en paralelo.
- Puertas de características detrás de bandera de config.

## Fase 3: Aprobaciones centrales

- Agregar eventos de solicitud + resolución de aprobación en WS.
- Actualizar UI de app mac para prompt + respuesta.
- Runtime del nodo deja de mostrar prompt de UI.

## Fase 4: Unificación TLS

- Agregar config TLS para WS usando runtime TLS de bridge.
- Agregar anclaje a clientes.

## Fase 5: Deprecar bridge

- Migrar iOS/Android/nodo mac a WS.
- Mantener bridge como respaldo; eliminar una vez estable.

## Fase 6: Autenticación vinculada a dispositivo

- Requerir identidad basada en clave para todas las conexiones no locales.
- Agregar UI de revocación + rotación.

---

# Notas de seguridad

- Rol/lista permitida aplicados en el límite del gateway.
- Ningún cliente obtiene API "completa" sin alcance de operador.
- Emparejamiento requerido para _todas_ las conexiones.
- TLS + anclaje reduce riesgo MITM para móvil.
- Aprobación silenciosa SSH es una conveniencia; aún grabada + revocable.
- Descubrimiento nunca es un ancla de confianza.
- Reclamos de capacidades son verificados contra listas permitidas del servidor por plataforma/tipo.

# Streaming + cargas grandes (media de nodos)

El plano de control WS está bien para mensajes pequeños, pero los nodos también hacen:

- clips de cámara
- grabaciones de pantalla
- streams de audio

Opciones:

1. Frames binarios WS + fragmentación + reglas de contrapresión.
2. Endpoint de streaming separado (aún TLS + autenticación).
3. Mantener bridge más tiempo para comandos pesados en media, migrar al último.

Elegir uno antes de la implementación para evitar deriva.

# Política de capacidades + comandos

- Caps/comandos reportados por nodos son tratados como **reclamos**.
- Gateway aplica listas permitidas por plataforma.
- Cualquier comando nuevo requiere aprobación del operador o cambio explícito de lista permitida.
- Auditar cambios con marcas de tiempo.

# Auditoría + limitación de tasa

- Registrar: solicitudes de emparejamiento, aprobaciones/negaciones, emisión/rotación/revocación de tokens.
- Limitar tasa de spam de emparejamiento y prompts de aprobación.

# Higiene del protocolo

- Versión de protocolo explícita + códigos de error.
- Reglas de reconexión + política de latido.
- TTL de presencia y semántica de última vez visto.

---

# Preguntas abiertas

1. Dispositivo único ejecutando ambos roles: modelo de token
   - Recomendar tokens separados por rol (nodo vs operador).
   - Mismo deviceId; alcances diferentes; revocación más clara.

2. Granularidad de alcance del operador
   - read/write/admin + aprobaciones + emparejamiento (mínimo viable).
   - Considerar alcances por característica más tarde.

3. UX de rotación + revocación de tokens
   - Rotar automáticamente en cambio de rol.
   - UI para revocar por deviceId + rol.

4. Descubrimiento
   - Extender TXT actual de Bonjour para incluir huella TLS WS + pistas de rol.
   - Tratar solo como pistas de localizador.

5. Aprobación entre redes
   - Broadcast a todos los clientes operadores; UI activa muestra modal.
   - Primera respuesta gana; gateway aplica atomicidad.

---

# Resumen (TL;DR)

- Hoy: plano de control WS + transporte de nodos Bridge.
- Dolor: aprobaciones + duplicación + dos pilas.
- Propuesta: un protocolo WS con roles + alcances explícitos, emparejamiento unificado + anclaje TLS, aprobaciones hospedadas en gateway, IDs de dispositivo estables + slugs amigables.
- Resultado: UX más simple, seguridad más fuerte, menos duplicación, mejor enrutamiento móvil.
