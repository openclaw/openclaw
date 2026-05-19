import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './NavBar.css'

type NavBarProps = {
  title?: string
}

function segmentLabel(segment: string): string {
  const map: Record<string, string> = {
    agents: 'Agent',
    code: '程式碼',
    workflows: '工作流',
    cron: '排程',
    models: '模型',
    devops: 'DevOps',
    settings: '設定',
  }
  return map[segment] ?? segment
}

export function NavBar({ title }: NavBarProps) {
  const location = useLocation()
  const navigate = useNavigate()

  const breadcrumb = useMemo(() => {
    const path = location.pathname.replace(/^\/+|\/+$/g, '')
    if (!path) {
      return ['首頁']
    }
    const segments = path.split('/').map((item) => segmentLabel(item))
    return ['首頁', ...segments]
  }, [location.pathname])

  const displayTitle = title ?? breadcrumb[breadcrumb.length - 1] ?? 'OpenClaw'

  return (
    <header className="nav-bar">
      <button
        type="button"
        className="nav-back-btn"
        onClick={() => navigate(-1)}
        aria-label="返回上一頁"
      >
        ←
      </button>

      <div className="nav-main">
        <h2>{displayTitle}</h2>
        <p>{breadcrumb.join(' / ')}</p>
      </div>
    </header>
  )
}
