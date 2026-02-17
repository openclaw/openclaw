---
title: Ejemplos de Configuración
summary: Ejemplos de configuración del Gateway para casos de uso comunes
---

Esta página proporciona ejemplos de configuración completos para casos de uso comunes del Gateway. Cada ejemplo incluye explicaciones de decisiones clave de configuración.

## Configuración Básica de Gateway Remoto

Un gateway remoto simple accesible desde cualquier lugar:

```json5
{
  gateway: {
    mode: "remote",
    bind: "0.0.0.0",
    port: 18789,
    allowedAgents: ["agent-123"],
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
}
```

**Notas clave:**
- `mode: "remote"` permite conexiones de agentes remotos
- `bind: "0.0.0.0"` escucha en todas las interfaces de red
- `allowedAgents` restringe qué agentes pueden conectarse
- Las variables de entorno mantienen los tokens seguros

## Gateway Local con Múltiples Canales

Un gateway local que ejecuta tanto Telegram como Discord:

```json5
{
  gateway: {
    mode: "local",
    bind: "127.0.0.1",
    port: 18789,
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      allowedUserIds: [123456789, 987654321],
    },
    discord: {
      enabled: true,
      botToken: process.env.DISCORD_BOT_TOKEN,
      allowedUserIds: ["987654321098765432"],
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "Eres un asistente útil para tareas de ingeniería de software.",
  },
}
```

**Notas clave:**
- `mode: "local"` significa que el agente se ejecuta en la misma máquina
- `bind: "127.0.0.1"` restringe las conexiones a localhost solamente
- Cada canal tiene su propia lista `allowedUserIds`
- El `systemPrompt` personaliza el comportamiento del agente

## Gateway con Modelo Local (Ollama)

Usando un modelo local a través de Ollama:

```json5
{
  gateway: {
    mode: "local",
    bind: "127.0.0.1",
    port: 18789,
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
  },
  agent: {
    provider: "ollama",
    model: "llama3.1:70b",
    baseURL: "http://localhost:11434",
  },
  features: {
    thinkingBudget: "low", // Los modelos locales pueden necesitar presupuestos más bajos
  },
}
```

**Notas clave:**
- `provider: "ollama"` usa Ollama para modelos locales
- `baseURL` apunta a tu instancia de Ollama
- `thinkingBudget: "low"` ayuda a gestionar el rendimiento del modelo local

## Gateway de Alta Seguridad

Configuración con seguridad maximizada:

```json5
{
  gateway: {
    mode: "remote",
    bind: "127.0.0.1", // Solo conexiones locales
    port: 18789,
    allowedAgents: ["agent-abc123"],
    auth: {
      type: "bearer",
      token: process.env.GATEWAY_AUTH_TOKEN,
    },
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      allowedUserIds: [123456789], // Solo un usuario
      requireApproval: true, // Requiere aprobación para comandos
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
  sandbox: {
    mode: "strict",
    allowedCommands: ["git", "npm", "node"], // Comandos en lista blanca
    blockedPaths: ["/etc", "/var", "/usr"], // Rutas protegidas
  },
  features: {
    autoApprove: false, // Desactivar auto-aprobación
    elevatedMode: false, // Desactivar modo elevado
  },
}
```

**Notas clave:**
- `bind: "127.0.0.1"` con `mode: "remote"` requiere túnel (por ejemplo, Tailscale)
- Autenticación de portador añade capa adicional de seguridad
- `requireApproval: true` requiere confirmación del usuario
- `sandbox.mode: "strict"` con comandos en lista blanca limita la ejecución
- Todos los permisos elevados desactivados

## Gateway Multi-Agente

Soportando múltiples agentes con diferentes configuraciones:

```json5
{
  gateway: {
    mode: "remote",
    bind: "0.0.0.0",
    port: 18789,
    allowedAgents: ["agent-work", "agent-personal"],
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
    discord: {
      enabled: true,
      botToken: process.env.DISCORD_BOT_TOKEN,
    },
  },
  agents: {
    "agent-work": {
      provider: "anthropic",
      model: "claude-sonnet-4",
      systemPrompt: "Eres un asistente de productividad profesional.",
      features: {
        thinkingBudget: "high",
      },
    },
    "agent-personal": {
      provider: "anthropic",
      model: "claude-sonnet-4",
      systemPrompt: "Eres un asistente personal amigable.",
      features: {
        thinkingBudget: "medium",
      },
    },
  },
  routing: {
    defaultAgent: "agent-work",
    rules: [
      {
        channel: "telegram",
        userId: "123456789",
        agent: "agent-personal",
      },
    ],
  },
}
```

**Notas clave:**
- `agents` objeto define múltiples configuraciones de agentes
- `routing.rules` dirige usuarios/canales específicos a agentes específicos
- `routing.defaultAgent` proporciona fallback
- Cada agente puede tener su propio `systemPrompt` y características

## Gateway con Tailscale

Acceso seguro remoto a través de Tailscale:

```json5
{
  gateway: {
    mode: "remote",
    bind: "100.64.0.1", // Tu IP de Tailscale
    port: 18789,
    allowedAgents: ["agent-mobile"],
  },
  tailscale: {
    enabled: true,
    hostname: "openclaw-gateway",
    authKey: process.env.TAILSCALE_AUTH_KEY,
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
}
```

**Notas clave:**
- `bind` establece a tu IP de Tailscale
- `tailscale.enabled: true` habilita la integración de Tailscale
- Proporciona acceso remoto seguro sin exponer puertos públicos
- `hostname` establece nombre de Tailscale para fácil conexión

## Gateway con Proxy Confiable

Gateway detrás de un proxy inverso:

```json5
{
  gateway: {
    mode: "remote",
    bind: "127.0.0.1",
    port: 18789,
    trustedProxy: {
      enabled: true,
      ips: ["10.0.0.1"], // IP del proxy
      headers: ["X-Real-IP", "X-Forwarded-For"],
    },
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
}
```

**Notas clave:**
- `trustedProxy.enabled: true` confía en encabezados de proxy
- `trustedProxy.ips` lista IPs de proxy de confianza
- `trustedProxy.headers` especifica qué encabezados confiar
- Gateway vincula a localhost, proxy maneja acceso externo

## Gateway de Desarrollo

Configuración optimizada para desarrollo:

```json5
{
  gateway: {
    mode: "local",
    bind: "127.0.0.1",
    port: 18789,
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN_DEV,
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
    systemPrompt: "Eres un asistente de desarrollo. Proporciona explicaciones detalladas.",
  },
  features: {
    thinkingBudget: "high",
    autoApprove: true, // Desarrollo rápido
    elevatedMode: true, // Pruebas completas
  },
  logging: {
    level: "debug", // Logging verboso
    console: true,
    file: {
      enabled: true,
      path: "./logs/gateway-dev.log",
    },
  },
  sandbox: {
    mode: "permissive", // Menos restricciones
  },
}
```

**Notas clave:**
- `logging.level: "debug"` para salida verbosa
- `autoApprove: true` acelera pruebas
- `sandbox.mode: "permissive"` permite más experimentación
- Usa token de bot de desarrollo separado
- Logging de archivo para depuración

## Gateway de Producción

Configuración robusta lista para producción:

```json5
{
  gateway: {
    mode: "remote",
    bind: "0.0.0.0",
    port: 18789,
    allowedAgents: ["agent-prod"],
    auth: {
      type: "bearer",
      token: process.env.GATEWAY_AUTH_TOKEN,
    },
    healthCheck: {
      enabled: true,
      path: "/health",
      interval: 30000,
    },
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      allowedUserIds: process.env.TELEGRAM_ALLOWED_USERS?.split(",").map(Number),
      requireApproval: true,
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
    maxTokens: 4096,
    timeout: 300000, // 5 minutos
  },
  features: {
    thinkingBudget: "medium",
    autoApprove: false,
    elevatedMode: false,
  },
  sandbox: {
    mode: "strict",
    allowedCommands: ["git", "npm", "node", "python3"],
  },
  logging: {
    level: "info",
    console: false, // Sin logging de consola en producción
    file: {
      enabled: true,
      path: "/var/log/openclaw/gateway.log",
      maxSize: "10m",
      maxFiles: 10,
    },
    sentry: {
      enabled: true,
      dsn: process.env.SENTRY_DSN,
      environment: "production",
    },
  },
  monitoring: {
    prometheus: {
      enabled: true,
      port: 9090,
      path: "/metrics",
    },
  },
}
```

**Notas clave:**
- `healthCheck` permite monitoreo
- `logging.file` con rotación para gestión de logs
- `logging.sentry` para rastreo de errores
- `monitoring.prometheus` para métricas
- Todas las características de seguridad habilitadas
- Configuración desde variables de entorno para secretos
- Timeouts de producción y límites de tokens

## Gateway con Múltiples Proveedores

Usando diferentes proveedores de IA para diferentes propósitos:

```json5
{
  gateway: {
    mode: "local",
    bind: "127.0.0.1",
    port: 18789,
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
  },
  agents: {
    "agent-main": {
      provider: "anthropic",
      model: "claude-sonnet-4",
      systemPrompt: "Asistente de propósito general.",
    },
    "agent-code": {
      provider: "openai",
      model: "gpt-4",
      systemPrompt: "Asistente de codificación especializado.",
      baseURL: "https://api.openai.com/v1",
    },
    "agent-local": {
      provider: "ollama",
      model: "llama3.1:70b",
      baseURL: "http://localhost:11434",
      systemPrompt: "Modelo local para tareas rápidas.",
    },
  },
  routing: {
    defaultAgent: "agent-main",
    rules: [
      {
        pattern: "^/code",
        agent: "agent-code",
      },
      {
        pattern: "^/local",
        agent: "agent-local",
      },
    ],
  },
}
```

**Notas clave:**
- Múltiples agentes con diferentes proveedores
- `routing.rules` usa patrones para dirigir a agentes específicos
- Cada proveedor puede tener su propia `baseURL`
- Permite especializados según la tarea

## Gateway con Habilidades Personalizadas

Gateway con habilidades/extensiones personalizadas:

```json5
{
  gateway: {
    mode: "local",
    bind: "127.0.0.1",
    port: 18789,
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
  skills: {
    enabled: true,
    paths: [
      "./skills/custom-tool.js",
      "./skills/database-query.js",
      "./skills/api-integration.js",
    ],
    config: {
      "database-query": {
        host: process.env.DB_HOST,
        port: 5432,
        database: process.env.DB_NAME,
      },
      "api-integration": {
        apiKey: process.env.API_KEY,
        baseUrl: "https://api.example.com",
      },
    },
  },
}
```

**Notas clave:**
- `skills.enabled: true` activa sistema de habilidades
- `skills.paths` lista archivos de habilidades personalizadas
- `skills.config` proporciona configuración por habilidad
- Las habilidades pueden acceder a servicios externos

## Gateway con Rate Limiting

Implementando límites de tasa:

```json5
{
  gateway: {
    mode: "remote",
    bind: "0.0.0.0",
    port: 18789,
    rateLimit: {
      enabled: true,
      windowMs: 900000, // 15 minutos
      maxRequests: 100,
      keyGenerator: "ip", // Limitar por IP
    },
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      rateLimit: {
        enabled: true,
        maxMessages: 10,
        windowMs: 60000, // 10 mensajes por minuto
      },
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
}
```

**Notas clave:**
- `gateway.rateLimit` establece límites globales
- `channels.telegram.rateLimit` establece límites por canal
- `windowMs` define ventana de tiempo en milisegundos
- `keyGenerator` determina cómo agrupar solicitudes

## Gateway con Respuestas en Caché

Mejorando rendimiento con caché:

```json5
{
  gateway: {
    mode: "local",
    bind: "127.0.0.1",
    port: 18789,
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
  cache: {
    enabled: true,
    type: "redis",
    config: {
      host: "localhost",
      port: 6379,
      ttl: 3600, // 1 hora
    },
    strategy: {
      cacheKey: "content", // Cachear por contenido del mensaje
      invalidateOn: ["config-change", "model-change"],
    },
  },
}
```

**Notas clave:**
- `cache.enabled: true` activa caché de respuestas
- `cache.type: "redis"` usa Redis para almacenamiento
- `cache.config.ttl` establece tiempo de expiración de caché
- `cache.strategy` controla comportamiento de caché

## Gateway con Webhook de Discord

Usando webhooks en lugar de bots:

```json5
{
  gateway: {
    mode: "local",
    bind: "127.0.0.1",
    port: 18789,
  },
  channels: {
    discord: {
      enabled: true,
      mode: "webhook",
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      webhookId: process.env.DISCORD_WEBHOOK_ID,
      webhookToken: process.env.DISCORD_WEBHOOK_TOKEN,
    },
  },
  agent: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
}
```

**Notas clave:**
- `mode: "webhook"` usa webhooks de Discord en lugar de bot
- Requiere `webhookUrl`, `webhookId`, y `webhookToken`
- Más simple que configuración completa de bot
- Limitado a enviar mensajes (sin eventos de recepción)

## Mejores Prácticas para Todos los Entornos

### Gestión de Variables de Entorno

Usa siempre variables de entorno para secretos:

```json5
{
  channels: {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN, // ✓ Correcto
      // botToken: "123456:ABC-DEF...", // ✗ Nunca hardcodear
    },
  },
}
```

### Configuración Estructurada

Organiza configuraciones complejas en secciones lógicas:

```json5
{
  // Configuración de Gateway
  gateway: { /* ... */ },
  
  // Configuración de Canales
  channels: { /* ... */ },
  
  // Configuración de Agente
  agent: { /* ... */ },
  
  // Características y Comportamiento
  features: { /* ... */ },
  
  // Seguridad
  sandbox: { /* ... */ },
  
  // Observabilidad
  logging: { /* ... */ },
  monitoring: { /* ... */ },
}
```

### Configuración Específica de Entorno

Usa diferentes archivos de configuración para diferentes entornos:

```bash
# Desarrollo
openclaw gateway run --config config.dev.json5

# Staging
openclaw gateway run --config config.staging.json5

# Producción
openclaw gateway run --config config.prod.json5
```

### Documentación de Configuración

Agrega comentarios en JSON5 para explicar decisiones:

```json5
{
  gateway: {
    // Modo remoto permite conectar desde móvil
    mode: "remote",
    
    // Vincular a Tailscale IP para acceso seguro
    bind: "100.64.0.1",
    
    // Puerto estándar del gateway
    port: 18789,
  },
}
```

## Recursos Adicionales

- [Referencia de Configuración](/es-ES/gateway/configuration-reference) - Documentación completa de campos
- [Configuración del Gateway](/es-ES/gateway/configuration) - Guía de configuración
- [Solución de Problemas](/es-ES/gateway/troubleshooting) - Problemas comunes y soluciones
- [Seguridad](/es-ES/gateway/authentication) - Mejores prácticas de seguridad
