import {
  Settings,
  Bell,
  Shield,
  Palette,
  Key,
  Save,
} from 'lucide-react'
import { useState } from 'react'
import clsx from 'clsx'

const sections = [
  { id: 'general', name: 'General', icon: Settings },
  { id: 'notifications', name: 'Notifications', icon: Bell },
  { id: 'security', name: 'Security', icon: Shield },
  { id: 'api-keys', name: 'API Keys', icon: Key },
  { id: 'appearance', name: 'Appearance', icon: Palette },
]

export function SettingsPage() {
  const [activeSection, setActiveSection] = useState('general')
  const [settings, setSettings] = useState({
    systemName: 'OpenClaw Agent Manager',
    timezone: 'UTC',
    emailNotifications: true,
    pushNotifications: true,
    slackNotifications: false,
    telegramNotifications: true,
    darkMode: true,
    compactView: false,
  })

  const updateSetting = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-surface-400 mt-1">
          Configure your agent management system
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar */}
        <div className="space-y-1">
          {sections.map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left',
                activeSection === section.id
                  ? 'bg-primary-500/20 text-primary-400'
                  : 'text-surface-400 hover:text-surface-100 hover:bg-surface-800'
              )}
            >
              <section.icon className="w-5 h-5" />
              {section.name}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="lg:col-span-3 space-y-6">
          {activeSection === 'general' && (
            <div className="card">
              <h2 className="card-title mb-6">General Settings</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-surface-300 mb-2">
                    System Name
                  </label>
                  <input
                    type="text"
                    className="input"
                    value={settings.systemName}
                    onChange={e => updateSetting('systemName', e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-surface-300 mb-2">
                    Timezone
                  </label>
                  <select
                    className="input"
                    value={settings.timezone}
                    onChange={e => updateSetting('timezone', e.target.value)}
                  >
                    <option value="UTC">UTC</option>
                    <option value="Europe/London">Europe/London</option>
                    <option value="America/New_York">America/New York</option>
                    <option value="Asia/Dubai">Asia/Dubai</option>
                    <option value="Asia/Riyadh">Asia/Riyadh</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'notifications' && (
            <div className="card">
              <h2 className="card-title mb-6">Notification Preferences</h2>
              
              <div className="space-y-4">
                {[
                  { key: 'emailNotifications', label: 'Email Notifications', desc: 'Receive alerts via email' },
                  { key: 'pushNotifications', label: 'Push Notifications', desc: 'Browser push notifications' },
                  { key: 'slackNotifications', label: 'Slack Notifications', desc: 'Send alerts to Slack channel' },
                  { key: 'telegramNotifications', label: 'Telegram Notifications', desc: 'Send alerts via Telegram bot' },
                ].map(item => (
                  <div key={item.key} className="flex items-center justify-between py-3 border-b border-surface-800 last:border-0">
                    <div>
                      <h3 className="font-medium">{item.label}</h3>
                      <p className="text-sm text-surface-500">{item.desc}</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={settings[item.key as keyof typeof settings] as boolean}
                        onChange={e => updateSetting(item.key, e.target.checked)}
                      />
                      <div className="w-11 h-6 bg-surface-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-500"></div>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'security' && (
            <div className="card">
              <h2 className="card-title mb-6">Security Settings</h2>
              
              <div className="space-y-4">
                <div className="p-4 bg-surface-800 rounded-lg">
                  <h3 className="font-medium mb-2">Two-Factor Authentication</h3>
                  <p className="text-sm text-surface-400 mb-4">
                    Add an extra layer of security to your account
                  </p>
                  <button className="btn-secondary">Enable 2FA</button>
                </div>

                <div className="p-4 bg-surface-800 rounded-lg">
                  <h3 className="font-medium mb-2">Session Management</h3>
                  <p className="text-sm text-surface-400 mb-4">
                    View and manage active sessions
                  </p>
                  <button className="btn-secondary">View Sessions</button>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'api-keys' && (
            <div className="card">
              <h2 className="card-title mb-6">API Keys</h2>
              <p className="text-surface-400 mb-6">
                Manage API keys for integrations. Keys are stored securely and never exposed.
              </p>
              
              <div className="space-y-4">
                {[
                  { name: 'Stripe API Key', configured: true },
                  { name: 'GitHub Token', configured: true },
                  { name: 'OpenAI API Key', configured: false },
                  { name: 'Notion API Key', configured: false },
                  { name: 'Telegram Bot Token', configured: true },
                ].map(key => (
                  <div key={key.name} className="flex items-center justify-between py-3 border-b border-surface-800 last:border-0">
                    <div className="flex items-center gap-3">
                      <Key className="w-5 h-5 text-surface-400" />
                      <span>{key.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={clsx(
                        'badge',
                        key.configured ? 'badge-success' : 'badge-warning'
                      )}>
                        {key.configured ? 'Configured' : 'Not Set'}
                      </span>
                      <button className="btn-ghost text-sm">Edit</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'appearance' && (
            <div className="card">
              <h2 className="card-title mb-6">Appearance</h2>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between py-3 border-b border-surface-800">
                  <div>
                    <h3 className="font-medium">Dark Mode</h3>
                    <p className="text-sm text-surface-500">Use dark color scheme</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={settings.darkMode}
                      onChange={e => updateSetting('darkMode', e.target.checked)}
                    />
                    <div className="w-11 h-6 bg-surface-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-500"></div>
                  </label>
                </div>

                <div className="flex items-center justify-between py-3">
                  <div>
                    <h3 className="font-medium">Compact View</h3>
                    <p className="text-sm text-surface-500">Reduce spacing and show more content</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={settings.compactView}
                      onChange={e => updateSetting('compactView', e.target.checked)}
                    />
                    <div className="w-11 h-6 bg-surface-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-500"></div>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Save button */}
          <div className="flex justify-end">
            <button className="btn-primary flex items-center gap-2">
              <Save className="w-4 h-4" />
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
