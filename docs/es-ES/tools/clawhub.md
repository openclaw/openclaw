---
title: "ClawHub"
description: "Repositorio central para herramientas y habilidades de agentes"
---

## Descripción General

ClawHub es el repositorio oficial de OpenClaw para herramientas de agentes, habilidades y extensiones. Proporciona:

- **Herramientas verificadas**: Colección curada de herramientas listas para producción
- **Habilidades compartibles**: Habilidades de agentes reutilizables creadas por la comunidad
- **Gestión de versiones**: Control de versiones y actualizaciones de herramientas
- **Descubrimiento fácil**: Navega e instala herramientas con un solo comando

## Uso Básico

### Navegar por el Hub

```bash
# Listar todas las herramientas disponibles
openclaw hub list

# Buscar herramientas específicas
openclaw hub search browser

# Ver detalles de una herramienta
openclaw hub show playwright-browser
```

### Instalar Herramientas

```bash
# Instalar una herramienta desde ClawHub
openclaw hub install playwright-browser

# Instalar una versión específica
openclaw hub install playwright-browser@2.0.0

# Instalar múltiples herramientas
openclaw hub install playwright-browser firecrawl-scraper
```

### Actualizar Herramientas

```bash
# Actualizar todas las herramientas instaladas
openclaw hub update

# Actualizar una herramienta específica
openclaw hub update playwright-browser

# Verificar actualizaciones disponibles
openclaw hub outdated
```

## Herramientas Disponibles

### Categorías

Las herramientas de ClawHub están organizadas en categorías:

| Categoría           | Descripción                  | Ejemplos                            |
| ------------------- | ---------------------------- | ----------------------------------- |
| **Browser**         | Automatización del navegador | playwright-browser, puppeteer-tools |
| **Web Scraping**    | Extracción de datos web      | firecrawl-scraper, beautiful-soup   |
| **APIs**            | Integraciones de APIs        | github-api, slack-api               |
| **Data Processing** | Procesamiento de datos       | csv-parser, json-tools              |
| **AI/ML**           | Herramientas de IA/ML        | openai-tools, huggingface           |
| **DevOps**          | Herramientas de DevOps       | docker-tools, kubernetes            |
| **Communication**   | Mensajería y notificaciones  | email-sender, sms-tools             |

### Herramientas Populares

#### Playwright Browser

Automatización del navegador con todas las funciones usando Playwright.

```bash
openclaw hub install playwright-browser
```

**Características**:

- Control de múltiples navegadores (Chrome, Firefox, Safari)
- Modo headless y modo con cabeza
- Capturas de pantalla y grabación de video
- Manejo de red y cookies

#### Firecrawl Scraper

Extracción avanzada de datos web y scraping.

```bash
openclaw hub install firecrawl-scraper
```

**Características**:

- Scraping inteligente de páginas
- Extracción automática de esquema
- Manejo de JavaScript
- Manejo de límites de tasa

#### GitHub API

Herramientas de integración de GitHub.

```bash
openclaw hub install github-api
```

**Características**:

- Gestión de repositorios
- Gestión de problemas y PRs
- Integración de GitHub Actions
- Análisis de código

## Publicación en ClawHub

### Requisitos

Para publicar una herramienta en ClawHub, debe:

1. Seguir el [formato de herramienta estándar de OpenClaw](/es-ES/tools/plugin)
2. Incluir documentación completa
3. Tener pruebas de cobertura >80%
4. Seguir las mejores prácticas de seguridad
5. Proporcionar ejemplos de uso

### Proceso de Publicación

1. **Crear tu herramienta**:

   ```bash
   openclaw create-tool mi-herramienta-increible
   cd mi-herramienta-increible
   ```

2. **Desarrollar y probar**:

   ```typescript
   // src/index.ts
   export default {
     name: "mi-herramienta-increible",
     description: "Hace algo increíble",
     version: "1.0.0",

     async execute(params) {
       // Tu lógica de herramienta aquí
       return { success: true };
     },
   };
   ```

3. **Agregar documentación**:

   ```markdown
   # Mi Herramienta Increíble

   ## Descripción

   Esta herramienta hace algo increíble...

   ## Uso

   ...

   ## Ejemplos

   ...
   ```

4. **Publicar en ClawHub**:

   ```bash
   # Iniciar sesión en ClawHub
   openclaw hub login

   # Publicar tu herramienta
   openclaw hub publish
   ```

### Mejores Prácticas

#### Versionado

Sigue [Versionado Semántico](https://semver.org/):

- **MAJOR**: Cambios incompatibles en la API
- **MINOR**: Funcionalidad nueva compatible hacia atrás
- **PATCH**: Correcciones de errores compatibles hacia atrás

```bash
# Actualizar versión
openclaw hub version patch  # 1.0.0 → 1.0.1
openclaw hub version minor  # 1.0.1 → 1.1.0
openclaw hub version major  # 1.1.0 → 2.0.0
```

#### Documentación

Proporciona documentación clara y completa:

```markdown
# Tu Herramienta

## Instalación

\`\`\`bash
openclaw hub install tu-herramienta
\`\`\`

## Inicio Rápido

[Ejemplo mínimo funcional]

## Referencia de la API

[Parámetros detallados y valores de retorno]

## Ejemplos

[Casos de uso del mundo real]

## Solución de Problemas

[Problemas comunes y soluciones]
```

#### Pruebas

Asegura una cobertura de pruebas completa:

```typescript
// tests/index.test.ts
import { describe, it, expect } from "vitest";
import myTool from "../src";

describe("Mi Herramienta", () => {
  it("debería hacer algo increíble", async () => {
    const result = await myTool.execute({ input: "test" });
    expect(result.success).toBe(true);
  });

  it("debería manejar errores correctamente", async () => {
    await expect(myTool.execute({ invalid: "params" })).rejects.toThrow();
  });
});
```

#### Seguridad

Sigue las mejores prácticas de seguridad:

- Valida todas las entradas
- Sanitiza las salidas
- Maneja secretos de forma segura
- Audita dependencias regularmente

```typescript
// Validación de entrada
import { z } from "zod";

const paramsSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1),
});

export async function execute(params: unknown) {
  // Validar entradas
  const validated = paramsSchema.parse(params);

  // Usar entradas validadas
  return await processData(validated);
}
```

## Gestión de ClawHub

### Para Mantenedores

Si mantienes una herramienta en ClawHub:

#### Actualizar tu Herramienta

```bash
# Hacer cambios
git commit -am "fix: corregir el manejo de errores"

# Actualizar versión
openclaw hub version patch

# Publicar actualización
openclaw hub publish
```

#### Obsoletizar Versiones

```bash
# Marcar una versión como obsoleta
openclaw hub deprecate tu-herramienta@1.0.0 "Usar 2.0.0 en su lugar"
```

#### Transferir Propiedad

```bash
# Transferir propiedad de la herramienta
openclaw hub transfer tu-herramienta nuevo-propietario
```

### Para Usuarios

#### Reportar Problemas

Si encuentras un problema con una herramienta:

```bash
# Obtener información de la herramienta
openclaw hub show nombre-herramienta

# Reportar en el repositorio de la herramienta
# (URL del repositorio se muestra en la información de la herramienta)
```

#### Solicitar Funciones

- Abre un issue en el repositorio de la herramienta
- Describe claramente el caso de uso
- Proporciona ejemplos si es posible

## Política de ClawHub

### Directrices de Revisión

Todas las herramientas enviadas son revisadas por:

1. **Seguridad**: Sin código malicioso o vulnerabilidades
2. **Calidad**: Código limpio, bien probado, documentado
3. **Funcionalidad**: Funciona como se anuncia
4. **Singularidad**: Proporciona valor no disponible en herramientas existentes
5. **Mantenimiento**: Mantenedor comprometido con soporte continuo

### Proceso de Remoción

Las herramientas pueden ser removidas de ClawHub si:

- Contienen vulnerabilidades de seguridad
- No se mantienen (sin actualizaciones por >6 meses)
- Violan términos de servicio
- Son reportadas como maliciosas

### Código de Conducta

Todos los contribuyentes deben seguir el [Código de Conducta de OpenClaw](https://github.com/openclaw/openclaw/blob/main/CODE_OF_CONDUCT.md).

## Soporte

¿Necesitas ayuda con ClawHub?

- **Documentación**: [docs.openclaw.ai/es-ES/tools/clawhub](https://docs.openclaw.ai/es-ES/tools/clawhub)
- **Comunidad**: [discord.gg/openclaw](https://discord.gg/openclaw)
- **Issues**: [github.com/openclaw/clawhub/issues](https://github.com/openclaw/clawhub/issues)
