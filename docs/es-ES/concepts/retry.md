---
title: Retry
description: Cómo OpenClaw maneja reintentos para solicitudes de modelo fallidas
---

**Retry** es el mecanismo que OpenClaw utiliza para manejar fallas temporales al llamar a modelos de lenguaje. Cuando una solicitud falla, OpenClaw la reintenta automáticamente con backoff exponencial.

## Cómo Funciona

Cuando una solicitud de modelo falla:

1. **OpenClaw espera un corto período** (por ejemplo, 1 segundo)
2. **Reintenta la solicitud**
3. **Si aún falla, espera más tiempo** (por ejemplo, 2 segundos)
4. **Reintenta nuevamente** con tiempos de espera en aumento
5. **Continúa hasta éxito o se alcanza el máximo de reintentos**

Esto ayuda a recuperarse de fallas temporales como:

- **Problemas de red** (timeouts, conexiones rechazadas)
- **Límites de tasa** (demasiadas solicitudes)
- **Errores del servidor** (500, 503)
- **Sobrecarga** (proveedor temporalmente no disponible)

## Configuración de Retry

### Máximo de Reintentos

Establece cuántas veces reintentar antes de rendirse:

```bash
# Establecer máximo de reintentos (predeterminado: 3)
openclaw config set agent.maxRetries 5

# Deshabilitar reintentos
openclaw config set agent.maxRetries 0
```

### Retraso de Retry

Establece el retraso inicial antes del primer reintento:

```bash
# Establecer retraso de reintento en ms (predeterminado: 1000)
openclaw config set agent.retryDelay 2000
```

### Multiplicador de Backoff

Controla qué tan rápido crece el retraso:

```bash
# Establecer multiplicador de backoff (predeterminado: 2)
openclaw config set agent.retryBackoff 1.5
```

Con un multiplicador de `2`:

- Reintento 1: espera 1s
- Reintento 2: espera 2s
- Reintento 3: espera 4s
- Reintento 4: espera 8s
- Reintento 5: espera 16s

### Retraso Máximo

Establece un límite en cuánto tiempo esperar entre reintentos:

```bash
# Establecer retraso máximo en ms (predeterminado: 60000)
openclaw config set agent.maxRetryDelay 30000
```

Esto previene que los retrasos se vuelvan demasiado largos con backoff exponencial.

## Errores Reintentables

OpenClaw reintenta automáticamente estos tipos de errores:

### Errores de Red

- **ECONNREFUSED**: Conexión rechazada
- **ETIMEDOUT**: Timeout de conexión
- **ENOTFOUND**: DNS lookup falló
- **EAI_AGAIN**: Error DNS temporal

### Errores HTTP

- **429**: Too Many Requests (límite de tasa)
- **500**: Internal Server Error
- **502**: Bad Gateway
- **503**: Service Unavailable
- **504**: Gateway Timeout

### Errores de Proveedor

- **overloaded_error**: Proveedor temporalmente sobrecargado
- **rate_limit_error**: Límite de tasa alcanzado
- **timeout_error**: Solicitud timeout

## Errores No Reintentables

OpenClaw **no** reintenta estos errores:

### Errores del Cliente

- **400**: Bad Request (solicitud inválida)
- **401**: Unauthorized (clave API inválida)
- **403**: Forbidden (permisos insuficientes)
- **404**: Not Found (endpoint no existe)

### Errores de Modelo

- **invalid_request_error**: Parámetros de solicitud inválidos
- **authentication_error**: Autenticación falló
- **permission_error**: Permiso denegado

Para estos errores, OpenClaw falla inmediatamente en lugar de reintentar.

## Retry con Failover

OpenClaw combina retry con [model failover](/es-ES/concepts/model-failover):

1. **Intenta el modelo primario**
2. **Reintenta el modelo primario** (hasta `maxRetries` veces)
3. **Si aún falla, hace failover al siguiente modelo**
4. **Reintenta el nuevo modelo** (hasta `maxRetries` veces)
5. **Continúa hasta que un modelo tenga éxito o todos fallen**

Esto proporciona múltiples niveles de resiliencia.

## Backoff Exponencial

El **backoff exponencial** significa que el tiempo de espera crece exponencialmente con cada reintento. Esto ayuda a:

- **Reducir la carga** en el proveedor sobrecargado
- **Evitar inundar** con reintentos
- **Dar tiempo** para que problemas temporales se resuelvan

Ejemplo con `retryDelay=1000` y `retryBackoff=2`:

```
Reintento 1: espera 1s
Reintento 2: espera 2s
Reintento 3: espera 4s
Reintento 4: espera 8s
Reintento 5: espera 16s
```

## Jitter

OpenClaw añade **jitter** (aleatoriedad) a los retrasos de reintento para prevenir el "efecto rebaño" donde múltiples clientes reintentan al mismo tiempo.

Con jitter, el retraso real es:

```
retraso_real = retraso_base * (1 + aleatorio(-0.1, +0.1))
```

Por ejemplo, con un retraso base de 2s:

- Podría esperar 1.8s
- Podría esperar 2.2s
- Podría esperar 1.9s

Esto dispersa los reintentos en el tiempo.

## Logging de Retry

OpenClaw registra todos los intentos de reintento para debugging:

```
[retry] Attempt 1 failed: rate_limit_error
[retry] Waiting 1000ms before retry
[retry] Attempt 2 failed: rate_limit_error
[retry] Waiting 2000ms before retry
[retry] Attempt 3 succeeded
```

Visualiza logs en tiempo real con:

```bash
openclaw logs --follow --filter retry
```

## Métricas de Retry

OpenClaw rastrea estadísticas de reintento:

- **Tasa de reintento**: Qué tan a menudo ocurren reintentos
- **Distribución de reintentos**: Cuántos reintentos se necesitan típicamente
- **Razones de reintento**: Qué errores causan reintentos
- **Duración de reintento**: Cuánto tiempo toman los reintentos

Visualiza métricas con:

```bash
openclaw metrics --retry
```

## Mejores Prácticas

### Configuración de Reintentos

- **Usa 3-5 reintentos** para la mayoría de casos de uso
- **Usa más reintentos** si los límites de tasa son un problema
- **Usa menos reintentos** si la latencia es crítica

### Configuración de Retraso

- **Comienza con 1-2s** para el retraso inicial
- **Usa backoff más alto** (2-3x) para límites de tasa
- **Usa backoff más bajo** (1.5x) para mejor latencia

### Configuración de Límites

- **Establece `maxRetryDelay`** para prevenir retrasos muy largos
- **Considera el timeout total** (maxRetries × maxRetryDelay)
- **Balancea latencia vs tasa de éxito**

### Monitoreo

- **Monitorea tasa de reintento** para detectar problemas
- **Alerta en alta tasa de reintento** (puede indicar problema del proveedor)
- **Revisa razones de reintento** para identificar causa raíz

## Desactivar Reintentos

Para deshabilitar reintentos completamente:

```bash
openclaw config set agent.maxRetries 0
```

Esto hará que OpenClaw falle inmediatamente en cualquier error.

## Retry con Múltiples Agentes

En configuraciones multi-agente, cada agente tiene su propia configuración de reintento independiente:

- **No se comparten límites de reintento**: Cada agente reintenta independientemente
- **No se comparte backoff**: Cada agente tiene su propio backoff
- **No hay coordinación**: Los agentes no coordinan reintentos

Sin embargo, los agentes aún compiten por:

- **Límites de tasa del proveedor**: Límites de tasa compartidos
- **Recursos de red**: Ancho de banda compartido
- **Límites de concurrencia**: Límites de conexión compartidos

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## Solución de Problemas

### Demasiados Reintentos

Si ves demasiados reintentos:

1. **Verifica límites de tasa del proveedor**: ¿Necesitas límites de tasa más altos?
2. **Aumenta retraso de reintento**: Dale más tiempo al proveedor para recuperarse
3. **Reduce concurrencia**: Envía menos solicitudes simultáneas
4. **Considera cambiar de proveedor**: Usa proveedor con límites de tasa más altos

### Reintentos Lentos

Si los reintentos toman demasiado tiempo:

1. **Reduce máximo de reintentos**: Falla más rápido
2. **Reduce retraso de reintento**: Espera menos entre reintentos
3. **Reduce backoff**: Crece el retraso más lentamente
4. **Establece `maxRetryDelay` más bajo**: Limita retrasos largos

### Reintentos No Funcionan

Si los reintentos no funcionan:

1. **Verifica que los reintentos estén habilitados**: `maxRetries > 0`
2. **Verifica el tipo de error**: ¿Es reintentable?
3. **Revisa logs**: ¿Qué está pasando?
4. **Verifica la configuración**: ¿Retraso/backoff configurados correctamente?

## Referencias API

OpenClaw proporciona APIs programáticas para retry:

```typescript
import { RetryManager } from 'openclaw'

// Configurar retry
const retry = new RetryManager({
  maxRetries: 5,
  retryDelay: 1000,
  retryBackoff: 2,
  maxRetryDelay: 60000,
})

// Ejecutar con retry
const result = await retry.execute(async () => {
  return await model.generate(prompt)
})
```

Consulta la [Referencia API](/es-ES/api/retry) para documentación completa.
