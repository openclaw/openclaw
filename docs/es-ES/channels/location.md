---
title: Ubicación
description: Analizar y manejar datos de ubicación de mensajes
icon: location-dot
---

# Datos de Ubicación

OpenClaw puede analizar y manejar datos de ubicación enviados a través de canales de mensajería. Esto te permite construir agentes conscientes de la ubicación que pueden proporcionar información basada en la ubicación, direcciones o servicios basados en proximidad.

## Canales Soportados

Los datos de ubicación actualmente son soportados en:

- **Telegram**: Ubicación en tiempo real y lugares estáticos
- **WhatsApp**: Mensajes de ubicación
- **Matrix**: Mensajes de geo-URI

## Formato de Datos de Ubicación

Los datos de ubicación se entregan como parte del objeto del mensaje:

```typescript
{
  id: "mensaje_id",
  from: "usuario_id",
  timestamp: 1234567890,
  location: {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 20, // metros (opcional)
    name: "San Francisco, CA", // opcional
    address: "123 Main St", // opcional
  }
}
```

## Recibir Datos de Ubicación

### Detectar Mensajes de Ubicación

Verifica si un mensaje contiene datos de ubicación:

```typescript
agent.on("message", async (message) => {
  if (message.location) {
    const { latitude, longitude } = message.location;
    console.log(`Recibida ubicación: ${latitude}, ${longitude}`);
  }
});
```

### Analizar Ubicación

Extrae información de ubicación:

```typescript
agent.on("message", async (message) => {
  if (message.location) {
    const { latitude, longitude, name, address } = message.location;

    await message.reply(`
**Ubicación Recibida**
Coordenadas: ${latitude}, ${longitude}
${name ? `Lugar: ${name}` : ""}
${address ? `Dirección: ${address}` : ""}
    `);
  }
});
```

## Enviar Datos de Ubicación

### Enviar Ubicación Estática

Envía una ubicación estática:

```typescript
await agent.sendMessage({
  to: "usuario_id",
  location: {
    latitude: 37.7749,
    longitude: -122.4194,
    name: "San Francisco",
    address: "123 Main St, San Francisco, CA 94102",
  },
});
```

### Enviar Ubicación en Tiempo Real (Telegram)

Telegram soporta compartir ubicación en tiempo real:

```typescript
await agent.sendMessage({
  to: "usuario_id",
  location: {
    latitude: 37.7749,
    longitude: -122.4194,
    livePeriod: 900, // Compartir durante 15 minutos
  },
});
```

## Casos de Uso

### 1. Búsqueda de Lugares Cercanos

Encuentra lugares cercanos basados en la ubicación del usuario:

```typescript
import { findNearbyPlaces } from "./services/places";

agent.on("message", async (message) => {
  if (message.body === "!nearby" && message.location) {
    const places = await findNearbyPlaces(
      message.location.latitude,
      message.location.longitude,
      "restaurante",
    );

    await message.reply(`Restaurantes cercanos:\n${places.map((p) => `• ${p.name}`).join("\n")}`);
  }
});
```

### 2. Información Meteorológica

Proporciona información meteorológica basada en la ubicación:

```typescript
import { getWeather } from "./services/weather";

agent.on("message", async (message) => {
  if (message.location) {
    const weather = await getWeather(message.location.latitude, message.location.longitude);

    await message.reply(`
**Clima Actual**
Temperatura: ${weather.temp}°C
Condiciones: ${weather.description}
Humedad: ${weather.humidity}%
    `);
  }
});
```

### 3. Seguimiento de Entregas

Rastrea entregas basadas en la ubicación:

```typescript
agent.on("message", async (message) => {
  if (message.location && message.body.startsWith("!track")) {
    const orderId = message.body.split(" ")[1];

    await updateDeliveryLocation(orderId, {
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      timestamp: Date.now(),
    });

    await message.reply(`Ubicación de entrega actualizada para orden ${orderId}`);
  }
});
```

### 4. Check-ins Basados en Ubicación

Implementa sistema de check-in:

```typescript
agent.on("message", async (message) => {
  if (message.location && message.body === "!checkin") {
    await recordCheckin({
      userId: message.from,
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      timestamp: Date.now(),
    });

    await message.reply("✅ Check-in registrado!");
  }
});
```

## Trabajar con Coordenadas

### Calcular Distancia

Calcula distancia entre dos puntos:

```typescript
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Radio de la Tierra en km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distancia en km
}

// Uso
agent.on("message", async (message) => {
  if (message.location) {
    const storeLocation = { lat: 37.7749, lon: -122.4194 };
    const distance = calculateDistance(
      message.location.latitude,
      message.location.longitude,
      storeLocation.lat,
      storeLocation.lon,
    );

    await message.reply(`Estás a ${distance.toFixed(2)} km de nuestra tienda.`);
  }
});
```

### Geocodificación Inversa

Convierte coordenadas a dirección:

```typescript
import { reverseGeocode } from "./services/geocoding";

agent.on("message", async (message) => {
  if (message.location && !message.location.address) {
    const address = await reverseGeocode(message.location.latitude, message.location.longitude);

    await message.reply(`Ubicación: ${address}`);
  }
});
```

## Privacidad y Seguridad

### Mejores Prácticas

1. **Solicita Permiso**: Siempre pide permiso antes de solicitar datos de ubicación
2. **Almacena Datos Temporalmente**: No almacenes datos de ubicación más de lo necesario
3. **Encripta Datos**: Encripta datos de ubicación en reposo
4. **Proporciona Claridad**: Explica cómo se usarán los datos de ubicación
5. **Permite Exclusión**: Permite a los usuarios desactivar el seguimiento de ubicación

### Ejemplo de Implementación

```typescript
// Solicita permiso antes de usar la ubicación
agent.on("message", async (message) => {
  if (message.body === "!weather") {
    await message.reply(
      "Por favor comparte tu ubicación para obtener información meteorológica local.",
    );

    // Espera respuesta de ubicación
    agent.once("location", async (locationMessage) => {
      if (locationMessage.from === message.from) {
        const weather = await getWeather(
          locationMessage.location.latitude,
          locationMessage.location.longitude,
        );

        await locationMessage.reply(`Clima: ${weather.description}`);
      }
    });
  }
});
```

## Solución de Problemas

### Los Datos de Ubicación No se Reciben

Si los datos de ubicación no llegan:

1. Verifica que el canal soporte ubicación:

   ```bash
   openclaw channels status
   ```

2. Asegúrate de que el usuario haya compartido ubicación correctamente

3. Revisa los logs del gateway:
   ```bash
   openclaw gateway logs --level debug
   ```

### Precisión de Ubicación

Si la precisión de ubicación es baja:

- Los dispositivos móviles pueden tener GPS limitado en interiores
- Solicita que el usuario habilite servicios de ubicación de alta precisión
- Considera usar WiFi o señales de torre celular para mejor precisión

## Ejemplos

### Bot de Clima

```typescript
import { OpenClawAgent } from "openclaw";
import { getWeather } from "./services/weather";

const agent = new OpenClawAgent({
  name: "weather-bot",
});

agent.on("message", async (message) => {
  if (message.body === "!weather") {
    await message.reply("Por favor comparte tu ubicación.");
  } else if (message.location) {
    const weather = await getWeather(message.location.latitude, message.location.longitude);

    await message.reply(`
🌤️ **Clima Actual**
📍 ${message.location.name || "Tu ubicación"}
🌡️ ${weather.temp}°C
💧 ${weather.humidity}% humedad
    `);
  }
});

await agent.start();
```

### Bot de Lugares Cercanos

```typescript
import { OpenClawAgent } from "openclaw";
import { findNearbyPlaces } from "./services/places";

const agent = new OpenClawAgent({
  name: "places-bot",
});

agent.command("nearby", async (ctx, args) => {
  const category = args.join(" ") || "restaurante";
  await ctx.reply(`Por favor comparte tu ubicación para encontrar ${category}s cercanos.`);
});

agent.on("message", async (message) => {
  if (message.location) {
    const places = await findNearbyPlaces(
      message.location.latitude,
      message.location.longitude,
      "restaurante",
      5000, // 5km de radio
    );

    await message.reply(`
📍 **Lugares Cercanos**
${places
  .slice(0, 5)
  .map((p, i) => `${i + 1}. ${p.name} (${p.distance}m)`)
  .join("\n")}
    `);
  }
});

await agent.start();
```

## Recursos Adicionales

- [Documentación de Canales](/es-ES/channels)
- [API de Bot de Telegram - Ubicación](https://core.telegram.org/bots/api#location)
- [Documentación de Negocios de WhatsApp](https://developers.facebook.com/docs/whatsapp)

## Soporte

Si encuentras problemas con datos de ubicación:

1. Revisa esta documentación
2. Consulta los [problemas de GitHub](https://github.com/openclaw/openclaw/issues)
3. Pregunta en el [servidor de Discord](https://discord.gg/openclaw)
