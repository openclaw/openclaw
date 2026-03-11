import type { BaseEntity } from "../shared/types.js";

export interface Employee extends BaseEntity {
  name: string;
  email: string | null;
  role: string | null;
  department: string | null;
  status: string;
  startDate: string | null;
  metadata: Record<string, unknown>;
}

export interface PayrollRecord extends BaseEntity {
  employeeId: string;
  period: string;
  gross: number;
  deductions: number;
  net: number;
  status: string;
}
