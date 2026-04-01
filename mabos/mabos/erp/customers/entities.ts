import type { BaseEntity } from "../shared/types.js";

export interface Contact extends BaseEntity {
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  segment: string | null;
  lifecycleStage: string;
  metadata: Record<string, unknown>;
}

export interface Interaction extends BaseEntity {
  contactId: string;
  channel: string;
  type: string;
  summary: string;
  sentiment: number | null;
  agentId: string | null;
}
