import type { AcpxRuntime as UpstreamRuntime } from "acpx/runtime";
import { createLazyRuntimeMethodBinder } from "openclaw/plugin-sdk/lazy-runtime";
import type { AcpRuntime, AcpRuntimeTurn, AcpRuntimeTurnInput } from "../runtime-api.js";

export type CompleteAcpRuntimeTurn = AcpRuntimeTurn &
  Required<Pick<AcpRuntimeTurn, "promptStarted">>;

/**
 * Contract for runtimes this extension resolves behind the lazy proxy. The
 * SDK keeps these hooks optional for third-party backends, but every ACPX
 * runtime (the extension's AcpxRuntime and the upstream acpx runtime)
 * implements the full surface. Requiring them here turns an absent hook into
 * a compile error instead of a silently fabricated success at runtime.
 */
export type CompleteAcpRuntime = Omit<
  AcpRuntime,
  "startTurn" | "getStatus" | "prepareFreshSession"
> &
  Required<Pick<AcpRuntime, "getCapabilities" | "setMode" | "setConfigOption" | "doctor">> & {
    startTurn(input: AcpRuntimeTurnInput): CompleteAcpRuntimeTurn;
    getStatus: UpstreamRuntime["getStatus"];
    setModel: UpstreamRuntime["setModel"];
    prepareFreshSession(
      input:
        | Parameters<NonNullable<AcpRuntime["prepareFreshSession"]>>[0]
        | Parameters<UpstreamRuntime["prepareFreshSession"]>[0],
    ): Promise<void>;
    findSession(input: {
      sessionKey: string;
      agent: string;
      agentId?: string;
    }): ReturnType<UpstreamRuntime["findSession"]>;
    shutdown(): Promise<void>;
  };

/** Start an ACP turn through a lazy runtime resolver without awaiting resolution up front. */
function lazyStartRuntimeTurn(
  resolveRuntime: () => Promise<CompleteAcpRuntime>,
  input: AcpRuntimeTurnInput,
): CompleteAcpRuntimeTurn {
  const turnPromise = resolveRuntime().then((runtime) => runtime.startTurn(input));
  return {
    requestId: input.requestId,
    get promptStarted() {
      return turnPromise.then((turn) => turn.promptStarted);
    },
    events: {
      async *[Symbol.asyncIterator]() {
        yield* (await turnPromise).events;
      },
    },
    result: turnPromise.then((turn) => turn.result),
    cancel(inputArgs) {
      return turnPromise.then((turn) => turn.cancel(inputArgs));
    },
    closeStream(inputArgs) {
      return turnPromise.then((turn) => turn.closeStream(inputArgs));
    },
  };
}

/** Create an ACP runtime facade backed by an async runtime resolver. */
export function createLazyAcpRuntimeProxy(
  resolveRuntime: () => Promise<CompleteAcpRuntime>,
): CompleteAcpRuntime {
  const bind = createLazyRuntimeMethodBinder(resolveRuntime);
  return {
    ownerAwareSessions: 1,
    findSession: bind((runtime) => runtime.findSession.bind(runtime)),
    shutdown: bind((runtime) => runtime.shutdown.bind(runtime)),
    ensureSession: bind((runtime) => runtime.ensureSession.bind(runtime)),
    startTurn(input) {
      return lazyStartRuntimeTurn(resolveRuntime, input);
    },
    async *runTurn(input) {
      yield* (await resolveRuntime()).runTurn(input);
    },
    getCapabilities: bind((runtime) => runtime.getCapabilities.bind(runtime)),
    getStatus: bind((runtime) => runtime.getStatus.bind(runtime)),
    setMode: bind((runtime) => runtime.setMode.bind(runtime)),
    setModel: bind((runtime) => runtime.setModel.bind(runtime)),
    setConfigOption: bind((runtime) => runtime.setConfigOption.bind(runtime)),
    doctor: bind((runtime) => runtime.doctor.bind(runtime)),
    prepareFreshSession: bind((runtime) => runtime.prepareFreshSession.bind(runtime)),
    cancel: bind((runtime) => runtime.cancel.bind(runtime)),
    close: bind((runtime) => runtime.close.bind(runtime)),
  };
}
