---
summary: "Guia do ClawHub: registro público de skills + fluxos de trabalho da CLI"
read_when:
  - Apresentando o ClawHub a novos usuários
  - Instalando, buscando ou publicando skills
  - Explicando flags da CLI do ClawHub e o comportamento de sincronização
title: "ClawHub"
---

# ClawHub

ClawHub é o **registro público de skills para OpenClaw**. É um serviço gratuito: todas as skills são públicas, abertas e visíveis para todos, para compartilhamento e reutilização. Uma skill é apenas uma pasta com um arquivo `SKILL.md` (além de arquivos de texto de suporte). Você pode navegar pelas skills no app web ou usar a CLI para buscar, instalar, atualizar e publicar skills.

Site: [clawhub.ai](https://clawhub.ai)

## O que é o ClawHub

- Um registro público para skills do OpenClaw.
- Um repositório versionado de pacotes de skills e metadados.
- Uma superfície de descoberta para busca, tags e sinais de uso.

## Como funciona

1. Um usuário publica um pacote de skill (arquivos + metadados).
2. O ClawHub armazena o pacote, analisa os metadados e atribui uma versão.
3. O registro indexa a skill para busca e descoberta.
4. Usuários navegam, baixam e instalam skills no OpenClaw.

## O que você pode fazer

- Publicar novas skills e novas versões de skills existentes.
- Descobrir skills por nome, tags ou busca.
- Baixar pacotes de skills e inspecionar seus arquivos.
- Denunciar skills que sejam abusivas ou inseguras.
- Se você for moderador, ocultar, reexibir, excluir ou banir.

## Para quem é (amigável para iniciantes)

Se você quer adicionar novas capacidades ao seu agente OpenClaw, o ClawHub é a maneira mais fácil de encontrar e instalar skills. Você não precisa saber como o backend funciona. Você pode:

- Buscar skills usando linguagem simples.
- Instalar uma skill no seu workspace.
- Atualizar skills depois com um único comando.
- Fazer backup das suas próprias skills publicando-as.

## Início rápido (não técnico)

1. Instale a CLI (veja a próxima seção).
2. Busque algo de que você precisa:
   - `clawhub search "calendar"`
3. Instale uma skill:
   - `clawhub install <skill-slug>`
4. Inicie uma nova sessão do OpenClaw para que ele reconheça a nova skill.

## Instalar a CLI

Escolha uma opção:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Como isso se encaixa no OpenClaw

Por padrão, a CLI instala skills em `./skills` dentro do seu diretório de trabalho atual. Se um workspace do OpenClaw estiver configurado, `clawhub` recorre a esse workspace, a menos que você sobrescreva `--workdir` (ou `CLAWHUB_WORKDIR`). O OpenClaw carrega skills do workspace a partir de `<workspace>/skills` e as reconhecerá na **próxima** sessão. Se você já usa `~/.openclaw/skills` ou skills empacotadas, as skills do workspace têm precedência.

Para mais detalhes sobre como as skills são carregadas, compartilhadas e controladas, veja
[Skills](/tools/skills).

## Visão geral do sistema de skills

Uma skill é um pacote versionado de arquivos que ensina o OpenClaw a executar uma
tarefa específica. Cada publicação cria uma nova versão, e o registro mantém um
histórico de versões para que os usuários possam auditar mudanças.

Uma skill típica inclui:

- Um arquivo `SKILL.md` com a descrição principal e o uso.
- Configurações, scripts ou arquivos de suporte opcionais usados pela skill.
- Metadados como tags, resumo e requisitos de instalação.

O ClawHub usa metadados para impulsionar a descoberta e expor com segurança as capacidades das skills.
O registro também acompanha sinais de uso (como estrelas e downloads) para melhorar
o ranqueamento e a visibilidade.

## O que o serviço oferece (recursos)

- **Navegação pública** de skills e do conteúdo `SKILL.md`.
- **Busca** alimentada por embeddings (busca vetorial), não apenas por palavras-chave.
- **Versionamento** com semver, changelogs e tags (incluindo `latest`).
- **Downloads** como um zip por versão.
- **Estrelas e comentários** para feedback da comunidade.
- **Moderação** com ganchos para aprovações e auditorias.
- **API amigável à CLI** para automação e scripts.

## Segurança e moderação

O ClawHub é aberto por padrão. Qualquer pessoa pode enviar skills, mas uma conta do GitHub
precisa ter pelo menos uma semana para publicar. Isso ajuda a desacelerar abusos sem bloquear
contribuidores legítimos.

Denúncias e moderação:

- Qualquer usuário autenticado pode denunciar uma skill.
- Motivos de denúncia são obrigatórios e registrados.
- Cada usuário pode ter até 20 denúncias ativas ao mesmo tempo.
- Skills com mais de 3 denúncias únicas são ocultadas automaticamente por padrão.
- Moderadores podem ver skills ocultas, reexibi-las, excluí-las ou banir usuários.
- Abusar do recurso de denúncia pode resultar em banimento da conta.

Interessado em se tornar moderador? Pergunte no Discord do OpenClaw e entre em contato com um
moderador ou mantenedor.

## Comandos e parâmetros da CLI

Opções globais (aplicam-se a todos os comandos):

- `--workdir <dir>`: Diretório de trabalho (padrão: diretório atual; recorre ao workspace do OpenClaw).
- `--dir <dir>`: Diretório de skills, relativo ao workdir (padrão: `skills`).
- `--site <url>`: URL base do site (login pelo navegador).
- `--registry <url>`: URL base da API do registro.
- `--no-input`: Desativar prompts (não interativo).
- `-V, --cli-version`: Imprimir a versão da CLI.

Autenticação:

- `clawhub login` (fluxo pelo navegador) ou `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Opções:

- `--token <token>`: Colar um token de API.
- `--label <label>`: Rótulo armazenado para tokens de login pelo navegador (padrão: `CLI token`).
- `--no-browser`: Não abrir um navegador (requer `--token`).

Busca:

- `clawhub search "query"`
- `--limit <n>`: Máximo de resultados.

Instalação:

- `clawhub install <slug>`
- `--version <version>`: Instalar uma versão específica.
- `--force`: Sobrescrever se a pasta já existir.

Atualização:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Atualizar para uma versão específica (apenas um slug).
- `--force`: Sobrescrever quando arquivos locais não corresponderem a nenhuma versão publicada.

Listagem:

- `clawhub list` (lê `.clawhub/lock.json`)

Publicação:

- `clawhub publish <path>`
- `--slug <slug>`: Slug da skill.
- `--name <name>`: Nome de exibição.
- `--version <version>`: Versão semver.
- `--changelog <text>`: Texto do changelog (pode ser vazio).
- `--tags <tags>`: Tags separadas por vírgula (padrão: `latest`).

Excluir/restaurar (apenas proprietário/admin):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Sincronizar (varrer skills locais + publicar novas/atualizadas):

- `clawhub sync`
- `--root <dir...>`: Raízes extras de varredura.
- `--all`: Enviar tudo sem prompts.
- `--dry-run`: Mostrar o que seria enviado.
- `--bump <type>`: `patch|minor|major` para atualizações (padrão: `patch`).
- `--changelog <text>`: Changelog para atualizações não interativas.
- `--tags <tags>`: Tags separadas por vírgula (padrão: `latest`).
- `--concurrency <n>`: Verificações do registro (padrão: 4).

## Fluxos de trabalho comuns para agentes

### Buscar skills

```bash
clawhub search "postgres backups"
```

### Baixar novas skills

```bash
clawhub install my-skill-pack
```

### Atualizar skills instaladas

```bash
clawhub update --all
```

### Fazer backup das suas skills (publicar ou sincronizar)

Para uma única pasta de skill:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Para varrer e fazer backup de muitas skills de uma vez:

```bash
clawhub sync --all
```

## Detalhes avançados (técnicos)

### Versionamento e tags

- Cada publicação cria uma nova **semver** `SkillVersion`.
- Tags (como `latest`) apontam para uma versão; mover tags permite fazer rollback.
- Changelogs são anexados por versão e podem ficar vazios ao sincronizar ou publicar atualizações.

### Alterações locais vs versões do registro

Atualizações comparam o conteúdo local da skill com versões do registro usando um hash de conteúdo. Se os arquivos locais não corresponderem a nenhuma versão publicada, a CLI pergunta antes de sobrescrever (ou exige `--force` em execuções não interativas).

### Varredura de sincronização e raízes de fallback

`clawhub sync` primeiro varre seu workdir atual. Se nenhuma skill for encontrada, recorre a locais legados conhecidos (por exemplo, `~/openclaw/skills` e `~/.openclaw/skills`). Isso foi projetado para encontrar instalações antigas de skills sem flags extras.

### Armazenamento e arquivo de bloqueio

- Skills instaladas são registradas em `.clawhub/lock.json` dentro do seu workdir.
- Tokens de autenticação são armazenados no arquivo de configuração da CLI do ClawHub (substitua via `CLAWHUB_CONFIG_PATH`).

### Telemetria (contagem de instalações)

Quando você executa `clawhub sync` enquanto está autenticado, a CLI envia um snapshot mínimo para calcular contagens de instalação. Você pode desativar isso completamente:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Variáveis de ambiente

- `CLAWHUB_SITE`: Substituir a URL do site.
- `CLAWHUB_REGISTRY`: Substituir a URL da API do registro.
- `CLAWHUB_CONFIG_PATH`: Substituir onde a CLI armazena o token/configuração.
- `CLAWHUB_WORKDIR`: Substituir o workdir padrão.
- `CLAWHUB_DISABLE_TELEMETRY=1`: Desativar telemetria em `sync`.
