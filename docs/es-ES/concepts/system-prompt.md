---
title: System Prompt
description: Cómo construye y personaliza OpenClaw el system prompt del agente
---

El **system prompt** es un mensaje especial enviado al modelo al inicio de cada solicitud que le indica al agente cómo comportarse. Contiene instrucciones, contexto del entorno y definiciones de herramientas.

## Componentes del System Prompt

El system prompt se construye a partir de varias fuentes:

### 1. Instrucciones Base

Instrucciones centrales sobre cómo debe comportarse el agente:

- **Identidad**: "Eres OpenClaw, un asistente de IA útil"
- **Capacidades**: Qué herramientas están disponibles
- **Pautas de comportamiento**: Cómo responder, cuándo usar herramientas
- **Mejores prácticas**: Consejos para usar herramientas efectivamente

Estas instrucciones están integradas en OpenClaw y proporcionan comportamiento base consistente.

### 2. Información del Entorno

Contexto sobre el entorno donde se ejecuta el agente:

- **Directorio de trabajo**: `Working directory: /path/to/project`
- **Plataforma**: `Platform: darwin` (macOS), `linux`, `win32`
- **Fecha actual**: `Today's date: Mon Jan 15 2024`
- **ID del agente**: `Agent ID: abc123`
- **ID de sesión**: `Session ID: xyz789`

Esto ayuda al agente a entender su contexto y hacer sugerencias apropiadas.

### 3. Instrucciones Personalizadas

Instrucciones específicas del proyecto desde archivos `AGENTS.md` o `CLAUDE.md` en el workspace:

```markdown
# Pautas del Proyecto

Este es un proyecto React TypeScript usando Vite.

## Estilo de Código

- Usa TypeScript estricto
- Prefiere componentes funcionales
- Escribe pruebas para nueva funcionalidad

## Arquitectura

- Componentes en `src/components/`
- Hooks en `src/hooks/`
- Utilidades en `src/utils/`
```

OpenClaw lee estos archivos y los incluye en el system prompt, permitiéndote personalizar el comportamiento del agente para tu proyecto.

### 4. Definiciones de Herramientas

Descripciones de todas las herramientas disponibles:

```json
{
  "name": "read_file",
  "description": "Lee el contenido de un archivo",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Ruta al archivo a leer"
      }
    },
    "required": ["path"]
  }
}
```

Esto le dice al modelo qué herramientas puede llamar y cómo usarlas.

### 5. Configuración

Configuración del agente que afecta el comportamiento:

- **Límites de contexto**: Tamaños máximos de contexto
- **Configuración de herramientas**: Qué herramientas están habilitadas
- **Preferencias de usuario**: Configuración personalizada

## Construcción del System Prompt

OpenClaw construye el system prompt dinámicamente para cada solicitud:

1. **Comienza con instrucciones base**
2. **Añade información del entorno**
3. **Lee archivos `AGENTS.md` / `CLAUDE.md`** si existen
4. **Añade definiciones de herramientas** para herramientas habilitadas
5. **Añade cualquier instrucción dinámica** según el estado

El resultado es un system prompt completo y personalizado para cada solicitud.

## Ubicaciones de Instrucciones Personalizadas

OpenClaw busca archivos de instrucciones en estas ubicaciones (en orden):

1. **Directorio actual**: `./AGENTS.md` o `./CLAUDE.md`
2. **Directorios padre**: `../AGENTS.md`, `../../AGENTS.md`, etc.
3. **Directorio home**: `~/.openclaw/AGENTS.md`
4. **Directorio global**: `/etc/openclaw/AGENTS.md`

El primer archivo encontrado se usa. Esto permite:

- **Instrucciones específicas del proyecto** en el directorio del proyecto
- **Instrucciones del usuario** en el directorio home
- **Instrucciones del sistema** en ubicación global

## Formato de Instrucciones Personalizadas

Los archivos `AGENTS.md` / `CLAUDE.md` deben ser Markdown válido:

```markdown
# Título (opcional)

Instrucciones generales sobre el proyecto...

## Sección 1

Instrucciones específicas...

## Sección 2

Más instrucciones...
```

El agente ve el contenido completo del archivo como parte de su system prompt.

### Mejores Prácticas para Instrucciones

- **Sea específico**: Proporciona detalles concretos, no generalidades vagas
- **Use ejemplos**: Muestra cómo deberían verse las cosas
- **Priorice**: Pon las instrucciones más importantes primero
- **Sea conciso**: Más corto es mejor (usa límites de contexto)
- **Actualice regularmente**: Mantenga las instrucciones actuales

Ejemplo de buenas instrucciones:

````markdown
# Pautas del Proyecto

## Estilo de Código

- Usa TypeScript estricto con tipos explícitos
- Prefiere `const` sobre `let`, nunca uses `var`
- Usa imports ES6, no require()
- Ejecuta `npm run format` antes de hacer commit

## Arquitectura

Componentes viven en `src/components/` con este patrón:

\```typescript
export interface MyComponentProps {
title: string
}

export function MyComponent({ title }: MyComponentProps) {
// implementación
}
\```

## Pruebas

Escribe pruebas en `*.test.ts` usando este patrón:

\```typescript
describe('MyComponent', () => {
it('renders title', () => {
// prueba
})
})
\```
````

## Ver el System Prompt

Para debugging, puedes ver el system prompt completo:

```bash
# Ver system prompt para sesión actual
openclaw debug system-prompt

# Ver system prompt para sesión específica
openclaw debug system-prompt --session <session-id>

# Guardar en archivo
openclaw debug system-prompt > system-prompt.txt
```

Esto muestra exactamente qué ve el modelo, útil para debugging de comportamiento del agente.

## Límites del System Prompt

El system prompt consume parte del límite de contexto del modelo:

- **Instrucciones base**: ~2K tokens
- **Definiciones de herramientas**: ~5-10K tokens (según cuántas herramientas)
- **Instrucciones personalizadas**: Variable (tu archivo)
- **Entorno**: ~100 tokens

Total típico: **~7-12K tokens**

Esto deja la mayor parte del contexto para mensajes, pero ten en cuenta las instrucciones personalizadas largas reducen el espacio para historial de mensajes.

## Actualización del System Prompt

El system prompt se reconstruye para cada solicitud, por lo que los cambios tienen efecto inmediatamente:

- **Edita `AGENTS.md`**: Próxima solicitud verá nuevas instrucciones
- **Cambia workspace**: Carga `AGENTS.md` diferente
- **Actualiza configuración**: Afecta próxima solicitud

No necesitas reiniciar el gateway o resetear sesiones.

## System Prompt Multi-agente

Cuando ejecutas múltiples agentes, cada uno obtiene su propio system prompt:

- **Instrucciones base diferentes**: Los agentes pueden tener roles diferentes
- **Instrucciones personalizadas diferentes**: Los agentes pueden leer diferentes archivos
- **Herramientas diferentes**: Los agentes pueden tener diferentes herramientas habilitadas

Configura diferentes `AGENTS.md` para diferentes agentes colocándolos en diferentes workspaces.

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## System Prompt y Caché

Algunos proveedores (Anthropic) soportan **prompt caching** donde partes del system prompt se cachean para solicitudes más rápidas/económicas:

- **Instrucciones base**: Cacheadas (rara vez cambian)
- **Definiciones de herramientas**: Cacheadas (rara vez cambian)
- **Instrucciones personalizadas**: Cacheadas (cambian ocasionalmente)
- **Información del entorno**: No cacheadas (cambian con cada solicitud)

OpenClaw usa automáticamente prompt caching cuando está disponible.

## Mejores Prácticas

### Escribir Instrucciones Personalizadas

- **Mantenga `AGENTS.md` bajo 2-3K tokens** (~1500-2000 palabras)
- **Enfóquese en lo importante**: Arquitectura, estilo, flujos de trabajo
- **Use ejemplos de código**: Muestra patrones correctos
- **Actualice según aprende**: Añada nuevas pautas a medida que surjan
- **Versione en git**: Rastrea cambios en las instrucciones

### Organización

- **Instrucciones específicas del proyecto** en el repositorio del proyecto
- **Instrucciones personales** en `~/.openclaw/AGENTS.md`
- **Instrucciones del equipo** compartidas vía git
- **Instrucciones del sistema** en `/etc/openclaw/AGENTS.md` (raro)

### Debugging

- **Use `openclaw debug system-prompt`** para ver qué ve el agente
- **Verifique tamaño de tokens** si las sesiones se compactan demasiado pronto
- **Compare system prompts** entre sesiones si el comportamiento difiere
- **Pruebe cambios** con tareas pequeñas antes de confiar en ellas

## Solución de Problemas

### El agente no sigue las instrucciones

Si el agente ignora tus instrucciones personalizadas:

1. **Verifique que `AGENTS.md` exista**: `ls AGENTS.md`
2. **Verifique el contenido**: `cat AGENTS.md`
3. **Ver system prompt**: `openclaw debug system-prompt`
4. **Haga las instrucciones más específicas**: Sea explícito sobre qué hacer
5. **Use ejemplos**: Muestre el comportamiento correcto

### Las instrucciones no se cargan

Si las instrucciones personalizadas no se cargan:

1. **Verifique la ubicación del archivo**: ¿Está en el directorio correcto?
2. **Verifique el nombre del archivo**: Debe ser `AGENTS.md` o `CLAUDE.md`
3. **Verifique permisos**: ¿Puede OpenClaw leer el archivo?
4. **Ver system prompt**: ¿Aparecen las instrucciones allí?

### El system prompt es demasiado largo

Si el system prompt consume demasiado contexto:

1. **Reduzca instrucciones personalizadas**: Mantenga `AGENTS.md` conciso
2. **Deshabilite herramientas no usadas**: Menos definiciones de herramientas
3. **Use modelo con contexto más grande**: Más espacio para todo
4. **Considere múltiples archivos**: Separe instrucciones por tarea

## Referencias API

OpenClaw proporciona APIs programáticas para system prompt:

```typescript
import { SystemPromptBuilder } from "openclaw";

// Construir system prompt
const builder = new SystemPromptBuilder();
const prompt = await builder.build({
  workspace: "/path/to/project",
  agentId: "my-agent",
  tools: ["read_file", "write_file"],
});

// Añadir instrucciones personalizadas
builder.addInstructions("Texto de instrucción personalizado...");

// Obtener tamaño de tokens
const tokens = await builder.countTokens();
```

Consulta la [Referencia API](/es-ES/api/system-prompt) para documentación completa.
