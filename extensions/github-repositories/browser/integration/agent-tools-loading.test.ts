import { expect, it } from "vitest";
import { useLazyEnglishTest } from "../../../../ui/src/i18n/lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  {
    surface: "tool panel",
    load: () => import("../../../../ui/src/pages/agents/panels-tools-skills.tsx"),
  },
  {
    surface: "skills panel",
    load: () => import("../../../../ui/src/pages/agents/panels-skills.tsx"),
  },
])("loads agent tool fallback copy with the $surface, preserving GitHub copy", async ({ load }) => {
  const { en, manager } = await loadI18n({ agentTools: { title: "Werkzeugzugriff" } });
  const agentTools = en.agentTools;
  expect(agentTools.disableAll).toBeUndefined();

  const { settingsEnglish } = await import("../../english-api.ts");
  const { registerControlUiEnglish } =
    await import("../../../../ui/src/plugins/control-ui-english.ts");
  registerControlUiEnglish(settingsEnglish);
  await manager.setLocale("de");
  await load();

  expect(en.agentTools).toBe(agentTools);
  expect(manager.t("agentTools.title")).toBe("Werkzeugzugriff");
  expect(manager.t("agentTools.disableAll")).toBe("Disable All");
  expect(manager.t("agentTools.previewTitle")).toBe("Tool preview");
  expect(manager.t("agentTools.githubVerify")).toBe("Verify");

  registerControlUiEnglish(settingsEnglish);
  expect(en.agentTools).toBe(agentTools);
  expect(manager.t("agentTools.disableAll")).toBe("Disable All");
});
