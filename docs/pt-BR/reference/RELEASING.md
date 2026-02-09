---
summary: "Checklist de lançamento passo a passo para npm + app macOS"
read_when:
  - Cortar um novo lançamento npm
  - Cortar um novo lançamento do app macOS
  - Verificar metadados antes de publicar
---

# Checklist de Lançamento (npm + macOS)

Use `pnpm` (Node 22+) a partir da raiz do repositório. Mantenha a árvore de trabalho limpa antes de marcar/publicar.

## Gatilho do operador

Quando o operador disser “release”, faça imediatamente este preflight (sem perguntas extras, a menos que esteja bloqueado):

- Leia este documento e `docs/platforms/mac/release.md`.
- Carregue as variáveis de ambiente de `~/.profile` e confirme que `SPARKLE_PRIVATE_KEY_FILE` + as variáveis do App Store Connect estão definidas (SPARKLE_PRIVATE_KEY_FILE deve ficar em `~/.profile`).
- Use as chaves do Sparkle de `~/Library/CloudStorage/Dropbox/Backup/Sparkle` se necessário.

1. **Versão & metadados**

- [ ] Atualize a versão de `package.json` (por exemplo, `2026.1.29`).
- [ ] Execute `pnpm plugins:sync` para alinhar as versões dos pacotes de extensões + changelogs.
- [ ] Atualize as strings de versão da CLI: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) e o user agent do Baileys em [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] Confirme os metadados do pacote (nome, descrição, repositório, palavras-chave, licença) e se o mapa de `bin` aponta para [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) para `openclaw`.
- [ ] Se as dependências mudaram, execute `pnpm install` para que `pnpm-lock.yaml` esteja atual.

2. **Build & artefatos**

- [ ] Se as entradas do A2UI mudaram, execute `pnpm canvas:a2ui:bundle` e faça commit de qualquer [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) atualizado.
- [ ] `pnpm run build` (regenera `dist/`).
- [ ] Verifique se o pacote npm `files` inclui todas as pastas `dist/*` necessárias (notavelmente `dist/node-host/**` e `dist/acp/**` para node headless + ACP CLI).
- [ ] Confirme que `dist/build-info.json` existe e inclui o hash `commit` esperado (o banner da CLI usa isso para instalações via npm).
- [ ] Opcional: `npm pack --pack-destination /tmp` após o build; inspecione o conteúdo do tarball e mantenha-o à mão para o release no GitHub (não faça commit).

3. **Changelog & docs**

- [ ] Atualize `CHANGELOG.md` com destaques voltados ao usuario (crie o arquivo se não existir); mantenha as entradas estritamente em ordem decrescente por versão.
- [ ] Garanta que exemplos/flags do README correspondam ao comportamento atual da CLI (notavelmente novos comandos ou opções).

4. **Validação**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (ou `pnpm test:coverage` se voce precisar de saída de cobertura)
- [ ] `pnpm release:check` (verifica o conteúdo do npm pack)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (smoke test de instalação via Docker, caminho rápido; obrigatório antes do lançamento)
  - Se o lançamento npm imediatamente anterior for conhecido como quebrado, defina `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` ou `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` para a etapa de preinstall.
- [ ] (Opcional) Smoke completo do instalador (adiciona cobertura de não-root + CLI): `pnpm test:install:smoke`
- [ ] (Opcional) E2E do instalador (Docker, executa `curl -fsSL https://openclaw.ai/install.sh | bash`, faz onboarding e depois executa chamadas reais de ferramentas):
  - `pnpm test:install:e2e:openai` (requer `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (requer `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (requer ambas as chaves; executa ambos os provedores)
- [ ] (Opcional) Faça um spot-check do web gateway se suas mudanças afetarem caminhos de envio/recebimento.

5. **App macOS (Sparkle)**

- [ ] Faça o build + assinatura do app macOS e depois compacte em zip para distribuição.
- [ ] Gere o appcast do Sparkle (notas em HTML via [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) e atualize `appcast.xml`.
- [ ] Mantenha o zip do app (e o zip dSYM opcional) prontos para anexar ao release do GitHub.
- [ ] Siga [macOS release](/platforms/mac/release) para os comandos exatos e as variáveis de ambiente necessárias.
  - `APP_BUILD` deve ser numérico + monotônico (sem `-beta`) para que o Sparkle compare versões corretamente.
  - Se for notarizar, use o perfil de chaveiro `openclaw-notary` criado a partir das variáveis de ambiente da API do App Store Connect (veja [macOS release](/platforms/mac/release)).

6. **Publicar (npm)**

- [ ] Confirme que o status do git está limpo; faça commit e push conforme necessário.
- [ ] `npm login` (verifique o 2FA), se necessário.
- [ ] `npm publish --access public` (use `--tag beta` para pré-lançamentos).
- [ ] Verifique o registry: `npm view openclaw version`, `npm view openclaw dist-tags` e `npx -y openclaw@X.Y.Z --version` (ou `--help`).

### Solução de problemas (notas do lançamento 2.0.0-beta2)

- **npm pack/publish trava ou produz um tarball enorme**: o bundle do app macOS em `dist/OpenClaw.app` (e zips de release) é varrido para dentro do pacote. Corrija fazendo whitelist do conteúdo publicado via `package.json` `files` (inclua subdirs dist, docs, skills; exclua bundles de app). Confirme com `npm pack --dry-run` que `dist/OpenClaw.app` não está listado.
- **Loop de autenticação web do npm para dist-tags**: use autenticação legada para obter o prompt de OTP:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **Falha na verificação de `npx` com `ECOMPROMISED: Lock compromised`**: tente novamente com um cache novo:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Tag precisa ser repontada após um ajuste tardio**: force a atualização e faça push da tag, depois garanta que os assets do release no GitHub ainda correspondam:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **Release no GitHub + appcast**

- [ ] Marque a tag e faça push: `git tag vX.Y.Z && git push origin vX.Y.Z` (ou `git push --tags`).
- [ ] Crie/atualize o release do GitHub para `vX.Y.Z` com **título `openclaw X.Y.Z`** (não apenas a tag); o corpo deve incluir a seção **completa** do changelog para essa versão (Destaques + Mudanças + Correções), inline (sem links soltos), e **não deve repetir o título dentro do corpo**.
- [ ] Anexe os artefatos: tarball `npm pack` (opcional), `OpenClaw-X.Y.Z.zip` e `OpenClaw-X.Y.Z.dSYM.zip` (se gerado).
- [ ] Faça commit do `appcast.xml` atualizado e faça push (o Sparkle consome a partir da main).
- [ ] A partir de um diretório temporário limpo (sem `package.json`), execute `npx -y openclaw@X.Y.Z send --help` para confirmar que a instalação/entrypoints da CLI funcionam.
- [ ] Anuncie/compartilhe as notas de lançamento.

## Escopo de publicação de plugins (npm)

Publicamos apenas **plugins npm existentes** sob o escopo `@openclaw/*`. Plugins
empacotados que não estão no npm permanecem **apenas na árvore do disco** (ainda enviados em
`extensions/**`).

Processo para derivar a lista:

1. Execute `npm search @openclaw --json` e capture os nomes dos pacotes.
2. Compare com os nomes em `extensions/*/package.json`.
3. Publique apenas a **interseção** (já existentes no npm).

Lista atual de plugins npm (atualize conforme necessário):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

As notas de lançamento também devem destacar **novos plugins empacotados opcionais** que **não
ficam ativados por padrão** (exemplo: `tlon`).
