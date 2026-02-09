---
summary: "Referência da CLI para `openclaw plugins` (listar, instalar, ativar/desativar, diagnóstico)"
read_when:
  - Voce quer instalar ou gerenciar plugins do Gateway em processo
  - Voce quer depurar falhas de carregamento de plugins
title: "plugins"
---

# `openclaw plugins`

Gerencie plugins/extensões do Gateway (carregados em processo).

Relacionado:

- Sistema de plugins: [Plugins](/tools/plugin)
- Manifesto + esquema de plugin: [Plugin manifest](/plugins/manifest)
- Endurecimento de segurança: [Security](/gateway/security)

## Comandos

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Plugins incluídos vêm com o OpenClaw, mas começam desativados. Use `plugins enable` para
ativá-los.

Todos os plugins devem incluir um arquivo `openclaw.plugin.json` com um JSON Schema embutido
(`configSchema`, mesmo que vazio). Manifestos ou esquemas ausentes/inválidos impedem
o carregamento do plugin e fazem a validação de configuração falhar.

### Instalar

```bash
openclaw plugins install <path-or-spec>
```

Nota de segurança: trate instalações de plugins como execução de código. Prefira versões fixadas.

Arquivos suportados: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` para evitar copiar um diretório local (adiciona a `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Atualizar

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

As atualizações se aplicam apenas a plugins instalados via npm (rastreados em `plugins.installs`).
