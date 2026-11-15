type NativeBootstrapResult = {
  status:
    | "disabled"
    | "enabled"
    | "existing"
    | "manual_required"
    | "paired"
    | "retrying"
    | "superseded";
  code?: string;
};

export function createNativeBootstrapController(params: {
  getPairing(): Promise<{ relayUrl?: string } | null>;
  applyPairing(params: {
    pairing: { relayUrl: string; token: string; gatewayUrl?: string };
    accessMode: "all";
    source: "native";
    isCurrent(): boolean;
  }): Promise<{ ok?: boolean; existing?: boolean } | undefined>;
}): {
  attempt(): Promise<NativeBootstrapResult>;
  disableSynchronously(): Promise<void>;
  enable(options?: { attemptNow?: boolean }): Promise<NativeBootstrapResult>;
  status(): Promise<{ disabled: boolean; state: string; failureCode?: string }>;
};

export function requestRelayEnsure(relayPort: number): Promise<void>;

export function prepareRetiredCopilotState(): Promise<{ blocked: boolean }>;

export function discardRetiredCopilotState(): Promise<void>;
