import { Tabbar } from '@telegram-apps/telegram-ui'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AgentControl } from './pages/AgentControl'
import { CodeWorkspace } from './pages/CodeWorkspace'
import { Dashboard } from './pages/Dashboard'
import './App.css'

type RouteItem = {
  path: string
  title: string
  description: string
}

const routeItems: RouteItem[] = [
  { path: '/workflows', title: '工作流管理', description: '啟動與追蹤內建自動流程。' },
  { path: '/cron', title: '排程管理', description: '查看、啟用與手動執行排程。' },
  { path: '/models', title: '模型切換', description: '瀏覽模型並切換會話模型。' },
  { path: '/devops', title: 'DevOps 面板', description: '追蹤 CI/CD 與 PR 狀態。' },
  { path: '/settings', title: '設定中心', description: '通知、安全與偏好設定。' },
]

type TabItem = {
  path: string
  text: string
  icon: string
}

const tabItems: TabItem[] = [
  { path: '/', text: '首頁', icon: '🏠' },
  { path: '/agents', text: 'Agent', icon: '🤖' },
  { path: '/code', text: '程式碼', icon: '💻' },
  { path: '/settings', text: '更多', icon: '⚙️' },
]

function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <section className="page-shell">
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  )
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <div className="app-shell">
      <div className="app-body">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={<AgentControl />} />
          <Route path="/code" element={<CodeWorkspace />} />
          {routeItems.map((item) => (
            <Route
              key={item.path}
              path={item.path}
              element={<PlaceholderPage title={item.title} description={item.description} />}
            />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      <Tabbar>
        {tabItems.map((item) => (
          <Tabbar.Item
            key={item.path}
            text={item.text}
            selected={location.pathname === item.path}
            onClick={() => navigate(item.path)}
          >
            <span aria-hidden="true">{item.icon}</span>
          </Tabbar.Item>
        ))}
      </Tabbar>
    </div>
  )
}

export default App
