// Discord tests cover agent components.wildcard plugin behavior.
import { beforeAll, describe, expect, it } from "vitest";

let buildDiscordComponentCustomId: typeof import("../components.js").buildDiscordComponentCustomId;
let buildDiscordModalCustomId: typeof import("../components.js").buildDiscordModalCustomId;
let createDiscordComponentControls: typeof import("./agent-components.js").createDiscordComponentControls;
let createDiscordComponentModal: typeof import("./agent-components.js").createDiscordComponentModal;

beforeAll(async () => {
  ({ buildDiscordComponentCustomId, buildDiscordModalCustomId } = await import("../components.js"));
  ({ createDiscordComponentControls, createDiscordComponentModal } =
    await import("./agent-components.js"));
});

function createWildcardComponents() {
  const context = { cfg: {}, accountId: "default" };
  expect(createDiscordComponentControls).toHaveLength(6);
  return [
    ...createDiscordComponentControls.map((createControl) => createControl(context)),
    createDiscordComponentModal(context),
  ];
}

describe("discord wildcard component registration ids", () => {
  it("uses distinct sentinel customIds instead of a shared literal wildcard", () => {
    const components = createWildcardComponents();
    const customIds = components.map((component) => component.customId);

    expect(customIds.some((id) => id === "*")).toBe(false);
    expect(new Set(customIds).size).toBe(customIds.length);
  });

  it("still resolves sentinel ids and runtime ids through wildcard parser key", () => {
    const components = createWildcardComponents();
    const interactionCustomId = buildDiscordComponentCustomId({ componentId: "sel_test" });
    const interactionModalId = buildDiscordModalCustomId("mdl_test");

    for (const component of components) {
      expect(component.customIdParser(component.customId).key).toBe("*");
      if (component.customId.includes("_modal_")) {
        expect(component.customIdParser(interactionModalId).key).toBe("*");
      } else {
        expect(component.customIdParser(interactionCustomId).key).toBe("*");
      }
    }
  });
});
