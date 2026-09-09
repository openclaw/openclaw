import {
  HumanInterventionConflictError,
  type HumanInterventionBrowser,
  type HumanInterventionService,
} from "./service.js";

type ReservationReader = Pick<HumanInterventionService, "getProfileReservation">;

type ProfileGateState = {
  active: number;
  blocking: boolean;
  tail: Promise<void>;
  idleWaiters: Array<() => void>;
};

function profileKey(browser: HumanInterventionBrowser): string {
  return `${browser.target}:${browser.profile}`;
}

export class HumanInterventionProfileGate {
  private readonly states = new Map<string, ProfileGateState>();

  constructor(private readonly reservations: ReservationReader) {}

  async beginAutomation(browser: HumanInterventionBrowser): Promise<() => Promise<void>> {
    const key = profileKey(browser);
    await this.withLock(key, async (state) => {
      if (state.blocking || (await this.reservations.getProfileReservation(browser))) {
        throw new HumanInterventionConflictError(
          `Browser profile ${browser.profile} is paused for human control`,
        );
      }
      state.active += 1;
    });
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.withLock(key, (state) => {
        state.active = Math.max(0, state.active - 1);
        if (state.active === 0) {
          for (const resolve of state.idleWaiters.splice(0)) {
            resolve();
          }
        }
      });
      this.cleanup(key);
    };
  }

  async reserve<T>(browser: HumanInterventionBrowser, create: () => Promise<T>): Promise<T> {
    const key = profileKey(browser);
    await this.withLock(key, (state) => {
      if (state.blocking) {
        throw new HumanInterventionConflictError(
          `Browser profile ${browser.profile} already has a pending handoff`,
        );
      }
      state.blocking = true;
    });
    try {
      await this.waitForIdle(key);
      return await create();
    } finally {
      await this.withLock(key, (state) => {
        state.blocking = false;
      });
      this.cleanup(key);
    }
  }

  private state(key: string): ProfileGateState {
    const current = this.states.get(key);
    if (current) {
      return current;
    }
    const created: ProfileGateState = {
      active: 0,
      blocking: false,
      tail: Promise.resolve(),
      idleWaiters: [],
    };
    this.states.set(key, created);
    return created;
  }

  private async withLock<T>(
    key: string,
    operation: (state: ProfileGateState) => T | Promise<T>,
  ): Promise<T> {
    const state = this.state(key);
    const prior = state.tail;
    let unlock!: () => void;
    state.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await prior;
    try {
      return await operation(state);
    } finally {
      unlock();
    }
  }

  private async waitForIdle(key: string): Promise<void> {
    let pending: Promise<void> | undefined;
    await this.withLock(key, (state) => {
      if (state.active > 0) {
        pending = new Promise<void>((resolve) => {
          state.idleWaiters.push(resolve);
        });
      }
    });
    await pending;
  }

  private cleanup(key: string): void {
    const state = this.states.get(key);
    if (state && state.active === 0 && !state.blocking && state.idleWaiters.length === 0) {
      void state.tail.then(() => {
        if (this.states.get(key) === state && state.active === 0 && !state.blocking) {
          this.states.delete(key);
        }
      });
    }
  }
}
