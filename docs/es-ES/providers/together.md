---
summary: "Configuración de Together AI (autenticación + selección de modelo)"
read_when:
  - Quieres usar Together AI con OpenClaw
  - Necesitas la variable de entorno de clave de API o la opción de autenticación CLI
---

# Together AI

[Together AI](https://together.ai) proporciona acceso a modelos de código abierto líderes incluyendo Llama, DeepSeek, Kimi y más mediante una API unificada.

- Proveedor: `together`
- Autenticación: `TOGETHER_API_KEY`
- API: Compatible con OpenAI

## Inicio rápido

1. Establece la clave de API (recomendado: almacénala para el Gateway):

```bash
openclaw onboard --auth-choice together-api-key
```

2. Establece un modelo por defecto:

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.5" },
    },
  },
}
```

## Ejemplo no interactivo

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

Esto establecerá `together/moonshotai/Kimi-K2.5` como el modelo por defecto.

## Nota sobre entorno

Si el Gateway se ejecuta como un daemon (launchd/systemd), asegúrate de que `TOGETHER_API_KEY`
esté disponible para ese proceso (por ejemplo, en `~/.clawdbot/.env` o mediante
`env.shellEnv`).

## Modelos disponibles

Together AI proporciona acceso a muchos modelos de código abierto populares:

- **GLM 4.7 Fp8** - Modelo por defecto con ventana de contexto de 200K
- **Llama 3.3 70B Instruct Turbo** - Seguimiento de instrucciones rápido y eficiente
- **Llama 4 Scout** - Modelo de visión con comprensión de imágenes
- **Llama 4 Maverick** - Visión y razonamiento avanzado
- **DeepSeek V3.1** - Modelo potente de codificación y razonamiento
- **DeepSeek R1** - Modelo avanzado de razonamiento
- **Kimi K2 Instruct** - Modelo de alto rendimiento con ventana de contexto de 262K

Todos los modelos soportan completaciones de chat estándar y son compatibles con la API de OpenAI.
