import { describe, expect, it } from "vitest";
import { buildDiscordComponentCustomId, buildDiscordModalCustomId } from "../components.js";
import {
  createDiscordComponentButton,
  createDiscordComponentChannelSelect,
  createDiscordComponentMentionableSelect,
  createDiscordComponentModal,
  createDiscordComponentRoleSelect,
  createDiscordComponentStringSelect,
  createDiscordComponentUserSelect
} from "./agent-components.js";
function asWildcardComponent(value) {
  return value;
}
function createWildcardComponents() {
  const context = {};
  return [
    asWildcardComponent(createDiscordComponentButton(context)),
    asWildcardComponent(createDiscordComponentStringSelect(context)),
    asWildcardComponent(createDiscordComponentUserSelect(context)),
    asWildcardComponent(createDiscordComponentRoleSelect(context)),
    asWildcardComponent(createDiscordComponentMentionableSelect(context)),
    asWildcardComponent(createDiscordComponentChannelSelect(context)),
    asWildcardComponent(createDiscordComponentModal(context))
  ];
}
describe("discord wildcard component registration ids", () => {
  it("uses distinct sentinel customIds instead of a shared literal wildcard", () => {
    const components = createWildcardComponents();
    const customIds = components.map((component) => component.customId);
    expect(customIds.every((id) => id !== "*")).toBe(true);
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
