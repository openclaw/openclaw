---
summary: "Push do Gmail Pub/Sub integrado aos webhooks do OpenClaw via gogcli"
read_when:
  - Conectando gatilhos da caixa de entrada do Gmail ao OpenClaw
  - Configurando push do Pub/Sub para despertar o agente
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

Objetivo: monitoramento do Gmail -> push do Pub/Sub -> `gog gmail watch serve` -> webhook do OpenClaw.

## Pré-requisitos

- `gcloud` instalado e com login efetuado ([guia de instalação](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) instalado e autorizado para a conta do Gmail ([gogcli.sh](https://gogcli.sh/)).
- Hooks do OpenClaw habilitados (veja [Webhooks](/automation/webhook)).
- `tailscale` com login efetuado ([tailscale.com](https://tailscale.com/)). A configuração suportada usa o Tailscale Funnel para o endpoint HTTPS público.
  Outros serviços de túnel podem funcionar, mas são DIY/não suportados e exigem configuração manual.
  No momento, o Tailscale é o que oferecemos suporte.

Exemplo de configuração do hook (habilita o mapeamento predefinido do Gmail):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Para entregar o resumo do Gmail a uma superfície de chat, substitua o preset por um mapeamento
que defina `deliver` + opcional `channel`/`to`:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

Se você quiser um canal fixo, defina `channel` + `to`. Caso contrário, `channel: "last"`
usa a última rota de entrega (retorna para o WhatsApp).

Para forçar um modelo mais barato para execuções do Gmail, defina `model` no mapeamento
(`provider/model` ou alias). Se você aplicar `agents.defaults.models`, inclua-o ali.

Para definir um modelo padrão e nível de pensamento especificamente para hooks do Gmail, adicione
`hooks.gmail.model` / `hooks.gmail.thinking` na sua configuração:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

Notas:

- `model`/`thinking` por hook no mapeamento ainda substitui esses padrões.
- Ordem de fallback: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → primário (autenticação/limite de taxa/timeouts).
- Se `agents.defaults.models` estiver definido, o modelo do Gmail deve estar na lista de permissões.
- O conteúdo do hook do Gmail é envolvido por limites de segurança de conteúdo externo por padrão.
  Para desativar (perigoso), defina `hooks.gmail.allowUnsafeExternalContent: true`.
  Para desativar (perigoso), defina `hooks.gmail.allowUnsafeExternalContent: true`.

Para personalizar ainda mais o tratamento do payload, adicione `hooks.mappings` ou um módulo de transformação JS/TS
em `hooks.transformsDir` (veja [Webhooks](/automation/webhook)).

## Assistente (recomendado)

Use o helper do OpenClaw para conectar tudo (instala dependências no macOS via brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Padrões:

- Usa o Tailscale Funnel para o endpoint público de push.
- Grava a configuração `hooks.gmail` para `openclaw webhooks gmail run`.
- Habilita o preset de hook do Gmail (`hooks.presets: ["gmail"]`).

Nota sobre caminho: quando `tailscale.mode` está habilitado, o OpenClaw define automaticamente
`hooks.gmail.serve.path` como `/` e mantém o caminho público em
`hooks.gmail.tailscale.path` (padrão `/gmail-pubsub`) porque o Tailscale
remove o prefixo set-path antes de fazer o proxy.
Se você precisar que o backend receba o caminho com prefixo, defina
`hooks.gmail.tailscale.target` (ou `--tailscale-target`) para uma URL completa como
`http://127.0.0.1:8788/gmail-pubsub` e corresponda `hooks.gmail.serve.path`.

Quer um endpoint personalizado? Use `--push-endpoint <url>` ou `--tailscale off`.

Nota de plataforma: no macOS o assistente instala `gcloud`, `gogcli` e `tailscale`
via Homebrew; no Linux, instale-os manualmente antes.

Inicialização automática do Gateway (recomendado):

- Quando `hooks.enabled=true` e `hooks.gmail.account` estão definidos, o Gateway inicia
  `gog gmail watch serve` na inicialização e renova automaticamente o watch.
- Defina `OPENCLAW_SKIP_GMAIL_WATCHER=1` para optar por não usar (útil se você executa o daemon por conta própria).
- Não execute o daemon manual ao mesmo tempo, ou você enfrentará
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Daemon manual (inicia `gog gmail watch serve` + renovação automática):

```bash
openclaw webhooks gmail run
```

## Configuração única

1. Selecione o projeto do GCP **que possui o cliente OAuth** usado por `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Nota: o watch do Gmail exige que o tópico do Pub/Sub esteja no mesmo projeto que o cliente OAuth.

2. Habilite as APIs:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Crie um tópico:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Permita que o push do Gmail publique:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Iniciar o watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Salve o `history_id` da saída (para depuração).

## Executar o handler de push

Exemplo local (autenticação por token compartilhado):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Notas:

- `--token` protege o endpoint de push (`x-gog-token` ou `?token=`).
- `--hook-url` aponta para o OpenClaw `/hooks/gmail` (mapeado; execução isolada + resumo para o principal).
- `--include-body` e `--max-bytes` controlam o trecho do corpo enviado ao OpenClaw.

Recomendado: `openclaw webhooks gmail run` envolve o mesmo fluxo e renova automaticamente o watch.

## Expor o handler (avançado, não suportado)

Se você precisar de um túnel que não seja Tailscale, conecte manualmente e use a URL pública na
assinatura de push (não suportado, sem proteções):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Use a URL gerada como endpoint de push:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Produção: use um endpoint HTTPS estável e configure OIDC JWT do Pub/Sub, depois execute:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Teste

Envie uma mensagem para a caixa de entrada monitorada:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Verifique o estado do watch e o histórico:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Solução de problemas

- `Invalid topicName`: incompatibilidade de projeto (tópico não está no projeto do cliente OAuth).
- `User not authorized`: falta de `roles/pubsub.publisher` no tópico.
- Mensagens vazias: o push do Gmail fornece apenas `historyId`; busque via `gog gmail history`.

## Limpeza

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
