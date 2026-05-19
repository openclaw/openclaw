import { useState } from 'react'
import { hapticFeedback, showConfirm } from '../api/telegram-bridge'
import './ConfirmDialog.css'

type ConfirmDialogProps = {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  requireBiometric?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  title,
  message,
  confirmText = '確認',
  cancelText = '取消',
  danger = false,
  requireBiometric = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function runConfirmFlow(): Promise<void> {
    setBusy(true)
    try {
      const accepted = await showConfirm(message)
      if (accepted) {
        hapticFeedback('success')
        await onConfirm()
      } else {
        hapticFeedback('selection')
      }
    } finally {
      setBusy(false)
    }
  }

  async function handlePrimaryClick(): Promise<void> {
    // 優先使用 Telegram 原生確認，如原生不可用將退回 fallback modal。
    const hasNativeBridge = typeof (window as Window & { Telegram?: unknown }).Telegram !== 'undefined'
    if (hasNativeBridge) {
      await runConfirmFlow()
      return
    }
    setOpen(true)
  }

  async function confirmFallback(): Promise<void> {
    setBusy(true)
    try {
      if (requireBiometric) {
        // 目前先保留提示流程，後續可接原生生物辨識 API。
        const acceptedBiometric = window.confirm('需要生物辨識確認，是否繼續？')
        if (!acceptedBiometric) {
          setOpen(false)
          return
        }
      }
      await onConfirm()
      hapticFeedback('success')
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={danger ? 'confirm-trigger confirm-trigger-danger' : 'confirm-trigger'}
        disabled={busy}
        onClick={() => void handlePrimaryClick()}
      >
        {confirmText}
      </button>

      {open ? (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label={title}>
          <div className="confirm-modal">
            <h3>{title}</h3>
            <p>{message}</p>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={() => setOpen(false)} disabled={busy}>
                {cancelText}
              </button>
              <button
                type="button"
                className={danger ? 'confirm-accept confirm-accept-danger' : 'confirm-accept'}
                onClick={() => void confirmFallback()}
                disabled={busy}
              >
                {confirmText}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
