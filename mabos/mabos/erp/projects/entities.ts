import type { BaseEntity } from "../shared/types.js";

export interface Project extends BaseEntity {
  name: string;
  description: string | null;
  status: string;
  priority: number;
  budget: number | null;
  startDate: string | null;
  endDate: string | null;
  ownerId: string | null;
}

export interface Task extends BaseEntity {
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  assigneeId: string | null;
  dueDate: string | null;
  estimatedHours: number | null;
}

export interface Milestone extends BaseEntity {
  projectId: string;
  title: string;
  dueDate: string | null;
  status: string;
  completedAt: string | null;
}
