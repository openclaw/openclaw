---
summary: "Guia de configuração para desenvolvedores que trabalham no app macOS do OpenClaw"
read_when:
  - Configurando o ambiente de desenvolvimento macOS
title: "Configuração de Desenvolvimento macOS"
---

# Configuração de Desenvolvedor macOS

Este guia cobre as etapas necessárias para compilar e executar o aplicativo macOS do OpenClaw a partir do código-fonte.

## Pré-requisitos

Antes de compilar o app, verifique se voce tem o seguinte instalado:

1. **Xcode 26.2+**: Necessário para desenvolvimento em Swift.
2. **Node.js 22+ & pnpm**: Necessários para o gateway, a CLI e os scripts de empacotamento.

## 1) Instalar dependências

Instale as dependências de todo o projeto:

```bash
pnpm install
```

## 2. Compilar e empacotar o app

Para compilar o app macOS e empacotá-lo em `dist/OpenClaw.app`, execute:

```bash
./scripts/package-mac-app.sh
```

Se voce não tiver um certificado Apple Developer ID, o script usará automaticamente **assinatura ad-hoc** (`-`).

Para modos de execução de desenvolvimento, flags de assinatura e solução de problemas de Team ID, veja o README do app macOS:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Nota**: Apps assinados ad-hoc podem acionar avisos de segurança. Se o app travar imediatamente com "Abort trap 6", veja a seção [Solução de problemas](#solução-de-problemas).

## 3. Instalar a CLI

O app macOS espera uma instalação global da CLI `openclaw` para gerenciar tarefas em segundo plano.

**Para instalar (recomendado):**

1. Abra o app OpenClaw.
2. Vá para a aba de configurações **General**.
3. Clique em **"Install CLI"**.

Alternativamente, instale manualmente:

```bash
npm install -g openclaw@<version>
```

## Solução de problemas

### Falha na compilação: incompatibilidade de toolchain ou SDK

A compilação do app macOS espera o SDK mais recente do macOS e a toolchain Swift 6.2.

**Dependências do sistema (obrigatórias):**

- **Versão mais recente do macOS disponível no Software Update** (exigida pelos SDKs do Xcode 26.2)
- **Xcode 26.2** (toolchain Swift 6.2)

**Verificações:**

```bash
xcodebuild -version
xcrun swift --version
```

Se as versões não corresponderem, atualize o macOS/Xcode e execute a compilação novamente.

### App trava ao conceder permissões

Se o app travar quando voce tenta permitir acesso a **Reconhecimento de Fala** ou **Microfone**, isso pode ocorrer devido a um cache TCC corrompido ou incompatibilidade de assinatura.

**Correção:**

1. Redefina as permissões do TCC:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Se isso não funcionar, altere temporariamente o `BUNDLE_ID` em [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) para forçar um "estado limpo" do macOS.

### Gateway "Starting..." indefinidamente

Se o status do Gateway permanecer em "Starting...", verifique se um processo zumbi está ocupando a porta:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Se uma execução manual estiver ocupando a porta, encerre esse processo (Ctrl+C). Como último recurso, finalize o PID encontrado acima.
