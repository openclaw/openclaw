import { axValue, type RawAXNode } from "./cdp-ax.js";
import type { RoleRefMap, RoleSnapshotOptions } from "./pw-role-snapshot.js";
import { ROLE_SNAPSHOT_MAX_DEPTH } from "./snapshot-depth-limit.js";
import { INTERACTIVE_ROLES, STRUCTURAL_ROLES } from "./snapshot-roles.js";

export type CdpRoleRef = RoleRefMap[string] & {
  backendDOMNodeId?: number;
  frameId?: string;
};

export type CursorInteractiveInfo = {
  text: string;
  hasOnClick?: boolean;
  hasCursorPointer?: boolean;
  hasTabIndex?: boolean;
  isEditable?: boolean;
  hiddenInputType?: string;
};

export type RoleTreeNode = {
  raw: RawAXNode;
  role: string;
  name: string;
  value: string;
  backendDOMNodeId?: number;
  children: number[];
  parent?: number;
  ref?: string;
  nth?: number;
  url?: string;
  cursorInfo?: CursorInteractiveInfo;
  frameId?: string;
  iframeLineIndex?: number;
  transparent?: boolean;
};

export function buildRoleTree(
  nodes: RawAXNode[],
  rootBackendNodeId?: number,
): { tree: RoleTreeNode[]; roots: number[] } {
  const byId = new Map<string, number>();
  const tree: RoleTreeNode[] = [];
  for (const raw of nodes) {
    const nodeId = raw.nodeId ?? "";
    if (!nodeId) {
      continue;
    }
    const role = axValue(raw.role) || "unknown";
    const name = axValue(raw.name);
    const normalizedRole = role.toLowerCase();
    byId.set(nodeId, tree.length);
    tree.push({
      raw,
      role,
      name,
      value: axValue(raw.value),
      backendDOMNodeId:
        typeof raw.backendDOMNodeId === "number" && raw.backendDOMNodeId > 0
          ? Math.floor(raw.backendDOMNodeId)
          : undefined,
      children: [],
      ...(rootBackendNodeId !== undefined
        ? {
            transparent:
              raw.ignored === true ||
              ["none", "presentation", "fragment"].includes(normalizedRole) ||
              (normalizedRole === "generic" && !name),
          }
        : {}),
    });
  }

  for (const [index, node] of tree.entries()) {
    for (const childId of node.raw.childIds ?? []) {
      const childIndex = byId.get(childId);
      if (childIndex === undefined) {
        continue;
      }
      node.children.push(childIndex);
      tree[childIndex]!.parent = index;
    }
  }

  const roots: number[] = [];
  if (rootBackendNodeId !== undefined) {
    const rootIndex = tree.findIndex((node) => node.backendDOMNodeId === rootBackendNodeId);
    if (rootIndex < 0) {
      throw new Error("Snapshot root is no longer present in the accessibility tree; retry.");
    }
    roots.push(rootIndex);
  } else {
    for (const [index, node] of tree.entries()) {
      if (node.parent === undefined) {
        roots.push(index);
      }
    }
  }
  return { tree, roots: roots.length ? roots : tree.length ? [0] : [] };
}

function shouldIncludeRoleNode(node: RoleTreeNode, options: RoleSnapshotOptions): boolean {
  if (node.transparent) {
    return false;
  }
  const role = node.role.toLowerCase();
  if (options.interactive) {
    return INTERACTIVE_ROLES.has(role) || role === "iframe" || Boolean(node.cursorInfo);
  }
  if (options.compact && STRUCTURAL_ROLES.has(role) && !node.name && !node.ref) {
    return false;
  }
  return true;
}

function roleStateSuffix(node: RawAXNode): string {
  const properties = new Map((node.properties ?? []).map(({ name, value }) => [name, value.value]));
  return ["checked", "disabled", "expanded", "pressed", "selected", "level", "invalid"]
    .flatMap((name) => {
      const value = properties.get(name);
      if (value === true || value === "true") {
        return [` [${name}]`];
      }
      if (
        value === "mixed" ||
        (name === "level" && typeof value === "number") ||
        (name === "invalid" && typeof value === "string" && value !== "false")
      ) {
        return [` [${name}=${value}]`];
      }
      return [];
    })
    .join("");
}

function cursorSuffix(info?: CursorInteractiveInfo): string {
  if (!info) {
    return "";
  }
  const parts = [
    info.hasCursorPointer ? "cursor:pointer" : undefined,
    info.hasOnClick ? "onclick" : undefined,
    info.hasTabIndex ? "tabindex" : undefined,
    info.isEditable ? "contenteditable" : undefined,
    info.hiddenInputType ? `hidden-${info.hiddenInputType}` : undefined,
  ].filter(Boolean);
  return parts.length ? ` [${parts.join(", ")}]` : "";
}

export function renderRoleTree(
  tree: RoleTreeNode[],
  index: number,
  output: string[],
  options: RoleSnapshotOptions,
  state: { truncated: boolean; recordIframePositions?: boolean; flattenInteractive?: boolean },
  depth = 0,
): void {
  const node = tree[index]!;
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return;
  }
  if (depth > ROLE_SNAPSHOT_MAX_DEPTH) {
    state.truncated = true;
    return;
  }
  if (shouldIncludeRoleNode(node, options)) {
    const indent = "  ".repeat(state.flattenInteractive && options.interactive ? 0 : depth);
    const name = node.name ? ` ${JSON.stringify(node.name)}` : "";
    const ref = node.ref ? ` [ref=${node.ref}]` : "";
    const nth = node.nth !== undefined && node.nth > 0 ? ` [nth=${node.nth}]` : "";
    const value = node.value ? ` value=${JSON.stringify(node.value)}` : "";
    const url = node.url ? ` [url=${node.url}]` : "";
    if (state.recordIframePositions && node.ref && node.frameId) {
      // A repeated AX child still expands after its first rendered occurrence.
      node.iframeLineIndex ??= output.length;
    }
    output.push(
      `${indent}- ${node.role}${name}${ref}${nth}${roleStateSuffix(node.raw)}${value}${url}${cursorSuffix(node.cursorInfo)}`,
    );
  }
  for (const child of node.children) {
    renderRoleTree(tree, child, output, options, state, depth + (node.transparent ? 0 : 1));
  }
}
