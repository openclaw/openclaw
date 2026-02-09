---
summary: "Extensão do Chrome: deixe o OpenClaw controlar sua aba existente do Chrome"
read_when:
  - Você quer que o agente controle uma aba existente do Chrome (botão na barra de ferramentas)
  - Você precisa de Gateway remoto + automação de navegador local via Tailscale
  - Você quer entender as implicações de segurança da tomada de controle do navegador
title: "Extensão do Chrome"
---

# Extensão do Chrome (relay do navegador)

A extensão do OpenClaw para Chrome permite que o agente controle suas **abas existentes do Chrome** (sua janela normal do Chrome) em vez de iniciar um perfil do Chrome separado gerenciado pelo OpenClaw.

O anexar/desanexar acontece por meio de **um único botão na barra de ferramentas do Chrome**.

## O que é (conceito)

Há três partes:

- **Serviço de controle do navegador** (Gateway ou node): a API que o agente/ferramenta chama (via o Gateway)
- **Servidor de relay local** (CDP em loopback): faz a ponte entre o servidor de controle e a extensão (`http://127.0.0.1:18792` por padrão)
- **Extensão Chrome MV3**: anexa à aba ativa usando `chrome.debugger` e encaminha mensagens CDP para o relay

O OpenClaw então controla a aba anexada por meio da superfície normal da ferramenta `browser` (selecionando o perfil correto).

## Instalar / carregar (descompactado)

1. Instale a extensão em um caminho local estável:

```bash
openclaw browser extension install
```

2. Imprima o caminho do diretório da extensão instalada:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Ative “Modo do desenvolvedor”
- “Carregar sem compactação” → selecione o diretório impresso acima

4. Fixe a extensão.

## Atualizações (sem etapa de build)

A extensão é distribuída dentro da release do OpenClaw (pacote npm) como arquivos estáticos. Não há uma etapa separada de “build”.

Após atualizar o OpenClaw:

- Reexecute `openclaw browser extension install` para atualizar os arquivos instalados no diretório de estado do OpenClaw.
- Chrome → `chrome://extensions` → clique em “Recarregar” na extensão.

## Usar (sem configuração extra)

O OpenClaw vem com um perfil de navegador integrado chamado `chrome` que aponta para o relay da extensão na porta padrão.

Use assim:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Ferramenta do agente: `browser` com `profile="chrome"`

Se você quiser um nome diferente ou uma porta de relay diferente, crie seu próprio perfil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Anexar / desanexar (botão da barra de ferramentas)

- Abra a aba que você quer que o OpenClaw controle.
- Clique no ícone da extensão.
  - O badge mostra `ON` quando anexado.
- Clique novamente para desanexar.

## Qual aba ele controla?

- Ele **não** controla automaticamente “qualquer aba que você esteja vendo”.
- Ele controla **apenas a(s) aba(s) que você anexou explicitamente** clicando no botão da barra de ferramentas.
- Para alternar: abra a outra aba e clique no ícone da extensão nela.

## Badge + erros comuns

- `ON`: anexado; o OpenClaw pode controlar essa aba.
- `…`: conectando ao relay local.
- `!`: relay não alcançável (mais comum: o servidor de relay do navegador não está em execução nesta máquina).

Se você vir `!`:

- Certifique-se de que o Gateway está em execução localmente (configuração padrão) ou execute um host de node nesta máquina se o Gateway estiver em outro lugar.
- Abra a página de Opções da extensão; ela mostra se o relay está acessível.

## Gateway remoto (use um host de node)

### Gateway local (mesma máquina do Chrome) — geralmente **sem etapas extras**

Se o Gateway roda na mesma máquina do Chrome, ele inicia o serviço de controle do navegador em loopback
e inicia automaticamente o servidor de relay. A extensão conversa com o relay local; as chamadas da CLI/ferramenta vão para o Gateway.

### Gateway remoto (Gateway roda em outro lugar) — **execute um host de node**

Se o seu Gateway roda em outra máquina, inicie um host de node na máquina que executa o Chrome.
O Gateway fará proxy das ações do navegador para esse node; a extensão + relay permanecem locais na máquina do navegador.

Se vários nodes estiverem conectados, fixe um com `gateway.nodes.browser.node` ou defina `gateway.nodes.browser.mode`.

## Sandboxing (containers de ferramentas)

Se sua sessão de agente estiver em sandbox (`agents.defaults.sandbox.mode != "off"`), a ferramenta `browser` pode ser restrita:

- Por padrão, sessões em sandbox geralmente apontam para o **navegador de sandbox** (`target="sandbox"`), não para o seu Chrome do host.
- A tomada de controle via relay da extensão do Chrome exige controlar o servidor de controle do navegador do **host**.

Opções:

- Mais fácil: use a extensão a partir de uma sessão/agente **fora de sandbox**.
- Ou permita o controle do navegador do host para sessões em sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Depois, garanta que a ferramenta não seja negada pela política de ferramentas e (se necessário) chame `browser` com `target="host"`.

Depuração: `openclaw sandbox explain`

## Dicas de acesso remoto

- Mantenha o Gateway e o host de node na mesma tailnet; evite expor portas de relay para a LAN ou Internet pública.
- Pareie nodes intencionalmente; desative o roteamento de proxy do navegador se você não quiser controle remoto (`gateway.nodes.browser.mode="off"`).

## Como funciona o “caminho da extensão”

`openclaw browser extension path` imprime o diretório **instalado** em disco que contém os arquivos da extensão.

A CLI intencionalmente **não** imprime um caminho de `node_modules`. Sempre execute `openclaw browser extension install` primeiro para copiar a extensão para um local estável dentro do diretório de estado do OpenClaw.

Se você mover ou excluir esse diretório de instalação, o Chrome marcará a extensão como quebrada até que você a recarregue a partir de um caminho válido.

## Implicações de segurança (leia isto)

Isso é poderoso e arriscado. Trate como se estivesse dando ao modelo “mãos no seu navegador”.

- A extensão usa a API de depuração do Chrome (`chrome.debugger`). Quando anexada, o modelo pode:
  - click/type/navegue nessa aba
  - ler o conteúdo da página
  - acessar tudo o que a sessão logada da aba puder acessar
- **Isso não é isolado** como o perfil dedicado gerenciado pelo OpenClaw.
  - Se você anexar ao seu perfil/aba de uso diário, estará concedendo acesso a esse estado de conta.

Recomendações:

- Prefira um perfil dedicado do Chrome (separado da sua navegação pessoal) para uso do relay da extensão.
- Mantenha o Gateway e quaisquer hosts de node apenas na tailnet; confie na autenticação do Gateway + pareamento de nodes.
- Evite expor portas de relay pela LAN (`0.0.0.0`) e evite Funnel (público).
- O relay bloqueia origens que não sejam da extensão e exige um token de autenticação interno para clientes CDP.

Relacionado:

- Visão geral da ferramenta de navegador: [Browser](/tools/browser)
- Auditoria de segurança: [Security](/gateway/security)
- Configuração do Tailscale: [Tailscale](/gateway/tailscale)
