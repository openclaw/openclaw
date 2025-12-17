import { getSignalAdapter } from "../signals.js";
import { directive } from "./directive.js";
/**
 * Efficiently render lists with keyed updates
 * Similar to Lit's repeat or Solid's For
 */
export function repeat(items, keyFn, template) {
    const signals = getSignalAdapter();
    // Create marker
    const marker = document.createComment("repeat");
    // Track current items and their DOM nodes
    const itemMap = new Map();
    let disposeEffect;
    const updateList = () => {
        // Get current items
        const source = typeof items === "function" ? items() : items;
        const currentItems = (source ?? []);
        const parent = marker.parentNode;
        // Can't update if marker not in DOM yet
        if (!parent)
            return;
        // Create a set of current keys for quick lookup
        const currentKeys = new Set();
        const newItemMap = new Map();
        // Process each item
        currentItems.forEach((item, index) => {
            const key = keyFn(item, index);
            currentKeys.add(key);
            // Check if we already have this item
            const existing = itemMap.get(key);
            if (existing) {
                // Update existing item if needed
                if (existing.item !== item) {
                    // Item data changed but key is same - we might want to update
                    // For now, keep the same nodes but update the item reference
                    existing.item = item;
                }
                newItemMap.set(key, existing);
            }
            else {
                // Create new item
                const result = template(item, index);
                const nodes = [];
                // Convert result to nodes
                if (result instanceof Node) {
                    nodes.push(result);
                }
                else if (Array.isArray(result)) {
                    result.forEach((r) => {
                        if (r instanceof Node)
                            nodes.push(r);
                    });
                }
                else if (result != null && result !== "") {
                    nodes.push(document.createTextNode(String(result)));
                }
                // Insert nodes before marker
                nodes.forEach((node) => {
                    parent.insertBefore(node, marker);
                });
                newItemMap.set(key, { nodes, item });
            }
        });
        // Remove items that are no longer in the list
        itemMap.forEach((value, key) => {
            if (!currentKeys.has(key)) {
                // Remove the nodes
                value.nodes.forEach((node) => {
                    if (node.parentNode) {
                        node.parentNode.removeChild(node);
                    }
                });
            }
        });
        // Reorder nodes if needed (only when in DOM)
        let previousNode = marker;
        for (let i = currentItems.length - 1; i >= 0; i--) {
            const item = currentItems[i];
            const key = keyFn(item, i);
            const entry = newItemMap.get(key);
            if (entry) {
                // Move nodes to correct position
                entry.nodes.forEach((node) => {
                    if (node.nextSibling !== previousNode) {
                        parent.insertBefore(node, previousNode);
                    }
                    previousNode = node;
                });
            }
        }
        // Update the item map
        itemMap.clear();
        newItemMap.forEach((value, key) => {
            itemMap.set(key, value);
        });
    };
    return directive(marker, () => {
        if (disposeEffect)
            return;
        disposeEffect = signals.createEffect(updateList);
    }, () => {
        disposeEffect?.();
        disposeEffect = undefined;
        itemMap.forEach((value) => {
            value.nodes.forEach((node) => {
                node.parentNode?.removeChild(node);
            });
        });
        itemMap.clear();
    });
}
//# sourceMappingURL=repeat.js.map