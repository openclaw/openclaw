---
title: "Detección de Bucles"
description: "Previene bucles infinitos de agentes con detección automática"
---

## Descripción General

La detección de bucles es una característica de seguridad que previene que los agentes se queden atascados en bucles infinitos de llamadas de herramientas. Monitorea patrones de ejecución y detiene automáticamente el comportamiento repetitivo.

## Cómo Funciona

El sistema de detección de bucles:

1. **Rastrea llamadas de herramientas**: Monitorea secuencias de llamadas de herramientas
2. **Detecta patrones**: Identifica secuencias repetitivas de operaciones
3. **Calcula umbral**: Determina cuándo un patrón indica un bucle
4. **Interviene**: Detiene la ejecución cuando se detecta un bucle

## Patrones Detectados

### Llamadas de Herramientas Repetidas

```typescript
// Bucle detectado: la misma herramienta llamada repetidamente
await tool.execute({ action: 'fetch' });
await tool.execute({ action: 'fetch' });
await tool.execute({ action: 'fetch' });
await tool.execute({ action: 'fetch' });
// → Bucle detectado, ejecución detenida
```

### Secuencias Cíclicas

```typescript
// Bucle detectado: secuencia A → B → C → A repetida
await toolA.execute();
await toolB.execute();
await toolC.execute();
await toolA.execute();
await toolB.execute();
await toolC.execute();
// → Bucle detectado después de 2 ciclos
```

### Recursión Fallida

```typescript
// Bucle detectado: intentos fallidos repetidos
for (let i = 0; i < 100; i++) {
  try {
    await unreliableOperation();
  } catch (error) {
    // Continuar reintentando indefinidamente
  }
}
// → Bucle detectado, ejecución detenida
```

## Configuración

Personaliza el comportamiento de detección de bucles:

```bash
# Establecer umbral de detección de bucles (número de repeticiones)
openclaw config set loopDetection.threshold 5

# Habilitar/deshabilitar detección de bucles
openclaw config set loopDetection.enabled true

# Establecer tamaño de ventana para detección de patrones
openclaw config set loopDetection.windowSize 10

# Configurar intervención automática
openclaw config set loopDetection.autoStop true
```

## Parámetros de Configuración

| Parámetro | Tipo | Predeterminado | Descripción |
|-----------|------|----------------|-------------|
| `enabled` | boolean | true | Habilitar/deshabilitar detección de bucles |
| `threshold` | number | 5 | Número de repeticiones antes de detectar un bucle |
| `windowSize` | number | 10 | Número de llamadas de herramientas a analizar |
| `autoStop` | boolean | true | Detener automáticamente la ejecución cuando se detecta un bucle |

## Manejo de Bucles

Cuando se detecta un bucle:

1. **Detención automática**: La ejecución se detiene inmediatamente (si `autoStop` está habilitado)
2. **Registro**: El bucle se registra en `~/.openclaw/logs/loops.log`
3. **Notificación**: El usuario es notificado del bucle detectado
4. **Contexto**: Se proporciona información sobre el patrón del bucle

## Evitar Falsas Detecciones

### Operaciones Legítimas Repetitivas

Para operaciones que necesitan legítimamente repetirse:

```typescript
// Marcar operación como no-bucle
await tool.execute({
  action: 'poll',
  loopDetection: { ignore: true }
});
```

### Operaciones por Lotes

```typescript
// Procesamiento por lotes no se considera un bucle
for (const item of items) {
  await tool.execute({
    action: 'process',
    data: item,
    loopDetection: { batch: true }
  });
}
```

### Reintentos con Retroceso

```typescript
// Reintentos apropiados con retroceso exponencial
let attempts = 0;
while (attempts < maxRetries) {
  try {
    await operation();
    break;
  } catch (error) {
    attempts++;
    await sleep(Math.pow(2, attempts) * 1000);
  }
}
```

## Inspeccionar Bucles Detectados

Ver historial de bucles detectados:

```bash
# Ver todos los bucles detectados
openclaw loops list

# Ver detalles de un bucle específico
openclaw loops show <loop-id>

# Ver estadísticas de bucles
openclaw loops stats
```

## Mejores Prácticas

1. **Establecer límites**: Siempre establece límites de iteración en bucles
2. **Usar retroceso**: Implementa retroceso exponencial para reintentos
3. **Agregar condiciones de salida**: Asegúrate de que los bucles tengan condiciones de salida claras
4. **Monitorear patrones**: Revisa regularmente los logs de detección de bucles
5. **Ajustar umbrales**: Configura umbrales según tus necesidades
6. **Marcar lotes**: Usa marcadores de lote para procesamiento legítimo repetitivo

## Ejemplo: Procesamiento Seguro

```typescript
// ❌ Malo: Bucle potencial
while (true) {
  const data = await fetchData();
  if (!data) continue;
  await processData(data);
}

// ✅ Bueno: Con límites y condiciones de salida
let attempts = 0;
const maxAttempts = 10;
while (attempts < maxAttempts) {
  const data = await fetchData();
  if (!data) {
    attempts++;
    await sleep(1000 * attempts);
    continue;
  }
  await processData(data);
  break; // Condición de salida exitosa
}
```

## Detección Avanzada

### Análisis de Patrones Personalizados

```bash
# Configurar patrones de bucle personalizados
openclaw config set loopDetection.patterns '[
  { "sequence": ["fetch", "process", "fetch"], "threshold": 3 },
  { "sequence": ["retry", "retry"], "threshold": 5 }
]'
```

### Integración con Monitoreo

```typescript
// Integrar con sistema de monitoreo
openclaw.on('loopDetected', (event) => {
  monitoring.alert({
    type: 'loop_detected',
    pattern: event.pattern,
    duration: event.duration,
    context: event.context
  });
});
```

## Solución de Problemas

### Falsos Positivos

Si ves falsas detecciones de bucles:

```bash
# Aumentar umbral
openclaw config set loopDetection.threshold 10

# Aumentar tamaño de ventana
openclaw config set loopDetection.windowSize 20

# Deshabilitar temporalmente
openclaw config set loopDetection.enabled false
```

### Bucles No Detectados

Si los bucles pasan desapercibidos:

```bash
# Disminuir umbral
openclaw config set loopDetection.threshold 3

# Disminuir tamaño de ventana
openclaw config set loopDetection.windowSize 5

# Habilitar registro detallado
openclaw config set loopDetection.verbose true
```

## Ver También

- [Exec](/es-ES/tools/exec) - Ejecución de comandos
- [Thinking](/es-ES/tools/thinking) - Control de comportamiento del agente
- [Herramientas Sandbox Multi-Agente](/es-ES/tools/multi-agent-sandbox-tools) - Ejecución segura de agentes
