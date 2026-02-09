---
summary: "Referência da CLI para `openclaw configure` (prompts interativos de configuração)"
read_when:
  - Você quer ajustar credenciais, dispositivos ou padrões do agente de forma interativa
title: "configurar"
---

# `openclaw configure`

Prompt interativo para configurar credenciais, dispositivos e padrões do agente.

Nota: A seção **Model** agora inclui uma seleção múltipla para a lista de permissões `agents.defaults.models` (o que aparece em `/model` e no seletor de modelos).

Dica: `openclaw config` sem um subcomando abre o mesmo assistente. Use
`openclaw config get|set|unset` para edições não interativas.

Relacionados:

- Referência de configuração do Gateway: [Configuration](/gateway/configuration)
- CLI de Configuração: [Config](/cli/config)

Notas:

- Escolher onde o Gateway é executado sempre atualiza `gateway.mode`. Você pode selecionar "Continuar" sem outras seções se isso for tudo de que precisa.
- Serviços orientados a canais (Slack/Discord/Matrix/Microsoft Teams) solicitam listas de permissões de canais/salas durante a configuração. Você pode inserir nomes ou IDs; o assistente resolve nomes para IDs quando possível.

## Exemplos

```bash
openclaw configure
openclaw configure --section models --section channels
```
