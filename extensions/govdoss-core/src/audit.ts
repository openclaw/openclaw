export type SOA4AuditEvent = {
  subject: string;
  object: string;
  authentication?: string;
  authorization?: string;
  approval?: string;
  action: string;
  outcome?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

export function createAuditEvent(input: Omit<SOA4AuditEvent, "timestamp">): SOA4AuditEvent {
  return {
    ...input,
    timestamp: Date.now()
  };
}

export class AuditBuffer {
  private readonly events: SOA4AuditEvent[] = [];

  add(event: SOA4AuditEvent) {
    this.events.push(event);
  }

  list() {
    return [...this.events];
  }
}
