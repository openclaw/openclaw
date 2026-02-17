---
title: "Referencia de Configuración del Gateway"
description: "Referencia completa campo por campo para la configuración del gateway de OpenClaw"
---

Esta página documenta cada campo de configuración disponible para el gateway de OpenClaw. Para obtener una visión general conceptual y patrones de configuración comunes, consulta [Configuración del Gateway](/es-ES/gateway/configuration).

## Estructura de Configuración

La configuración del gateway de OpenClaw es un objeto JSON con campos de nivel superior que controlan varios aspectos del comportamiento del gateway. Aquí está la estructura completa con valores predeterminados:

```json
{
  "gateway": {
    "mode": "remote",
    "bind": "loopback",
    "port": 18789,
    "hostname": null,
    "baseUrl": null,
    "enableBonjour": true,
    "bonjourName": null,
    "logLevel": "info",
    "logFormat": "pretty",
    "logFile": null,
    "enableHealthEndpoint": true,
    "healthEndpointPath": "/_health",
    "enableHeartbeat": true,
    "heartbeatInterval": 30,
    "modelProvider": "openai",
    "model": null,
    "temperature": null,
    "maxTokens": null,
    "systemPrompt": null,
    "allowedChannels": ["*"],
    "blockedChannels": [],
    "allowedOrigins": ["*"],
    "enableCors": true,
    "corsMaxAge": 86400,
    "enableRateLimit": false,
    "rateLimitWindowMs": 60000,
    "rateLimitMax": 100,
    "trustedProxies": [],
    "enableTrustedProxyAuth": false,
    "trustedProxyAuthHeader": "X-Forwarded-User",
    "enableSandbox": true,
    "sandboxPolicy": "default",
    "toolPolicy": "default",
    "elevatedTools": [],
    "enableLocalModels": false,
    "localModelsDir": null,
    "localModelsPort": 11435,
    "enableOpenAIHttpApi": false,
    "openAIHttpApiPath": "/v1",
    "enableOpenResponsesHttpApi": false,
    "openResponsesHttpApiPath": "/openresponses/v1",
    "enableToolsInvokeHttpApi": false,
    "toolsInvokeHttpApiPath": "/tools/invoke",
    "enablePairing": true,
    "pairingCodes": [],
    "pairingCodeLength": 6,
    "pairingCodeExpiry": 300,
    "enableDiscovery": true,
    "discoveryInterval": 60,
    "enableGatewayLock": true,
    "gatewayLockFile": null,
    "enableBackgroundProcess": false,
    "backgroundProcessInterval": 60,
    "enableTailscale": false,
    "tailscaleHostname": null,
    "tailscaleAuthKey": null,
    "enableAuthentication": false,
    "authenticationMethod": "bearer",
    "bearerToken": null,
    "basicAuthUsername": null,
    "basicAuthPassword": null,
    "enableLogging": true,
    "enableMetrics": false,
    "metricsPort": 9090,
    "metricsPath": "/metrics",
    "enableTracing": false,
    "tracingEndpoint": null,
    "tracingServiceName": "openclaw-gateway",
    "enableProfiling": false,
    "profilingPort": 6060,
    "profilingPath": "/debug/pprof",
    "enableGracefulShutdown": true,
    "gracefulShutdownTimeout": 30,
    "enablePidFile": false,
    "pidFile": null,
    "enableSignalHandling": true,
    "enableVersionCheck": true,
    "versionCheckInterval": 86400,
    "enableUpdateCheck": true,
    "updateCheckInterval": 86400,
    "enableTelemetry": true,
    "telemetryEndpoint": null,
    "telemetryInterval": 3600,
    "enableCrashReporting": true,
    "crashReportingEndpoint": null,
    "enableErrorReporting": true,
    "errorReportingEndpoint": null,
    "enablePerformanceMonitoring": false,
    "performanceMonitoringInterval": 60,
    "enableResourceMonitoring": false,
    "resourceMonitoringInterval": 60,
    "enableDebugEndpoints": false,
    "debugEndpointsPath": "/_debug",
    "enableAdminEndpoints": false,
    "adminEndpointsPath": "/_admin",
    "adminAuthToken": null,
    "enableStatusEndpoint": true,
    "statusEndpointPath": "/_status",
    "enableConfigEndpoint": false,
    "configEndpointPath": "/_config",
    "enableRoutesEndpoint": false,
    "routesEndpointPath": "/_routes",
    "enablePlugins": true,
    "pluginsDir": null,
    "plugins": [],
    "enableExtensions": true,
    "extensionsDir": null,
    "extensions": [],
    "enableHooks": true,
    "hooks": {},
    "enableMiddleware": true,
    "middleware": [],
    "enableInterceptors": true,
    "interceptors": [],
    "enableFilters": true,
    "filters": [],
    "enableTransformers": true,
    "transformers": [],
    "enableValidators": true,
    "validators": [],
    "enableSerializers": true,
    "serializers": [],
    "enableDeserializers": true,
    "deserializers": [],
    "enableEncoders": true,
    "encoders": [],
    "enableDecoders": true,
    "decoders": [],
    "enableCompression": true,
    "compressionLevel": 6,
    "compressionThreshold": 1024,
    "enableCaching": false,
    "cacheTtl": 300,
    "cacheMaxSize": 100,
    "enableRetry": true,
    "retryAttempts": 3,
    "retryDelay": 1000,
    "retryBackoff": "exponential",
    "enableTimeout": true,
    "timeoutMs": 30000,
    "enableCircuitBreaker": false,
    "circuitBreakerThreshold": 5,
    "circuitBreakerTimeout": 60000,
    "enableBulkhead": false,
    "bulkheadMaxConcurrent": 10,
    "bulkheadMaxQueue": 10,
    "enableLoadBalancing": false,
    "loadBalancingStrategy": "round-robin",
    "loadBalancingTargets": [],
    "enableFailover": false,
    "failoverTargets": [],
    "enableHealthCheck": true,
    "healthCheckInterval": 30,
    "healthCheckTimeout": 5000,
    "healthCheckPath": "/_health",
    "enableReadinessCheck": true,
    "readinessCheckPath": "/_ready",
    "enableLivenessCheck": true,
    "livenessCheckPath": "/_live",
    "enableStartupCheck": true,
    "startupCheckPath": "/_startup",
    "enableShutdownHook": true,
    "shutdownHookTimeout": 30,
    "enableCleanup": true,
    "cleanupTimeout": 30,
    "enableWatchdog": false,
    "watchdogInterval": 60,
    "watchdogTimeout": 120,
    "enableAutoRestart": false,
    "autoRestartDelay": 5000,
    "autoRestartMaxAttempts": 3,
    "enableAutoUpdate": false,
    "autoUpdateChannel": "stable",
    "autoUpdateCheckInterval": 86400,
    "enableBackup": false,
    "backupInterval": 86400,
    "backupDir": null,
    "backupRetention": 7,
    "enableRestore": false,
    "restoreDir": null,
    "enableSync": false,
    "syncInterval": 300,
    "syncEndpoint": null,
    "enableReplication": false,
    "replicationTargets": [],
    "replicationInterval": 60,
    "enableClustering": false,
    "clusterNodes": [],
    "clusterPort": 18790,
    "enableDistributedLock": false,
    "distributedLockBackend": "redis",
    "distributedLockConfig": {},
    "enableQueue": false,
    "queueBackend": "memory",
    "queueConfig": {},
    "enableCache": false,
    "cacheBackend": "memory",
    "cacheConfig": {},
    "enableStorage": false,
    "storageBackend": "fs",
    "storageConfig": {},
    "enableDatabase": false,
    "databaseBackend": "sqlite",
    "databaseConfig": {},
    "enableSearch": false,
    "searchBackend": "memory",
    "searchConfig": {},
    "enableNotifications": false,
    "notificationsBackend": "webhook",
    "notificationsConfig": {},
    "enableWebhooks": false,
    "webhooksEndpoint": null,
    "webhooksSecret": null,
    "enableWebsocket": false,
    "websocketPath": "/ws",
    "websocketPingInterval": 30,
    "enableSse": false,
    "ssePath": "/events",
    "enableGraphql": false,
    "graphqlPath": "/graphql",
    "enableRest": true,
    "restPath": "/api",
    "enableGrpc": false,
    "grpcPort": 50051,
    "enableThrift": false,
    "thriftPort": 9090,
    "enableMessagePack": false,
    "enableProtobuf": false,
    "enableAvro": false,
    "enableJson": true,
    "enableXml": false,
    "enableYaml": false,
    "enableToml": false,
    "enableCsv": false,
    "enableHtml": false,
    "enableMarkdown": false,
    "enablePlainText": true
  }
}
```

<Note>
Esta es una referencia completa. La mayoría de las instalaciones solo necesitan configurar unos pocos campos clave. Consulta [Ejemplos de Configuración](/es-ES/gateway/configuration-examples) para patrones comunes.
</Note>

## Campos de Nivel Superior

### `gateway`

**Tipo**: `object`  
**Requerido**: Sí  
**Predeterminado**: `{}`

El objeto raíz que contiene toda la configuración del gateway. Todos los demás campos están anidados dentro de este objeto.

## Configuración del Servidor

### `gateway.mode`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"remote"`  
**Valores permitidos**: `"remote"`, `"local"`

Controla el modo operativo del gateway:

- `"remote"`: El gateway acepta conexiones de clientes remotos (típico para servidores)
- `"local"`: El gateway solo acepta conexiones locales (para uso de escritorio/desarrollo)

```json
{
  "gateway": {
    "mode": "remote"
  }
}
```

<Tip>
Usa `"local"` para desarrollo o cuando ejecutes el gateway en tu máquina local. Usa `"remote"` para despliegues en producción donde los clientes necesitan conectarse de forma remota.
</Tip>

### `gateway.bind`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"loopback"`  
**Valores permitidos**: `"loopback"`, `"all"`, dirección IP específica

Controla qué interfaz de red escucha el gateway:

- `"loopback"`: Solo escucha en localhost (127.0.0.1)
- `"all"`: Escucha en todas las interfaces de red (0.0.0.0)
- Dirección IP específica: Escucha en una interfaz específica

```json
{
  "gateway": {
    "bind": "all"
  }
}
```

<Warning>
Usar `"all"` expone el gateway a todas las interfaces de red. Asegúrate de tener autenticación y firewalls apropiados en su lugar.
</Warning>

### `gateway.port`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `18789`

El número de puerto en el que el gateway escuchará las conexiones entrantes.

```json
{
  "gateway": {
    "port": 18789
  }
}
```

<Note>
Asegúrate de que el puerto esté disponible y no esté bloqueado por un firewall. Puedes verificar si un puerto está en uso con `netstat` o `lsof`.
</Note>

### `gateway.hostname`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

El nombre de host en el que el gateway está accesible. Si es `null`, el gateway intentará detectar el nombre de host automáticamente.

```json
{
  "gateway": {
    "hostname": "gateway.example.com"
  }
}
```

### `gateway.baseUrl`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

La URL base en la que el gateway está accesible. Se usa para generar URLs en respuestas y webhooks. Si es `null`, el gateway construirá la URL base a partir de `hostname` y `port`.

```json
{
  "gateway": {
    "baseUrl": "https://gateway.example.com"
  }
}
```

<Tip>
Establece esto cuando uses un proxy inverso o balanceador de carga frente al gateway para asegurar que las URLs generadas sean correctas.
</Tip>

## Configuración de Bonjour/mDNS

### `gateway.enableBonjour`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el descubrimiento Bonjour/mDNS para el gateway, permitiendo que los clientes descubran automáticamente el gateway en la red local.

```json
{
  "gateway": {
    "enableBonjour": true
  }
}
```

Para más detalles, consulta [Bonjour](/es-ES/gateway/bonjour).

### `gateway.bonjourName`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

El nombre del servicio Bonjour. Si es `null`, el gateway usará un nombre predeterminado basado en el nombre de host.

```json
{
  "gateway": {
    "bonjourName": "My OpenClaw Gateway"
  }
}
```

## Configuración de Logging

### `gateway.logLevel`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"info"`  
**Valores permitidos**: `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"fatal"`

Controla el nivel de detalle de los logs. Los niveles están ordenados de más a menos detallado:

- `"trace"`: Información de debugging extremadamente detallada
- `"debug"`: Información de debugging detallada
- `"info"`: Mensajes informativos (predeterminado)
- `"warn"`: Mensajes de advertencia
- `"error"`: Mensajes de error
- `"fatal"`: Mensajes de error fatal

```json
{
  "gateway": {
    "logLevel": "debug"
  }
}
```

Para más detalles, consulta [Logging](/es-ES/gateway/logging).

### `gateway.logFormat`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"pretty"`  
**Valores permitidos**: `"pretty"`, `"json"`, `"text"`

Controla el formato de salida de los logs:

- `"pretty"`: Logs legibles por humanos con colores (mejor para desarrollo)
- `"json"`: Logs estructurados en JSON (mejor para producción/análisis)
- `"text"`: Logs de texto plano (para herramientas heredadas)

```json
{
  "gateway": {
    "logFormat": "json"
  }
}
```

### `gateway.logFile`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Ruta a un archivo donde se escribirán los logs. Si es `null`, los logs se escriben solo en stdout.

```json
{
  "gateway": {
    "logFile": "/var/log/openclaw-gateway.log"
  }
}
```

## Configuración de Health Check

### `gateway.enableHealthEndpoint`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el endpoint de health check HTTP que responde con el estado del gateway.

```json
{
  "gateway": {
    "enableHealthEndpoint": true
  }
}
```

Para más detalles, consulta [Health](/es-ES/gateway/health).

### `gateway.healthEndpointPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_health"`

La ruta URL del endpoint de health check.

```json
{
  "gateway": {
    "healthEndpointPath": "/_health"
  }
}
```

## Configuración de Heartbeat

### `gateway.enableHeartbeat`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de heartbeat que periódicamente verifica el estado del gateway y sus dependencias.

```json
{
  "gateway": {
    "enableHeartbeat": true
  }
}
```

Para más detalles, consulta [Heartbeat](/es-ES/gateway/heartbeat).

### `gateway.heartbeatInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `30`

Intervalo en segundos entre verificaciones de heartbeat.

```json
{
  "gateway": {
    "heartbeatInterval": 30
  }
}
```

## Configuración del Proveedor de Modelo

### `gateway.modelProvider`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"openai"`  
**Valores permitidos**: `"openai"`, `"anthropic"`, `"local"`, etc.

El proveedor de modelo de IA a usar para las respuestas del gateway.

```json
{
  "gateway": {
    "modelProvider": "anthropic"
  }
}
```

### `gateway.model`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

El ID específico del modelo a usar. Si es `null`, el gateway usará el modelo predeterminado del proveedor.

```json
{
  "gateway": {
    "model": "gpt-4"
  }
}
```

### `gateway.temperature`

**Tipo**: `number | null`  
**Requerido**: No  
**Predeterminado**: `null`  
**Rango**: `0.0` - `2.0`

Controla la aleatoriedad de las respuestas del modelo. Valores más bajos hacen las respuestas más deterministas, valores más altos las hacen más creativas.

```json
{
  "gateway": {
    "temperature": 0.7
  }
}
```

### `gateway.maxTokens`

**Tipo**: `number | null`  
**Requerido**: No  
**Predeterminado**: `null`

El número máximo de tokens a generar en las respuestas. Si es `null`, usa el máximo del modelo.

```json
{
  "gateway": {
    "maxTokens": 2000
  }
}
```

### `gateway.systemPrompt`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Un prompt del sistema personalizado para anteponer a todas las conversaciones.

```json
{
  "gateway": {
    "systemPrompt": "You are a helpful assistant specialized in technical support."
  }
}
```

## Configuración de Control de Canales

### `gateway.allowedChannels`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `["*"]`

Lista de tipos de canales permitidos para conectarse al gateway. Usa `["*"]` para permitir todos los canales.

```json
{
  "gateway": {
    "allowedChannels": ["telegram", "discord", "slack"]
  }
}
```

### `gateway.blockedChannels`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de tipos de canales bloqueados explícitamente. Tiene prioridad sobre `allowedChannels`.

```json
{
  "gateway": {
    "blockedChannels": ["whatsapp"]
  }
}
```

## Configuración de CORS

### `gateway.allowedOrigins`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `["*"]`

Lista de orígenes permitidos para solicitudes CORS. Usa `["*"]` para permitir todos los orígenes.

```json
{
  "gateway": {
    "allowedOrigins": ["https://app.example.com", "https://admin.example.com"]
  }
}
```

<Warning>
Usar `["*"]` permite cualquier origen, lo cual puede ser un riesgo de seguridad. En producción, especifica solo los orígenes que necesitan acceder al gateway.
</Warning>

### `gateway.enableCors`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el soporte CORS (Cross-Origin Resource Sharing).

```json
{
  "gateway": {
    "enableCors": true
  }
}
```

### `gateway.corsMaxAge`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `86400`

El tiempo máximo en segundos que los resultados de una solicitud preflight pueden ser cacheados.

```json
{
  "gateway": {
    "corsMaxAge": 86400
  }
}
```

## Configuración de Rate Limiting

### `gateway.enableRateLimit`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el rate limiting para las solicitudes al gateway.

```json
{
  "gateway": {
    "enableRateLimit": true
  }
}
```

### `gateway.rateLimitWindowMs`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `60000`

La ventana de tiempo en milisegundos para el rate limiting.

```json
{
  "gateway": {
    "rateLimitWindowMs": 60000
  }
}
```

### `gateway.rateLimitMax`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `100`

El número máximo de solicitudes permitidas por ventana.

```json
{
  "gateway": {
    "rateLimitMax": 100
  }
}
```

## Configuración de Proxy

### `gateway.trustedProxies`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de direcciones IP de proxies confiables. El gateway usará los headers `X-Forwarded-*` de estas IPs.

```json
{
  "gateway": {
    "trustedProxies": ["10.0.0.1", "10.0.0.2"]
  }
}
```

Para más detalles, consulta [Trusted Proxy Auth](/es-ES/gateway/trusted-proxy-auth).

### `gateway.enableTrustedProxyAuth`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la autenticación a través de headers de proxy confiable.

```json
{
  "gateway": {
    "enableTrustedProxyAuth": true
  }
}
```

### `gateway.trustedProxyAuthHeader`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"X-Forwarded-User"`

El nombre del header que contiene la identidad del usuario del proxy confiable.

```json
{
  "gateway": {
    "trustedProxyAuthHeader": "X-Forwarded-User"
  }
}
```

## Configuración de Sandbox y Herramientas

### `gateway.enableSandbox`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sandbox para la ejecución de herramientas, proporcionando aislamiento y restricciones de seguridad.

```json
{
  "gateway": {
    "enableSandbox": true
  }
}
```

Para más detalles, consulta [Sandboxing](/es-ES/gateway/sandboxing).

### `gateway.sandboxPolicy`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"default"`  
**Valores permitidos**: `"default"`, `"strict"`, `"permissive"`, `"custom"`

La política de sandbox a aplicar:

- `"default"`: Restricciones de sandbox estándar
- `"strict"`: Restricciones más estrictas
- `"permissive"`: Restricciones más relajadas
- `"custom"`: Usa una política personalizada

```json
{
  "gateway": {
    "sandboxPolicy": "strict"
  }
}
```

### `gateway.toolPolicy`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"default"`  
**Valores permitidos**: `"default"`, `"strict"`, `"permissive"`, `"custom"`

La política de herramientas que controla qué herramientas pueden ser usadas:

- `"default"`: Herramientas estándar habilitadas
- `"strict"`: Solo herramientas seguras básicas
- `"permissive"`: Todas las herramientas habilitadas
- `"custom"`: Lista personalizada de herramientas

```json
{
  "gateway": {
    "toolPolicy": "strict"
  }
}
```

Para más detalles, consulta [Sandbox vs Tool Policy vs Elevated](/es-ES/gateway/sandbox-vs-tool-policy-vs-elevated).

### `gateway.elevatedTools`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de herramientas que requieren permisos elevados para ejecutarse.

```json
{
  "gateway": {
    "elevatedTools": ["system.exec", "file.delete"]
  }
}
```

## Configuración de Modelos Locales

### `gateway.enableLocalModels`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte para modelos de IA ejecutándose localmente.

```json
{
  "gateway": {
    "enableLocalModels": true
  }
}
```

Para más detalles, consulta [Local Models](/es-ES/gateway/local-models).

### `gateway.localModelsDir`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Directorio donde se almacenan los archivos de modelos locales.

```json
{
  "gateway": {
    "localModelsDir": "/var/lib/openclaw/models"
  }
}
```

### `gateway.localModelsPort`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `11435`

Puerto en el que el servidor de modelos locales escucha.

```json
{
  "gateway": {
    "localModelsPort": 11435
  }
}
```

## Configuración de API HTTP

### `gateway.enableOpenAIHttpApi`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la API HTTP compatible con OpenAI.

```json
{
  "gateway": {
    "enableOpenAIHttpApi": true
  }
}
```

Para más detalles, consulta [OpenAI HTTP API](/es-ES/gateway/openai-http-api).

### `gateway.openAIHttpApiPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/v1"`

Ruta base para los endpoints de la API OpenAI.

```json
{
  "gateway": {
    "openAIHttpApiPath": "/v1"
  }
}
```

### `gateway.enableOpenResponsesHttpApi`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la API HTTP OpenResponses.

```json
{
  "gateway": {
    "enableOpenResponsesHttpApi": true
  }
}
```

Para más detalles, consulta [OpenResponses HTTP API](/es-ES/gateway/openresponses-http-api).

### `gateway.openResponsesHttpApiPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/openresponses/v1"`

Ruta base para los endpoints de la API OpenResponses.

```json
{
  "gateway": {
    "openResponsesHttpApiPath": "/openresponses/v1"
  }
}
```

### `gateway.enableToolsInvokeHttpApi`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la API HTTP de invocación de herramientas.

```json
{
  "gateway": {
    "enableToolsInvokeHttpApi": true
  }
}
```

Para más detalles, consulta [Tools Invoke HTTP API](/es-ES/gateway/tools-invoke-http-api).

### `gateway.toolsInvokeHttpApiPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/tools/invoke"`

Ruta base para los endpoints de la API de invocación de herramientas.

```json
{
  "gateway": {
    "toolsInvokeHttpApiPath": "/tools/invoke"
  }
}
```

## Configuración de Pairing

### `gateway.enablePairing`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de pairing que permite que los clientes se autentiquen usando códigos de corta duración.

```json
{
  "gateway": {
    "enablePairing": true
  }
}
```

Para más detalles, consulta [Pairing](/es-ES/gateway/pairing).

### `gateway.pairingCodes`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de códigos de pairing preconfigurados. Estos no expiran a menos que se eliminen.

```json
{
  "gateway": {
    "pairingCodes": ["ABC123", "XYZ789"]
  }
}
```

### `gateway.pairingCodeLength`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `6`

Longitud de los códigos de pairing generados automáticamente.

```json
{
  "gateway": {
    "pairingCodeLength": 6
  }
}
```

### `gateway.pairingCodeExpiry`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `300`

Tiempo en segundos hasta que expiran los códigos de pairing generados.

```json
{
  "gateway": {
    "pairingCodeExpiry": 300
  }
}
```

## Configuración de Discovery

### `gateway.enableDiscovery`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de descubrimiento que permite que los clientes encuentren automáticamente el gateway.

```json
{
  "gateway": {
    "enableDiscovery": true
  }
}
```

Para más detalles, consulta [Discovery](/es-ES/gateway/discovery).

### `gateway.discoveryInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `60`

Intervalo en segundos entre anuncios de descubrimiento.

```json
{
  "gateway": {
    "discoveryInterval": 60
  }
}
```

## Configuración de Gateway Lock

### `gateway.enableGatewayLock`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de gateway lock que previene que múltiples instancias del gateway se ejecuten simultáneamente.

```json
{
  "gateway": {
    "enableGatewayLock": true
  }
}
```

Para más detalles, consulta [Gateway Lock](/es-ES/gateway/gateway-lock).

### `gateway.gatewayLockFile`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Ruta al archivo de lock. Si es `null`, usa una ubicación predeterminada.

```json
{
  "gateway": {
    "gatewayLockFile": "/var/run/openclaw-gateway.lock"
  }
}
```

## Configuración de Background Process

### `gateway.enableBackgroundProcess`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el modo de proceso en background que permite que el gateway se ejecute como un daemon.

```json
{
  "gateway": {
    "enableBackgroundProcess": true
  }
}
```

Para más detalles, consulta [Background Process](/es-ES/gateway/background-process).

### `gateway.backgroundProcessInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `60`

Intervalo en segundos entre tareas de mantenimiento en background.

```json
{
  "gateway": {
    "backgroundProcessInterval": 60
  }
}
```

## Configuración de Tailscale

### `gateway.enableTailscale`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la integración con Tailscale para networking privado seguro.

```json
{
  "gateway": {
    "enableTailscale": true
  }
}
```

Para más detalles, consulta [Tailscale](/es-ES/gateway/tailscale).

### `gateway.tailscaleHostname`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

El nombre de host Tailscale del gateway.

```json
{
  "gateway": {
    "tailscaleHostname": "gateway.tail12345.ts.net"
  }
}
```

### `gateway.tailscaleAuthKey`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Clave de autenticación de Tailscale para el registro automático.

```json
{
  "gateway": {
    "tailscaleAuthKey": "tskey-auth-xxxxxxxxxxxx"
  }
}
```

<Warning>
Mantén las claves de autenticación de Tailscale seguras. No las comprometas en el control de versiones.
</Warning>

## Configuración de Autenticación

### `gateway.enableAuthentication`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la autenticación para las solicitudes al gateway.

```json
{
  "gateway": {
    "enableAuthentication": true
  }
}
```

Para más detalles, consulta [Authentication](/es-ES/gateway/authentication).

### `gateway.authenticationMethod`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"bearer"`  
**Valores permitidos**: `"bearer"`, `"basic"`, `"custom"`

El método de autenticación a usar:

- `"bearer"`: Autenticación por Bearer token
- `"basic"`: Autenticación HTTP Basic
- `"custom"`: Método de autenticación personalizado

```json
{
  "gateway": {
    "authenticationMethod": "bearer"
  }
}
```

### `gateway.bearerToken`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

El bearer token requerido para la autenticación cuando `authenticationMethod` es `"bearer"`.

```json
{
  "gateway": {
    "bearerToken": "your-secret-token-here"
  }
}
```

<Warning>
Mantén los bearer tokens seguros. Usa variables de entorno o gestión de secretos para valores de producción.
</Warning>

### `gateway.basicAuthUsername`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

El nombre de usuario para la autenticación HTTP Basic.

```json
{
  "gateway": {
    "basicAuthUsername": "admin"
  }
}
```

### `gateway.basicAuthPassword`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

La contraseña para la autenticación HTTP Basic.

```json
{
  "gateway": {
    "basicAuthPassword": "secure-password"
  }
}
```

## Configuración de Monitoring y Observabilidad

### `gateway.enableLogging`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el logging. Generalmente debe dejarse en `true`.

```json
{
  "gateway": {
    "enableLogging": true
  }
}
```

### `gateway.enableMetrics`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la exportación de métricas Prometheus.

```json
{
  "gateway": {
    "enableMetrics": true
  }
}
```

### `gateway.metricsPort`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `9090`

Puerto en el que se exponen las métricas.

```json
{
  "gateway": {
    "metricsPort": 9090
  }
}
```

### `gateway.metricsPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/metrics"`

Ruta URL del endpoint de métricas.

```json
{
  "gateway": {
    "metricsPath": "/metrics"
  }
}
```

### `gateway.enableTracing`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la exportación de traces distribuidos.

```json
{
  "gateway": {
    "enableTracing": true
  }
}
```

### `gateway.tracingEndpoint`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Endpoint donde se envían los traces (por ejemplo, Jaeger o Zipkin).

```json
{
  "gateway": {
    "tracingEndpoint": "http://localhost:14268/api/traces"
  }
}
```

### `gateway.tracingServiceName`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"openclaw-gateway"`

Nombre del servicio usado en los traces.

```json
{
  "gateway": {
    "tracingServiceName": "openclaw-gateway"
  }
}
```

### `gateway.enableProfiling`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita los endpoints de profiling de rendimiento.

```json
{
  "gateway": {
    "enableProfiling": true
  }
}
```

### `gateway.profilingPort`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `6060`

Puerto en el que se exponen los endpoints de profiling.

```json
{
  "gateway": {
    "profilingPort": 6060
  }
}
```

### `gateway.profilingPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/debug/pprof"`

Ruta base para los endpoints de profiling.

```json
{
  "gateway": {
    "profilingPath": "/debug/pprof"
  }
}
```

## Configuración de Lifecycle

### `gateway.enableGracefulShutdown`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el graceful shutdown que espera a que las solicitudes en curso se completen antes de cerrar.

```json
{
  "gateway": {
    "enableGracefulShutdown": true
  }
}
```

### `gateway.gracefulShutdownTimeout`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `30`

Tiempo máximo en segundos a esperar a que las solicitudes se completen durante el shutdown.

```json
{
  "gateway": {
    "gracefulShutdownTimeout": 30
  }
}
```

### `gateway.enablePidFile`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la creación de un archivo PID para el tracking del proceso.

```json
{
  "gateway": {
    "enablePidFile": true
  }
}
```

### `gateway.pidFile`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Ruta al archivo PID. Si es `null`, usa una ubicación predeterminada.

```json
{
  "gateway": {
    "pidFile": "/var/run/openclaw-gateway.pid"
  }
}
```

### `gateway.enableSignalHandling`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el manejo de señales del sistema operativo (SIGTERM, SIGINT, etc.).

```json
{
  "gateway": {
    "enableSignalHandling": true
  }
}
```

## Configuración de Actualización y Telemetría

### `gateway.enableVersionCheck`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita las verificaciones de versión para detectar versiones desactualizadas.

```json
{
  "gateway": {
    "enableVersionCheck": true
  }
}
```

### `gateway.versionCheckInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `86400`

Intervalo en segundos entre verificaciones de versión.

```json
{
  "gateway": {
    "versionCheckInterval": 86400
  }
}
```

### `gateway.enableUpdateCheck`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita las verificaciones de actualizaciones disponibles.

```json
{
  "gateway": {
    "enableUpdateCheck": true
  }
}
```

### `gateway.updateCheckInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `86400`

Intervalo en segundos entre verificaciones de actualización.

```json
{
  "gateway": {
    "updateCheckInterval": 86400
  }
}
```

### `gateway.enableTelemetry`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita la recopilación de telemetría para ayudar a mejorar OpenClaw.

```json
{
  "gateway": {
    "enableTelemetry": false
  }
}
```

<Note>
La telemetría solo recopila datos de uso anónimos. Nunca incluye contenido de mensajes o información personal.
</Note>

### `gateway.telemetryEndpoint`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Endpoint personalizado para el envío de telemetría.

```json
{
  "gateway": {
    "telemetryEndpoint": "https://telemetry.example.com"
  }
}
```

### `gateway.telemetryInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `3600`

Intervalo en segundos entre envíos de telemetría.

```json
{
  "gateway": {
    "telemetryInterval": 3600
  }
}
```

### `gateway.enableCrashReporting`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el reporte automático de crashes.

```json
{
  "gateway": {
    "enableCrashReporting": true
  }
}
```

### `gateway.crashReportingEndpoint`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Endpoint personalizado para los reportes de crash.

```json
{
  "gateway": {
    "crashReportingEndpoint": "https://crashes.example.com"
  }
}
```

### `gateway.enableErrorReporting`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el reporte automático de errores.

```json
{
  "gateway": {
    "enableErrorReporting": true
  }
}
```

### `gateway.errorReportingEndpoint`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Endpoint personalizado para los reportes de error.

```json
{
  "gateway": {
    "errorReportingEndpoint": "https://errors.example.com"
  }
}
```

## Configuración de Resource Monitoring

### `gateway.enablePerformanceMonitoring`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el monitoring de rendimiento detallado.

```json
{
  "gateway": {
    "enablePerformanceMonitoring": true
  }
}
```

### `gateway.performanceMonitoringInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `60`

Intervalo en segundos entre recopilaciones de datos de rendimiento.

```json
{
  "gateway": {
    "performanceMonitoringInterval": 60
  }
}
```

### `gateway.enableResourceMonitoring`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el monitoring del uso de recursos del sistema (CPU, memoria, etc.).

```json
{
  "gateway": {
    "enableResourceMonitoring": true
  }
}
```

### `gateway.resourceMonitoringInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `60`

Intervalo en segundos entre recopilaciones de métricas de recursos.

```json
{
  "gateway": {
    "resourceMonitoringInterval": 60
  }
}
```

## Endpoints de Debug y Admin

### `gateway.enableDebugEndpoints`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita los endpoints de debugging HTTP.

```json
{
  "gateway": {
    "enableDebugEndpoints": true
  }
}
```

<Warning>
Los endpoints de debug exponen información interna del sistema. Solo habilítalos en entornos de desarrollo.
</Warning>

### `gateway.debugEndpointsPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_debug"`

Ruta base para los endpoints de debug.

```json
{
  "gateway": {
    "debugEndpointsPath": "/_debug"
  }
}
```

### `gateway.enableAdminEndpoints`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita los endpoints administrativos HTTP.

```json
{
  "gateway": {
    "enableAdminEndpoints": true
  }
}
```

### `gateway.adminEndpointsPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_admin"`

Ruta base para los endpoints admin.

```json
{
  "gateway": {
    "adminEndpointsPath": "/_admin"
  }
}
```

### `gateway.adminAuthToken`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Bearer token requerido para acceder a los endpoints admin.

```json
{
  "gateway": {
    "adminAuthToken": "your-admin-token"
  }
}
```

## Endpoints de Estado

### `gateway.enableStatusEndpoint`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el endpoint de estado que proporciona información sobre el estado del gateway.

```json
{
  "gateway": {
    "enableStatusEndpoint": true
  }
}
```

### `gateway.statusEndpointPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_status"`

Ruta URL del endpoint de estado.

```json
{
  "gateway": {
    "statusEndpointPath": "/_status"
  }
}
```

### `gateway.enableConfigEndpoint`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el endpoint de configuración que expone la configuración actual.

```json
{
  "gateway": {
    "enableConfigEndpoint": true
  }
}
```

<Warning>
El endpoint de configuración puede exponer información sensible. Solo habilítalo en entornos de desarrollo.
</Warning>

### `gateway.configEndpointPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_config"`

Ruta URL del endpoint de configuración.

```json
{
  "gateway": {
    "configEndpointPath": "/_config"
  }
}
```

### `gateway.enableRoutesEndpoint`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el endpoint de rutas que lista todas las rutas registradas.

```json
{
  "gateway": {
    "enableRoutesEndpoint": true
  }
}
```

### `gateway.routesEndpointPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_routes"`

Ruta URL del endpoint de rutas.

```json
{
  "gateway": {
    "routesEndpointPath": "/_routes"
  }
}
```

## Sistema de Plugins y Extensiones

### `gateway.enablePlugins`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de plugins.

```json
{
  "gateway": {
    "enablePlugins": true
  }
}
```

### `gateway.pluginsDir`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Directorio donde se almacenan los plugins. Si es `null`, usa una ubicación predeterminada.

```json
{
  "gateway": {
    "pluginsDir": "/usr/local/lib/openclaw/plugins"
  }
}
```

### `gateway.plugins`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de plugins a cargar.

```json
{
  "gateway": {
    "plugins": ["plugin-name-1", "plugin-name-2"]
  }
}
```

### `gateway.enableExtensions`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de extensiones.

```json
{
  "gateway": {
    "enableExtensions": true
  }
}
```

### `gateway.extensionsDir`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Directorio donde se almacenan las extensiones.

```json
{
  "gateway": {
    "extensionsDir": "/usr/local/lib/openclaw/extensions"
  }
}
```

### `gateway.extensions`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de extensiones a cargar.

```json
{
  "gateway": {
    "extensions": ["extension-name-1", "extension-name-2"]
  }
}
```

## Sistema de Hooks

### `gateway.enableHooks`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de hooks que permite interceptar y modificar el comportamiento del gateway.

```json
{
  "gateway": {
    "enableHooks": true
  }
}
```

### `gateway.hooks`

**Tipo**: `object`  
**Requerido**: No  
**Predeterminado**: `{}`

Configuración de hooks personalizados. Las claves son nombres de hooks y los valores son funciones o rutas de módulo.

```json
{
  "gateway": {
    "hooks": {
      "beforeRequest": "./hooks/before-request.js",
      "afterResponse": "./hooks/after-response.js"
    }
  }
}
```

## Middleware y Interceptores

### `gateway.enableMiddleware`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de middleware.

```json
{
  "gateway": {
    "enableMiddleware": true
  }
}
```

### `gateway.middleware`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de funciones middleware o rutas de módulo a aplicar.

```json
{
  "gateway": {
    "middleware": ["./middleware/logger.js", "./middleware/auth.js"]
  }
}
```

### `gateway.enableInterceptors`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de interceptores.

```json
{
  "gateway": {
    "enableInterceptors": true
  }
}
```

### `gateway.interceptors`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de funciones interceptoras o rutas de módulo.

```json
{
  "gateway": {
    "interceptors": ["./interceptors/request.js", "./interceptors/response.js"]
  }
}
```

## Filtros y Transformadores

### `gateway.enableFilters`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de filtros.

```json
{
  "gateway": {
    "enableFilters": true
  }
}
```

### `gateway.filters`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de funciones filtro o rutas de módulo.

```json
{
  "gateway": {
    "filters": ["./filters/sanitize.js", "./filters/validate.js"]
  }
}
```

### `gateway.enableTransformers`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de transformadores.

```json
{
  "gateway": {
    "enableTransformers": true
  }
}
```

### `gateway.transformers`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de funciones transformadoras o rutas de módulo.

```json
{
  "gateway": {
    "transformers": ["./transformers/normalize.js", "./transformers/enrich.js"]
  }
}
```

## Validadores

### `gateway.enableValidators`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el sistema de validadores.

```json
{
  "gateway": {
    "enableValidators": true
  }
}
```

### `gateway.validators`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de funciones validadoras o rutas de módulo.

```json
{
  "gateway": {
    "validators": ["./validators/schema.js", "./validators/business-rules.js"]
  }
}
```

## Serialización y Deserialización

### `gateway.enableSerializers`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita los serializers personalizados.

```json
{
  "gateway": {
    "enableSerializers": true
  }
}
```

### `gateway.serializers`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de serializers personalizados.

```json
{
  "gateway": {
    "serializers": ["./serializers/custom.js"]
  }
}
```

### `gateway.enableDeserializers`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita los deserializers personalizados.

```json
{
  "gateway": {
    "enableDeserializers": true
  }
}
```

### `gateway.deserializers`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de deserializers personalizados.

```json
{
  "gateway": {
    "deserializers": ["./deserializers/custom.js"]
  }
}
```

## Codificación y Decodificación

### `gateway.enableEncoders`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita los encoders personalizados.

```json
{
  "gateway": {
    "enableEncoders": true
  }
}
```

### `gateway.encoders`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de encoders personalizados.

```json
{
  "gateway": {
    "encoders": ["./encoders/custom.js"]
  }
}
```

### `gateway.enableDecoders`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita los decoders personalizados.

```json
{
  "gateway": {
    "enableDecoders": true
  }
}
```

### `gateway.decoders`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de decoders personalizados.

```json
{
  "gateway": {
    "decoders": ["./decoders/custom.js"]
  }
}
```

## Compresión

### `gateway.enableCompression`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita la compresión de respuestas HTTP.

```json
{
  "gateway": {
    "enableCompression": true
  }
}
```

### `gateway.compressionLevel`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `6`  
**Rango**: `0` - `9`

Nivel de compresión (0 = sin compresión, 9 = máxima compresión).

```json
{
  "gateway": {
    "compressionLevel": 6
  }
}
```

### `gateway.compressionThreshold`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `1024`

Tamaño mínimo en bytes para activar la compresión.

```json
{
  "gateway": {
    "compressionThreshold": 1024
  }
}
```

## Caching

### `gateway.enableCaching`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el caching de respuestas.

```json
{
  "gateway": {
    "enableCaching": true
  }
}
```

### `gateway.cacheTtl`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `300`

Tiempo de vida del cache en segundos.

```json
{
  "gateway": {
    "cacheTtl": 300
  }
}
```

### `gateway.cacheMaxSize`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `100`

Número máximo de entradas en el cache.

```json
{
  "gateway": {
    "cacheMaxSize": 100
  }
}
```

## Configuración de Retry

### `gateway.enableRetry`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el reintento automático de solicitudes fallidas.

```json
{
  "gateway": {
    "enableRetry": true
  }
}
```

### `gateway.retryAttempts`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `3`

Número de intentos de reintento.

```json
{
  "gateway": {
    "retryAttempts": 3
  }
}
```

### `gateway.retryDelay`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `1000`

Retraso inicial en milisegundos entre reintentos.

```json
{
  "gateway": {
    "retryDelay": 1000
  }
}
```

### `gateway.retryBackoff`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"exponential"`  
**Valores permitidos**: `"exponential"`, `"linear"`, `"constant"`

Estrategia de backoff para reintentos:

- `"exponential"`: El retraso se duplica después de cada intento
- `"linear"`: El retraso aumenta linealmente
- `"constant"`: El retraso permanece constante

```json
{
  "gateway": {
    "retryBackoff": "exponential"
  }
}
```

## Configuración de Timeout

### `gateway.enableTimeout`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita los timeouts de solicitud.

```json
{
  "gateway": {
    "enableTimeout": true
  }
}
```

### `gateway.timeoutMs`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `30000`

Timeout de solicitud en milisegundos.

```json
{
  "gateway": {
    "timeoutMs": 30000
  }
}
```

## Circuit Breaker

### `gateway.enableCircuitBreaker`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el patrón circuit breaker para prevenir llamadas a servicios fallidos.

```json
{
  "gateway": {
    "enableCircuitBreaker": true
  }
}
```

### `gateway.circuitBreakerThreshold`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `5`

Número de fallos antes de abrir el circuit.

```json
{
  "gateway": {
    "circuitBreakerThreshold": 5
  }
}
```

### `gateway.circuitBreakerTimeout`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `60000`

Tiempo en milisegundos antes de intentar cerrar el circuit.

```json
{
  "gateway": {
    "circuitBreakerTimeout": 60000
  }
}
```

## Bulkhead

### `gateway.enableBulkhead`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el patrón bulkhead para limitar la concurrencia.

```json
{
  "gateway": {
    "enableBulkhead": true
  }
}
```

### `gateway.bulkheadMaxConcurrent`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `10`

Número máximo de solicitudes concurrentes.

```json
{
  "gateway": {
    "bulkheadMaxConcurrent": 10
  }
}
```

### `gateway.bulkheadMaxQueue`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `10`

Número máximo de solicitudes en cola cuando se alcanza el límite de concurrencia.

```json
{
  "gateway": {
    "bulkheadMaxQueue": 10
  }
}
```

## Load Balancing

### `gateway.enableLoadBalancing`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el load balancing entre múltiples backends.

```json
{
  "gateway": {
    "enableLoadBalancing": true
  }
}
```

### `gateway.loadBalancingStrategy`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"round-robin"`  
**Valores permitidos**: `"round-robin"`, `"random"`, `"least-connections"`, `"ip-hash"`

Estrategia de load balancing a usar.

```json
{
  "gateway": {
    "loadBalancingStrategy": "round-robin"
  }
}
```

### `gateway.loadBalancingTargets`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de URLs de backend para load balancing.

```json
{
  "gateway": {
    "loadBalancingTargets": [
      "http://backend1.example.com",
      "http://backend2.example.com"
    ]
  }
}
```

## Failover

### `gateway.enableFailover`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el failover automático a backends de respaldo.

```json
{
  "gateway": {
    "enableFailover": true
  }
}
```

### `gateway.failoverTargets`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de URLs de backend de failover, en orden de prioridad.

```json
{
  "gateway": {
    "failoverTargets": [
      "http://backup1.example.com",
      "http://backup2.example.com"
    ]
  }
}
```

## Health Checks

### `gateway.enableHealthCheck`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita los health checks periódicos.

```json
{
  "gateway": {
    "enableHealthCheck": true
  }
}
```

### `gateway.healthCheckInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `30`

Intervalo en segundos entre health checks.

```json
{
  "gateway": {
    "healthCheckInterval": 30
  }
}
```

### `gateway.healthCheckTimeout`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `5000`

Timeout de health check en milisegundos.

```json
{
  "gateway": {
    "healthCheckTimeout": 5000
  }
}
```

### `gateway.healthCheckPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_health"`

Ruta para las solicitudes de health check.

```json
{
  "gateway": {
    "healthCheckPath": "/_health"
  }
}
```

## Readiness y Liveness Checks

### `gateway.enableReadinessCheck`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el endpoint de readiness check (para orquestadores de contenedores).

```json
{
  "gateway": {
    "enableReadinessCheck": true
  }
}
```

### `gateway.readinessCheckPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_ready"`

Ruta del endpoint de readiness check.

```json
{
  "gateway": {
    "readinessCheckPath": "/_ready"
  }
}
```

### `gateway.enableLivenessCheck`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el endpoint de liveness check (para orquestadores de contenedores).

```json
{
  "gateway": {
    "enableLivenessCheck": true
  }
}
```

### `gateway.livenessCheckPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_live"`

Ruta del endpoint de liveness check.

```json
{
  "gateway": {
    "livenessCheckPath": "/_live"
  }
}
```

### `gateway.enableStartupCheck`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el endpoint de startup check (para orquestadores de contenedores).

```json
{
  "gateway": {
    "enableStartupCheck": true
  }
}
```

### `gateway.startupCheckPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/_startup"`

Ruta del endpoint de startup check.

```json
{
  "gateway": {
    "startupCheckPath": "/_startup"
  }
}
```

## Shutdown y Cleanup

### `gateway.enableShutdownHook`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita los hooks de shutdown personalizados.

```json
{
  "gateway": {
    "enableShutdownHook": true
  }
}
```

### `gateway.shutdownHookTimeout`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `30`

Timeout en segundos para los hooks de shutdown.

```json
{
  "gateway": {
    "shutdownHookTimeout": 30
  }
}
```

### `gateway.enableCleanup`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita las tareas de cleanup automáticas durante el shutdown.

```json
{
  "gateway": {
    "enableCleanup": true
  }
}
```

### `gateway.cleanupTimeout`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `30`

Timeout en segundos para las tareas de cleanup.

```json
{
  "gateway": {
    "cleanupTimeout": 30
  }
}
```

## Watchdog y Auto-Restart

### `gateway.enableWatchdog`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el proceso watchdog que monitorea el estado del gateway.

```json
{
  "gateway": {
    "enableWatchdog": true
  }
}
```

### `gateway.watchdogInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `60`

Intervalo en segundos entre verificaciones del watchdog.

```json
{
  "gateway": {
    "watchdogInterval": 60
  }
}
```

### `gateway.watchdogTimeout`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `120`

Timeout en segundos antes de que el watchdog considere el gateway no responsivo.

```json
{
  "gateway": {
    "watchdogTimeout": 120
  }
}
```

### `gateway.enableAutoRestart`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el auto-restart en caso de fallo.

```json
{
  "gateway": {
    "enableAutoRestart": true
  }
}
```

<Warning>
El auto-restart debe usarse con precaución y típicamente solo en entornos de desarrollo o con proper process supervision.
</Warning>

### `gateway.autoRestartDelay`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `5000`

Retraso en milisegundos antes de intentar un auto-restart.

```json
{
  "gateway": {
    "autoRestartDelay": 5000
  }
}
```

### `gateway.autoRestartMaxAttempts`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `3`

Número máximo de intentos de auto-restart.

```json
{
  "gateway": {
    "autoRestartMaxAttempts": 3
  }
}
```

## Auto-Update

### `gateway.enableAutoUpdate`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita las actualizaciones automáticas del gateway.

```json
{
  "gateway": {
    "enableAutoUpdate": true
  }
}
```

<Warning>
Las actualizaciones automáticas pueden causar downtime inesperado. Úsalas con precaución en producción.
</Warning>

### `gateway.autoUpdateChannel`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"stable"`  
**Valores permitidos**: `"stable"`, `"beta"`, `"dev"`

Canal de actualización a seguir.

```json
{
  "gateway": {
    "autoUpdateChannel": "stable"
  }
}
```

### `gateway.autoUpdateCheckInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `86400`

Intervalo en segundos entre verificaciones de actualización.

```json
{
  "gateway": {
    "autoUpdateCheckInterval": 86400
  }
}
```

## Backup y Restore

### `gateway.enableBackup`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita los backups automáticos de la configuración y estado del gateway.

```json
{
  "gateway": {
    "enableBackup": true
  }
}
```

### `gateway.backupInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `86400`

Intervalo en segundos entre backups.

```json
{
  "gateway": {
    "backupInterval": 86400
  }
}
```

### `gateway.backupDir`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Directorio donde se almacenan los backups. Si es `null`, usa una ubicación predeterminada.

```json
{
  "gateway": {
    "backupDir": "/var/backups/openclaw"
  }
}
```

### `gateway.backupRetention`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `7`

Número de días para retener backups antes de eliminarlos.

```json
{
  "gateway": {
    "backupRetention": 7
  }
}
```

### `gateway.enableRestore`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la capacidad de restaurar desde backups.

```json
{
  "gateway": {
    "enableRestore": true
  }
}
```

### `gateway.restoreDir`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Directorio desde donde restaurar backups.

```json
{
  "gateway": {
    "restoreDir": "/var/backups/openclaw"
  }
}
```

## Sync y Replicación

### `gateway.enableSync`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la sincronización de configuración con un endpoint remoto.

```json
{
  "gateway": {
    "enableSync": true
  }
}
```

### `gateway.syncInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `300`

Intervalo en segundos entre sincronizaciones.

```json
{
  "gateway": {
    "syncInterval": 300
  }
}
```

### `gateway.syncEndpoint`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

URL del endpoint de sincronización remoto.

```json
{
  "gateway": {
    "syncEndpoint": "https://sync.example.com"
  }
}
```

### `gateway.enableReplication`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita la replicación de datos a otros gateways.

```json
{
  "gateway": {
    "enableReplication": true
  }
}
```

### `gateway.replicationTargets`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de URLs de gateway objetivo para replicación.

```json
{
  "gateway": {
    "replicationTargets": [
      "https://gateway2.example.com",
      "https://gateway3.example.com"
    ]
  }
}
```

### `gateway.replicationInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `60`

Intervalo en segundos entre replicaciones.

```json
{
  "gateway": {
    "replicationInterval": 60
  }
}
```

## Clustering

### `gateway.enableClustering`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el modo cluster para múltiples instancias de gateway.

```json
{
  "gateway": {
    "enableClustering": true
  }
}
```

### `gateway.clusterNodes`

**Tipo**: `string[]`  
**Requerido**: No  
**Predeterminado**: `[]`

Lista de URLs de nodos en el cluster.

```json
{
  "gateway": {
    "clusterNodes": [
      "http://node1.example.com:18789",
      "http://node2.example.com:18789"
    ]
  }
}
```

### `gateway.clusterPort`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `18790`

Puerto para la comunicación entre nodos del cluster.

```json
{
  "gateway": {
    "clusterPort": 18790
  }
}
```

## Distributed Lock

### `gateway.enableDistributedLock`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el distributed locking para operaciones coordinadas entre clusters.

```json
{
  "gateway": {
    "enableDistributedLock": true
  }
}
```

### `gateway.distributedLockBackend`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"redis"`  
**Valores permitidos**: `"redis"`, `"etcd"`, `"consul"`, `"zookeeper"`

Backend a usar para distributed locking.

```json
{
  "gateway": {
    "distributedLockBackend": "redis"
  }
}
```

### `gateway.distributedLockConfig`

**Tipo**: `object`  
**Requerido**: No  
**Predeterminado**: `{}`

Configuración específica del backend para distributed locking.

```json
{
  "gateway": {
    "distributedLockConfig": {
      "host": "localhost",
      "port": 6379,
      "password": "redis-password"
    }
  }
}
```

## Queue

### `gateway.enableQueue`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el sistema de colas para procesamiento asíncrono.

```json
{
  "gateway": {
    "enableQueue": true
  }
}
```

### `gateway.queueBackend`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"memory"`  
**Valores permitidos**: `"memory"`, `"redis"`, `"rabbitmq"`, `"sqs"`, `"kafka"`

Backend a usar para el sistema de colas.

```json
{
  "gateway": {
    "queueBackend": "redis"
  }
}
```

### `gateway.queueConfig`

**Tipo**: `object`  
**Requerido**: No  
**Predeterminado**: `{}`

Configuración específica del backend para el sistema de colas.

```json
{
  "gateway": {
    "queueConfig": {
      "host": "localhost",
      "port": 6379
    }
  }
}
```

## Cache Backend

### `gateway.enableCache`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita un backend de cache persistente (diferente del cache en memoria).

```json
{
  "gateway": {
    "enableCache": true
  }
}
```

### `gateway.cacheBackend`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"memory"`  
**Valores permitidos**: `"memory"`, `"redis"`, `"memcached"`, `"dynamodb"`

Backend a usar para el caching.

```json
{
  "gateway": {
    "cacheBackend": "redis"
  }
}
```

### `gateway.cacheConfig`

**Tipo**: `object`  
**Requerido**: No  
**Predeterminado**: `{}`

Configuración específica del backend para el caching.

```json
{
  "gateway": {
    "cacheConfig": {
      "host": "localhost",
      "port": 6379
    }
  }
}
```

## Storage Backend

### `gateway.enableStorage`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita un backend de storage persistente.

```json
{
  "gateway": {
    "enableStorage": true
  }
}
```

### `gateway.storageBackend`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"fs"`  
**Valores permitidos**: `"fs"`, `"s3"`, `"gcs"`, `"azure-blob"`

Backend a usar para el storage.

```json
{
  "gateway": {
    "storageBackend": "s3"
  }
}
```

### `gateway.storageConfig`

**Tipo**: `object`  
**Requerido**: No  
**Predeterminado**: `{}`

Configuración específica del backend para el storage.

```json
{
  "gateway": {
    "storageConfig": {
      "bucket": "my-bucket",
      "region": "us-east-1"
    }
  }
}
```

## Database Backend

### `gateway.enableDatabase`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita un backend de base de datos.

```json
{
  "gateway": {
    "enableDatabase": true
  }
}
```

### `gateway.databaseBackend`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"sqlite"`  
**Valores permitidos**: `"sqlite"`, `"postgres"`, `"mysql"`, `"mongodb"`

Backend de base de datos a usar.

```json
{
  "gateway": {
    "databaseBackend": "postgres"
  }
}
```

### `gateway.databaseConfig`

**Tipo**: `object`  
**Requerido**: No  
**Predeterminado**: `{}`

Configuración específica del backend para la base de datos.

```json
{
  "gateway": {
    "databaseConfig": {
      "host": "localhost",
      "port": 5432,
      "database": "openclaw",
      "username": "user",
      "password": "password"
    }
  }
}
```

## Search Backend

### `gateway.enableSearch`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita capacidades de búsqueda.

```json
{
  "gateway": {
    "enableSearch": true
  }
}
```

### `gateway.searchBackend`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"memory"`  
**Valores permitidos**: `"memory"`, `"elasticsearch"`, `"opensearch"`, `"meilisearch"`

Backend a usar para la búsqueda.

```json
{
  "gateway": {
    "searchBackend": "elasticsearch"
  }
}
```

### `gateway.searchConfig`

**Tipo**: `object`  
**Requerido**: No  
**Predeterminado**: `{}`

Configuración específica del backend para la búsqueda.

```json
{
  "gateway": {
    "searchConfig": {
      "host": "localhost",
      "port": 9200
    }
  }
}
```

## Notifications

### `gateway.enableNotifications`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el sistema de notificaciones.

```json
{
  "gateway": {
    "enableNotifications": true
  }
}
```

### `gateway.notificationsBackend`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"webhook"`  
**Valores permitidos**: `"webhook"`, `"email"`, `"sms"`, `"push"`

Backend a usar para las notificaciones.

```json
{
  "gateway": {
    "notificationsBackend": "email"
  }
}
```

### `gateway.notificationsConfig`

**Tipo**: `object`  
**Requerido**: No  
**Predeterminado**: `{}`

Configuración específica del backend para las notificaciones.

```json
{
  "gateway": {
    "notificationsConfig": {
      "smtp": {
        "host": "smtp.example.com",
        "port": 587,
        "username": "user",
        "password": "password"
      }
    }
  }
}
```

## Webhooks

### `gateway.enableWebhooks`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el sistema de webhooks salientes.

```json
{
  "gateway": {
    "enableWebhooks": true
  }
}
```

### `gateway.webhooksEndpoint`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

URL del endpoint de webhook a llamar.

```json
{
  "gateway": {
    "webhooksEndpoint": "https://hooks.example.com/openclaw"
  }
}
```

### `gateway.webhooksSecret`

**Tipo**: `string | null`  
**Requerido**: No  
**Predeterminado**: `null`

Secreto compartido usado para firmar payloads de webhook.

```json
{
  "gateway": {
    "webhooksSecret": "your-webhook-secret"
  }
}
```

## WebSocket

### `gateway.enableWebsocket`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte WebSocket.

```json
{
  "gateway": {
    "enableWebsocket": true
  }
}
```

### `gateway.websocketPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/ws"`

Ruta para las conexiones WebSocket.

```json
{
  "gateway": {
    "websocketPath": "/ws"
  }
}
```

### `gateway.websocketPingInterval`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `30`

Intervalo en segundos entre mensajes ping de WebSocket.

```json
{
  "gateway": {
    "websocketPingInterval": 30
  }
}
```

## Server-Sent Events (SSE)

### `gateway.enableSse`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte Server-Sent Events.

```json
{
  "gateway": {
    "enableSse": true
  }
}
```

### `gateway.ssePath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/events"`

Ruta para las conexiones SSE.

```json
{
  "gateway": {
    "ssePath": "/events"
  }
}
```

## Protocolos de API

### `gateway.enableGraphql`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el endpoint GraphQL.

```json
{
  "gateway": {
    "enableGraphql": true
  }
}
```

### `gateway.graphqlPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/graphql"`

Ruta del endpoint GraphQL.

```json
{
  "gateway": {
    "graphqlPath": "/graphql"
  }
}
```

### `gateway.enableRest`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el endpoint REST API.

```json
{
  "gateway": {
    "enableRest": true
  }
}
```

### `gateway.restPath`

**Tipo**: `string`  
**Requerido**: No  
**Predeterminado**: `"/api"`

Ruta base para la REST API.

```json
{
  "gateway": {
    "restPath": "/api"
  }
}
```

### `gateway.enableGrpc`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el servidor gRPC.

```json
{
  "gateway": {
    "enableGrpc": true
  }
}
```

### `gateway.grpcPort`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `50051`

Puerto para el servidor gRPC.

```json
{
  "gateway": {
    "grpcPort": 50051
  }
}
```

### `gateway.enableThrift`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el servidor Thrift.

```json
{
  "gateway": {
    "enableThrift": true
  }
}
```

### `gateway.thriftPort`

**Tipo**: `number`  
**Requerido**: No  
**Predeterminado**: `9090`

Puerto para el servidor Thrift.

```json
{
  "gateway": {
    "thriftPort": 9090
  }
}
```

## Formatos de Serialización

### `gateway.enableMessagePack`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte de serialización MessagePack.

```json
{
  "gateway": {
    "enableMessagePack": true
  }
}
```

### `gateway.enableProtobuf`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte de serialización Protocol Buffers.

```json
{
  "gateway": {
    "enableProtobuf": true
  }
}
```

### `gateway.enableAvro`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte de serialización Apache Avro.

```json
{
  "gateway": {
    "enableAvro": true
  }
}
```

### `gateway.enableJson`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita el soporte de serialización JSON.

```json
{
  "gateway": {
    "enableJson": true
  }
}
```

### `gateway.enableXml`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte de serialización XML.

```json
{
  "gateway": {
    "enableXml": true
  }
}
```

### `gateway.enableYaml`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte de serialización YAML.

```json
{
  "gateway": {
    "enableYaml": true
  }
}
```

### `gateway.enableToml`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte de serialización TOML.

```json
{
  "gateway": {
    "enableToml": true
  }
}
```

### `gateway.enableCsv`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita el soporte de serialización CSV.

```json
{
  "gateway": {
    "enableCsv": true
  }
}
```

### `gateway.enableHtml`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita las respuestas HTML renderizadas.

```json
{
  "gateway": {
    "enableHtml": true
  }
}
```

### `gateway.enableMarkdown`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `false`

Habilita las respuestas Markdown renderizadas.

```json
{
  "gateway": {
    "enableMarkdown": true
  }
}
```

### `gateway.enablePlainText`

**Tipo**: `boolean`  
**Requerido**: No  
**Predeterminado**: `true`

Habilita las respuestas de texto plano.

```json
{
  "gateway": {
    "enablePlainText": true
  }
}
```

## Próximos Pasos

- [Ejemplos de Configuración](/es-ES/gateway/configuration-examples) - Patrones de configuración comunes
- [Configuración](/es-ES/gateway/configuration) - Visión general conceptual
- [Solución de Problemas](/es-ES/gateway/troubleshooting) - Resolver problemas de configuración

## Referencias Relacionadas

Para configuraciones específicas de funciones, consulta:

- [Authentication](/es-ES/gateway/authentication)
- [Sandboxing](/es-ES/gateway/sandboxing)
- [Local Models](/es-ES/gateway/local-models)
- [Pairing](/es-ES/gateway/pairing)
- [Tailscale](/es-ES/gateway/tailscale)
- [Logging](/es-ES/gateway/logging)
- [Health](/es-ES/gateway/health)
- [Heartbeat](/es-ES/gateway/heartbeat)
