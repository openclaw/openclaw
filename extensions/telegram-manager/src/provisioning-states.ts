// Provisioning state machine for OP-167.
// States: REQUESTED → CREATING_BOT → BOT_CREATED → CREATING_SERVER →
// SERVER_CREATED → INSTALLING_OPENCLAW → CONFIGURING_OPENCLAW → VERIFYING → READY | FAILED

export const PROVISIONING_STATES = [
  "REQUESTED",
  "CREATING_BOT",
  "BOT_CREATED",
  "CREATING_SERVER",
  "SERVER_CREATED",
  "INSTALLING_OPENCLAW",
  "CONFIGURING_OPENCLAW",
  "VERIFYING",
  "READY",
  "FAILED",
] as const;

export type ProvisioningState = (typeof PROVISIONING_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<ProvisioningState> = new Set(["READY", "FAILED"]);

const ALLOWED_TRANSITIONS: Record<ProvisioningState, ReadonlySet<ProvisioningState>> = {
  REQUESTED: new Set(["CREATING_BOT", "FAILED"]),
  CREATING_BOT: new Set(["BOT_CREATED", "FAILED"]),
  BOT_CREATED: new Set(["CREATING_SERVER", "FAILED"]),
  CREATING_SERVER: new Set(["SERVER_CREATED", "FAILED"]),
  SERVER_CREATED: new Set(["INSTALLING_OPENCLAW", "FAILED"]),
  INSTALLING_OPENCLAW: new Set(["CONFIGURING_OPENCLAW", "FAILED"]),
  CONFIGURING_OPENCLAW: new Set(["VERIFYING", "FAILED"]),
  VERIFYING: new Set(["READY", "FAILED"]),
  READY: new Set([]),
  FAILED: new Set(["REQUESTED"]),
};

export function isTerminalState(state: ProvisioningState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: ProvisioningState, to: ProvisioningState): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from: ProvisioningState, to: ProvisioningState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid provisioning transition ${from} -> ${to}`);
  }
}

export function nextStateOnSuccess(state: ProvisioningState): ProvisioningState | undefined {
  const order: ProvisioningState[] = [
    "REQUESTED",
    "CREATING_BOT",
    "BOT_CREATED",
    "CREATING_SERVER",
    "SERVER_CREATED",
    "INSTALLING_OPENCLAW",
    "CONFIGURING_OPENCLAW",
    "VERIFYING",
    "READY",
  ];
  const i = order.indexOf(state);
  if (i < 0 || i + 1 >= order.length) {
    return undefined;
  }
  return order[i + 1];
}
