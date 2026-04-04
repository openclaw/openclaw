// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BrowseSkillCard, InstalledSkillCard, type InstalledSkillData } from "./skill-card";

const workspaceSkill: InstalledSkillData = {
  name: "Local Workflow",
  slug: "local-workflow",
  description: "A workspace-only skill.",
  source: "workspace",
  filePath: "/tmp/workspace/skills/local-workflow/SKILL.md",
  protected: false,
};

describe("skill card icons", () => {
  it("uses the folder icon for workspace skills without emoji", () => {
    const { container } = render(
      <InstalledSkillCard
        skill={workspaceSkill}
        removingSlug={null}
        confirmRemove={null}
        onConfirmRemove={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(container.querySelector('img[src="/icons/folder.png"]')).not.toBeNull();
    expect(container.querySelector('img[src="https://github.com/workspace.png?size=80"]')).toBeNull();
  });

  it("keeps GitHub avatars for browse results from skills.sh sources", () => {
    const { container } = render(
      <BrowseSkillCard
        skill={{
          slug: "nextjs",
          displayName: "Next.js",
          summary: "Official Next.js skill.",
          installs: 42,
          source: "vercel/next.js",
        }}
        isInstalled={false}
        onInstall={() => {}}
      />,
    );

    expect(container.querySelector('img[src="https://github.com/vercel.png?size=80"]')).not.toBeNull();
  });
});
