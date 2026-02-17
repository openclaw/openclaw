---
title: Cola
description: Cómo OpenClaw gestiona colas de mensajes para procesamiento
---

La **cola** es el mecanismo que OpenClaw utiliza para gestionar mensajes entrantes y asegurar que se procesen en el orden correcto. Cuando múltiples mensajes llegan simultáneamente, se ponen en cola y procesan uno a la vez.

## Cómo Funciona

Cuando llega un mensaje:

1. **Se añade a la cola** con una marca de tiempo
2. **Espera su turno** si otros mensajes se están procesando
3. **Se procesa** cuando llega al frente de la cola
4. **Se elimina de la cola** una vez completado

Esto asegura que:

- **Los mensajes se procesan en orden** (FIFO - First In, First Out)
- **Solo un mensaje se procesa a la vez** por agente
- **No se pierden mensajes** incluso bajo alta carga

## Estructura de la Cola

Cada agente tiene su propia cola independiente. La cola contiene:

- **ID del mensaje**: Identificador único para el mensaje
- **Marca de tiempo**: Cuándo fue recibido el mensaje
- **Canal**: Desde qué canal vino el mensaje
- **Remitente**: Quién envió el mensaje
- **Contenido**: El mensaje en sí
- **Prioridad**: Prioridad opcional (ver abajo)

## Prioridad de la Cola

Por defecto, los mensajes se procesan en orden de llegada (FIFO). Pero OpenClaw soporta **colas de prioridad** para ciertos tipos de mensajes:

- **Prioridad alta**: Comandos de sistema, mensajes de administrador
- **Prioridad normal**: Mensajes regulares del usuario
- **Prioridad baja**: Mensajes batch, procesamiento en segundo plano

Los mensajes de prioridad alta se procesan antes que mensajes de prioridad normal, incluso si llegaron después.

### Configuración de Prioridad

```bash
# Habilitar cola de prioridad
openclaw config set agent.queue.usePriority true

# Establecer usuarios de prioridad alta (procesados primero)
openclaw config set agent.queue.highPriorityUsers '["admin@example.com"]'

# Establecer canales de prioridad alta
openclaw config set agent.queue.highPriorityChannels '["#urgent"]'
```

## Tamaño de la Cola

La cola puede crecer si llegan mensajes más rápido de lo que se pueden procesar. OpenClaw rastrea:

- **Tamaño actual de la cola**: Cuántos mensajes están esperando
- **Tamaño promedio de la cola**: Cola promedio a lo largo del tiempo
- **Tamaño máximo de la cola**: Cola pico

Visualiza estadísticas de la cola con:

```bash
openclaw queue status
```

### Límites de la Cola

Para prevenir uso excesivo de memoria, puedes establecer un tamaño máximo de cola:

```bash
# Establecer tamaño máximo de cola (predeterminado: infinito)
openclaw config set agent.queue.maxSize 100
```

Si la cola alcanza el máximo:

- **Se rechazan nuevos mensajes** con un error
- **Los usuarios ven un mensaje "ocupado"**
- **Se registra la situación de sobrecarga** para monitoreo

## Tiempo de Espera en Cola

OpenClaw rastrea cuánto tiempo pasan los mensajes en cola:

- **Tiempo de espera promedio**: Tiempo promedio en cola
- **Tiempo de espera máximo**: Espera más larga vista
- **P95/P99**: Percentiles para rendimiento

Visualiza métricas de tiempo de espera con:

```bash
openclaw queue metrics
```

### Alertas de Tiempo de Espera

Alerta si los mensajes esperan demasiado:

```bash
# Alertar si los mensajes esperan más de 30 segundos
openclaw config set agent.queue.maxWaitTime 30000
```

## Persistencia de la Cola

Por defecto, la cola solo está en memoria y se pierde si el gateway se bloquea. Para producción, habilita persistencia:

```bash
# Habilitar persistencia de cola (recomendado para producción)
openclaw config set agent.queue.persist true
```

Con persistencia habilitada:

- **La cola se guarda en disco** después de cada mensaje
- **La cola se restaura** al reiniciar
- **No se pierden mensajes** durante reinicios

Los datos de la cola se almacenan en:

```
~/.openclaw/queue/<agent-id>.jsonl
```

## Procesamiento de Cola

### Modo Secuencial

El modo predeterminado procesa un mensaje a la vez:

```bash
# Usar procesamiento secuencial (predeterminado)
openclaw config set agent.queue.mode "sequential"
```

Beneficios:

- **Orden garantizado**: Los mensajes se procesan en orden estricto
- **Uso simple de recursos**: Solo una solicitud de modelo a la vez
- **Fácil de depurar**: Comportamiento predecible

Desventajas:

- **Más lento**: Solo un mensaje a la vez
- **Puede generar retraso**: Los usuarios esperan si hay otros mensajes en cola

### Modo Paralelo

Procesa múltiples mensajes simultáneamente:

```bash
# Usar procesamiento paralelo
openclaw config set agent.queue.mode "parallel"

# Establecer máximo de workers paralelos
openclaw config set agent.queue.concurrency 3
```

Beneficios:

- **Más rápido**: Múltiples mensajes a la vez
- **Menor latencia**: Los usuarios esperan menos
- **Mejor throughput**: Más mensajes por minuto

Desventajas:

- **Orden no garantizado**: Los mensajes pueden terminarse fuera de orden
- **Mayor uso de recursos**: Múltiples solicitudes de modelo
- **Mayor complejidad**: Más difícil de depurar

### Modo Batch

Agrupa múltiples mensajes en una sola solicitud:

```bash
# Usar procesamiento batch
openclaw config set agent.queue.mode "batch"

# Establecer tamaño de batch
openclaw config set agent.queue.batchSize 5

# Establecer tiempo de espera de batch (ms)
openclaw config set agent.queue.batchWait 1000
```

Beneficios:

- **Más eficiente**: Menos llamadas de modelo
- **Menor costo**: Mejor uso de contexto
- **Más rápido para ráfagas**: Maneja múltiples mensajes rápidamente

Desventajas:

- **Mayor latencia**: Los usuarios esperan a que se llene el batch
- **Más complejo**: Requiere modelo con soporte de batch
- **Más difícil de depurar**: Múltiples mensajes en una solicitud

## Monitoreo de Cola

OpenClaw proporciona varias formas de monitorear la cola:

### Estado de la Cola

```bash
# Ver estado actual de la cola
openclaw queue status
```

Esto muestra:

- Tamaño actual de la cola
- Mensajes en procesamiento
- Tiempo de espera promedio
- Throughput (mensajes/minuto)

### Métricas de Cola

```bash
# Ver métricas detalladas
openclaw queue metrics
```

Esto muestra:

- Tamaño promedio/máximo de cola
- Tiempos de espera promedio/máximos
- Percentiles (P50, P95, P99)
- Throughput a lo largo del tiempo

### Logs de Cola

```bash
# Ver eventos de cola en logs
openclaw logs --filter queue
```

Esto muestra:

- Cuándo los mensajes entran/salen de la cola
- Cuánto tiempo esperan los mensajes
- Cuándo se procesan los mensajes
- Cualquier error de cola

## Limpieza de Cola

Si la cola se atasca o tiene mensajes antiguos:

```bash
# Limpiar todos los mensajes en cola
openclaw queue clear

# Limpiar mensajes más antiguos que 1 hora
openclaw queue clear --older-than 1h

# Limpiar mensajes de un canal específico
openclaw queue clear --channel "#test"
```

## Colas Multi-agente

En configuraciones multi-agente, cada agente tiene su propia cola independiente:

- **No se comparte cola**: Los agentes no comparten colas
- **No se compite por recursos**: Cada agente procesa su propia cola
- **No hay interferencia**: Los agentes no se bloquean mutuamente

Sin embargo, los agentes aún compiten por:

- **Límites de tasa de modelo**: Los proveedores limitan solicitudes totales
- **Recursos del sistema**: CPU, memoria, red
- **Límites de tasa de API**: Los canales limitan solicitudes totales

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## Mejores Prácticas

### Elección de Modo

- **Usa secuencial** para la mayoría de casos de uso (predeterminado simple y confiable)
- **Usa paralelo** si necesitas baja latencia y tienes alta carga
- **Usa batch** si tienes mensajes ráfaga y quieres eficiencia

### Monitoreo

- **Monitorea el tamaño de la cola** regularmente para detectar problemas
- **Establece alertas** para colas grandes o tiempos de espera largos
- **Revisa métricas** para identificar cuellos de botella

### Configuración de Límites

- **Establece límites de cola razonables** para prevenir uso de memoria
- **Establece límites de tiempo de espera** para detectar problemas
- **Establece límites de concurrencia** para controlar uso de recursos

### Persistencia

- **Habilita persistencia** para producción (previene pérdida de mensajes)
- **Deshabilita persistencia** para desarrollo (más simple, más rápido)
- **Limpia periódicamente** archivos de cola antiguos

## Solución de Problemas

### Cola que crece sin límite

Si la cola sigue creciendo:

1. **Verifica límites de tasa del modelo**: ¿Estás alcanzando límites de tasa?
2. **Verifica concurrencia**: ¿Podrías procesar más rápido con más workers?
3. **Verifica uso de recursos**: ¿Está el sistema con recursos limitados?
4. **Verifica errores**: ¿Los mensajes están fallando y reintentándose?

### Mensajes atascados en cola

Si los mensajes no se procesan:

1. **Verifica que el gateway esté ejecutándose**: `openclaw gateway status`
2. **Verifica que el agente esté activo**: `openclaw agent status`
3. **Revisa logs para errores**: `openclaw logs --follow`
4. **Intenta limpiar la cola**: `openclaw queue clear`

### Procesamiento fuera de orden

Si los mensajes se procesan fuera de orden:

1. **Verifica el modo de la cola**: ¿Estás usando modo paralelo?
2. **Verifica prioridades**: ¿Los mensajes de alta prioridad se procesan primero?
3. **Verifica marcas de tiempo**: ¿Los relojes están sincronizados?

## Referencias API

OpenClaw proporciona APIs programáticas para gestión de cola:

```typescript
import { QueueManager } from "openclaw";

// Obtener tamaño de cola
const size = await queue.size();

// Añadir mensaje a cola
await queue.enqueue(message, { priority: "high" });

// Procesar siguiente mensaje
const message = await queue.dequeue();

// Limpiar cola
await queue.clear();
```

Consulta la [Referencia API](/es-ES/api/queue) para documentación completa.
