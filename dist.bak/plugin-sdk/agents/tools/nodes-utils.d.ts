import type { NodeListNode } from "../../shared/node-list-types.js";
import { type GatewayCallOptions } from "./gateway.js";
export type { NodeListNode };
type DefaultNodeFallback = "none" | "first";
type DefaultNodeSelectionOptions = {
    capability?: string;
    fallback?: DefaultNodeFallback;
    preferLocalMac?: boolean;
};
export declare function selectDefaultNodeFromList(nodes: NodeListNode[], options?: DefaultNodeSelectionOptions): NodeListNode | null;
export declare function listNodes(opts: GatewayCallOptions): Promise<NodeListNode[]>;
export declare function resolveNodeIdFromList(nodes: NodeListNode[], query?: string, allowDefault?: boolean): string;
export declare function resolveNodeId(opts: GatewayCallOptions, query?: string, allowDefault?: boolean): Promise<string>;
