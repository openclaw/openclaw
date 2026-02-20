import { RefreshCw, AlertCircle } from 'lucide-react'

interface QueryStateProps {
  isLoading?: boolean
  error?: Error | null
  empty?: boolean
  emptyIcon?: React.ReactNode
  emptyTitle?: string
  emptyDescription?: string
  onRetry?: () => void
  children: React.ReactNode
}

/**
 * Shared loading / error / empty state wrapper for React Query data.
 * Renders children only when not loading, no error, and (if empty=false) has content.
 */
export function QueryState({
  isLoading,
  error,
  empty,
  emptyIcon,
  emptyTitle = 'No data',
  emptyDescription,
  onRetry,
  children,
}: QueryStateProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <RefreshCw className="w-8 h-8 animate-spin text-surface-400 mb-4" />
        <p className="text-sm text-surface-500">Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
        <p className="font-medium text-surface-200 mb-1">Something went wrong</p>
        <p className="text-sm text-surface-500 mb-4 max-w-md">{error.message}</p>
        {onRetry && (
          <button onClick={onRetry} className="btn-primary flex items-center gap-2">
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
        )}
      </div>
    )
  }

  if (empty) {
    return (
      <div className="card flex flex-col items-center justify-center py-20 text-surface-400">
        {emptyIcon}
        <p className="mt-4 font-medium text-surface-300">{emptyTitle}</p>
        {emptyDescription && <p className="text-sm mt-1">{emptyDescription}</p>}
      </div>
    )
  }

  return <>{children}</>
}
