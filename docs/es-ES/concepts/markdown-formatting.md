---
title: "Formato Markdown"
description: "Cómo OpenClaw maneja el formato Markdown en mensajes y respuestas"
---

# Formato Markdown

OpenClaw usa **Markdown** extensivamente para formatear mensajes, documentación y salida de agentes. Entender cómo funciona el formato de Markdown es esencial para comunicarse efectivamente con agentes y construir herramientas personalizadas.

## Descripción general

OpenClaw admite **GitHub Flavored Markdown (GFM)**, que incluye:

- Markdown estándar (encabezados, listas, enlaces, etc.)
- Bloques de código con resaltado de sintaxis
- Tablas
- Listas de tareas
- Tachado
- Emojis
- Y más...

## Sintaxis básica

### Encabezados

```markdown
# Encabezado de nivel 1
## Encabezado de nivel 2
### Encabezado de nivel 3
```

### Énfasis

```markdown
*cursiva* o _cursiva_
**negrita** o __negrita__
***negrita y cursiva***
~~tachado~~
```

### Listas

```markdown
# Lista desordenada
- Elemento 1
- Elemento 2
  - Subíndice

# Lista ordenada
1. Primer elemento
2. Segundo elemento
3. Tercer elemento

# Lista de tareas
- [x] Tarea completada
- [ ] Tarea pendiente
```

### Enlaces

```markdown
[Texto del enlace](https://example.com)
[Enlace con título](https://example.com "Texto del título")
```

### Imágenes

```markdown
![Texto alternativo](https://example.com/image.png)
![Imagen con título](https://example.com/image.png "Título de la imagen")
```

### Citas

```markdown
> Esta es una cita
> Puede abarcar múltiples líneas
```

## Bloques de código

### Código en línea

Use backticks para código en línea:

```markdown
Usa el comando `openclaw chat` para iniciar una conversación.
```

### Bloques de código cercados

Use triple backticks para bloques de código de múltiples líneas:

````markdown
```
def hello():
    print("Hello, world!")
```
````

### Resaltado de sintaxis

Especifica el lenguaje para resaltado de sintaxis:

````markdown
```python
def factorial(n):
    if n == 0:
        return 1
    return n * factorial(n - 1)
```
````

Lenguajes admitidos incluyen: `python`, `javascript`, `typescript`, `bash`, `json`, `yaml`, `markdown`, y más.

## Tablas

```markdown
| Encabezado 1 | Encabezado 2 | Encabezado 3 |
|--------------|--------------|--------------|
| Fila 1       | Datos        | Más datos    |
| Fila 2       | Datos        | Más datos    |
```

### Alineación de tablas

```markdown
| Izquierda | Centro | Derecha |
|:----------|:------:|--------:|
| Texto     | Texto  | Texto   |
```

## Reglas horizontales

```markdown
---
***
___
```

## Listas de tareas

```markdown
- [x] Tarea completada
- [ ] Tarea pendiente
- [ ] Otra tarea
```

## Emojis

OpenClaw admite emojis de GitHub:

```markdown
:smile: :rocket: :tada: :heart:
```

Renderiza como: 😊 🚀 🎉 ❤️

## Markdown en respuestas de agentes

Cuando los agentes responden, usan Markdown para formatear su salida:

### Ejemplo: Bloque de código

**Entrada del usuario**:
```
Escribe una función de Python para calcular números de Fibonacci.
```

**Respuesta del agente**:
````markdown
Aquí está una función de Python para calcular números de Fibonacci:

```python
def fibonacci(n):
    """Calcula el n-ésimo número de Fibonacci."""
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)
```

Uso:
```python
print(fibonacci(10))  # Salida: 55
```
````

### Ejemplo: Tabla

**Entrada del usuario**:
```
Compara diferentes proveedores de modelos.
```

**Respuesta del agente**:
```markdown
Aquí hay una comparación de proveedores de modelos:

| Proveedor  | Modelo              | Tokens de contexto | Costo (por 1M tokens) |
|------------|---------------------|--------------------|-----------------------|
| OpenAI     | GPT-4 Turbo         | 128,000            | $10                   |
| Anthropic  | Claude 3 Opus       | 200,000            | $15                   |
| Google     | Gemini 1.5 Pro      | 1,000,000          | $7                    |
```

## Markdown en canales

Diferentes canales tienen diferentes capacidades de renderizado de Markdown:

### CLI (Terminal)

El CLI de OpenClaw renderiza Markdown usando un renderizador de terminal:

- **Resaltado de sintaxis**: Bloques de código con color
- **Formato**: Negrita, cursiva, enlaces
- **Tablas**: Renderizadas como ASCII art
- **Listas**: Renderizadas con viñetas/números

### Telegram

Telegram admite un subconjunto de Markdown:

- **Negrita**: `**texto**`
- **Cursiva**: `*texto*`
- **Código en línea**: `` `código` ``
- **Bloques de código**: ` ```código``` `
- **Enlaces**: `[texto](url)`

**Nota**: Los bloques de código de Telegram no admiten especificadores de lenguaje.

### Discord

Discord admite Markdown completo:

- Todos los elementos de markdown estándar
- Bloques de código con resaltado de sintaxis
- Emojis personalizados
- Menciones (@usuario, #canal)

### Slack

Slack usa su propio sabor de markdown:

- **Negrita**: `*texto*`
- **Cursiva**: `_texto_`
- **Tachado**: `~texto~`
- **Código**: `` `código` ``
- **Bloques de código**: ` ```código``` `

**Nota**: Slack no admite encabezados o tablas de markdown.

## Mejores prácticas

### 1. Usa bloques de código para código

Siempre usa bloques de código cercados para snippets de código:

````markdown
```python
def example():
    pass
```
````

**No** uses código en línea para múltiples líneas:

```markdown
Aquí hay un ejemplo: `def example(): pass`.
```

### 2. Especifica lenguajes de código

Siempre especifica el lenguaje para resaltado de sintaxis:

````markdown
```python
# Código de Python
```
````

### 3. Usa tablas para datos estructurados

Las tablas son excelentes para comparaciones y datos estructurados:

```markdown
| Característica | Estado    |
|----------------|-----------|
| Soporte de CLI | ✅        |
| Soporte web    | 🚧        |
```

### 4. Mantén el markdown simple

No todos los canales admiten markdown avanzado. Mantén el formato simple para compatibilidad:

- Usa negrita y cursiva con moderación
- Evita markdown complejo anidado
- Prueba en múltiples canales

### 5. Usa listas para pasos

Las listas ordenadas son excelentes para instrucciones paso a paso:

```markdown
1. Instala OpenClaw
2. Configura tu modelo
3. Inicia una conversación
```

## Markdown personalizado en herramientas

Al construir herramientas personalizadas, puedes devolver markdown en las respuestas de tu herramienta:

```typescript
import { Agent } from 'openclaw/plugin-sdk'

const myTool = {
  name: 'example-tool',
  async execute(context: Agent.Context) {
    return {
      markdown: `
# Resultado

Aquí está el resultado de la herramienta:

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
      `
    }
  }
}
```

## Renderizado de markdown

OpenClaw usa la especificación **CommonMark** para renderizar markdown, con extensiones GFM.

### CLI

El CLI renderiza markdown usando:

- [marked](https://github.com/markedjs/marked) - analizador de Markdown
- [marked-terminal](https://github.com/mikaelbr/marked-terminal) - renderizador de terminal

### Web

La interfaz web renderiza markdown usando:

- [react-markdown](https://github.com/remarkjs/react-markdown)
- [remark-gfm](https://github.com/remarkjs/remark-gfm) - soporte de GFM

## Ver también

- [Agentes](/es-ES/concepts/agent) - Cómo responden los agentes con markdown
- [Canales](/es-ES/channels/overview) - Soporte de markdown en diferentes canales
- [Herramientas personalizadas](/es-ES/tools/custom) - Devolver markdown desde herramientas
