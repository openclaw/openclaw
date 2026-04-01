import { LayoutGrid, GitBranch, Activity } from "lucide-react";
import { type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { AgentListItem } from "@/lib/types";
import { AgentActivityDiagram } from "./AgentActivityDiagram";
import { AgentOrgChart } from "./AgentOrgChart";

type AgentViewSwitcherProps = {
  agents: AgentListItem[] | undefined;
  isLoading: boolean;
  onSelectAgent: (id: string) => void;
  children: ReactNode;
};

export function AgentViewSwitcher({
  agents,
  isLoading,
  onSelectAgent,
  children,
}: AgentViewSwitcherProps) {
  return (
    <Tabs defaultValue="grid" className="gap-4">
      {/* Frosted glass hero banner */}
      <div className="relative w-full h-[200px] max-md:h-[150px] rounded-xl overflow-hidden">
        {/* Gradient fallback / background */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#667eea] to-[#764ba2]" />

        {/* Dark scrim for text contrast */}
        <div className="absolute inset-0 bg-black/30" />

        {/* Frosted glass overlay */}
        <div
          className="absolute inset-0"
          style={{
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            background: "rgba(255, 255, 255, 0.15)",
            border: "1px solid rgba(255, 255, 255, 0.2)",
          }}
        />

        {/* Tab bar on top of glass */}
        <div className="relative z-10 flex items-center justify-center h-full">
          <TabsList
            variant="line"
            className="bg-transparent gap-0 max-md:overflow-x-auto max-md:scrollbar-hide max-md:snap-x"
          >
            <TabsTrigger
              value="grid"
              className="px-6 py-3 min-w-[100px] font-semibold text-sm text-white/70 hover:bg-white/10 data-[state=active]:text-white data-[state=active]:after:bg-[var(--accent-purple)] data-[state=active]:after:h-[3px] data-[state=active]:after:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent-purple)] focus-visible:ring-offset-2 [&_svg]:!size-[18px] max-[480px]:[&_svg]:hidden"
            >
              <LayoutGrid />
              Grid
            </TabsTrigger>
            <TabsTrigger
              value="org-chart"
              className="px-6 py-3 min-w-[100px] font-semibold text-sm text-white/70 hover:bg-white/10 data-[state=active]:text-white data-[state=active]:after:bg-[var(--accent-purple)] data-[state=active]:after:h-[3px] data-[state=active]:after:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent-purple)] focus-visible:ring-offset-2 [&_svg]:!size-[18px] max-[480px]:[&_svg]:hidden"
            >
              <GitBranch />
              Org Chart
            </TabsTrigger>
            <TabsTrigger
              value="activity"
              className="px-6 py-3 min-w-[100px] font-semibold text-sm text-white/70 hover:bg-white/10 data-[state=active]:text-white data-[state=active]:after:bg-[var(--accent-purple)] data-[state=active]:after:h-[3px] data-[state=active]:after:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent-purple)] focus-visible:ring-offset-2 [&_svg]:!size-[18px] max-[480px]:[&_svg]:hidden"
            >
              <Activity />
              Activity
            </TabsTrigger>
          </TabsList>
        </div>
      </div>

      {/* Tab content panels */}
      <TabsContent value="grid">{children}</TabsContent>

      <TabsContent value="org-chart">
        <AgentOrgChart agents={agents} isLoading={isLoading} onSelectAgent={onSelectAgent} />
      </TabsContent>

      <TabsContent value="activity">
        <AgentActivityDiagram agents={agents} isLoading={isLoading} />
      </TabsContent>
    </Tabs>
  );
}
