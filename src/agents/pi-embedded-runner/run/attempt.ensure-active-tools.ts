export type EnsureActiveToolsParams = {
  session: {
    agent: { state: { tools: { name: string }[] } };
    setActiveToolsByName: (names: string[]) => void;
  };
  isRawModelRun: boolean;
  sessionToolAllowlist: string[];
  effectiveToolCount: number;
  warn?: (message: string) => void;
};

export function ensureActiveToolsBeforePrompt(params: EnsureActiveToolsParams): void {
  if (params.isRawModelRun || params.sessionToolAllowlist.length === 0) {
    return;
  }
  const activeBefore = params.session.agent.state.tools.length;
  params.session.setActiveToolsByName(params.sessionToolAllowlist);
  const activeAfter = params.session.agent.state.tools.length;
  if (activeBefore === 0) {
    params.warn?.(
      `[OPENCLAW_TOOLS_DIAG] active tools were empty at prompt dispatch; restored to ${activeAfter}/${params.sessionToolAllowlist.length} (effective=${params.effectiveToolCount})`,
    );
  } else if (activeAfter < params.sessionToolAllowlist.length) {
    params.warn?.(
      `[OPENCLAW_TOOLS_DIAG] re-apply restored only ${activeAfter}/${params.sessionToolAllowlist.length} tools (allowlist contains entries missing from Pi registry)`,
    );
  }
}
