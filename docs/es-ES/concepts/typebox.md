---
title: TypeBox
description: Cómo usa OpenClaw TypeBox para validación de esquemas de herramientas
---

**TypeBox** es una biblioteca para construir esquemas JSON con inferencia de tipos TypeScript. OpenClaw usa TypeBox para definir y validar esquemas de entrada de herramientas.

## Por Qué TypeBox

OpenClaw usa TypeBox para herramientas porque:

- **Type-safe**: Los esquemas TypeScript se infieren automáticamente desde esquemas TypeBox
- **Validación en tiempo de ejecución**: Los esquemas TypeBox se compilan a validadores JSON Schema rápidos
- **Sin duplicación**: Una definición genera tanto tipos TS como validación en tiempo de ejecución
- **Estándar**: Genera JSON Schema estándar compatible con LLMs

## Esquema Básico de Herramienta

Una herramienta simple que lee archivos:

```typescript
import { Type } from '@sinclair/typebox'
import { tool } from 'openclaw/plugin-sdk'

export const readFile = tool({
  name: 'read_file',
  description: 'Lee el contenido de un archivo',
  input: Type.Object({
    path: Type.String({
      description: 'Ruta al archivo a leer',
    }),
  }),
  async execute({ path }) {
    // path es inferido como string
    return await fs.readFile(path, 'utf-8')
  },
})
```

TypeBox genera:

- **Tipo TypeScript**: `{ path: string }`
- **Esquema JSON**: `{ type: "object", properties: { path: { type: "string" } } }`
- **Validador**: Valida entrada antes de ejecutar

## Tipos TypeBox

### Primitivos

```typescript
Type.String()        // string
Type.Number()        // number
Type.Integer()       // entero
Type.Boolean()       // boolean
Type.Null()          // null
```

### Arrays

```typescript
// Array de strings
Type.Array(Type.String())

// Array con límites de longitud
Type.Array(Type.String(), {
  minItems: 1,
  maxItems: 10,
})
```

### Objetos

```typescript
// Objeto con propiedades requeridas
Type.Object({
  name: Type.String(),
  age: Type.Number(),
})

// Propiedades opcionales
Type.Object({
  name: Type.String(),
  nickname: Type.Optional(Type.String()),
})
```

### Unions

```typescript
// String o número
Type.Union([Type.String(), Type.Number()])

// Literal string union (enum)
Type.Union([
  Type.Literal('red'),
  Type.Literal('green'),
  Type.Literal('blue'),
])
```

### Enums

Para enum-like strings, usa union de literales:

```typescript
const Color = Type.Union([
  Type.Literal('red'),
  Type.Literal('green'),
  Type.Literal('blue'),
])

// En una herramienta
Type.Object({
  color: Color,
})
```

## Descripciones

Añade descripciones para ayudar al LLM a entender parámetros:

```typescript
Type.Object({
  path: Type.String({
    description: 'Ruta al archivo a leer (relativa o absoluta)',
  }),
  encoding: Type.Optional(Type.String({
    description: 'Codificación del archivo (predeterminado: utf-8)',
    default: 'utf-8',
  })),
})
```

Las descripciones aparecen en el esquema JSON enviado al modelo.

## Validación

TypeBox valida automáticamente entradas:

```typescript
const schema = Type.Object({
  count: Type.Integer({ minimum: 1, maximum: 100 }),
})

// Pasa validación
{ count: 50 }

// Falla validación
{ count: 0 }      // menor que el mínimo
{ count: 3.5 }    // no es un entero
{ count: "50" }   // tipo incorrecto
```

Si la validación falla, el agente recibe un error y puede corregir la entrada.

## Valores Predeterminados

Especifica valores predeterminados para parámetros opcionales:

```typescript
Type.Object({
  path: Type.String(),
  encoding: Type.Optional(Type.String({
    default: 'utf-8',
  })),
  maxSize: Type.Optional(Type.Integer({
    default: 1048576, // 1MB
  })),
})
```

Si el modelo omite un parámetro, se usa el valor predeterminado.

## Esquemas Complejos

### Objetos Anidados

```typescript
Type.Object({
  user: Type.Object({
    name: Type.String(),
    email: Type.String(),
  }),
  settings: Type.Object({
    theme: Type.Union([
      Type.Literal('light'),
      Type.Literal('dark'),
    ]),
    notifications: Type.Boolean(),
  }),
})
```

### Arrays de Objetos

```typescript
Type.Array(
  Type.Object({
    id: Type.String(),
    name: Type.String(),
  })
)
```

### Propiedades Adicionales

Por defecto, no se permiten propiedades adicionales. Para permitirlas:

```typescript
Type.Object(
  {
    name: Type.String(),
  },
  { additionalProperties: true }
)
```

### Patrones

Valida strings contra regex:

```typescript
Type.String({
  pattern: '^[a-z0-9-]+$',
  description: 'Slug (solo minúsculas, números, guiones)',
})
```

## Inferencia de Tipos

TypeBox infiere automáticamente tipos TypeScript:

```typescript
const schema = Type.Object({
  name: Type.String(),
  age: Type.Number(),
})

type Person = Static<typeof schema>
// Inferido: { name: string; age: number }
```

En herramientas, esto sucede automáticamente:

```typescript
export const myTool = tool({
  input: Type.Object({
    query: Type.String(),
    limit: Type.Optional(Type.Integer()),
  }),
  async execute({ query, limit }) {
    // query: string
    // limit: number | undefined
  },
})
```

## Reutilización de Esquemas

Define esquemas reutilizables:

```typescript
// Esquema compartido
const FileOptions = Type.Object({
  encoding: Type.Optional(Type.String()),
  maxSize: Type.Optional(Type.Integer()),
})

// Usa en múltiples herramientas
export const readFile = tool({
  input: Type.Object({
    path: Type.String(),
    options: Type.Optional(FileOptions),
  }),
  // ...
})

export const writeFile = tool({
  input: Type.Object({
    path: Type.String(),
    content: Type.String(),
    options: Type.Optional(FileOptions),
  }),
  // ...
})
```

## Esquemas Condicionales

TypeBox soporta lógica condicional:

```typescript
Type.Object({
  type: Type.Union([
    Type.Literal('file'),
    Type.Literal('directory'),
  ]),
  // Si type=file, path requerido
  path: Type.String(),
})
```

Para lógica más compleja, usa validación personalizada en `execute()`.

## Mensajes de Error

Personaliza mensajes de error de validación:

```typescript
Type.String({
  description: 'Dirección de correo electrónico',
  pattern: '^[^@]+@[^@]+\\.[^@]+$',
  errorMessage: {
    pattern: 'Debe ser una dirección de correo electrónico válida',
  },
})
```

El modelo ve estos errores y puede corregir la entrada.

## Rendimiento

TypeBox compila esquemas a validadores JavaScript rápidos:

- **Más rápido que JSON Schema**: ~10-100x más rápido que validadores JSON Schema
- **Sin penalización en tiempo de ejecución**: Los esquemas se compilan una vez
- **Type-safe**: Sin tradeoff vs validación manual

## Mejores Prácticas

### Descripciones

- **Escribe descripciones claras** para todos los parámetros
- **Incluye ejemplos** en descripciones si es útil
- **Especifica valores predeterminados** en descripciones
- **Explica restricciones** (min/max, pattern, etc.)

### Tipos

- **Usa tipos específicos**: `Type.Integer()` no `Type.Number()` para enteros
- **Añade validación**: min/max, pattern, enum, etc.
- **Haz parámetros opcionales** cuando sea apropiado
- **Proporciona valores predeterminados** para parámetros opcionales

### Organización

- **Reutiliza esquemas** en lugar de duplicar
- **Exporta esquemas comunes** para otros plugins
- **Agrupa esquemas relacionados** en un archivo
- **Usa namespaces** para colecciones de esquemas grandes

### Testing

- **Prueba casos válidos**: Asegúrate de que las entradas correctas pasen
- **Prueba casos inválidos**: Asegúrate de que las entradas incorrectas fallen
- **Prueba casos límite**: min/max, strings vacíos, arrays vacíos
- **Prueba inferencia de tipos**: TypeScript debería detectar errores

## Patrones Comunes

### String Enum

```typescript
const Status = Type.Union([
  Type.Literal('pending'),
  Type.Literal('active'),
  Type.Literal('complete'),
])
```

### Ruta de Archivo

```typescript
Type.String({
  description: 'Ruta al archivo (relativa o absoluta)',
  pattern: '^[^\\0]+$', // sin caracteres null
})
```

### Dirección de Email

```typescript
Type.String({
  description: 'Dirección de correo electrónico',
  pattern: '^[^@]+@[^@]+\\.[^@]+$',
})
```

### URL

```typescript
Type.String({
  description: 'URL (http o https)',
  pattern: '^https?://',
})
```

### Fecha ISO

```typescript
Type.String({
  description: 'Fecha en formato ISO 8601 (YYYY-MM-DD)',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
})
```

### Entero Positivo

```typescript
Type.Integer({
  minimum: 1,
  description: 'Entero positivo',
})
```

### Array No Vacío

```typescript
Type.Array(Type.String(), {
  minItems: 1,
  description: 'Array de strings (al menos uno)',
})
```

## Limitaciones

### Lo Que TypeBox No Puede Hacer

- **Validación personalizada compleja**: Usa validación manual en `execute()`
- **Referencias cruzadas de campos**: Usa validación manual
- **Lógica condicional compleja**: Simplifica o usa validación manual
- **Valores de esquema dinámicos**: Los esquemas son estáticos

### Workarounds

Para validación compleja, valida en `execute()`:

```typescript
export const myTool = tool({
  input: Type.Object({
    startDate: Type.String(),
    endDate: Type.String(),
  }),
  async execute({ startDate, endDate }) {
    // Validación personalizada
    const start = new Date(startDate)
    const end = new Date(endDate)
    if (end < start) {
      throw new Error('endDate debe ser después de startDate')
    }
    // ...
  },
})
```

## Documentación de TypeBox

Para toda la referencia de TypeBox, consulta:

- **Docs de TypeBox**: https://github.com/sinclairzx81/typebox
- **Ejemplos**: https://github.com/sinclairzx81/typebox#examples
- **JSON Schema**: https://json-schema.org/

## Ejemplos de OpenClaw

Consulta herramientas integradas de OpenClaw para ejemplos:

- `src/tools/file.ts` - Herramientas de archivo con esquemas TypeBox
- `src/tools/shell.ts` - Herramientas de shell con validación
- `extensions/*/src/tools.ts` - Herramientas de plugin con esquemas TypeBox

Todos los plugins de OpenClaw usan TypeBox para definiciones de herramientas.
