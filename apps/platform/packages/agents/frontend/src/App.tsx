import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { AgentsPage } from './pages/Agents'
import { TasksPage } from './pages/Tasks'
import { IntegrationsPage } from './pages/Integrations'
import { ActivityPage } from './pages/Activity'
import { Monitoring } from './pages/Monitoring'
import { SettingsPage } from './pages/Settings'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:agentSlug" element={<AgentsPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="monitoring" element={<Monitoring />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
