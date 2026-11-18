/** Scalar accounting shared by host hooks and worker replies. */
export type BeforeCompactionHookMetrics = {
  messageCountOriginal: number;
  tokenCountOriginal: number | undefined;
  messageCountBefore: number;
  tokenCountBefore: number | undefined;
};
