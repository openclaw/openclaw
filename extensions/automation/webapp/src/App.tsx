import { Tabbar } from '@telegram-apps/telegram-ui'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AgentControl } from './pages/AgentControl'
import { CodeWorkspace } from './pages/CodeWorkspace'
import { CronManager } from './pages/CronManager'
import { Dashboard } from './pages/Dashboard'
import { DevOpsPanel } from './pages/DevOpsPanel'
import { ModelSelector } from './pages/ModelSelector'
import { Settings } from './pages/Settings'
import { WorkflowEditor } from './pages/WorkflowEditor'
import './App.css'

type RouteItem = {
  path: string
  title: string
  description: string
}

const routeItems: RouteItem[] = [
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
          <Route path="/workflows" element={<WorkflowEditor />} />
          <Route path="/cron" element={<CronManager />} />
          <Route path="/models" element={<ModelSelector />} />
          <Route path="/devops" element={<DevOpsPanel />} />
          <Route path="/settings" element={<Settings />} />
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
