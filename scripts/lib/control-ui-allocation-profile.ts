import { mapColdLoadCpuProfile, type ColdLoadCpuFrame } from "./control-ui-cold-load-trace.ts";
import { controlUiProfileSourceOwner } from "./control-ui-cpu-census.ts";

type AllocationNode = {
  id: number;
  callFrame: ColdLoadCpuFrame;
  selfSize: number;
  children: AllocationNode[];
};

export type ControlUiAllocationProfile = {
  head: AllocationNode;
  samples: { size: number; nodeId: number; ordinal: number }[];
};

/** Reuse the CPU profiler's asset/source-map boundary for allocation stacks. */
export async function mapControlUiAllocationProfile(
  profile: ControlUiAllocationProfile,
  options: Parameters<typeof mapColdLoadCpuProfile>[1],
) {
  const nodes: AllocationNode[] = [];
  const visit = (node: AllocationNode) => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(profile.head);
  const mapped = await mapColdLoadCpuProfile(
    { nodes: nodes.map(({ id, callFrame }) => ({ id, callFrame })) },
    options,
  );
  const frames = new Map(mapped.profile.nodes.map((node) => [node.id, node.callFrame]));
  const replace = (node: AllocationNode): AllocationNode => ({
    ...node,
    callFrame: frames.get(node.id)!,
    children: node.children.map(replace),
  });
  return {
    profile: { ...profile, head: replace(profile.head) },
    mappedFrames: mapped.mappedFrames,
    unmappedFrames: mapped.unmappedFrames,
  };
}

/** Count each sampled allocation once, not once per ancestor in its stack. */
export function summarizeControlUiAllocations(profile: ControlUiAllocationProfile) {
  const frames = new Map<number, ColdLoadCpuFrame>();
  const sourceFrames = new Map<number, ColdLoadCpuFrame>();
  const visit = (node: AllocationNode, caller?: ColdLoadCpuFrame) => {
    frames.set(node.id, node.callFrame);
    const source = node.callFrame.url ? node.callFrame : caller;
    sourceFrames.set(node.id, source ?? node.callFrame);
    node.children.forEach((child) => visit(child, source));
  };
  visit(profile.head);
  type Entry = ColdLoadCpuFrame & { bytes: number; samples: number };
  const functions = new Map<string, Entry>();
  const sourceFunctions = new Map<string, Entry>();
  const missing = {
    functionName: "<missing allocation stack>",
    url: "",
    lineNumber: 0,
    columnNumber: 0,
  };
  let bytes = 0;
  let missingFrameBytes = 0;
  for (const sample of profile.samples) {
    if (!Number.isFinite(sample.size) || sample.size < 0) {
      throw new Error("Invalid allocation sample size");
    }
    // V8 can return samples whose stack node is absent from the supplied tree.
    // Preserve their bytes explicitly; no source attribution can be recovered.
    if (!frames.has(sample.nodeId)) {
      missingFrameBytes += sample.size;
    }
    for (const [table, frame] of [
      [functions, frames.get(sample.nodeId) ?? missing],
      [sourceFunctions, sourceFrames.get(sample.nodeId) ?? missing],
    ] as const) {
      const key = JSON.stringify([
        frame.url,
        frame.functionName,
        frame.lineNumber,
        frame.columnNumber,
      ]);
      const entry = table.get(key) ?? { ...frame, bytes: 0, samples: 0 };
      entry.bytes += sample.size;
      entry.samples++;
      table.set(key, entry);
    }
    bytes += sample.size;
  }
  const files = new Map<string, { file: string; bytes: number; samples: number }>();
  const owners = new Map<string, number>();
  const ranked = [...sourceFunctions.values()]
    .toSorted((a, b) => b.bytes - a.bytes)
    .map((entry) => {
      const owner = controlUiProfileSourceOwner(entry.url, entry.functionName, entry.lineNumber);
      const file = files.get(entry.url) ?? { file: entry.url, bytes: 0, samples: 0 };
      file.bytes += entry.bytes;
      file.samples += entry.samples;
      files.set(entry.url, file);
      owners.set(owner, (owners.get(owner) ?? 0) + entry.bytes);
      return Object.assign(entry, { owner });
    });
  return {
    bytes,
    samples: profile.samples.length,
    missingFrameBytes,
    functions: [...functions.values()].toSorted((a, b) => b.bytes - a.bytes),
    sourceFunctions: ranked,
    files: [...files.values()].toSorted((a, b) => b.bytes - a.bytes),
    owners: Object.fromEntries(owners),
    contract:
      "Estimated allocated bytes from 4 KiB V8 sampling, including major/minor-GC collected objects. functions ranks allocating leaves; sourceFunctions/files/owners charge URL-less native children to their nearest source-bearing caller. Each sample counts once per table, never inclusively up the stack. Missing stack bytes remain unattributed. Whole renderer main isolate, including automation; excludes other isolates and native allocations. Not retained heap or exact object counts. Profiling adds overhead; use separate timing runs.",
  };
}
