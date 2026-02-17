---
title: Gmail Push con Pub/Sub
description: Recibe notificaciones en tiempo real de Gmail usando Google Cloud Pub/Sub
---

OpenClaw puede recibir notificaciones push de Gmail en tiempo real a través de Google Cloud Pub/Sub, lo que permite respuestas instantáneas a correos electrónicos entrantes sin necesidad de sondeo.

## Descripción general

El método de notificación push de Gmail se basa en Google Cloud Pub/Sub para entregar notificaciones en tiempo real cuando llegan nuevos mensajes. Esto es significativamente más eficiente que el sondeo y proporciona entrega casi instantánea de notificaciones.

<Note>
La integración de Gmail Push con Pub/Sub está disponible en la versión 2025.1.18 de OpenClaw y posteriores.
</Note>

## Cómo funciona

1. Tu Gateway OpenClaw se suscribe a un tema de Google Cloud Pub/Sub
2. Configuras Gmail para publicar notificaciones en ese tema cuando llegan nuevos mensajes
3. Pub/Sub envía notificaciones al endpoint del Gateway
4. OpenClaw procesa las notificaciones y obtiene los nuevos mensajes a través de la API de Gmail

## Configuración

### Requisitos previos

- Un proyecto de Google Cloud con facturación habilitada
- API de Gmail habilitada para tu proyecto
- Credenciales OAuth 2.0 configuradas para OpenClaw
- Acceso a Google Cloud Console

### Paso 1: Crear un tema de Pub/Sub

1. Ve a [Google Cloud Console](https://console.cloud.google.com)
2. Selecciona tu proyecto
3. Navega a **Pub/Sub > Temas**
4. Haz clic en **Crear tema**
5. Ingresa un ID de tema (por ejemplo, `gmail-openclaw-notifications`)
6. Haz clic en **Crear tema**

### Paso 2: Crear una suscripción push

1. En la página del tema, haz clic en **Crear suscripción**
2. Ingresa un ID de suscripción (por ejemplo, `gmail-openclaw-sub`)
3. Selecciona **Push** como tipo de entrega
4. Ingresa la URL de tu endpoint:
   ```
   https://tu-gateway-host.com/webhooks/gmail/pubsub
   ```
5. (Opcional) Configura autenticación para la URL del endpoint
6. Haz clic en **Crear**

### Paso 3: Otorgar permisos a Gmail

Gmail necesita permiso para publicar en tu tema de Pub/Sub:

1. Ve a la página de tu **Tema** en Cloud Console
2. Haz clic en **Mostrar panel de información** (esquina superior derecha)
3. Haz clic en **Añadir miembro principal**
4. Añade `gmail-api-push@system.gserviceaccount.com` como miembro principal
5. Asigna el rol **Pub/Sub Publisher**
6. Haz clic en **Guardar**

### Paso 4: Configurar OpenClaw

Añade la configuración de Gmail Pub/Sub a tu archivo de configuración del Gateway:

```yaml
automation:
  gmail:
    pubsub:
      # Habilita notificaciones push de Gmail
      enabled: true

      # ID del proyecto de Google Cloud
      project_id: tu-id-de-proyecto-gcp

      # ID del tema de Pub/Sub (sin el prefijo projects/)
      topic_id: gmail-openclaw-notifications

      # Opcional: puerto para el servidor de webhooks (predeterminado: 8080)
      webhook_port: 8080

      # Opcional: ruta para el endpoint de webhook (predeterminado: /webhooks/gmail/pubsub)
      webhook_path: /webhooks/gmail/pubsub
```

### Paso 5: Iniciar el watch de Gmail

Usa la CLI de OpenClaw para iniciar el watch de Gmail:

```bash
openclaw gmail watch --email tu@email.com
```

Este comando:

- Registra tu dirección de correo electrónico con Gmail API para notificaciones push
- Configura Gmail para publicar notificaciones en tu tema de Pub/Sub
- La configuración del watch expira después de 7 días y debe renovarse

<Note>
Los watches de Gmail expiran después de 7 días. Puedes configurar una tarea programada para renovar automáticamente el watch (ver más abajo).
</Note>

## Renovación automática del watch

Para mantener las notificaciones push funcionando, configura una tarea programada para renovar el watch de Gmail:

```yaml
automation:
  cron:
    - name: renovar-watch-gmail
      # Ejecuta cada 6 días (antes de la expiración de 7 días)
      schedule: "0 0 */6 * *"
      command: openclaw gmail watch --email tu@email.com
```

## Formato del payload de Pub/Sub

Cuando llega un nuevo mensaje, Gmail publica una notificación a tu tema de Pub/Sub. OpenClaw recibe el siguiente payload:

```json
{
  "message": {
    "data": "eyJlbWFpbEFkZHJlc3MiOiJ1c2VyQGV4YW1wbGUuY29tIiwiaGlzdG9yeUlkIjoiMTIzNDU2In0=",
    "messageId": "2070443601311540",
    "message_id": "2070443601311540",
    "publishTime": "2025-01-18T10:30:00.123Z",
    "publish_time": "2025-01-18T10:30:00.123Z"
  },
  "subscription": "projects/tu-proyecto/subscriptions/gmail-openclaw-sub"
}
```

El campo `data` es una cadena codificada en Base64 que contiene:

```json
{
  "emailAddress": "tu@email.com",
  "historyId": "123456"
}
```

OpenClaw decodifica automáticamente estos datos y utiliza el `historyId` para obtener nuevos mensajes de manera eficiente.

## Verificación de la entrega de notificaciones

### Opción 1: Revisar los registros del Gateway

Los registros del Gateway mostrarán las notificaciones push entrantes:

```
[INFO] Gmail Pub/Sub notification received: historyId=123456, email=tu@email.com
[INFO] Fetching new messages since historyId=123450
[INFO] Found 2 new messages
```

### Opción 2: Usar Google Cloud Monitoring

1. Ve a **Pub/Sub > Suscripciones** en Cloud Console
2. Haz clic en tu suscripción
3. Revisa las métricas:
   - **Mensajes no reconocidos:** Debe ser bajo
   - **Edad del mensaje más antiguo no reconocido:** Debe ser baja
   - **Tasa de entrega push:** Debe mostrar entregas exitosas

### Opción 3: Enviar un correo de prueba

Envía un correo electrónico a tu dirección de Gmail y verifica:

1. La notificación de Pub/Sub llega al Gateway (revisa registros)
2. OpenClaw procesa el nuevo mensaje
3. Cualquier automatización configurada se activa

## Seguridad

### Proteger tu endpoint de webhook

Es importante asegurar el endpoint de webhook para evitar acceso no autorizado:

#### Opción 1: Autenticación de Pub/Sub

Configura autenticación en tu suscripción push:

1. En Cloud Console, edita tu suscripción
2. Expande **Configuración de autenticación**
3. Habilita **Autenticación**
4. Crea o selecciona una cuenta de servicio
5. OpenClaw validará automáticamente los tokens JWT de las solicitudes

#### Opción 2: Validación de IP de origen

Restringe el acceso a tu endpoint de webhook solo desde las IPs de Pub/Sub:

```yaml
automation:
  gmail:
    pubsub:
      # Lista de rangos de IP permitidos (IPs de Pub/Sub)
      allowed_ips:
        - "35.186.150.0/23"
        - "35.188.237.0/24"
        # Añade otros rangos de IP de Pub/Sub según sea necesario
```

<Note>
Las IPs de Google Cloud Pub/Sub pueden cambiar. Consulta la [documentación oficial de Google Cloud](https://cloud.google.com/pubsub/docs/push#ip_ranges) para los rangos de IP actuales.
</Note>

#### Opción 3: Usar Tailscale o una VPN

Ejecuta el Gateway en una red privada y usa Tailscale o una VPN para enrutar el tráfico de Pub/Sub de forma segura.

## Solución de problemas

### Las notificaciones push no llegan

1. **Verifica el estado del watch:**

   ```bash
   openclaw gmail watch --email tu@email.com --status
   ```

2. **Revisa los permisos de Pub/Sub:**
   - Confirma que `gmail-api-push@system.gserviceaccount.com` tiene el rol **Pub/Sub Publisher**

3. **Verifica la suscripción push:**
   - Asegúrate de que la URL del endpoint sea correcta y accesible
   - Verifica que el Gateway esté escuchando en el puerto configurado

4. **Revisa los registros del Gateway:**

   ```bash
   tail -f ~/.openclaw/gateway.log
   ```

5. **Prueba la entrega manual:**
   Ve a tu suscripción en Cloud Console y haz clic en **Publicar mensaje** para enviar una notificación de prueba.

### El watch expira demasiado rápido

Los watches de Gmail expiran después de 7 días. Si se configuró correctamente:

- Establece una tarea programada para renovar cada 6 días (ver más arriba)
- Monitorea los registros del Gateway para advertencias sobre expiración de watch

### Error: "No se pudo verificar el token push"

Si usas autenticación de Pub/Sub y ves este error:

1. Verifica que la cuenta de servicio esté configurada correctamente
2. Asegúrate de que OpenClaw tenga permisos para validar tokens JWT
3. Revisa que el `project_id` en la configuración sea correcto

### Los mensajes se procesan varias veces

Pub/Sub garantiza entrega al menos una vez, por lo que es posible recibir notificaciones duplicadas:

- OpenClaw deduplica automáticamente usando `historyId`
- Si aún observas duplicados, revisa tu lógica de procesamiento de mensajes

## Sondeo vs. Push

| Característica               | Sondeo                  | Push (Pub/Sub)                           |
| ---------------------------- | ----------------------- | ---------------------------------------- |
| Latencia                     | 1-5 minutos             | < 1 segundo                              |
| Uso de API                   | Alto (sondeo constante) | Bajo (solo cuando llegan mensajes)       |
| Eficiencia                   | Menor                   | Mayor                                    |
| Complejidad de configuración | Baja                    | Media                                    |
| Costo                        | Cuota de API de Gmail   | Cuota de API de Gmail + costo de Pub/Sub |

<Note>
Google Cloud Pub/Sub ofrece [10 GB de datos gratis por mes](https://cloud.google.com/pubsub/pricing), lo cual es más que suficiente para la mayoría de los casos de uso de notificaciones de Gmail.
</Note>

## Próximos pasos

- Aprende sobre [Hooks](/es-ES/automation/hooks) para procesar correos electrónicos entrantes
- Configura [Tareas programadas](/es-ES/automation/cron-jobs) para mantener activo el watch de Gmail
- Explora la [Solución de problemas de automatización](/es-ES/automation/troubleshooting) para problemas comunes
