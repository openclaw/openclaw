import { Layers, Users, Shapes, PieChart, Shield } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getAllPerspectives } from "@/lib/goal-perspectives";
import type { GoalPerspective, TroposGoalModel } from "@/lib/types";

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Layers,
  Users,
  Shapes,
  PieChart,
  Shield,
};

const tabTriggerClass =
  "text-[var(--text-secondary)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:bg-[var(--bg-tertiary)]";

type GoalPerspectiveSelectorProps = {
  perspective: GoalPerspective;
  onPerspectiveChange: (perspective: GoalPerspective) => void;
  goalModel?: TroposGoalModel;
};

export function GoalPerspectiveSelector({
  perspective,
  onPerspectiveChange,
  goalModel,
}: GoalPerspectiveSelectorProps) {
  const perspectives = getAllPerspectives(goalModel);

  return (
    <Tabs value={perspective} onValueChange={(v) => onPerspectiveChange(v as GoalPerspective)}>
      <TabsList className="bg-[var(--bg-secondary)]">
        {perspectives.map((p) => {
          const Icon = iconMap[p.icon];
          return (
            <TabsTrigger key={p.id} value={p.id} className={tabTriggerClass}>
              <span className="flex items-center gap-1.5">
                {Icon && <Icon className="w-3.5 h-3.5" />}
                {p.label}
              </span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
