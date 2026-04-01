import type {
  BusinessGoal,
  GoalBSCCategory,
  GoalDomainCategory,
  GoalPerspective,
  GoalType,
  TroposGoalModel,
} from "./types";

export type GoalGroup = {
  id: string;
  label: string;
  color: string;
  filterFn: (goal: BusinessGoal) => boolean;
};

export type GoalPerspectiveConfig = {
  id: GoalPerspective;
  label: string;
  description: string;
  icon: string; // Lucide icon name
  groups: GoalGroup[];
};

// --- By Level ---

const levelGroups: GoalGroup[] = [
  {
    id: "strategic",
    label: "Strategic",
    color: "var(--accent-purple)",
    filterFn: (g) => g.level === "strategic",
  },
  {
    id: "tactical",
    label: "Tactical",
    color: "var(--accent-blue)",
    filterFn: (g) => g.level === "tactical",
  },
  {
    id: "operational",
    label: "Operational",
    color: "var(--accent-orange)",
    filterFn: (g) => g.level === "operational",
  },
];

const levelPerspective: GoalPerspectiveConfig = {
  id: "level",
  label: "Level",
  description: "Group by goal hierarchy level",
  icon: "Layers",
  groups: levelGroups,
};

// --- By Type ---

const typeColors: Record<GoalType, string> = {
  hardgoal: "var(--accent-blue)",
  softgoal: "var(--accent-purple)",
  task: "var(--accent-green)",
  resource: "var(--accent-orange)",
};

const typeGroups: GoalGroup[] = [
  {
    id: "hardgoal",
    label: "Hard Goal",
    color: typeColors.hardgoal,
    filterFn: (g) => g.type === "hardgoal",
  },
  {
    id: "softgoal",
    label: "Soft Goal",
    color: typeColors.softgoal,
    filterFn: (g) => g.type === "softgoal",
  },
  {
    id: "task",
    label: "Task",
    color: typeColors.task,
    filterFn: (g) => g.type === "task",
  },
  {
    id: "resource",
    label: "Resource",
    color: typeColors.resource,
    filterFn: (g) => g.type === "resource",
  },
];

const typePerspective: GoalPerspectiveConfig = {
  id: "type",
  label: "Type",
  description: "Group by goal type (hardgoal, softgoal, task, resource)",
  icon: "Shapes",
  groups: typeGroups,
};

// --- BSC Perspective ---

const bscColors: Record<GoalBSCCategory, string> = {
  financial: "var(--accent-green)",
  customer: "var(--accent-blue)",
  "internal-process": "var(--accent-orange)",
  "learning-growth": "var(--accent-purple)",
};

const bscGroups: GoalGroup[] = [
  {
    id: "financial",
    label: "Financial",
    color: bscColors.financial,
    filterFn: (g) => g.category === "financial",
  },
  {
    id: "customer",
    label: "Customer",
    color: bscColors.customer,
    filterFn: (g) => g.category === "customer",
  },
  {
    id: "internal-process",
    label: "Internal Process",
    color: bscColors["internal-process"],
    filterFn: (g) => g.category === "internal-process",
  },
  {
    id: "learning-growth",
    label: "Learning & Growth",
    color: bscColors["learning-growth"],
    filterFn: (g) => g.category === "learning-growth",
  },
];

const bscPerspective: GoalPerspectiveConfig = {
  id: "bsc",
  label: "BSC",
  description: "Balanced Scorecard perspective",
  icon: "PieChart",
  groups: bscGroups,
};

// --- GOA Domain ---

const goaColors: Record<GoalDomainCategory, string> = {
  safety: "var(--accent-red, #ef4444)",
  efficiency: "var(--accent-green)",
  responsiveness: "var(--accent-blue)",
  robustness: "var(--accent-orange)",
};

const goaGroups: GoalGroup[] = [
  {
    id: "safety",
    label: "Safety",
    color: goaColors.safety,
    filterFn: (g) => g.domain === "safety",
  },
  {
    id: "efficiency",
    label: "Efficiency",
    color: goaColors.efficiency,
    filterFn: (g) => g.domain === "efficiency",
  },
  {
    id: "responsiveness",
    label: "Responsiveness",
    color: goaColors.responsiveness,
    filterFn: (g) => g.domain === "responsiveness",
  },
  {
    id: "robustness",
    label: "Robustness",
    color: goaColors.robustness,
    filterFn: (g) => g.domain === "robustness",
  },
];

const goaDomainPerspective: GoalPerspectiveConfig = {
  id: "goa-domain",
  label: "GOA Domain",
  description: "Goal-Oriented Architecture domain perspective",
  icon: "Shield",
  groups: goaGroups,
};

// --- By Actor (dynamic) ---

export function buildActorGroups(goalModel: TroposGoalModel): GoalGroup[] {
  const actors = goalModel.actors ?? [];
  const actorColors = [
    "var(--accent-purple)",
    "var(--accent-blue)",
    "var(--accent-green)",
    "var(--accent-orange)",
    "var(--accent-red, #ef4444)",
  ];

  return actors.map((actor, idx) => ({
    id: actor.id,
    label: actor.name || actor.id,
    color: actorColors[idx % actorColors.length],
    filterFn: (g: BusinessGoal) => g.actor === actor.id,
  }));
}

export function buildActorPerspective(goalModel: TroposGoalModel): GoalPerspectiveConfig {
  return {
    id: "actor",
    label: "Actor",
    description: "Group by Tropos actor",
    icon: "Users",
    groups: buildActorGroups(goalModel),
  };
}

// --- All static perspectives ---

export const staticPerspectives: GoalPerspectiveConfig[] = [
  levelPerspective,
  typePerspective,
  bscPerspective,
  goaDomainPerspective,
];

export function getAllPerspectives(goalModel?: TroposGoalModel): GoalPerspectiveConfig[] {
  const actorPerspective = goalModel
    ? buildActorPerspective(goalModel)
    : {
        id: "actor" as const,
        label: "Actor",
        description: "Group by Tropos actor",
        icon: "Users",
        groups: [],
      };

  return [
    levelPerspective,
    actorPerspective,
    typePerspective,
    bscPerspective,
    goaDomainPerspective,
  ];
}

export function getPerspectiveById(
  id: GoalPerspective,
  goalModel?: TroposGoalModel,
): GoalPerspectiveConfig | undefined {
  return getAllPerspectives(goalModel).find((p) => p.id === id);
}
