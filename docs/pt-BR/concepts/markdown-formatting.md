---
summary: "Pipeline de formatação Markdown para canais outbound"
read_when:
  - Você está mudando formatting ou chunking markdown para canais outbound
  - Você está adicionando um novo formatador de canal ou mapeamento de estilo
  - Você está debugando regressões de formatting entre canais
title: "Formatação Markdown"
---

# Formatação Markdown

OpenClaw formata Markdown outbound convertendo-o em uma representação intermediária compartilhada (IR) antes de renderizar saída específica de canal. O IR mantém o texto de origem intacto enquanto leva spans de estilo/link para que chunking e rendering possam permanecer consistentes entre canais.

## Objetivos

- **Consistência:** um parse step, múltiplos renderers.
- **Chunking seguro:** divide texto antes de renderizar para que formatting inline nunca quebrar através de chunks.
- **Channel fit:** mapea a mesma IR para Slack mrkdwn, Telegram HTML e Signal style ranges sem re-parsing Markdown.

## Pipeline

1. **Parse Markdown -> IR**
   - IR é texto plano mais style spans (bold/italic/strike/code/spoiler) e link spans.
   - Offsets são unidades de código UTF-16 para que Signal style ranges se alinhem com sua API.
   - Tabelas são parseadas apenas quando um canal opta em conversão de tabela.
2. **Chunk IR (format-first)**
   - Chunking acontece no texto IR antes de renderizar.
   - Formatting inline não divide entre chunks; spans são cortados por chunk.
3. **Render per canal**
   - **Slack:** tokens mrkdwn (bold/italic/strike/code), links como `<url|label>`.
   - **Telegram:** tags HTML (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** texto plano + ranges `text-style`; links se tornam `label (url)` quando label difere.

## Exemplo IR

Input Markdown:

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

## Onde é usado

- Adaptadores Slack, Telegram e Signal outbound renderizam a partir do IR.
- Outros canais (WhatsApp, iMessage, MS Teams, Discord) ainda usam texto plano ou suas próprias regras de formatting, com conversão de tabela Markdown aplicada antes de chunking quando habilitado.

## Tratamento de tabela

Tabelas Markdown não são suportadas consistentemente entre clientes de chat. Use `markdown.tables` para controlar conversão por canal (e por conta).

- `code`: renderiza tabelas como code blocks (padrão para a maioria dos canais).
- `bullets`: converte cada row em bullet points (padrão para Signal + WhatsApp).
- `off`: desabilita table parsing e conversão; texto de tabela bruto passa através.

Chaves de config:

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
```
