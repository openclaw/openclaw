---
summary: "Notas de protocolo RPC para el asistente de incorporación y el esquema de configuración"
read_when: "Al cambiar los pasos del asistente de incorporación o los endpoints del esquema de configuración"
title: "Protocolo de Incorporación y Configuración"
---

# Protocolo de Incorporación + Configuración

Propósito: superficies compartidas de incorporación + configuración en CLI, aplicación macOS e Interfaz de Control Web.

## Componentes

- Motor del asistente (sesión compartida + prompts + estado de incorporación).
- La incorporación de CLI usa el mismo flujo del asistente que los clientes de UI.
- El RPC del Gateway expone los endpoints del asistente + esquema de configuración.
- La incorporación de macOS usa el modelo de pasos del asistente.
- La Interfaz de Control Web renderiza formularios de configuración desde JSON Schema + pistas de UI.

## RPC del Gateway

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Respuestas (forma)

- Asistente: `{ sessionId, done, step?, status?, error? }`
- Esquema de configuración: `{ schema, uiHints, version, generatedAt }`

## Pistas de UI

- `uiHints` indexadas por ruta; metadatos opcionales (label/help/group/order/advanced/sensitive/placeholder).
- Los campos sensibles se renderizan como entradas de contraseña; sin capa de redacción.
- Los nodos de esquema no soportados vuelven al editor JSON en bruto.

## Notas

- Este documento es el único lugar para rastrear las refactorizaciones del protocolo para incorporación/configuración.
