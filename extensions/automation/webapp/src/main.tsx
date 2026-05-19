import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppRoot } from '@telegram-apps/telegram-ui'
import '@telegram-apps/telegram-ui/dist/styles.css'
import './index.css'
import App from './App.tsx'

type TelegramWebAppBridge = {
  ready?: () => void
  expand?: () => void
  requestFullscreen?: () => void
}

function initTelegramWebApp(): void {
  const bridge = (window as Window & {
    Telegram?: { WebApp?: TelegramWebAppBridge }
  }).Telegram?.WebApp

  try {
    bridge?.ready?.()
    bridge?.expand?.()
    bridge?.requestFullscreen?.()
  } catch {
    // 在非 Telegram 環境忽略初始化錯誤，保留本機開發可用性。
  }
}

initTelegramWebApp()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot>
      <BrowserRouter basename="/superclaw/">
        <App />
      </BrowserRouter>
    </AppRoot>
  </StrictMode>,
)
