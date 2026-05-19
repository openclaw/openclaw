import { useMemo } from 'react'
import {
  cloudStorage,
  getTelegramUser,
  getTheme,
  hapticFeedback,
  showConfirm,
} from '../api/telegram-bridge'

type UseTelegramResult = {
  user: ReturnType<typeof getTelegramUser>
  theme: ReturnType<typeof getTheme>
  showConfirm: typeof showConfirm
  haptic: typeof hapticFeedback
  cloudStorage: typeof cloudStorage
}

export function useTelegram(): UseTelegramResult {
  const user = useMemo(() => getTelegramUser(), [])
  const theme = useMemo(() => getTheme(), [])

  return {
    user,
    theme,
    showConfirm,
    haptic: hapticFeedback,
    cloudStorage,
  }
}
