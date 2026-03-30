import { MessageSquare, Mail, Hash, Send } from 'lucide-react'

const MESSAGES = [
  { id: '1', from: 'Jason', channel: 'telegram', icon: '✈️', text: 'How is the Ora Labs setup going?', time: '9:30 AM', unread: false },
  { id: '2', from: 'Luciel', channel: 'telegram', icon: '🤖', text: 'WooCommerce API keys still pending. Once configured, order monitoring will go live.', time: '9:31 AM', unread: false },
  { id: '3', from: 'Jason', channel: 'telegram', icon: '✈️', text: 'ok can you check for any new orders manually?', time: '9:35 AM', unread: false },
  { id: '4', from: 'Luciel', channel: 'telegram', icon: '🤖', text: 'Checking oralabs.net now…', time: '9:35 AM', unread: false },
  { id: '5', from: 'Gmail', channel: 'email', icon: '📧', text: 'New order #1234 - BPC-157 5mg x2', time: '8:12 AM', unread: true },
]

export function Messages() {
  return (
    <div className="p-5 max-w-2xl mx-auto">
      {/* Channel tabs */}
      <div className="flex gap-1 p-1 bg-white/[0.04] rounded-lg border border-white/[0.06] mb-4 w-fit">
        {[
          { label: 'All', icon: MessageSquare },
          { label: 'Telegram', icon: Send },
          { label: 'Gmail', icon: Mail },
          { label: 'Discord', icon: Hash },
        ].map(({ label, icon: Icon }) => (
          <button key={label} className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${label === 'All' ? 'bg-white/[0.08] text-white' : 'text-neutral-500 hover:text-white'}`}>
            <Icon size={11} />
            {label}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div className="space-y-1">
        {MESSAGES.map(m => (
          <div key={m.id} className={`flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-white/[0.03] ${m.unread ? 'bg-blue-500/5' : ''}`}>
            <div className="text-lg">{m.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-semibold text-white">{m.from}</span>
                <span className="text-[10px] text-neutral-600">{m.channel}</span>
                {m.unread && <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
              </div>
              <p className="text-sm text-neutral-400">{m.text}</p>
            </div>
            <span className="text-[10px] text-neutral-700 shrink-0">{m.time}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
