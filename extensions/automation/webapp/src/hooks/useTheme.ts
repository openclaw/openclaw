import { useEffect, useState } from 'react'
import { getTheme } from '../api/telegram-bridge'

type ThemeMode = 'light' | 'dark'

type TelegramThemeParams = Record<string, string>

type TelegramWebAppThemeBridge = {
  colorScheme?: ThemeMode
  themeParams?: TelegramThemeParams
  onEvent?: (eventName: string, handler: () => void) => void
  offEvent?: (eventName: string, handler: () => void) => void
}

type TelegramWindow = Window & {
  Telegram?: {
    WebApp?: TelegramWebAppThemeBridge
  }
}

function camelToKebab(input: string): string {
  return input.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
}

function applyThemeToDom(mode: ThemeMode, params?: TelegramThemeParams): void {
  const root = document.documentElement
  root.setAttribute('data-theme', mode)

  if (!params) {
    return
  }

  Object.entries(params).forEach(([key, value]) => {
    if (!value) {
      return
    }
    root.style.setProperty(`--tg-theme-${camelToKebab(key)}`, value)
  })
}

export function useTheme(): ThemeMode {
  const [theme, setTheme] = useState<ThemeMode>(getTheme())

  useEffect(() => {
    const webApp = (window as TelegramWindow).Telegram?.WebApp

    const syncTheme = () => {
      const mode: ThemeMode = webApp?.colorScheme === 'dark' ? 'dark' : 'light'
      setTheme(mode)
      applyThemeToDom(mode, webApp?.themeParams)
    }

    syncTheme()

    webApp?.onEvent?.('themeChanged', syncTheme)
    return () => {
      webApp?.offEvent?.('themeChanged', syncTheme)
    }
  }, [])

  return theme
}
