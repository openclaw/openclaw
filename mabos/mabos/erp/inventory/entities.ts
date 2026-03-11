import type { BaseEntity } from "../shared/types.js";

export interface StockItem extends BaseEntity {
  sku: string;
  name: string;
  quantity: number;
  reorderPoint: number;
  warehouseId: string | null;
  status: string;
  unit: string | null;
}

export interface StockMovement extends BaseEntity {
  stockItemId: string;
  type: "in" | "out" | "adjustment";
  quantity: number;
  reason: string | null;
  reference: string | null;
}
