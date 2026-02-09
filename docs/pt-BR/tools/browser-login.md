---
summary: "Logins manuais para automação de navegador + postagem no X/Twitter"
read_when:
  - Você precisa fazer login em sites para automação de navegador
  - Você quer publicar atualizações no X/Twitter
title: "Login no navegador"
---

# Login no navegador + postagem no X/Twitter

## Login manual (recomendado)

Quando um site exigir login, **entre manualmente** no perfil do navegador do **host** (o navegador do OpenClaw).

**Não** forneça suas credenciais ao modelo. Logins automatizados costumam acionar defesas anti‑bot e podem bloquear a conta.

Voltar para a documentação principal do navegador: [Browser](/tools/browser).

## Qual perfil do Chrome é usado?

O OpenClaw controla um **perfil dedicado do Chrome** (chamado `openclaw`, UI com tonalidade laranja). Ele é separado do seu perfil de navegador do dia a dia.

Duas maneiras fáceis de acessá‑lo:

1. **Peça ao agente para abrir o navegador** e depois faça login você mesmo.
2. **Abra via CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Se você tiver vários perfis, passe `--browser-profile <name>` (o padrão é `openclaw`).

## X/Twitter: fluxo recomendado

- **Leitura/pesquisa/threads:** use o navegador do **host** (login manual).
- **Publicar atualizações:** use o navegador do **host** (login manual).

## Sandboxing + acesso ao navegador do host

Sessões de navegador em sandbox têm **maior probabilidade** de acionar detecção de bots. Para X/Twitter (e outros sites rigorosos), prefira o navegador do **host**.

Se o agente estiver em sandbox, a ferramenta de navegador usa o sandbox por padrão. Para permitir controle do host:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Depois, aponte para o navegador do host:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Ou desative o sandboxing para o agente que publica atualizações.
