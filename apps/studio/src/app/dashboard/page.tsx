import { KanbanBoard } from "@/components/kanban-board";
import { AnalyticsCharts } from "@/components/analytics-charts";
import { ConfigForm } from "@/components/config-form";
import { ChatConsole } from "@/components/chat-console";
import { ActivityFeed } from "@/components/dashboard/activity-feed";

export default function DashboardPage() {
  // For prototype, we hardcode the agent ID we are monitoring.
  // In a real app, this would be dynamic or a list of agents.
  const AGENT_ID = "agent-001";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight">OpenClaw Studio</h1>
      </header>
      
      <main className="flex-1 p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Left Column: Launch Control */}
          <section className="lg:col-span-1">
             <h2 className="text-lg font-medium mb-4">Launch Control</h2>
             <ConfigForm />
          </section>

          {/* Middle Column: Status & Chat */}
          <section className="lg:col-span-2 space-y-6">
             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                    <h2 className="text-lg font-medium mb-4">Live Agent Status ({AGENT_ID})</h2>
                    <KanbanBoard agentId={AGENT_ID} />
                </div>
                <div>
                    <h2 className="text-lg font-medium mb-4">Test Console</h2>
                    <ChatConsole />
                </div>
             </div>

             <div>
                <h2 className="text-lg font-medium mb-4">Performance Analytics</h2>
                <AnalyticsCharts agentId={AGENT_ID} />
             </div>
          </section>

          {/* Right Column: Activity Stream (The Lobster Protocol) */}
          <section className="lg:col-span-1 h-[calc(100vh-180px)]">
             <h2 className="text-lg font-medium mb-4">Activity Stream</h2>
             <ActivityFeed agentId={AGENT_ID} />
          </section>
        </div>
      </main>
    </div>
  );
}