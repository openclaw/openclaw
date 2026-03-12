export type RevenueCommandInput = {
  command: string;
  contactName?: string;
  productType?: string;
  price?: number;
  email?: string;
  phone?: string;
};

export type ParsedRevenueCommand = {
  contactName: string;
  productType: string;
  price: number;
  opportunityName: string;
  email?: string;
  phone?: string;
};

export type RevenueContactResult = {
  exists: boolean;
  contactId: string;
};

export type RevenueOpportunityResult = {
  success: boolean;
  opportunityId?: string;
  error?: string;
};

export type RevenuePaymentResult = {
  success: boolean;
  url?: string;
  error?: string;
};

export type RevenueExecutionResult = {
  ok: boolean;
  runId: string;
  price: number;
  productType: string;
  opportunityName: string;
  contactName: string;
  paymentUrl?: string;
  result: {
    price: number;
    productType: string;
    opportunityName: string;
    contactName: string;
    contact: RevenueContactResult;
    opportunity: RevenueOpportunityResult;
    payment: RevenuePaymentResult;
  };
  error?: string;
};

export type ContactLookup = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
};

export type GhlClient = {
  checkContact: (params: { name: string; email?: string; phone?: string }) => Promise<ContactLookup | null>;
  createContact: (params: {
    name: string;
    email?: string;
    phone?: string;
    locationId: string;
  }) => Promise<{ id: string }>;
  createOpportunity: (params: {
    contactId: string;
    name: string;
    amount: number;
    locationId: string;
  }) => Promise<{ id: string }>;
};

export type StripeClient = {
  createPaymentLink: (params: {
    amount: number;
    currency: string;
    productName: string;
    metadata: Record<string, string>;
  }) => Promise<{ url: string }>;
};
