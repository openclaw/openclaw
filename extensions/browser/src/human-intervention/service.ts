import type {
  HumanInterventionControlRequest,
  HumanInterventionState,
} from "@openclaw/gateway-protocol";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CONTROL_LEASE_MS = 60 * 1000;
const MAX_LOCATED_IDS = 1_000;

type HumanInterventionOwner = {
  channel: string;
  accountId: string;
  senderId: string;
};

type HumanInterventionOrigin = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string;
};

export type HumanInterventionBrowser = {
  target: "host";
  profile: string;
  targetId: string;
};

export type HumanInterventionRecord = {
  id: string;
  state: HumanInterventionState;
  generation: number;
  agentId: string;
  sessionKey: string;
  owner: HumanInterventionOwner;
  origin: HumanInterventionOrigin;
  browser: HumanInterventionBrowser;
  reason: string;
  hostname: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  controllerId?: string;
  controllerLeaseExpiresAtMs?: number;
  continuationId?: string;
  completedAtMs?: number;
  /** Durable queue-admission time; this does not record execution start. */
  resumedAtMs?: number;
};

export type HumanInterventionRequest = Pick<
  HumanInterventionRecord,
  "agentId" | "sessionKey" | "owner" | "origin" | "browser" | "reason" | "hostname"
>;

type ServiceOptions = {
  now?: () => number;
  randomId?: () => string;
  pendingTtlMs?: number;
  controlLeaseMs?: number;
};

type MutationAuthorityGuard = () => void;

class HumanInterventionError extends Error {}

class HumanInterventionNotFoundError extends HumanInterventionError {
  constructor(id: string) {
    super(`Human browser handoff not found: ${id}`);
    this.name = "HumanInterventionNotFoundError";
  }
}

export class HumanInterventionConflictError extends HumanInterventionError {
  constructor(message: string) {
    super(message);
    this.name = "HumanInterventionConflictError";
  }
}

function profileKey(browser: HumanInterventionBrowser): string {
  return `${browser.target}:${browser.profile}`;
}

function canExpire(record: HumanInterventionRecord): boolean {
  return (
    record.state === "waiting" || record.state === "control" || record.state === "resume_pending"
  );
}

function isProfileReserved(record: HumanInterventionRecord, now: number): boolean {
  return canExpire(record) && record.expiresAtMs > now;
}

function endControl(
  current: HumanInterventionRecord,
  state: "waiting" | "cancelled" | "expired",
  now: number,
): HumanInterventionRecord {
  return {
    ...current,
    state,
    generation: current.generation + 1,
    updatedAtMs: now,
    controllerId: undefined,
    controllerLeaseExpiresAtMs: undefined,
  };
}

function defaultRandomId(): string {
  return globalThis.crypto.randomUUID();
}

export class HumanInterventionService {
  // Locations are hints only. Never retain records or authority in this cache.
  private readonly locatedKeys = new Map<string, string>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly pendingTtlMs: number;
  private readonly controlLeaseMs: number;

  constructor(
    private readonly store: PluginStateKeyedStore<HumanInterventionRecord>,
    options: ServiceOptions = {},
  ) {
    if (!store.update) {
      throw new Error("Human browser handoff storage requires atomic update support");
    }
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? defaultRandomId;
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.controlLeaseMs = options.controlLeaseMs ?? DEFAULT_CONTROL_LEASE_MS;
  }

  async request(input: HumanInterventionRequest): Promise<HumanInterventionRecord> {
    const now = this.now();
    const record: HumanInterventionRecord = {
      ...input,
      id: this.randomId(),
      state: "waiting",
      generation: 1,
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + this.pendingTtlMs,
    };
    let conflict: HumanInterventionRecord | undefined;
    const updated = await this.update(profileKey(input.browser), (current) => {
      if (current && isProfileReserved(current, now)) {
        conflict = current;
        return undefined;
      }
      return record;
    });
    if (!updated) {
      if (conflict) {
        throw new HumanInterventionConflictError(
          `Browser profile ${input.browser.profile} already has an active handoff`,
        );
      }
      throw new HumanInterventionConflictError(
        `Could not reserve browser profile ${input.browser.profile}`,
      );
    }
    this.rememberLocation(record.id, profileKey(record.browser));
    return record;
  }

  async get(id: string): Promise<HumanInterventionRecord> {
    return (await this.requireCurrentLocated(id)).record;
  }

  async claim(
    input: { id: string; controllerId: string },
    assertCurrentAuthority?: MutationAuthorityGuard,
  ): Promise<HumanInterventionRecord> {
    return await this.transitionById(
      input.id,
      (current, now) => {
        if (
          current.expiresAtMs <= now &&
          (current.state === "waiting" || current.state === "control")
        ) {
          throw new HumanInterventionConflictError("Human browser handoff has expired");
        }
        if (current.state !== "waiting" && current.state !== "control") {
          throw new HumanInterventionConflictError(
            `Human browser handoff cannot be claimed while ${current.state}`,
          );
        }
        const leaseActive =
          current.state === "control" && (current.controllerLeaseExpiresAtMs ?? 0) > now;
        if (leaseActive && current.controllerId !== input.controllerId) {
          throw new HumanInterventionConflictError("Human browser handoff is controlled elsewhere");
        }
        return {
          ...current,
          state: "control",
          generation: current.generation + (leaseActive ? 0 : 1),
          updatedAtMs: now,
          controllerId: input.controllerId,
          controllerLeaseExpiresAtMs: now + this.controlLeaseMs,
        };
      },
      assertCurrentAuthority,
    );
  }

  async renew(
    input: HumanInterventionControlRequest,
    assertCurrentAuthority?: MutationAuthorityGuard,
  ): Promise<HumanInterventionRecord> {
    return await this.transitionById(
      input.id,
      (current, now) => {
        this.assertController(current, input);
        return {
          ...current,
          updatedAtMs: now,
          controllerLeaseExpiresAtMs: now + this.controlLeaseMs,
        };
      },
      assertCurrentAuthority,
    );
  }

  async authorizeControl(input: HumanInterventionControlRequest): Promise<HumanInterventionRecord> {
    const located = await this.requireCurrentLocated(input.id);
    this.assertController(located.record, input);
    return located.record;
  }

  async leave(
    input: HumanInterventionControlRequest,
    assertCurrentAuthority?: MutationAuthorityGuard,
  ): Promise<HumanInterventionRecord> {
    return await this.transitionById(
      input.id,
      (current, now) => {
        this.assertController(current, input);
        return endControl(current, "waiting", now);
      },
      assertCurrentAuthority,
    );
  }

  async complete(
    input: HumanInterventionControlRequest,
    assertCurrentAuthority?: MutationAuthorityGuard,
  ): Promise<HumanInterventionRecord> {
    return await this.transitionById(
      input.id,
      (current, now) => {
        if (current.state === "resume_pending" || current.state === "resumed") {
          return current;
        }
        this.assertController(current, input);
        return {
          ...current,
          state: "resume_pending",
          generation: current.generation + 1,
          updatedAtMs: now,
          completedAtMs: now,
          continuationId: this.randomId(),
          controllerLeaseExpiresAtMs: undefined,
        };
      },
      assertCurrentAuthority,
    );
  }

  async cancel(
    id: string,
    assertCurrentAuthority?: MutationAuthorityGuard,
  ): Promise<HumanInterventionRecord> {
    return await this.transitionById(
      id,
      (current, now) => {
        if (
          current.state === "cancelled" ||
          current.state === "expired" ||
          current.state === "resume_pending" ||
          current.state === "resumed"
        ) {
          return current;
        }
        return endControl(current, "cancelled", now);
      },
      assertCurrentAuthority,
    );
  }

  async markContinuationAdmitted(input: {
    id: string;
    continuationId: string;
  }): Promise<HumanInterventionRecord> {
    return await this.transitionById(input.id, (current, now) => {
      if (current.state === "resumed" && current.continuationId === input.continuationId) {
        return current;
      }
      if (current.state !== "resume_pending" || current.continuationId !== input.continuationId) {
        throw new HumanInterventionConflictError("Continuation no longer owns this handoff");
      }
      return {
        ...current,
        state: "resumed",
        generation: current.generation + 1,
        updatedAtMs: now,
        resumedAtMs: now,
        controllerId: undefined,
      };
    });
  }

  async listResumePending(): Promise<HumanInterventionRecord[]> {
    const pending = (await this.store.entries()).filter(
      (entry) => entry.value.state === "resume_pending",
    );
    const current = await Promise.all(
      pending.map(async (entry) => {
        try {
          return await this.expireIfNeeded({ key: entry.key, record: entry.value });
        } catch (error) {
          if (error instanceof HumanInterventionNotFoundError) {
            return undefined;
          }
          throw error;
        }
      }),
    );
    return current.flatMap((entry) =>
      entry?.record.state === "resume_pending" ? [entry.record] : [],
    );
  }

  async getProfileReservation(
    browser: HumanInterventionBrowser,
  ): Promise<HumanInterventionRecord | undefined> {
    const current = await this.store.lookup(profileKey(browser));
    if (!current || !isProfileReserved(current, this.now())) {
      return undefined;
    }
    return current;
  }

  private async requireCurrentLocated(
    id: string,
  ): Promise<{ key: string; record: HumanInterventionRecord }> {
    return await this.expireIfNeeded(await this.requireLocated(id));
  }

  private async expireIfNeeded(located: {
    key: string;
    record: HumanInterventionRecord;
  }): Promise<{ key: string; record: HumanInterventionRecord }> {
    if (!canExpire(located.record) || located.record.expiresAtMs > this.now()) {
      return located;
    }
    const record = await this.transition(located.key, located.record.id, (current, now) => {
      if (!canExpire(current) || current.expiresAtMs > now) {
        return current;
      }
      return endControl(current, "expired", now);
    });
    return { key: located.key, record };
  }

  private async requireLocated(
    id: string,
  ): Promise<{ key: string; record: HumanInterventionRecord }> {
    const located = await this.find(id);
    if (!located) {
      throw new HumanInterventionNotFoundError(id);
    }
    return located;
  }

  private async find(
    id: string,
  ): Promise<{ key: string; record: HumanInterventionRecord } | undefined> {
    const key = this.locatedKeys.get(id);
    if (key !== undefined) {
      const record = await this.store.lookup(key);
      if (record?.id === id) {
        return { key, record };
      }
      this.locatedKeys.delete(id);
    }
    const entry = (await this.store.entries()).find((candidate) => candidate.value.id === id);
    if (entry) {
      this.rememberLocation(id, entry.key);
    }
    return entry ? { key: entry.key, record: entry.value } : undefined;
  }

  private rememberLocation(id: string, key: string): void {
    if (this.locatedKeys.size >= MAX_LOCATED_IDS && !this.locatedKeys.has(id)) {
      const oldest = this.locatedKeys.keys().next().value;
      if (oldest !== undefined) {
        this.locatedKeys.delete(oldest);
      }
    }
    this.locatedKeys.set(id, key);
  }

  private async transitionById(
    id: string,
    updateValue: (current: HumanInterventionRecord, now: number) => HumanInterventionRecord,
    assertCurrentAuthority?: MutationAuthorityGuard,
  ): Promise<HumanInterventionRecord> {
    const located = await this.requireCurrentLocated(id);
    return await this.transition(located.key, id, updateValue, assertCurrentAuthority);
  }

  private async transition(
    key: string,
    id: string,
    updateValue: (current: HumanInterventionRecord, now: number) => HumanInterventionRecord,
    assertCurrentAuthority?: MutationAuthorityGuard,
  ): Promise<HumanInterventionRecord> {
    let result: HumanInterventionRecord | undefined;
    let error: Error | undefined;
    const updated = await this.update(key, (current) => {
      if (!current || current.id !== id) {
        error = new HumanInterventionNotFoundError(id);
        return undefined;
      }
      try {
        assertCurrentAuthority?.();
        // Read time at the mutation boundary, after any queued store work.
        result = updateValue(current, this.now());
        return result;
      } catch (caught) {
        error = toErrorObject(caught, "Human browser handoff transition failed");
        return undefined;
      }
    });
    if (error) {
      throw error;
    }
    if (!updated || !result) {
      throw new HumanInterventionConflictError("Human browser handoff changed concurrently");
    }
    return result;
  }

  private assertController(
    current: HumanInterventionRecord,
    input: { controllerId: string; generation: number },
  ): void {
    const now = this.now();
    if (
      current.state !== "control" ||
      current.controllerId !== input.controllerId ||
      current.generation !== input.generation ||
      current.expiresAtMs <= now ||
      (current.controllerLeaseExpiresAtMs ?? 0) <= now
    ) {
      throw new HumanInterventionConflictError("Human browser handoff control is stale");
    }
  }

  private update(
    key: string,
    updateValue: (
      current: HumanInterventionRecord | undefined,
    ) => HumanInterventionRecord | undefined,
  ): Promise<boolean> {
    return this.store.update!(key, updateValue);
  }
}
