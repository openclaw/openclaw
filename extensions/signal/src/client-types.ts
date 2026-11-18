export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  assertDirectAdapterHandoff?: () => void;
};

export type SignalSseEvent = {
  event?: string;
  data?: string;
  id?: string;
};
