// Balance existing target order across a requested number of nonempty chunks.
export function splitTestTargetChunks(targets: string[], chunkCount: number): string[][] {
  if (targets.length === 0) {
    return [];
  }
  const normalizedChunkCount = Math.min(chunkCount, targets.length);
  const baseSize = Math.floor(targets.length / normalizedChunkCount);
  const remainder = targets.length % normalizedChunkCount;
  const chunks: string[][] = [];
  let offset = 0;
  for (let index = 0; index < normalizedChunkCount; index += 1) {
    const chunkSize = baseSize + (index < remainder ? 1 : 0);
    chunks.push(targets.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}
