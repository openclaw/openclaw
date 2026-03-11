import type { BaseEntity } from "../shared/types.js";

export interface Account extends BaseEntity {
  name: string;
  type: string;
  currency: string;
  balance: number;
  parentId: string | null;
}

export interface Invoice extends BaseEntity {
  customerId: string;
  status: string;
  amount: number;
  currency: string;
  dueDate: string | null;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number }>;
}

export interface Payment extends BaseEntity {
  invoiceId: string;
  amount: number;
  method: string | null;
  status: string;
  processedAt: string | null;
}

export interface LedgerEntry extends BaseEntity {
  accountId: string;
  debit: number;
  credit: number;
  description: string | null;
  referenceType: string | null;
  referenceId: string | null;
  postedAt: string;
}
