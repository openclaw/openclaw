import type { Page } from "playwright";

/** Keep requested AX nodes subscribed without polling/serializing the tree in timing windows. */
export async function createEngineAccessibilityObservation(page: Page) {
  const session = await page.context().newCDPSession(page);
  let updates = 0;
  let updatedNodes = 0;
  let loads = 0;
  session.on("Accessibility.nodesUpdated", ({ nodes }) => {
    updates++;
    updatedNodes += nodes.length;
  });
  session.on("Accessibility.loadComplete", () => {
    loads++;
  });
  await session.send("Accessibility.enable");
  const snapshot = async () => {
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    const exposed = nodes.filter((node) => !node.ignored);
    const roles: Record<string, number> = {};
    for (const node of exposed) {
      const role = String(node.role?.value ?? "unknown");
      roles[role] = (roles[role] ?? 0) + 1;
    }
    if (!exposed.some((node) => node.role?.value === "RootWebArea")) {
      throw new Error("Forced accessibility did not expose a document AX tree");
    }
    return {
      nodes: nodes.length,
      exposedNodes: exposed.length,
      roles,
      inputs: exposed
        .filter((node) => ["textbox", "combobox", "searchbox"].includes(String(node.role?.value)))
        .map((node) => ({
          role: node.role?.value,
          name: node.name?.value,
          value: node.value?.value,
        })),
      liveRegions: exposed
        .filter(
          (node) =>
            ["log", "status", "alert"].includes(String(node.role?.value)) ||
            node.properties?.some((property) => property.name === "live"),
        )
        .map((node) => ({
          role: node.role?.value,
          name: node.name?.value,
          properties: Object.fromEntries(
            (node.properties ?? [])
              .filter((property) => ["live", "atomic", "relevant", "busy"].includes(property.name))
              .map((property) => [property.name, property.value.value]),
          ),
        })),
    };
  };
  return {
    snapshot,
    reset: () => {
      updates = 0;
      updatedNodes = 0;
      loads = 0;
    },
    finish: async () => ({ updates, updatedNodes, loads, tree: await snapshot() }),
    dispose: () => session.detach(),
  };
}
