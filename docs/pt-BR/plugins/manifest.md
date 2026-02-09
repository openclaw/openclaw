---
summary: "Manifesto de plugin + requisitos de esquema JSON (validação estrita de configuração)"
read_when:
  - Você está criando um plugin do OpenClaw
  - Você precisa distribuir um esquema de configuração de plugin ou depurar erros de validação de plugin
title: "Manifesto de Plugin"
---

# Manifesto de plugin (openclaw.plugin.json)

Todo plugin **deve** incluir um arquivo `openclaw.plugin.json` na **raiz do plugin**.
O OpenClaw usa esse manifesto para validar a configuração **sem executar código do plugin**. Manifestos ausentes ou inválidos são tratados como erros de plugin e bloqueiam a
validação de configuração.

Veja o guia completo do sistema de plugins: [Plugins](/tools/plugin).

## Campos obrigatórios

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Chaves obrigatórias:

- `id` (string): id canônico do plugin.
- `configSchema` (object): JSON Schema para a configuração do plugin (inline).

Chaves opcionais:

- `kind` (string): tipo do plugin (exemplo: `"memory"`).
- `channels` (array): ids de canais registrados por este plugin (exemplo: `["matrix"]`).
- `providers` (array): ids de provedores registrados por este plugin.
- `skills` (array): diretórios de Skills a carregar (relativos à raiz do plugin).
- `name` (string): nome de exibição do plugin.
- `description` (string): resumo curto do plugin.
- `uiHints` (object): rótulos/placeholders/flags de sensibilidade de campos de configuração para renderização na UI.
- `version` (string): versão do plugin (informativo).

## Requisitos do JSON Schema

- **Todo plugin deve incluir um JSON Schema**, mesmo que não aceite configuração.
- Um esquema vazio é aceitável (por exemplo, `{ "type": "object", "additionalProperties": false }`).
- Os esquemas são validados no momento de leitura/gravação da configuração, não em tempo de execução.

## Comportamento de validação

- Chaves `channels.*` desconhecidas são **erros**, a menos que o id do canal seja declarado por
  um manifesto de plugin.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` e `plugins.slots.*`
  devem referenciar ids de plugin **descobertos**. Ids desconhecidos são **erros**.
- Se um plugin estiver instalado, mas tiver um manifesto ou esquema quebrado ou ausente,
  a validação falha e o Doctor reporta o erro do plugin.
- Se existir configuração de plugin, mas o plugin estiver **desativado**, a configuração é mantida e
  um **aviso** é exibido no Doctor + logs.

## Notas

- O manifesto é **obrigatório para todos os plugins**, incluindo carregamentos do sistema de arquivos local.
- O runtime ainda carrega o módulo do plugin separadamente; o manifesto é apenas para
  descoberta + validação.
- Se o seu plugin depender de módulos nativos, documente as etapas de build e quaisquer
  requisitos de lista de permissões do gerenciador de pacotes (por exemplo, pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
