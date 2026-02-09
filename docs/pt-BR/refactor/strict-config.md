---
summary: "Validação estrita de configuração + migrações apenas via Doctor"
read_when:
  - Ao projetar ou implementar comportamento de validação de configuração
  - Ao trabalhar em migrações de configuração ou fluxos do Doctor
  - Ao lidar com esquemas de configuração de plugins ou bloqueio de carregamento de plugins
title: "Validação estrita de configuração"
---

# Validação estrita de configuração (migrações apenas via Doctor)

## Objetivos

- **Rejeitar chaves de configuração desconhecidas em todos os lugares** (raiz + aninhadas).
- **Rejeitar configuração de plugin sem um esquema**; não carregar esse plugin.
- **Remover auto-migração legada no carregamento**; migrações rodam apenas via Doctor.
- **Executar automaticamente o Doctor (dry-run) na inicialização**; se inválido, bloquear comandos não diagnósticos.

## Não objetivos

- Compatibilidade retroativa no carregamento (chaves legadas não são auto-migradas).
- Remoção silenciosa de chaves não reconhecidas.

## Regras de validação estrita

- A configuração deve corresponder exatamente ao esquema em todos os níveis.
- Chaves desconhecidas são erros de validação (sem passthrough na raiz ou em níveis aninhados).
- `plugins.entries.<id>.config` deve ser validado pelo esquema do plugin.
  - Se um plugin não tiver um esquema, **rejeitar o carregamento do plugin** e apresentar um erro claro.
- Chaves `channels.<id>` desconhecidas são erros, a menos que um manifesto de plugin declare o id do canal.
- Manifestos de plugin (`openclaw.plugin.json`) são obrigatórios para todos os plugins.

## Aplicação de esquema de plugin

- Cada plugin fornece um JSON Schema estrito para sua configuração (inline no manifesto).
- Fluxo de carregamento do plugin:
  1. Resolver manifesto do plugin + esquema (`openclaw.plugin.json`).
  2. Validar a configuração contra o esquema.
  3. Se faltar esquema ou a configuração for inválida: bloquear o carregamento do plugin e registrar o erro.
- A mensagem de erro inclui:
  - ID do plugin
  - Motivo (esquema ausente / configuração inválida)
  - Caminho(s) que falharam na validação
- Plugins desativados mantêm sua configuração, mas o Doctor + logs exibem um aviso.

## Fluxo do Doctor

- O Doctor roda **toda vez** que a configuração é carregada (dry-run por padrão).
- Se a configuração for inválida:
  - Imprimir um resumo + erros acionáveis.
  - Instruir: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Aplica migrações.
  - Remove chaves desconhecidas.
  - Grava a configuração atualizada.

## Bloqueio de comandos (quando a configuração é inválida)

Permitidos (apenas diagnósticos):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Todo o restante deve falhar de forma rígida com: “Configuração inválida. Execute `openclaw doctor --fix`.”

## Formato de UX de erro

- Um único cabeçalho de resumo.
- Seções agrupadas:
  - Chaves desconhecidas (caminhos completos)
  - Chaves legadas / migrações necessárias
  - Falhas de carregamento de plugins (id do plugin + motivo + caminho)

## Pontos de implementação

- `src/config/zod-schema.ts`: remover passthrough na raiz; objetos estritos em todos os lugares.
- `src/config/zod-schema.providers.ts`: garantir esquemas de canal estritos.
- `src/config/validation.ts`: falhar em chaves desconhecidas; não aplicar migrações legadas.
- `src/config/io.ts`: remover auto-migrações legadas; sempre executar Doctor em dry-run.
- `src/config/legacy*.ts`: mover o uso para apenas Doctor.
- `src/plugins/*`: adicionar registro de esquemas + bloqueio.
- Bloqueio de comandos da CLI em `src/cli`.

## Testes

- Rejeição de chave desconhecida (raiz + aninhadas).
- Plugin sem esquema → carregamento do plugin bloqueado com erro claro.
- Configuração inválida → inicialização do gateway bloqueada, exceto comandos de diagnóstico.
- Doctor em dry-run automático; `doctor --fix` grava a configuração corrigida.
