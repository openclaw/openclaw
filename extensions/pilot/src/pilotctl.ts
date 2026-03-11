import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type {
  PilotDaemonStatus,
  PilotInboundMessage,
  PilotPeer,
  PilotTrustRequest,
} from "./types.js";

const execFile = promisify(execFileCb);

type PilotctlOptions = {
  socketPath?: string;
  pilotctlPath?: string;
  timeoutMs?: number;
};

type PilotctlResult<T = unknown> = {
  status: string;
  data: T;
};

async function run<T = unknown>(args: string[], opts?: PilotctlOptions): Promise<T> {
  const bin = opts?.pilotctlPath || process.env.PILOTCTL_PATH || "pilotctl";
  const fullArgs = ["--json", ...args];
  if (opts?.socketPath) {
    fullArgs.unshift("--socket", opts.socketPath);
  }
  const timeout = opts?.timeoutMs ?? 15_000;
  const { stdout } = await execFile(bin, fullArgs, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim()) as PilotctlResult<T>;
  if (parsed.status !== "ok") {
    throw new Error(`pilotctl error: ${JSON.stringify(parsed)}`);
  }
  return parsed.data;
}

export async function daemonStatus(opts?: PilotctlOptions): Promise<PilotDaemonStatus> {
  return run<PilotDaemonStatus>(["daemon", "status"], opts);
}

export async function daemonStart(
  hostname: string,
  registry: string,
  opts?: PilotctlOptions,
): Promise<PilotDaemonStatus> {
  return run<PilotDaemonStatus>(
    ["daemon", "start", "--hostname", hostname, "--registry", registry],
    opts,
  );
}

export async function daemonInfo(opts?: PilotctlOptions): Promise<PilotDaemonStatus> {
  return run<PilotDaemonStatus>(["info"], opts);
}

export async function sendMessage(
  addr: string,
  text: string,
  opts?: PilotctlOptions,
): Promise<{ messageId: string }> {
  return run<{ messageId: string }>(["send-message", addr, "--data", text], opts);
}

export async function receiveMessages(opts?: PilotctlOptions): Promise<PilotInboundMessage[]> {
  const data = await run<PilotInboundMessage[] | null>(["received", "--clear"], opts);
  return data ?? [];
}

export async function inbox(opts?: PilotctlOptions): Promise<PilotInboundMessage[]> {
  const data = await run<PilotInboundMessage[] | null>(["inbox", "--clear"], opts);
  return data ?? [];
}

export async function trustHandshake(
  addr: string,
  opts?: PilotctlOptions,
): Promise<{ status: string }> {
  return run<{ status: string }>(["handshake", addr], opts);
}

export async function trustApprove(
  addr: string,
  opts?: PilotctlOptions,
): Promise<{ status: string }> {
  return run<{ status: string }>(["approve", addr], opts);
}

export async function trustReject(
  addr: string,
  opts?: PilotctlOptions,
): Promise<{ status: string }> {
  return run<{ status: string }>(["reject", addr], opts);
}

export async function trustList(opts?: PilotctlOptions): Promise<PilotPeer[]> {
  const data = await run<PilotPeer[] | null>(["trust"], opts);
  return data ?? [];
}

export async function trustPending(opts?: PilotctlOptions): Promise<PilotTrustRequest[]> {
  const data = await run<PilotTrustRequest[] | null>(["pending"], opts);
  return data ?? [];
}

export async function lookup(hostname: string, opts?: PilotctlOptions): Promise<PilotPeer | null> {
  return run<PilotPeer | null>(["find", hostname], opts);
}

export async function listPeers(opts?: PilotctlOptions): Promise<PilotPeer[]> {
  const data = await run<PilotPeer[] | null>(["peers"], opts);
  return data ?? [];
}

export async function submitTask(
  addr: string,
  task: string,
  opts?: PilotctlOptions,
): Promise<{ taskId: string }> {
  return run<{ taskId: string }>(["task", "submit", addr, "--task", task], opts);
}

export async function taskList(
  opts?: PilotctlOptions,
): Promise<Array<{ taskId: string; status: string; addr: string }>> {
  const data = await run<Array<{ taskId: string; status: string; addr: string }> | null>(
    ["task", "list"],
    opts,
  );
  return data ?? [];
}

export async function publish(
  addr: string,
  topic: string,
  data: string,
  opts?: PilotctlOptions,
): Promise<{ status: string }> {
  return run<{ status: string }>(["publish", addr, topic, "--data", data], opts);
}

export async function subscribe(
  addr: string,
  topic: string,
  opts?: PilotctlOptions,
): Promise<{ subscriptionId: string }> {
  return run<{ subscriptionId: string }>(["subscribe", addr, topic], opts);
}
