/** Harness-owned binding to a local implementation or configured remote service. */
export type AgentHarnessRuntimeArtifactBinding = Readonly<{
  id: string;
  fingerprint: string;
}>;

/** Runtime artifact a verified continuation must keep using. */
export type ExpectedAgentHarnessRuntimeArtifact = Readonly<{
  harnessId: string;
  artifact: AgentHarnessRuntimeArtifactBinding;
}>;
