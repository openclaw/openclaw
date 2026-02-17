# Recursos i18n de documentación de OpenClaw

Esta carpeta almacena archivos **generados** y de **configuración** para las traducciones de la documentación.

## Archivos

- `glossary.<lang>.json` — mapeos de términos preferidos (usados en la guía de prompts).
- `<lang>.tm.jsonl` — memoria de traducción (caché) indexada por flujo de trabajo + modelo + hash de texto.

## Formato del glosario

`glossary.<lang>.json` es un array de entradas:

```json
{
  "source": "troubleshooting",
  "target": "solución de problemas",
  "ignore_case": true,
  "whole_word": false
}
```

Campos:

- `source`: frase en inglés (o idioma fuente) a preferir.
- `target`: traducción preferida de salida.

## Notas

- Las entradas del glosario se pasan al modelo como **guía de prompts** (sin reescrituras determinísticas).
- La memoria de traducción es actualizada por `scripts/docs-i18n`.
