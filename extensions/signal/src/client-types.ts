export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  assertDirectAdapterHandoff?: () => void;
};
