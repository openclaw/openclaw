---
summary: "Execute o OpenClaw em uma VM macOS em sandbox (local ou hospedada) quando voce precisa de isolamento ou iMessage"
read_when:
  - Voce quer o OpenClaw isolado do seu ambiente macOS principal
  - Voce quer integração com iMessage (BlueBubbles) em um sandbox
  - Voce quer um ambiente macOS redefinível que possa ser clonado
  - Voce quer comparar opções de VM macOS local vs hospedada
title: "VMs macOS"
---

# OpenClaw em VMs macOS (Sandboxing)

## Padrão recomendado (maioria dos usuários)

- **VPS Linux pequeno** para um Gateway sempre ativo e baixo custo. Veja [VPS hosting](/vps).
- **Hardware dedicado** (Mac mini ou máquina Linux) se voce quer controle total e um **IP residencial** para automação de navegador. Muitos sites bloqueiam IPs de data center, então a navegação local geralmente funciona melhor.
- **Híbrido:** mantenha o Gateway em um VPS barato e conecte seu Mac como um **nó** quando precisar de automação de navegador/UI. Veja [Nodes](/nodes) e [Gateway remote](/gateway/remote).

Use uma VM macOS quando voce precisar especificamente de recursos exclusivos do macOS (iMessage/BlueBubbles) ou quiser isolamento rigoroso do seu Mac do dia a dia.

## Opções de VM macOS

### VM local no seu Mac Apple Silicon (Lume)

Execute o OpenClaw em uma VM macOS em sandbox no seu Mac Apple Silicon existente usando o [Lume](https://cua.ai/docs/lume).

Isso oferece:

- Ambiente macOS completo em isolamento (seu host permanece limpo)
- Suporte a iMessage via BlueBubbles (impossível em Linux/Windows)
- Redefinição instantânea ao clonar VMs
- Sem hardware extra ou custos de nuvem

### Provedores de Mac hospedado (nuvem)

Se voce quiser macOS na nuvem, provedores de Mac hospedado também funcionam:

- [MacStadium](https://www.macstadium.com/) (Macs hospedados)
- Outros fornecedores de Mac hospedado também funcionam; siga a documentação de VM + SSH deles

Depois de ter acesso SSH a uma VM macOS, continue no passo 6 abaixo.

---

## Caminho rápido (Lume, usuários experientes)

1. Instale o Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Conclua o Assistente de Configuração, ative o Login Remoto (SSH)
4. `lume run openclaw --no-display`
5. Acesse por SSH, instale o OpenClaw, configure os canais
6. Concluído

---

## O que voce precisa (Lume)

- Mac Apple Silicon (M1/M2/M3/M4)
- macOS Sequoia ou posterior no host
- ~60 GB de espaço livre em disco por VM
- ~20 minutos

---

## 1. Instalar o Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Se `~/.local/bin` não estiver no seu PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Verifique:

```bash
lume --version
```

Docs: [Instalação do Lume](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Criar a VM macOS

```bash
lume create openclaw --os macos --ipsw latest
```

Isso baixa o macOS e cria a VM. Uma janela VNC abre automaticamente.

Nota: O download pode levar um tempo dependendo da sua conexão.

---

## 3. Concluir o Assistente de Configuração

Na janela VNC:

1. Selecione idioma e região
2. Pule o Apple ID (ou entre se voce quiser iMessage depois)
3. Crie uma conta de usuário (lembre o nome de usuário e a senha)
4. Pule todos os recursos opcionais

Depois que a configuração terminar, ative o SSH:

1. Abra Ajustes do Sistema → Geral → Compartilhamento
2. Ative "Login Remoto"

---

## 4. Obter o endereço IP da VM

```bash
lume get openclaw
```

Procure o endereço IP (geralmente `192.168.64.x`).

---

## 5. Acessar a VM por SSH

```bash
ssh youruser@192.168.64.X
```

Substitua `youruser` pela conta que voce criou e o IP pelo IP da sua VM.

---

## 6. Instalar o OpenClaw

Dentro da VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Siga os prompts de integração inicial para configurar seu provedor de modelo (Anthropic, OpenAI, etc.).

---

## 7. Configurar canais

Edite o arquivo de configuração:

```bash
nano ~/.openclaw/openclaw.json
```

Adicione seus canais:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Depois faça login no WhatsApp (escaneie o QR):

```bash
openclaw channels login
```

---

## 8. Executar a VM sem interface (headless)

Pare a VM e reinicie sem exibição:

```bash
lume stop openclaw
lume run openclaw --no-display
```

A VM roda em segundo plano. O daemon do OpenClaw mantém o gateway em execução.

Para verificar o status:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bônus: integração com iMessage

Este é o grande diferencial de rodar no macOS. Use o [BlueBubbles](https://bluebubbles.app) para adicionar iMessage ao OpenClaw.

Dentro da VM:

1. Baixe o BlueBubbles em bluebubbles.app
2. Entre com seu Apple ID
3. Ative a Web API e defina uma senha
4. Aponte os webhooks do BlueBubbles para seu gateway (exemplo: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Adicione ao seu config do OpenClaw:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Reinicie o gateway. Agora seu agente pode enviar e receber iMessages.

Detalhes completos de configuração: [BlueBubbles channel](/channels/bluebubbles)

---

## Salvar uma imagem dourada

Antes de personalizar mais, faça um snapshot do estado limpo:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Redefina a qualquer momento:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Executando 24/7

Mantenha a VM em execução:

- Mantendo seu Mac conectado à energia
- Desativando o repouso em Ajustes do Sistema → Economia de Energia
- Usando `caffeinate` se necessário

Para funcionamento realmente contínuo, considere um Mac mini dedicado ou um VPS pequeno. Veja [VPS hosting](/vps).

---

## Solução de problemas

| Problema                          | Solução                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Não consegue acessar a VM por SSH | Verifique se "Login Remoto" está ativado nos Ajustes do Sistema da VM                                     |
| IP da VM não aparece              | Aguarde a VM inicializar totalmente e execute `lume get openclaw` novamente                               |
| Comando do Lume não encontrado    | Adicione `~/.local/bin` ao seu PATH                                                                       |
| QR do WhatsApp não escaneia       | Garanta que voce está logado na VM (não no host) ao executar `openclaw channels login` |

---

## Documentos relacionados

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (avançado)
- [Docker Sandboxing](/install/docker) (abordagem alternativa de isolamento)
