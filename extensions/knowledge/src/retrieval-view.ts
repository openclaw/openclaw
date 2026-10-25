import type { FeatureClient } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import type { ToolLookupOutput, ToolSearchOutput } from "./retrieval-contract.js";

type Mode = "all" | "any" | "phrase" | "exact";
export type SearchState = {
  query: string;
  mode: Mode;
  kind: "" | "page" | "claim" | "relationship";
  type: string;
  tag: string;
  lifecycle: "active" | "superseded" | "all";
  offset: number;
  snapshot?: string | null;
};
export async function loadSearch(
  feature: FeatureClient<typeof contract>,
  state: SearchState,
): Promise<ToolSearchOutput | ToolLookupOutput> {
  const input = {
    query: state.query,
    lifecycle: state.lifecycle,
    offset: state.offset,
    limit: 20,
    ...(state.kind ? { kind: state.kind } : {}),
    ...(state.type ? { type: state.type } : {}),
    ...(state.tag ? { tag: state.tag } : {}),
  };
  return state.mode === "exact"
    ? feature.invoke("lookup", input)
    : feature.invoke("grep", { ...input, mode: state.mode });
}
