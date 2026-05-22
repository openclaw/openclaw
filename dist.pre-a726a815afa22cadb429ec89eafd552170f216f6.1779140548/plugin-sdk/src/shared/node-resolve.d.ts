import { type NodeMatchCandidate } from "./node-match.js";
type ResolveNodeFromListOptions<TNode extends NodeMatchCandidate> = {
    allowDefault?: boolean;
    pickDefaultNode?: (nodes: TNode[]) => TNode | null;
};
export declare function resolveNodeIdFromNodeList<TNode extends NodeMatchCandidate>(nodes: TNode[], query?: string, options?: ResolveNodeFromListOptions<TNode>): string;
export declare function resolveNodeFromNodeList<TNode extends NodeMatchCandidate>(nodes: TNode[], query?: string, options?: ResolveNodeFromListOptions<TNode>): TNode;
export {};
