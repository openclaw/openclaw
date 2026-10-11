export type CodexComputerContextEpoch = {
  value: number;
  frameToolCallId?: string;
  frameImageIdentity?: string;
};

export function invalidateCodexComputerFrame(contextEpoch: CodexComputerContextEpoch): void {
  contextEpoch.value += 1;
  delete contextEpoch.frameToolCallId;
  delete contextEpoch.frameImageIdentity;
}
