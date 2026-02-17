---
title: Zona Horaria
description: Cómo maneja OpenClaw zonas horarias en conversaciones del agente
---

**Zona horaria** se refiere a cómo OpenClaw maneja tiempo y fechas en conversaciones del agente. Una gestión correcta de zonas horarias asegura que el agente entienda cuándo el usuario dice "hoy", "mañana", "esta mañana", etc.

## Detección de Zona Horaria

OpenClaw detecta automáticamente la zona horaria del usuario desde:

1. **Configuración explícita**: `openclaw config set agent.timezone "America/Los_Angeles"`
2. **Variable de entorno**: `TZ=America/New_York`
3. **Configuración del sistema**: Configuración de zona horaria del OS
4. **Ubicación del usuario**: Desde metadatos del canal (si está disponible)
5. **Predeterminado**: UTC si no se puede detectar

La zona horaria detectada se incluye en el system prompt para que el agente la conozca.

## Establecer Zona Horaria

Puedes establecer explícitamente la zona horaria:

```bash
# Establecer zona horaria
openclaw config set agent.timezone "America/Los_Angeles"

# Limpiar (usar detección automática)
openclaw config set agent.timezone ""
```

Formato de zona horaria:

- **Nombres IANA**: `America/Los_Angeles`, `Europe/London`, `Asia/Tokyo`
- **Offsets UTC**: `UTC+8`, `UTC-5`
- **Abreviaturas** (no recomendado): `PST`, `EST` (ambiguas)

### Ejemplos de Zonas Horarias

Zonas horarias comunes:

- **US Pacific**: `America/Los_Angeles` (PST/PDT)
- **US Eastern**: `America/New_York` (EST/EDT)
- **US Central**: `America/Chicago` (CST/CDT)
- **US Mountain**: `America/Denver` (MST/MDT)
- **UK**: `Europe/London` (GMT/BST)
- **EU Central**: `Europe/Paris` (CET/CEST)
- **Japan**: `Asia/Tokyo` (JST)
- **Australia**: `Australia/Sydney` (AEDT/AEST)

## Zona Horaria en System Prompt

La zona horaria del usuario se incluye en el system prompt:

```
Today's date: Mon Jan 15 2024
Timezone: America/Los_Angeles (PST, UTC-8)
Current time: 9:30 AM
```

Esto permite al agente:

- **Entender referencias de tiempo relativas**: "esta mañana", "ayer"
- **Programar tareas apropiadamente**: "hazlo mañana a las 9am"
- **Mostrar tiempos en zona local**: "El archivo fue modificado a las 3pm"
- **Calcular duraciones correctamente**: "hace 2 horas"

## Manejo de Horario de Verano

OpenClaw maneja automáticamente transiciones de horario de verano (DST):

- **Antes de DST**: `America/Los_Angeles` = PST (UTC-8)
- **Después de DST**: `America/Los_Angeles` = PDT (UTC-7)

El agente siempre conoce el offset actual correcto.

## Zona Horaria por Canal

Diferentes canales pueden proporcionar información de zona horaria del usuario:

### Slack

- Usa zona horaria del perfil de Slack del usuario
- Cae a configuración del workspace si no está establecido
- Generalmente precisa para usuarios de Slack

### Discord

- Sin zona horaria integrada
- Cae a configuración del sistema o explícita
- Considera establecer explícitamente

### Telegram

- Sin zona horaria integrada
- Cae a configuración del sistema o explícita
- Considera establecer explícitamente

### CLI

- Usa zona horaria del sistema
- Generalmente precisa
- Puede sobrescribirse con variable de entorno `TZ`

## Zona Horaria Multi-usuario

En canales donde múltiples usuarios interactúan con el agente:

- **Cada usuario puede tener zona horaria diferente**
- **OpenClaw rastrea zona horaria por usuario**
- **El agente usa la zona horaria del usuario actual**

Ejemplo:

```
Alice (US Pacific): "Envíamelo esta tarde" → El agente entiende hora del Pacífico
Bob (Europe/London): "Envíamelo esta tarde" → El agente entiende hora de Londres
```

## Formateo de Tiempo

Al mostrar tiempos, OpenClaw:

- **Usa zona horaria del usuario** por defecto
- **Incluye zona horaria** para claridad (por ejemplo, "3pm PST")
- **Usa formato 12h/24h** según la configuración regional

### Formato de Hora

Controla el formato de hora (12h vs 24h):

```bash
# Usar formato 12 horas (predeterminado)
openclaw config set agent.timeFormat "12h"

# Usar formato 24 horas
openclaw config set agent.timeFormat "24h"

# Auto-detectar desde locale
openclaw config set agent.timeFormat "auto"
```

## Referencias de Tiempo Relativas

El agente entiende referencias de tiempo relativas en la zona horaria del usuario:

- **"hoy"**: Día actual en zona del usuario
- **"mañana"**: Día siguiente en zona del usuario
- **"esta mañana"**: Mañana en zona del usuario
- **"esta noche"**: Noche en zona del usuario
- **"la semana pasada"**: Hace 7 días desde zona del usuario
- **"el mes pasado"**: Hace ~30 días desde zona del usuario

Ejemplo:

```
Usuario (PST, 11pm): "hazlo mañana"
→ El agente programa para mañana en zona horaria del Pacífico (no UTC)
```

## Marcas de Tiempo

Las marcas de tiempo en logs y archivos de sesión usan:

- **UTC** para consistencia interna
- **Zona local** cuando se muestran al usuario
- **Formato ISO 8601** para análisis

Ejemplo de marca de tiempo de log:

```
2024-01-15T17:30:00Z        (UTC)
2024-01-15 09:30:00 PST     (mostrado al usuario)
```

## Zona Horaria Multi-agente

En configuraciones multi-agente, cada agente puede tener su propia zona horaria:

```bash
# Establecer zona horaria para agente1
openclaw config set agents.agent1.timezone "America/Los_Angeles"

# Establecer zona horaria para agente2
openclaw config set agents.agent2.timezone "Europe/London"
```

Esto es útil cuando diferentes agentes sirven a usuarios en diferentes zonas horarias.

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## Mejores Prácticas

### Establecer Zona Horaria Explícitamente

- **Establece explícitamente** en lugar de confiar en la detección para entornos de producción
- **Usa nombres IANA** (por ejemplo, `America/Los_Angeles`) no abreviaturas
- **Documenta zona horaria** en la configuración del equipo
- **Prueba cambios de horario de verano** alrededor de transiciones

### Equipos Distribuidos

- **Establece zona horaria del equipo** si todos están en la misma zona
- **Usa zonas horarias individuales** si el equipo es distribuido
- **Sé explícito en comunicación**: Incluye zona horaria cuando programes
- **Considera UTC** para coordinación de equipo

### Debugging

- **Verifica zona horaria**: `openclaw debug system-prompt | grep -i timezone`
- **Prueba tiempos relativos**: "¿Qué hora es?" debería mostrar hora local
- **Verifica formato de logs**: ¿Las marcas de tiempo tienen sentido?
- **Prueba alrededor de DST**: Verifica transiciones de horario de verano

## Solución de Problemas

### Zona horaria incorrecta

Si el agente usa la zona horaria incorrecta:

1. **Verifica configuración**: `openclaw config get agent.timezone`
2. **Verifica variable de entorno**: `echo $TZ`
3. **Verifica zona horaria del sistema**: `date +%Z`
4. **Establece explícitamente**: `openclaw config set agent.timezone "..."`

### El agente no entiende tiempos relativos

Si el agente malinterpreta "hoy", "mañana", etc.:

1. **Verifica zona horaria**: ¿Está establecida correctamente?
2. **Ver system prompt**: ¿Aparece la zona horaria allí?
3. **Sé más específico**: Usa fechas absolutas (por ejemplo, "January 15")
4. **Incluye zona horaria**: "3pm PST" en lugar de solo "3pm"

### El formato de hora es incorrecto

Si los tiempos se muestran en formato incorrecto:

1. **Verifica `agent.timeFormat`**: ¿Está establecido a tu preferencia?
2. **Verifica locale**: `echo $LANG`
3. **Establece explícitamente**: `openclaw config set agent.timeFormat "12h"`

### Problemas de DST

Si los tiempos son incorrectos alrededor de transiciones de horario de verano:

1. **Verifica base de datos de zona horaria del sistema**: ¿Está actualizada?
2. **Reinicia gateway**: Puede estar usando reglas antiguas de DST
3. **Usa offset UTC** si DST es problemático
4. **Reporta bugs**: Puede ser un bug de OpenClaw

## Referencias API

OpenClaw proporciona APIs programáticas para manejo de zonas horarias:

```typescript
import { TimezoneManager } from 'openclaw'

// Obtener zona horaria del usuario
const timezone = await tz.getUserTimezone(userId)

// Formatear tiempo en zona del usuario
const formatted = tz.format(timestamp, timezone, { format: '12h' })

// Analizar tiempo relativo
const date = tz.parseRelative('mañana', timezone)

// Convertir entre zonas horarias
const converted = tz.convert(timestamp, 'America/Los_Angeles', 'Europe/London')
```

Consulta la [Referencia API](/es-ES/api/timezone) para documentación completa.
