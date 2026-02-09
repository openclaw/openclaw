---
summary: "Canalización de formato Markdown para canales salientes"
read_when:
  - Está cambiando el formato Markdown o el troceado para canales salientes
  - Está agregando un nuevo formateador de canal o mapeo de estilos
  - Está depurando regresiones de formato entre canales
title: "Formato Markdown"
---

# Formato Markdown

OpenClaw formatea el Markdown saliente convirtiéndolo en una representación
intermedia (IR) compartida antes de renderizar la salida específica del canal. La IR mantiene intacto el texto de origen mientras transporta tramos de estilo/enlaces,
de modo que el troceado y el renderizado se mantengan consistentes entre canales.

## Objetivos

- **Consistencia:** un paso de análisis, múltiples renderizadores.
- **Troceado seguro:** dividir el texto antes de renderizar para que el formato en línea nunca
  se rompa entre fragmentos.
- **Ajuste por canal:** mapear la misma IR a Slack mrkdwn, HTML de Telegram y rangos de estilo de Signal
  sin volver a analizar Markdown.

## Canalización

1. **Analizar Markdown -> IR**
   - La IR es texto plano más tramos de estilo (negrita/cursiva/tachado/código/spoiler) y tramos de enlaces.
   - Los desplazamientos son unidades de código UTF-16 para que los rangos de estilo de Signal se alineen con su API.
   - Las tablas se analizan solo cuando un canal opta por la conversión de tablas.
2. **Trocear la IR (formato primero)**
   - El troceado ocurre sobre el texto de la IR antes del renderizado.
   - El formato en línea no se divide entre fragmentos; los tramos se recortan por fragmento.
3. **Renderizar por canal**
   - **Slack:** tokens mrkdwn (negrita/cursiva/tachado/código), enlaces como `<url|label>`.
   - **Telegram:** etiquetas HTML (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** texto plano + rangos `text-style`; los enlaces se convierten en `label (url)` cuando la etiqueta difiere.

## Ejemplo de IR

Markdown de entrada:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (esquemático):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Dónde se utiliza

- Los adaptadores salientes de Slack, Telegram y Signal renderizan a partir de la IR.
- Otros canales (WhatsApp, iMessage, MS Teams, Discord) todavía usan texto plano o
  sus propias reglas de formato, con la conversión de tablas Markdown aplicada antes
  del troceado cuando está habilitada.

## Manejo de tablas

Las tablas Markdown no se admiten de forma consistente entre clientes de chat. Use
`markdown.tables` para controlar la conversión por canal (y por cuenta).

- `code`: renderizar tablas como bloques de código (valor predeterminado para la mayoría de los canales).
- `bullets`: convertir cada fila en viñetas (valor predeterminado para Signal + WhatsApp).
- `off`: deshabilitar el análisis y la conversión de tablas; el texto de la tabla sin procesar pasa tal cual.

Claves de configuración:

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## Reglas de Chunking

- Los límites de fragmentos provienen de los adaptadores/configuración del canal y se aplican al texto de la IR.
- Los cercos de código se preservan como un solo bloque con una nueva línea final para que los canales
  los rendericen correctamente.
- Los prefijos de listas y de citas en bloque forman parte del texto de la IR, por lo que el troceado
  no se divide a mitad del prefijo.
- Los estilos en línea (negrita/cursiva/tachado/código en línea/spoiler) nunca se dividen entre fragmentos;
  el renderizador reabre los estilos dentro de cada fragmento.

Si necesita más información sobre el comportamiento de troceado entre canales, consulte
[Streaming + chunking](/concepts/streaming).

## Política de enlaces

- **Slack:** `[label](url)` -> `<url|label>`; las URL desnudas permanecen desnudas. El autolink
  se deshabilita durante el análisis para evitar enlaces dobles.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (modo de análisis HTML).
- **Signal:** `[label](url)` -> `label (url)` a menos que la etiqueta coincida con la URL.

## Spoilers

Los marcadores de spoiler (`||spoiler||`) se analizan solo para Signal, donde se mapean a
rangos de estilo SPOILER. Otros canales los tratan como texto plano.

## Cómo agregar o actualizar un formateador de canal

1. **Analizar una vez:** use el helper compartido `markdownToIR(...)` con opciones apropiadas del canal
   (autolink, estilo de encabezados, prefijo de citas en bloque).
2. **Renderizar:** implemente un renderizador con `renderMarkdownWithMarkers(...)` y un
   mapa de marcadores de estilo (o rangos de estilo de Signal).
3. **Trocear:** llame a `chunkMarkdownIR(...)` antes de renderizar; renderice cada fragmento.
4. **Conectar el adaptador:** actualice el adaptador saliente del canal para usar el nuevo troceador
   y renderizador.
5. **Probar:** agregue o actualice pruebas de formato y una prueba de entrega saliente si el
   canal usa troceado.

## Errores comunes

- Los tokens con corchetes angulares de Slack (`<@U123>`, `<#C123>`, `<https://...>`) deben
  preservarse; escape el HTML sin procesar de forma segura.
- El HTML de Telegram requiere escapar el texto fuera de las etiquetas para evitar marcado roto.
- Los rangos de estilo de Signal dependen de desplazamientos UTF-16; no use desplazamientos por puntos de código.
- Preserve las nuevas líneas finales para los bloques de código cercados para que los marcadores de cierre
  queden en su propia línea.
