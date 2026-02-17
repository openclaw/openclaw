---
title: "Creación de Habilidades"
description: "Crea habilidades personalizadas de agentes para OpenClaw"
---

## Descripción General

Las habilidades en OpenClaw son módulos reutilizables que amplían las capacidades del agente. Esta guía te muestra cómo crear tus propias habilidades personalizadas.

## Estructura de Habilidades

Una habilidad es un directorio con esta estructura:

```
mi-habilidad/
├── SKILL.md          # Descripción de la habilidad e instrucciones
├── config.json       # Configuración opcional de la habilidad
├── scripts/          # Scripts opcionales
└── resources/        # Recursos adicionales
```

## Crear una Nueva Habilidad

### Paso 1: Crear el Directorio de la Habilidad

```bash
# Crear directorio de habilidad
mkdir ~/.openclaw/skills/mi-habilidad-personalizada
cd ~/.openclaw/skills/mi-habilidad-personalizada
```

### Paso 2: Crear SKILL.md

El archivo `SKILL.md` contiene las instrucciones y documentación de la habilidad:

```markdown
# Mi Habilidad Personalizada

## Descripción
[Breve descripción de lo que hace tu habilidad]

## Cuándo Usar
[Describe cuándo debe activarse esta habilidad]

## Instrucciones
[Instrucciones detalladas paso a paso para el agente]

## Ejemplos
[Ejemplos de uso de la habilidad]
```

### Paso 3: Agregar Configuración (Opcional)

```json
{
  "name": "mi-habilidad-personalizada",
  "version": "1.0.0",
  "description": "Una habilidad personalizada para hacer X",
  "triggers": ["hacer X", "necesito X"],
  "dependencies": []
}
```

## Ejemplo: Habilidad de Revisión de Código

```markdown
# Habilidad de Revisión de Código

## Descripción
Realiza revisiones exhaustivas de código verificando mejores prácticas, problemas de seguridad y calidad del código.

## Cuándo Usar
Activar cuando se pida revisar código, o cuando se envíe código para revisión.

## Instrucciones
1. Leer todo el código cuidadosamente
2. Verificar lo siguiente:
   - Seguridad de tipos (TypeScript)
   - Manejo de errores
   - Mejores prácticas de seguridad
   - Problemas de rendimiento
   - Legibilidad del código
3. Proporcionar retroalimentación constructiva
4. Sugerir mejoras específicas con ejemplos

## Ejemplos
- "Por favor revisa este componente React"
- "Verifica este módulo de API en busca de problemas"
```

## Mejores Prácticas

1. **Ser Específico**: Proporcionar instrucciones claras y accionables
2. **Incluir Ejemplos**: Mostrar casos de uso del mundo real
3. **Documentar Triggers**: Enumerar claramente cuándo debe usarse la habilidad
4. **Probar Exhaustivamente**: Verificar que la habilidad funcione en varios escenarios
5. **Mantener Simple**: Enfocarse en una capacidad bien definida

## Ver También

- [Habilidades](/es-ES/tools/skills) - Descripción general de habilidades
- [Configuración de Habilidades](/es-ES/tools/skills-config) - Opciones de configuración
- [Plugin](/es-ES/tools/plugin) - Crear herramientas programáticas
