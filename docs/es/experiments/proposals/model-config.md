---
summary: "Exploración: configuración de modelos, perfiles de autenticación y comportamiento de fallback"
read_when:
  - Explorando ideas futuras de selección de modelos + perfiles de autenticación
title: "Exploración de configuración de modelos"
---

# Configuración de modelos (Exploración)

Este documento recopila **ideas** para la configuración futura de modelos. No es una
especificación en producción. Para el comportamiento actual, consulte:

- [Modelos](/concepts/models)
- [Failover de modelos](/concepts/model-failover)
- [OAuth + perfiles](/concepts/oauth)

## Motivación

Los operadores desean:

- Múltiples perfiles de autenticación por proveedor (personal vs. trabajo).
- Selección simple `/model` con fallbacks predecibles.
- Separación clara entre modelos de texto y modelos con capacidad de imagen.

## Posible dirección (alto nivel)

- Mantener la selección de modelos simple: `provider/model` con alias opcionales.
- Permitir que los proveedores tengan múltiples perfiles de autenticación, con un orden explícito.
- Usar una lista global de fallback para que todas las sesiones hagan failover de forma consistente.
- Sobrescribir el enrutamiento de imágenes solo cuando se configure explícitamente.

## Preguntas abiertas

- ¿La rotación de perfiles debería ser por proveedor o por modelo?
- ¿Cómo debería la interfaz de usuario presentar la selección de perfiles para una sesión?
- ¿Cuál es la ruta de migración más segura desde las claves de configuración heredadas?
