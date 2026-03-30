import { Routes, Route } from 'react-router-dom'
import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/layout/Sidebar'
import { TopBar } from './components/layout/TopBar'
import { QuickCapture } from './components/QuickCapture'
import { SearchModal } from './components/SearchModal'
import { Dashboard } from './screens/Dashboard'
import { Tasks } from './screens/Tasks'
import { Calendar } from './screens/Calendar'
import { Projects } from './screens/Projects'
import { Memory } from './screens/Memory'
import { Docs } from './screens/Docs'
import { Team } from './screens/Team'
import { Office } from './screens/Office'
import { Skills } from './screens/Skills'
import { System } from './screens/System'
import { Integrations } from './screens/Integrations'
import { Standup } from './screens/Standup'
import { Radar } from './screens/Radar'
import { Contacts } from './screens/Contacts'
import { Messages } from './screens/Messages'
import { Settings } from './screens/Settings'
import { Plus } from 'lucide-react'

function PlaceholderScreen({ name }: { name: string }) {
  return (
    <div className="flex items-center justify-center h-full text-neutral-600">
      <div className="text-center">
        <div className="text-4xl mb-3">🚧</div>
        <div className="text-sm">{name} — coming soon</div>
      </div>
    </div>
  )
}

export default function App() {
  const { searchOpen, quickCaptureOpen, setSearchOpen, setQuickCaptureOpen } = useStore()

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        setQuickCaptureOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setSearchOpen, setQuickCaptureOpen])

  return (
    <div className="flex h-screen overflow-hidden bg-[#0d0d0d]">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/standup" element={<Standup />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/team" element={<Team />} />
            <Route path="/office" element={<Office />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/system" element={<System />} />
            <Route path="/radar" element={<Radar />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<PlaceholderScreen name="Page" />} />
          </Routes>
        </main>
      </div>

      {/* Quick capture FAB */}
      <button
        onClick={() => setQuickCaptureOpen(true)}
        className="fixed bottom-6 right-6 w-12 h-12 rounded-full bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-900/50 flex items-center justify-center text-white transition-all hover:scale-110 z-40"
        title="Quick capture (⌘N)"
      >
        <Plus size={20} />
      </button>

      {/* Modals */}
      {searchOpen && <SearchModal />}
      {quickCaptureOpen && <QuickCapture />}
    </div>
  )
}
