import { expect, it, vi } from "vitest";

const loadedYaml = vi.hoisted(() => vi.fn());
vi.mock("yaml", async (importOriginal) => {
  const yaml = await importOriginal<typeof import("yaml")>();
  loadedYaml();
  return yaml;
});

it("loads the YAML parser for skill frontmatter without loading it for model catalog setup", async () => {
  await import("./prepared-model-catalog.js");
  await import("../skills/runtime/env-overrides.js");
  expect(loadedYaml).not.toHaveBeenCalled();

  const { parseSkillFrontmatter } = await import("../skills/loading/frontmatter.js");
  expect(parseSkillFrontmatter("---\nname: &name demo\ndescription: *name\n---")).toEqual({
    name: "demo",
    description: "demo",
  });
  expect(loadedYaml).toHaveBeenCalledOnce();
});
