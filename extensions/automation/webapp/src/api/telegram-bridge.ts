// Telegram WebApp API bridge with safe fallback behavior.

import type {
  HapticFeedbackType,
  TelegramTheme,
  TelegramUser,
  TelegramWebApp,
  TelegramWindow,
} from './types'

function getWebApp(): TelegramWebApp | undefined {
  return (window as TelegramWindow).Telegram?.WebApp
}

export function getTelegramUser(): TelegramUser | null {
  return getWebApp()?.initDataUnsafe?.user ?? null
}

export function getTheme(): TelegramTheme {
  return getWebApp()?.colorScheme === 'dark' ? 'dark' : 'light'
}

export async function showConfirm(message: string): Promise<boolean> {
  const webApp = getWebApp()
  if (!webApp?.showConfirm) {
    return window.confirm(message)
  }

  return new Promise<boolean>((resolve) => {
    webApp.showConfirm?.(message, (ok) => resolve(Boolean(ok)))
  })
}

export function hapticFeedback(type: HapticFeedbackType): void {
  const haptic = getWebApp()?.HapticFeedback
  if (!haptic) {
    return
  }

  if (type === 'selection') {
    haptic.selectionChanged?.()
    return
  }

  if (type === 'success' || type === 'warning' || type === 'error') {
    haptic.notificationOccurred?.(type)
    return
  }

  haptic.impactOccurred?.(type)
}

export const cloudStorage = {
  async get(key: string): Promise<string | null> {
    const storage = getWebApp()?.CloudStorage
    if (!storage?.getItem) {
      return null
    }

    return new Promise<string | null>((resolve, reject) => {
      storage.getItem?.(key, (error, value) => {
        if (error) {
          reject(new Error(`CloudStorage get 失敗: ${error}`))
          return
        }
        resolve(value ?? null)
      })
    })
  },

  async set(key: string, value: string): Promise<boolean> {
    const storage = getWebApp()?.CloudStorage
    if (!storage?.setItem) {
      return false
    }

    return new Promise<boolean>((resolve, reject) => {
      storage.setItem?.(key, value, (error, stored) => {
        if (error) {
          reject(new Error(`CloudStorage set 失敗: ${error}`))
          return
        }
        resolve(stored ?? true)
      })
    })
  },
}

export function createTelegramBridge() {
  return {
    getTelegramUser,
    getTheme,
    showConfirm,
    hapticFeedback,
    cloudStorage,
  }
}
