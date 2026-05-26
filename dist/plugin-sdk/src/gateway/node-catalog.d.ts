import { type PairedDevice } from "../infra/device-pairing.js";
import type { NodePairingPairedNode } from "../infra/node-pairing.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import type { NodeSession } from "./node-registry.js";
type KnownNodeDevicePairingSource = {
    nodeId: string;
    displayName?: string;
    platform?: string;
    clientId?: string;
    clientMode?: string;
    remoteIp?: string;
    approvedAtMs?: number;
    lastSeenAtMs?: number;
    lastSeenReason?: string;
};
type KnownNodeApprovedSource = {
    nodeId: string;
    displayName?: string;
    platform?: string;
    version?: string;
    coreVersion?: string;
    uiVersion?: string;
    remoteIp?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    caps: string[];
    commands: string[];
    permissions?: Record<string, boolean>;
    approvedAtMs?: number;
    lastConnectedAtMs?: number;
    lastSeenAtMs?: number;
    lastSeenReason?: string;
};
type KnownNodeEntry = {
    nodeId: string;
    devicePairing?: KnownNodeDevicePairingSource;
    nodePairing?: KnownNodeApprovedSource;
    live?: NodeSession;
    effective: NodeListNode;
};
type KnownNodeCatalog = {
    entriesById: Map<string, KnownNodeEntry>;
};
export declare function createKnownNodeCatalog(params: {
    pairedDevices: readonly PairedDevice[];
    pairedNodes?: readonly NodePairingPairedNode[];
    connectedNodes: readonly NodeSession[];
}): KnownNodeCatalog;
export declare function listKnownNodes(catalog: KnownNodeCatalog): NodeListNode[];
export declare function getKnownNodeEntry(catalog: KnownNodeCatalog, nodeId: string): KnownNodeEntry | null;
export declare function getKnownNode(catalog: KnownNodeCatalog, nodeId: string): NodeListNode | null;
export {};
