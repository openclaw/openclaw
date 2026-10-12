import { randomUUID } from "node:crypto";
import { createLazyRuntimeMethodBinder } from "openclaw/plugin-sdk/lazy-runtime";
import { verifyInstalledCuaDriverArtifacts } from "./driver-artifacts.js";

type DriverClickButton = import("@trycua/cua-driver").ClickButton;
type CuaDriverLike = import("@trycua/cua-driver").CuaDriverLike;
type CuaDriverSessionLike = import("@trycua/cua-driver").CuaDriverSessionLike;
type DriverScrollDirection = import("@trycua/cua-driver").ScrollDirection;
type CuaDriverSdk = Pick<
  typeof import("@trycua/cua-driver"),
  | "ActionTarget"
  | "ClickPosition"
  | "CuaDriver"
  | "DriverError"
  | "InputDeliveryMode"
  | "ScrollBy"
  | "SessionPermissionMode"
  | "createTrustedSession"
>;

export type CuaToolResult = import("@trycua/cua-driver").ToolResult;

// These numeric values are part of the pinned SDK contract. Keeping
// them local avoids loading the native library while OpenClaw is only
// registering the bundled plugin.
export const ClickButton = {
  Left: 0 as DriverClickButton,
  Right: 1 as DriverClickButton,
  Middle: 2 as DriverClickButton,
} as const;
export type ClickButton = (typeof ClickButton)[keyof typeof ClickButton];

export const ScrollDirection = {
  Up: 0 as DriverScrollDirection,
  Down: 1 as DriverScrollDirection,
  Left: 2 as DriverScrollDirection,
  Right: 3 as DriverScrollDirection,
} as const;
export type ScrollDirection = (typeof ScrollDirection)[keyof typeof ScrollDirection];

export type CuaDriverSession = Pick<DirectCuaDriverSession, keyof DirectCuaDriverSession> & {
  readonly generation: string;
  prepareAvailability?(): Promise<void>;
  prepareExecution?(signal?: AbortSignal, assertAuthority?: () => void): Promise<void>;
  resetAvailabilityCache(): void;
};

function isExpiredSessionError(sdk: CuaDriverSdk, error: unknown): boolean {
  return (
    sdk.DriverError.Tool.instanceOf(error) &&
    error.inner.errorCode === "permission_denied" &&
    error.inner.message === "Permission denied: authorization context expired"
  );
}

function driverToolError(sdk: CuaDriverSdk, error: unknown): unknown {
  if (!sdk.DriverError.Tool.instanceOf(error)) {
    return error;
  }
  return new Error(
    "CUA_DRIVER_TOOL_ERROR: " +
      error.inner.tool +
      ": " +
      error.inner.message +
      (error.inner.errorCode ? " (" + error.inner.errorCode + ")" : ""),
    { cause: error },
  );
}

function asyncOptions(signal?: AbortSignal) {
  return signal ? { signal } : undefined;
}

class DirectCuaDriverSession {
  private readonly runtime: CuaDriverLike;
  private readonly session: CuaDriverSessionLike;
  private readonly publicSession = `openclaw-${randomUUID()}`;
  private readonly desktopTarget: import("@trycua/cua-driver").ActionTarget;
  private startPromise: Promise<void> | undefined;
  private started = false;
  private disposed = false;

  constructor(private readonly sdk: CuaDriverSdk) {
    const unrestricted = sdk.SessionPermissionMode.Unrestricted;
    // This is an OpenClaw-owned ceiling, not plugin configuration or tool input.
    // The model cannot select a session or widen this authorization after start.
    const authorization = {
      allowedModes: [unrestricted],
      compatibilityMode: unrestricted,
      unrestrictedAcknowledged: true,
      maxSessionTtlSeconds: 3_600n,
      maxIdleTtlSeconds: 300n,
    };
    // Never use CuaDriver.create(): configured creation fixes the authorization
    // ceiling before the lifecycle session is admitted.
    this.runtime = sdk.CuaDriver.createConfigured({
      claudeCodeCompatibility: false,
      authorization,
    });
    this.session = sdk.createTrustedSession(this.runtime, {
      mode: unrestricted,
      ttlSeconds: authorization.maxSessionTtlSeconds,
      idleTtlSeconds: authorization.maxIdleTtlSeconds,
      publicSession: this.publicSession,
    });
    // CUA 0.20 moves modality from session state to each action. Keep one
    // lifecycle/authority owner and make the desktop target explicit per call.
    this.desktopTarget = sdk.ActionTarget.Desktop.new({ displayId: "primary" });
  }

  private async ensureSessionStarted(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-computer is stopping");
    }
    if (!this.startPromise) {
      const start = this.session
        .startSession({ session: this.publicSession }, asyncOptions(signal))
        .then(() => {
          this.started = true;
        });
      this.startPromise = start;
      try {
        await start;
      } catch (error) {
        if (this.startPromise === start) {
          this.startPromise = undefined;
        }
        throw error;
      }
      return;
    }
    await this.startPromise;
  }

  private async invoke<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureSessionStarted(signal);
    return await operation();
  }

  isAvailable(): boolean {
    return !this.disposed && this.runtime.isAvailable();
  }
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return await this.invoke(signal, () =>
      this.session.callTool(
        name,
        JSON.stringify({ ...args, session: this.publicSession }),
        asyncOptions(signal),
      ),
    );
  }
  async getCursorPosition(signal?: AbortSignal) {
    return await this.invoke(signal, () =>
      this.session.getCursorPosition({ session: this.publicSession }, asyncOptions(signal)),
    );
  }
  async getSessionState(signal?: AbortSignal) {
    await this.ensureSessionStarted(signal);
    return await this.session.getSessionState(
      { session: this.publicSession },
      asyncOptions(signal),
    );
  }
  async getDesktopState(signal?: AbortSignal) {
    return await this.invoke(signal, () => this.session.getDesktopState({}, asyncOptions(signal)));
  }
  async getScreenSize(signal?: AbortSignal) {
    return await this.invoke(signal, () => this.session.getScreenSize({}, asyncOptions(signal)));
  }
  async click(
    input: { x: number; y: number; button: ClickButton; count: number },
    signal?: AbortSignal,
  ): Promise<CuaToolResult> {
    return await this.invoke(signal, async () => {
      // Typed clicks return ActionResult and throw tool refusals; other SDK
      // actions still use the shared ToolResult envelope.
      try {
        const action = await this.session.click(
          {
            position: this.sdk.ClickPosition.Coordinates.new({ x: input.x, y: input.y }),
            deliveryMode: this.sdk.InputDeliveryMode.Foreground,
            button: input.button,
            count: input.count,
            target: this.desktopTarget,
          },
          asyncOptions(signal),
        );
        return { text: "", images: [], isError: false, degraded: false, rawJson: "{}", action };
      } catch (error) {
        if (!this.sdk.DriverError.Tool.instanceOf(error)) {
          throw error;
        }
        return {
          text: error.inner.message,
          images: [],
          isError: true,
          degraded: false,
          rawJson: "{}",
          errorCode: error.inner.errorCode,
        };
      }
    });
  }
  async drag(
    input: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: bigint },
    signal?: AbortSignal,
  ) {
    return await this.invoke(signal, () =>
      this.session.drag({ ...input, target: this.desktopTarget }, asyncOptions(signal)),
    );
  }
  async moveCursor(input: { x: number; y: number }, signal?: AbortSignal) {
    return await this.invoke(signal, () =>
      this.session.moveCursor({ ...input, target: this.desktopTarget }, asyncOptions(signal)),
    );
  }
  async scroll(
    input: { x: number; y: number; direction: ScrollDirection; amount: bigint },
    signal?: AbortSignal,
  ) {
    return await this.invoke(signal, () =>
      this.session.scroll(
        {
          ...input,
          target: this.desktopTarget,
          by: this.sdk.ScrollBy.Line,
        },
        asyncOptions(signal),
      ),
    );
  }
  async typeText(text: string, signal?: AbortSignal) {
    return await this.invoke(signal, () =>
      this.session.typeText({ text, target: this.desktopTarget }, asyncOptions(signal)),
    );
  }
  async pressKey(input: { key: string; modifiers: string[] }, signal?: AbortSignal) {
    return await this.invoke(signal, () =>
      this.session.pressKey({ ...input, target: this.desktopTarget }, asyncOptions(signal)),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    let failure: unknown;
    try {
      await this.startPromise;
    } catch (error) {
      failure = error;
    }
    if (this.started) {
      try {
        await this.session.endSession({ session: this.publicSession });
      } catch (error) {
        // Expiry already ended this authorization. Still release every native
        // resource, but do not make physical close fail on this refusal.
        if (
          !isExpiredSessionError(this.sdk, error) &&
          !this.sdk.DriverError.Shutdown?.instanceOf(error)
        ) {
          failure ??= error;
        }
      }
    }
    try {
      this.session.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.runtime.shutdown();
    } catch (error) {
      failure ??= error;
    }
    try {
      (this.runtime as CuaDriverLike & { uniffiDestroy?: () => void }).uniffiDestroy?.();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      throw failure instanceof Error
        ? failure
        : new Error("CUA Driver cleanup failed", { cause: failure });
    }
  }
}

async function loadCuaDriverSdk(): Promise<CuaDriverSdk> {
  const artifactVerification = verifyInstalledCuaDriverArtifacts();
  if (!artifactVerification.ok) {
    throw new Error(artifactVerification.diagnostic);
  }
  return (await import("@trycua/cua-driver")) as CuaDriverSdk;
}

function unavailableError(failure: unknown): Error {
  if (failure instanceof Error && /^COMPUTER_DRIVER_[A-Z_]+:/u.test(failure.message)) {
    return failure;
  }
  const detail = failure instanceof Error ? failure.message : String(failure);
  return new Error(`COMPUTER_DRIVER_UNAVAILABLE: failed to load CUA Driver SDK: ${detail}`, {
    cause: failure,
  });
}

class LazyCuaDriverSession implements CuaDriverSession {
  // Keep refs stable across lazy loading, but revoke them on session replacement.
  private currentGeneration = randomUUID();
  get generation(): string {
    return this.currentGeneration;
  }
  private loadedSdk: CuaDriverSdk | undefined;
  private preparePromise: Promise<void> | undefined;
  private runtime: DirectCuaDriverSession | undefined;
  private loadPromise: Promise<DirectCuaDriverSession> | undefined;
  private loadFailure: unknown;
  private hasLoadFailure = false;
  private disposed = false;

  constructor(private readonly loadSdk: () => Promise<CuaDriverSdk>) {}

  private resolveRuntime(): DirectCuaDriverSession | undefined {
    if (this.disposed || this.hasLoadFailure || this.loadPromise) {
      return undefined;
    }
    if (this.runtime) {
      return this.runtime;
    }
    const loadPromise = this.loadSdk()
      .then((sdk) => {
        this.loadedSdk = sdk;
        this.runtime = new DirectCuaDriverSession(sdk);
        return this.runtime;
      })
      .catch((error: unknown) => {
        this.loadFailure = error;
        this.hasLoadFailure = true;
        throw error;
      })
      .finally(() => {
        if (this.loadPromise === loadPromise) {
          this.loadPromise = undefined;
        }
      });
    this.loadPromise = loadPromise;
    // Availability is synchronous, so the first probe starts the ESM import
    // and reports unavailable until a later probe observes the loaded SDK.
    void loadPromise.catch(() => {});
    return undefined;
  }

  private async requireRuntime(): Promise<DirectCuaDriverSession> {
    const runtime = this.resolveRuntime();
    if (runtime) {
      return runtime;
    }
    if (this.loadPromise) {
      try {
        return await this.loadPromise;
      } catch (error) {
        throw unavailableError(this.loadFailure ?? error);
      }
    }
    throw unavailableError(
      this.disposed ? new Error("cua-computer is stopping") : this.loadFailure,
    );
  }

  isAvailable(): boolean {
    return this.resolveRuntime()?.isAvailable() ?? false;
  }

  async prepareAvailability(): Promise<void> {
    this.resolveRuntime();
    // Loading failure remains an unavailable capability with its original
    // diagnostic; an optional driver must not prevent the node from starting.
    await this.loadPromise?.catch(() => {});
  }

  resetAvailabilityCache(): void {
    if (!this.runtime && !this.disposed && !this.loadPromise) {
      this.loadFailure = undefined;
      this.hasLoadFailure = false;
    }
  }

  async prepareExecution(signal?: AbortSignal, assertAuthority?: () => void): Promise<void> {
    signal?.throwIfAborted();
    assertAuthority?.();
    if (!this.preparePromise) {
      const prepare = (async () => {
        const runtime = await this.requireRuntime();
        if (this.disposed) {
          throw unavailableError(new Error("cua-computer is stopping"));
        }
        try {
          // Check authority before dispatch, never replay the requested action.
          await runtime.getSessionState(signal);
        } catch (error) {
          const sdk = this.loadedSdk;
          if (!sdk || !isExpiredSessionError(sdk, error)) {
            throw sdk ? driverToolError(sdk, error) : error;
          }
          // Expiry alone is not authority: the owning execution must still
          // admit this operation before releasing or replacing its grant.
          signal?.throwIfAborted();
          assertAuthority?.();
          await runtime.dispose();
          this.runtime = undefined;
          this.currentGeneration = randomUUID();
          signal?.throwIfAborted();
          assertAuthority?.();
          if (this.disposed) {
            throw unavailableError(new Error("cua-computer is stopping"));
          }
          this.runtime = new DirectCuaDriverSession(sdk);
          await this.runtime.getSessionState(signal).catch((replacementError: unknown) => {
            throw driverToolError(sdk, replacementError);
          });
        }
        if (this.disposed) {
          throw unavailableError(new Error("cua-computer is stopping"));
        }
      })();
      this.preparePromise = prepare;
      void prepare
        .finally(() => {
          if (this.preparePromise === prepare) {
            this.preparePromise = undefined;
          }
        })
        .catch(() => {});
    }
    await this.preparePromise;
    signal?.throwIfAborted();
    assertAuthority?.();
  }

  private readonly bindRuntime = createLazyRuntimeMethodBinder(() => this.requireRuntime());
  getDesktopState = this.bindRuntime((runtime) => runtime.getDesktopState.bind(runtime));
  callTool = this.bindRuntime((runtime) => runtime.callTool.bind(runtime));
  getCursorPosition = this.bindRuntime((runtime) => runtime.getCursorPosition.bind(runtime));
  getSessionState = this.bindRuntime((runtime) => runtime.getSessionState.bind(runtime));
  getScreenSize = this.bindRuntime((runtime) => runtime.getScreenSize.bind(runtime));
  click = this.bindRuntime((runtime) => runtime.click.bind(runtime));
  drag = this.bindRuntime((runtime) => runtime.drag.bind(runtime));
  moveCursor = this.bindRuntime((runtime) => runtime.moveCursor.bind(runtime));
  scroll = this.bindRuntime((runtime) => runtime.scroll.bind(runtime));
  typeText = this.bindRuntime((runtime) => runtime.typeText.bind(runtime));
  pressKey = this.bindRuntime((runtime) => runtime.pressKey.bind(runtime));

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      await this.loadPromise;
    } catch {
      // A failed load has no native resources to release.
    }
    // Mark disposed before waiting, so expiry recovery cannot reopen authority.
    await this.preparePromise?.catch(() => {});
    await this.runtime?.dispose();
  }
}

export function createCuaDriver(
  options: { loadSdk?: () => Promise<CuaDriverSdk> } = {},
): CuaDriverSession {
  return new LazyCuaDriverSession(options.loadSdk ?? loadCuaDriverSdk);
}
