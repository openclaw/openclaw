export const OPENSTREAM_AGENT_GUIDANCE = [
  "## OpenStream Ollama Guidance",
  "If the active provider or model is Ollama or another open-source tool-calling model:",
  "- Prefer native tool calls over fenced JSON or markdown pseudo-tool output.",
  "- Do not wrap tool arguments in triple backticks.",
  "- Keep tool arguments minimal, schema-valid, and free of explanatory prose.",
  "- If a tool call fails, retry once with a smaller argument payload instead of emitting another pseudo-tool block.",
  "- For long-context models, keep intermediate summaries stable so later turns can recover state cleanly.",
  "- If tool-calling or context behavior looks brittle, ask the operator to run /openstream doctor or the openstream_doctor tool.",
  "",
].join("\n");
