---
summary: "Pipeline de formatação Markdown para canais de saída"
read_when:
  - Você está alterando a formatação Markdown ou o chunking para canais de saída
  - Você está adicionando um novo formatador de canal ou mapeamento de estilo
  - Você está depurando regressões de formatação entre canais
title: "Formatação Markdown"
---

# Formatação Markdown

O OpenClaw formata Markdown de saída convertendo-o em uma representação intermediária
compartilhada (IR) antes de renderizar a saída específica de cada canal. A IR mantém o
texto de origem intacto enquanto carrega spans de estilo/link, para que o chunking e a
renderização permaneçam consistentes entre canais.

## Objetivos

- **Consistência:** uma etapa de parsing, múltiplos renderizadores.
- **Chunking seguro:** dividir o texto antes da renderização para que a formatação inline
  nunca se quebre entre chunks.
- **Adequação ao canal:** mapear a mesma IR para mrkdwn do Slack, HTML do Telegram e
  intervalos de estilo do Signal sem reanalisar o Markdown.

## Pipeline

1. **Parse Markdown -> IR**
   - A IR é texto simples mais spans de estilo (negrito/itálico/tachado/código/spoiler) e spans de link.
   - Os offsets são unidades de código UTF-16 para que os intervalos de estilo do Signal se alinhem com sua API.
   - Tabelas são analisadas apenas quando um canal opta pela conversão de tabelas.
2. **Chunk IR (format-first)**
   - O chunking acontece no texto da IR antes da renderização.
   - A formatação inline não é dividida entre chunks; os spans são fatiados por chunk.
3. **Renderizar por canal**
   - **Slack:** tokens mrkdwn (negrito/itálico/tachado/código), links como `<url|label>`.
   - **Telegram:** tags HTML (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** texto simples + intervalos `text-style`; links viram `label (url)` quando o rótulo difere.

## Exemplo de IR

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

## Onde é usado

- Os adaptadores de saída do Slack, Telegram e Signal renderizam a partir da IR.
- Outros canais (WhatsApp, iMessage, MS Teams, Discord) ainda usam texto simples ou
  suas próprias regras de formatação, com conversão de tabelas Markdown aplicada antes
  do chunking quando habilitada.

## Tratamento de tabelas

Tabelas Markdown não são suportadas de forma consistente entre clientes de chat. Use
`markdown.tables` para controlar a conversão por canal (e por conta).

- `code`: renderizar tabelas como blocos de código (padrão para a maioria dos canais).
- `bullets`: converter cada linha em tópicos (padrão para Signal + WhatsApp).
- `off`: desabilitar o parsing e a conversão de tabelas; o texto bruto da tabela passa direto.

Chaves de configuração:

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

## Regras de chunking

- Os limites de chunk vêm dos adaptadores/configurações do canal e são aplicados ao texto da IR.
- Code fences são preservadas como um único bloco com uma nova linha final para que os canais
  as renderizem corretamente.
- Prefixos de listas e de blockquote fazem parte do texto da IR, então o chunking
  não divide no meio do prefixo.
- Estilos inline (negrito/itálico/tachado/código inline/spoiler) nunca são divididos entre
  chunks; o renderizador reabre os estilos dentro de cada chunk.

Se você precisar de mais detalhes sobre o comportamento de chunking entre canais, veja
[Streaming + chunking](/concepts/streaming).

## Política de links

- **Slack:** `[label](url)` -> `<url|label>`; URLs simples permanecem simples. O autolink
  é desativado durante o parse para evitar linkagem dupla.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (modo de parse HTML).
- **Signal:** `[label](url)` -> `label (url)` a menos que o rótulo corresponda à URL.

## Spoilers

Marcadores de spoiler (`||spoiler||`) são analisados apenas para o Signal, onde mapeiam para
intervalos de estilo SPOILER. Outros canais os tratam como texto simples.

## Como adicionar ou atualizar um formatador de canal

1. **Parse uma vez:** use o helper compartilhado `markdownToIR(...)` com opções apropriadas ao canal
   (autolink, estilo de cabeçalho, prefixo de blockquote).
2. **Renderizar:** implemente um renderizador com `renderMarkdownWithMarkers(...)` e um
   mapa de marcadores de estilo (ou intervalos de estilo do Signal).
3. **Chunk:** chame `chunkMarkdownIR(...)` antes de renderizar; renderize cada chunk.
4. **Conectar o adaptador:** atualize o adaptador de saída do canal para usar o novo chunker
   e renderizador.
5. **Testar:** adicione ou atualize testes de formatação e um teste de entrega de saída se o
   canal usar chunking.

## Armadilhas comuns

- Tokens entre colchetes angulares do Slack (`<@U123>`, `<#C123>`, `<https://...>`) devem ser
  preservados; escape HTML bruto com segurança.
- O HTML do Telegram exige escapar o texto fora das tags para evitar markup quebrado.
- Os intervalos de estilo do Signal dependem de offsets UTF-16; não use offsets por ponto de código.
- Preserve novas linhas finais para blocos de código cercados para que os marcadores de fechamento
  caiam em sua própria linha.
