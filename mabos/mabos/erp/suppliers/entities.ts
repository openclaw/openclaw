import type { BaseEntity } from "../shared/types.js";

export interface Supplier extends BaseEntity {
  name: string;
  contactEmail: string | null;
  category: string | null;
  rating: number | null;
  status: string;
  terms: string | null;
}

export interface PurchaseOrder extends BaseEntity {
  supplierId: string;
  items: Array<{ description: string; quantity: number; unitCost: number }>;
  totalCost: number;
  status: string;
  expectedDelivery: string | null;
}
