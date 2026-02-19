import type { BaseEntity } from "../shared/types.js";

export interface Shipment extends BaseEntity {
  orderId: string | null;
  supplierId: string | null;
  origin: string;
  destination: string;
  carrier: string | null;
  trackingNumber: string | null;
  status: string;
  estimatedArrival: string | null;
  actualArrival: string | null;
}

export interface RouteLeg {
  from: string;
  to: string;
  carrier: string;
  duration: string;
}

export interface Route extends BaseEntity {
  name: string;
  origin: string;
  destination: string;
  legs: RouteLeg[];
  status: string;
}
