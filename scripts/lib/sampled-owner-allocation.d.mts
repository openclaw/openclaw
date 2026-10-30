type SampledOwnerNode = {
  callFrame: { url: string };
  id: number;
  selfSize: number;
  children: SampledOwnerNode[];
};

export function sampledOwnerBytes(
  profile: { head: SampledOwnerNode; samples: { nodeId: number }[] },
  url: string,
): { bytes: number; samples: number };
