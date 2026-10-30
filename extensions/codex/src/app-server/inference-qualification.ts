/** Captured native provider routing; model permission stays with the execution source. */
export type CodexInferenceThreadQualification = Readonly<{
  assertCurrent: () => void;
  hasProvider: (provider: string) => boolean;
}>;
