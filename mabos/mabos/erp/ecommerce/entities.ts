import type { BaseEntity } from "../shared/types.js";

export interface Product extends BaseEntity {
  name: string;
  sku: string;
  price: number;
  currency: string;
  category: string;
  stockQty: number;
  status: string;
}

export interface Order extends BaseEntity {
  customerId: string;
  items: Array<{ productId: string; quantity: number; unitPrice: number }>;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  shippedAt: string | null;
}
