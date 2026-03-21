export type CircuitBreakerAction = "pause" | "reset" | "alert";

export type CircuitBreakerConfig = {
  /** Consecutive model errors before tripping. Default: 5. */
  consecutiveErrors?: number;
  /** Action(s) to execute when tripped. */
  action?: CircuitBreakerAction | CircuitBreakerAction[];
  /** Channel for alert delivery (e.g. "telegram", "discord"). */
  alertChannel?: string;
  /** Recipient for alert delivery. */
  alertTo?: string;
  /** Account ID for alert delivery. */
  alertAccountId?: string;
  /** Cooldown minutes for pause action. Default: 30. */
  cooldownMinutes?: number;
};
