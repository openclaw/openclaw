---
summary: "Plan: aislar browser act:evaluate de la cola de Playwright usando CDP, con plazos de extremo a extremo y resolución de ref más segura"
owner: "openclaw"
status: "draft"
last_updated: "2026-02-10"
title: "Refactorización CDP de Browser Evaluate"
---

# Plan de Refactorización CDP de Browser Evaluate

## Contexto

`act:evaluate` ejecuta JavaScript proporcionado por el usuario en la página. Hoy se ejecuta a través de Playwright (`page.evaluate` o `locator.evaluate`). Playwright serializa comandos CDP por página, por lo que un evaluate atascado o de larga duración puede bloquear la cola de comandos de la página y hacer que cada acción posterior en esa pestaña parezca "atascada".

El PR #13498 agrega una red de seguridad pragmática (evaluate acotado, propagación de aborto y recuperación de mejor esfuerzo). Este documento describe una refactorización mayor que hace que `act:evaluate` esté inherentemente aislado de Playwright para que un evaluate atascado no pueda bloquear las operaciones normales de Playwright.

## Objetivos

- `act:evaluate` no puede bloquear permanentemente acciones posteriores del navegador en la misma pestaña.
- Los tiempos de espera son la única fuente de verdad de extremo a extremo para que un llamador pueda confiar en un presupuesto.
- El aborto y el tiempo de espera se tratan de la misma manera en el despacho HTTP y en proceso.
- El direccionamiento de elementos para evaluate es compatible sin cambiar todo de Playwright.
- Mantener la compatibilidad hacia atrás para llamadores y payloads existentes.

## No objetivos

- Reemplazar todas las acciones del navegador (click, type, wait, etc.) con implementaciones CDP.
- Eliminar la red de seguridad existente introducida en el PR #13498 (sigue siendo un fallback útil).
- Introducir nuevas capacidades inseguras más allá de la puerta `browser.evaluateEnabled` existente.
- Agregar aislamiento de procesos (proceso/hilo de trabajo) para evaluate. Si todavía vemos estados atascados difíciles de recuperar después de esta refactorización, esa es una idea de seguimiento.

## Arquitectura actual (Por qué se atasca)

A alto nivel:

- Los llamadores envían `act:evaluate` al servicio de control del navegador.
- El manejador de ruta llama a Playwright para ejecutar el JavaScript.
- Playwright serializa comandos de página, por lo que un evaluate que nunca termina bloquea la cola.
- Una cola atascada significa que las operaciones posteriores de click/type/wait en la pestaña pueden parecer congelarse.

## Arquitectura propuesta

### 1. Propagación de plazo

Introducir un concepto de presupuesto único y derivar todo de él:

- El llamador establece `timeoutMs` (o un plazo en el futuro).
- El tiempo de espera de la solicitud externa, la lógica del manejador de ruta y el presupuesto de ejecución dentro de la página todos usan el mismo presupuesto, con un pequeño margen donde sea necesario para la sobrecarga de serialización.
- El aborto se propaga como un `AbortSignal` en todas partes para que la cancelación sea consistente.

Dirección de implementación:

- Agregar un ayudante pequeño (por ejemplo `createBudget({ timeoutMs, signal })`) que devuelva:
  - `signal`: el AbortSignal vinculado
  - `deadlineAtMs`: plazo absoluto
  - `remainingMs()`: presupuesto restante para operaciones hijas
- Usar este ayudante en:
  - `src/browser/client-fetch.ts` (despacho HTTP y en proceso)
  - `src/node-host/runner.ts` (ruta de proxy)
  - implementaciones de acciones del navegador (Playwright y CDP)

### 2. Motor de evaluación separado (ruta CDP)

Agregar una implementación de evaluate basada en CDP que no comparta la cola de comandos por página de Playwright. La propiedad clave es que el transporte de evaluate es una conexión WebSocket separada y una sesión CDP separada adjunta al objetivo.

Dirección de implementación:

- Nuevo módulo, por ejemplo `src/browser/cdp-evaluate.ts`, que:
  - Se conecta al endpoint CDP configurado (socket de nivel de navegador).
  - Usa `Target.attachToTarget({ targetId, flatten: true })` para obtener un `sessionId`.
  - Ejecuta ya sea:
    - `Runtime.evaluate` para evaluate a nivel de página, o
    - `DOM.resolveNode` más `Runtime.callFunctionOn` para evaluate de elemento.
  - En tiempo de espera o aborto:
    - Envía `Runtime.terminateExecution` de mejor esfuerzo para la sesión.
    - Cierra el WebSocket y devuelve un error claro.

Notas:

- Esto todavía ejecuta JavaScript en la página, por lo que la terminación puede tener efectos secundarios. La ventaja es que no bloquea la cola de Playwright, y es cancelable en la capa de transporte matando la sesión CDP.

### 3. Historia de Ref (direccionamiento de elementos sin una reescritura completa)

La parte difícil es el direccionamiento de elementos. CDP necesita un manejador DOM o `backendDOMNodeId`, mientras que hoy la mayoría de las acciones del navegador usan localizadores de Playwright basados en refs de snapshots.

Enfoque recomendado: mantener refs existentes, pero adjuntar un id resoluble CDP opcional.

#### 3.1 Extender información de Ref almacenada

Extender los metadatos de ref de rol almacenados para incluir opcionalmente un id CDP:

- Hoy: `{ role, name, nth }`
- Propuesto: `{ role, name, nth, backendDOMNodeId?: number }`

Esto mantiene todas las acciones basadas en Playwright existentes funcionando y permite que el evaluate CDP acepte el mismo valor `ref` cuando el `backendDOMNodeId` está disponible.

#### 3.2 Poblar backendDOMNodeId en tiempo de snapshot

Al producir un snapshot de rol:

1. Generar el mapa de ref de rol existente como hoy (role, name, nth).
2. Obtener el árbol AX a través de CDP (`Accessibility.getFullAXTree`) y calcular un mapa paralelo de `(role, name, nth) -> backendDOMNodeId` usando las mismas reglas de manejo de duplicados.
3. Fusionar el id de vuelta en la información de ref almacenada para la pestaña actual.

Si el mapeo falla para un ref, dejar `backendDOMNodeId` sin definir. Esto hace que la característica sea de mejor esfuerzo y segura para desplegar.

#### 3.3 Comportamiento de evaluate con Ref

En `act:evaluate`:

- Si `ref` está presente y tiene `backendDOMNodeId`, ejecutar evaluate de elemento a través de CDP.
- Si `ref` está presente pero no tiene `backendDOMNodeId`, volver a la ruta de Playwright (con la red de seguridad).

Escape hatch opcional:

- Extender la forma de la solicitud para aceptar `backendDOMNodeId` directamente para llamadores avanzados (y para depuración), mientras se mantiene `ref` como la interfaz principal.

### 4. Mantener una ruta de recuperación de último recurso

Incluso con evaluate CDP, hay otras formas de bloquear una pestaña o una conexión. Mantener los mecanismos de recuperación existentes (terminar ejecución + desconectar Playwright) como último recurso para:

- llamadores heredados
- entornos donde adjuntar CDP está bloqueado
- casos límite inesperados de Playwright

## Plan de implementación (iteración única)

### Entregables

- Un motor de evaluate basado en CDP que se ejecuta fuera de la cola de comandos por página de Playwright.
- Un presupuesto único de tiempo de espera/aborto de extremo a extremo utilizado consistentemente por llamadores y manejadores.
- Metadatos de ref que opcionalmente pueden llevar `backendDOMNodeId` para evaluate de elemento.
- `act:evaluate` prefiere el motor CDP cuando sea posible y vuelve a Playwright cuando no.
- Pruebas que demuestran que un evaluate atascado no bloquea acciones posteriores.
- Registros/métricas que hacen visibles los fallos y fallbacks.

### Lista de verificación de implementación

1. Agregar un ayudante de "presupuesto" compartido para vincular `timeoutMs` + `AbortSignal` ascendente en:
   - un único `AbortSignal`
   - un plazo absoluto
   - un ayudante `remainingMs()` para operaciones descendentes
2. Actualizar todas las rutas de llamador para usar ese ayudante para que `timeoutMs` signifique lo mismo en todas partes:
   - `src/browser/client-fetch.ts` (despacho HTTP y en proceso)
   - `src/node-host/runner.ts` (ruta de proxy de nodo)
   - envoltorios CLI que llaman `/act` (agregar `--timeout-ms` a `browser evaluate`)
3. Implementar `src/browser/cdp-evaluate.ts`:
   - conectar al socket CDP de nivel de navegador
   - `Target.attachToTarget` para obtener un `sessionId`
   - ejecutar `Runtime.evaluate` para evaluate de página
   - ejecutar `DOM.resolveNode` + `Runtime.callFunctionOn` para evaluate de elemento
   - en tiempo de espera/aborto: `Runtime.terminateExecution` de mejor esfuerzo luego cerrar el socket
4. Extender metadatos de ref de rol almacenados para incluir opcionalmente `backendDOMNodeId`:
   - mantener el comportamiento `{ role, name, nth }` existente para acciones de Playwright
   - agregar `backendDOMNodeId?: number` para direccionamiento de elemento CDP
5. Poblar `backendDOMNodeId` durante la creación de snapshot (mejor esfuerzo):
   - obtener árbol AX a través de CDP (`Accessibility.getFullAXTree`)
   - calcular `(role, name, nth) -> backendDOMNodeId` y fusionar en el mapa de ref almacenado
   - si el mapeo es ambiguo o falta, dejar el id sin definir
6. Actualizar enrutamiento de `act:evaluate`:
   - si no hay `ref`: siempre usar evaluate CDP
   - si `ref` resuelve a un `backendDOMNodeId`: usar evaluate de elemento CDP
   - de lo contrario: volver a evaluate de Playwright (todavía acotado y abortable)
7. Mantener la ruta de recuperación de "último recurso" existente como fallback, no la ruta predeterminada.
8. Agregar pruebas:
   - evaluate atascado agota tiempo de espera dentro del presupuesto y el siguiente click/type tiene éxito
   - abortar cancela evaluate (desconexión de cliente o tiempo de espera) y desbloquea acciones subsecuentes
   - los fallos de mapeo vuelven limpiamente a Playwright
9. Agregar observabilidad:
   - duración de evaluate y contadores de tiempo de espera
   - uso de terminateExecution
   - tasa de fallback (CDP -> Playwright) y razones

### Criterios de aceptación

- Un `act:evaluate` deliberadamente colgado devuelve dentro del presupuesto del llamador y no bloquea la pestaña para acciones posteriores.
- `timeoutMs` se comporta consistentemente en CLI, herramienta de agente, proxy de nodo y llamadas en proceso.
- Si `ref` puede mapearse a `backendDOMNodeId`, el evaluate de elemento usa CDP; de lo contrario, la ruta de fallback sigue siendo acotada y recuperable.

## Plan de pruebas

- Pruebas unitarias:
  - Lógica de coincidencia `(role, name, nth)` entre refs de rol y nodos del árbol AX.
  - Comportamiento del ayudante de presupuesto (margen, matemáticas de tiempo restante).
- Pruebas de integración:
  - El tiempo de espera de evaluate CDP devuelve dentro del presupuesto y no bloquea la siguiente acción.
  - El aborto cancela evaluate y activa terminación de mejor esfuerzo.
- Pruebas de contrato:
  - Asegurar que `BrowserActRequest` y `BrowserActResponse` permanezcan compatibles.

## Riesgos y mitigaciones

- El mapeo es imperfecto:
  - Mitigación: mapeo de mejor esfuerzo, fallback a evaluate de Playwright, y agregar herramientas de depuración.
- `Runtime.terminateExecution` tiene efectos secundarios:
  - Mitigación: usar solo en tiempo de espera/aborto y documentar el comportamiento en errores.
- Sobrecarga adicional:
  - Mitigación: obtener árbol AX solo cuando se solicitan snapshots, cachear por objetivo, y mantener la sesión CDP de corta duración.
- Limitaciones de relay de extensión:
  - Mitigación: usar APIs de adjuntar a nivel de navegador cuando los sockets por página no están disponibles, y mantener la ruta actual de Playwright como fallback.

## Preguntas abiertas

- ¿Debería el nuevo motor ser configurable como `playwright`, `cdp`, o `auto`?
- ¿Queremos exponer un nuevo formato "nodeRef" para usuarios avanzados, o mantener solo `ref`?
- ¿Cómo deberían participar los snapshots de frame y los snapshots con alcance de selector en el mapeo AX?
