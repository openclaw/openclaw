// QA Lab exposes the Matrix QA runner lazily to the temporary qa-matrix shim.
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;

export async function createMatrixQaTransportAdapter(
  context: Parameters<AdapterFactory["create"]>[0],
): Promise<Awaited<ReturnType<AdapterFactory["create"]>>> {
  return await (await import("./adapter.runtime.js")).createMatrixQaTransportAdapter(context);
}

export async function runQaMatrixCommand(opts: LiveTransportQaCommandOptions) {
  return await (await import("./cli.runtime.js")).runQaMatrixCommand(opts);
}
