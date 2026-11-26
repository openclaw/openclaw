import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { parseBeamPacket, type BeamPacket } from "../packet-contract/packet-v2.generated.js";
import { BEAM_MAX_BODY_BYTES, type BeamSourceModel, type BeamTranscriptItem } from "./types.js";

export type BeamCleanPacketV2 = BeamPacket;
export type BeamCleanCandidate = {
  source: string;
  origin: { adapter: string; sourceHome: string; nativeSession: string };
  branch?: string;
  title: string;
  updatedAt: string;
  completed: boolean;
  sourceModel?: BeamSourceModel;
  completeness: "complete" | "partial";
  items: Array<Pick<BeamTranscriptItem, "type" | "text"> & { speakerId?: string }>;
};

// Protocol 1 accepts at most 4 MiB of selected local history on stdin.
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;

export async function cleanBeamCandidate(
  input: string,
  signal: AbortSignal,
  resolveExecutable: () => Promise<string>,
): Promise<{ packet: BeamCleanPacketV2; raw: Buffer }> {
  signal.throwIfAborted();
  if (Buffer.byteLength(input) > MAX_CANDIDATE_BYTES) {
    throw new Error("Beam cleaner input exceeds 4 MiB");
  }
  const executable = await resolveExecutable();
  const result = await runCommandBuffered([executable, "clean", "--protocol", "1"], {
    baseEnv: {},
    input,
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: { stdout: BEAM_MAX_BODY_BYTES },
    discardOutput: { stderr: true },
  });
  signal.throwIfAborted();
  if (result.termination !== "exit" || result.code !== 0 || result.error) {
    // A failed process can echo source text. Only its bounded lifecycle status is public.
    throw new Error(`Beam cleaner failed (${result.termination}, status ${result.code ?? "none"})`);
  }
  // A receiver hashes the wire artifact. Parsing must preserve these exact bytes.
  return { packet: parseBeamPacket(result.stdout), raw: result.stdout };
}
