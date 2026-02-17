---
title: Model Failover
description: Cómo OpenClaw maneja fallos de modelos con fallback automático
---

**Model failover** es la capacidad de OpenClaw de cambiar automáticamente a un modelo de respaldo cuando el modelo primario falla o no está disponible. Esto asegura que el agente pueda continuar trabajando incluso cuando un proveedor de modelo experimenta problemas.

## Cómo Funciona

Cuando una solicitud de modelo falla, OpenClaw:

1. **Intenta con el siguiente modelo** en la lista de failover
2. **Registra el fallo** para debugging
3. **Notifica al usuario** si todos los modelos fallan

El failover es automático y transparente—el agente simplemente continúa trabajando con un modelo diferente.

## Configuración de Failover

Configura failover especificando múltiples modelos en `agent.models`:

```bash
# Establecer modelo primario + fallbacks
openclaw config set agent.models '["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"]'
```

OpenClaw intentará los modelos en orden:

1. Primero intenta `claude-3-5-sonnet-20241022`
2. Si falla, intenta `claude-3-5-haiku-20241022`
3. Si ambos fallan, devuelve un error

## Razones de Fallo

Los modelos pueden fallar por varias razones:

- **Límites de tasa** (demasiadas solicitudes)
- **Cuotas agotadas** (límite de gastos alcanzado)
- **Problemas de red** (tiempo de espera, conexión rechazada)
- **Errores del proveedor** (problemas del lado del servidor)
- **Sobrecarga** (proveedor temporalmente no disponible)
- **Errores de autenticación** (clave API inválida o expirada)

El failover ayuda a mitigar estos problemas cambiando a un proveedor diferente.

## Estrategias de Failover

### Failover Entre Proveedores

La estrategia más robusta es realizar failover entre diferentes proveedores:

```bash
openclaw config set agent.models '[
  "claude-3-5-sonnet-20241022",
  "openai/gpt-4o",
  "google/gemini-pro"
]'
```

Esto asegura que si Anthropic tiene problemas, puedes recurrir a OpenAI o Google.

### Failover Dentro del Mismo Proveedor

También puedes realizar failover entre modelos del mismo proveedor:

```bash
openclaw config set agent.models '[
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-haiku-20240307"
]'
```

Esto es útil si quieres quedarte con un proveedor pero tener fallbacks.

### Failover Basado en Costo

Puedes configurar failover para preferir modelos más baratos como respaldo:

```bash
openclaw config set agent.models '[
  "claude-3-5-sonnet-20241022",   # Modelo premium primario
  "claude-3-5-haiku-20241022",    # Modelo de rango medio
  "claude-3-haiku-20240307"       # Fallback económico
]'
```

### Failover Basado en Velocidad

O prioriza modelos más rápidos como respaldo:

```bash
openclaw config set agent.models '[
  "claude-3-5-sonnet-20241022",   # Mejor rendimiento
  "claude-3-5-haiku-20241022",    # Más rápido si Sonnet falla
]'
```

## Configuración de Reintentos

Por defecto, OpenClaw reintenta solicitudes fallidas antes de hacer failover. Puedes configurar el comportamiento de reintentos:

```bash
# Establecer número máximo de reintentos
openclaw config set agent.maxRetries 3

# Establecer retraso de backoff (ms)
openclaw config set agent.retryDelay 1000
```

Consulta [Retry](/es-ES/concepts/retry) para más detalles sobre lógica de reintentos.

## Logging de Failover

OpenClaw registra todos los eventos de failover para debugging. Los logs incluyen:

- Qué modelo falló
- Por qué falló
- A qué modelo se hizo failover
- Cuántos reintentos se intentaron

Los logs están en:

```
~/.openclaw/logs/agent-<id>.log
```

Visualiza logs en tiempo real con:

```bash
openclaw logs --follow
```

## Failover vs Retry

Es importante entender la diferencia:

- **Retry**: Intenta la misma solicitud con el mismo modelo múltiples veces
- **Failover**: Cambia a un modelo diferente después de que los reintentos fallen

El flujo es:

1. Intenta el modelo primario
2. Reintenta el modelo primario (hasta `maxRetries` veces)
3. Si aún falla, hace failover al siguiente modelo
4. Reintenta el nuevo modelo (hasta `maxRetries` veces)
5. Continúa hasta que un modelo tenga éxito o todos fallen

## Notificaciones de Failover

Cuando ocurre failover, OpenClaw puede notificar al usuario:

```bash
# Habilitar notificaciones de failover
openclaw config set agent.notifyOnFailover true
```

Esto mostrará un mensaje cuando el agente cambie a un modelo de respaldo.

## Limitaciones de Failover

### Diferencias de Capacidad de Modelos

Ten en cuenta que diferentes modelos tienen diferentes capacidades:

- **Límites de contexto** varían (algunos modelos manejan menos tokens)
- **Soporte de herramientas** puede diferir (no todos los modelos soportan todas las herramientas)
- **Calidad** puede variar (los modelos de respaldo pueden dar respuestas más pobres)

OpenClaw intentará adaptar solicitudes al nuevo modelo, pero algunas características pueden no funcionar.

### Preservación del Estado

El failover preserva el estado de la sesión, pero:

- **El historial de mensajes** permanece intacto
- **El contexto del sistema** permanece igual
- **Llamadas a herramientas en progreso** pueden necesitar reintentarse
- **Respuestas parciales** pueden perderse

El agente continuará donde lo dejó, pero puede necesitar regenerar parte de la respuesta.

## Mejores Prácticas

### Selección de Modelos de Respaldo

Al elegir modelos de respaldo:

1. **Usar diferentes proveedores** para máxima resiliencia
2. **Coincidir capacidades** (tamaño de contexto, soporte de herramientas)
3. **Considerar costo** (los respaldos deben ser asequibles)
4. **Probar failover** para asegurar que funcione

### Monitoreo

Monitorea el uso de failover para identificar problemas:

- **Revisa logs** regularmente para patrones de fallo
- **Rastrea tasa de failover** para detectar problemas del proveedor
- **Alerta en exceso de failover** (puede indicar un problema)

### Manejo de Degradación

Al hacer failover a un modelo más débil:

- **Ajustar expectativas** (puede ser más lento o menos preciso)
- **Considerar retroceso de funcionalidad** (desactivar características complejas)
- **Notificar al usuario** sobre degradación

## Desactivar Failover

Si quieres desactivar failover y solo usar un modelo:

```bash
# Solo usar un modelo (sin failover)
openclaw config set agent.models '["claude-3-5-sonnet-20241022"]'
```

Esto hará que el agente falle si el modelo primario no está disponible.
