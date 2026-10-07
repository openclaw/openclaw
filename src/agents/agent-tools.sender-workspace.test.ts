import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { preserveSessionInheritedToolPolicy } from "../config/sessions/session-entry-lineage.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

describe("sender workspace read authority", () => {
  it("contains sender and nested helper reads before skill routing or inline content", async () => {
    await withTempDir("openclaw-sender-skill-", async (parent) => {
      const root = path.join(parent, "repository");
      const outside = path.join(parent, "installed-skill");
      await fs.mkdir(root);
      await fs.mkdir(outside);
      const filePath = path.join(outside, "SKILL.md");
      await fs.writeFile(filePath, "protected outside instructions");
      await fs.writeFile(path.join(root, "proof.txt"), "repository read succeeds");
      await fs.symlink(outside, path.join(root, "escaped-skill"), "dir");
      const skillsSnapshot = {
        prompt: "",
        skills: [{ name: "known-outside" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "known-outside",
            description: "known installed skill",
            filePath,
            baseDir: outside,
            source: "test",
          }),
        ],
      };
      const config = { tools: { fs: { workspaceOnly: true } } };
      const policy = { allow: ["read", "ls", "sessions_spawn"], workspaceOnlyRead: true as const };
      const rootProfile = resolveConversationCapabilityProfile({
        config,
        agentId: "main",
        workspaceDir: root,
        senderId: "guest",
        conversationToolPolicy: policy,
      });
      expect(rootProfile.policy.workspaceOnlyRead).toBe(true);
      expect(rootProfile.policy.inheritedToolPolicySource).toBe("sender");
      const inherited = preserveSessionInheritedToolPolicy({
        inheritedToolPolicyVersion: 1,
        inheritedToolPolicySource: "sender",
        inheritedToolAllow: policy.allow,
        inheritedWorkspaceOnlyRead: true,
      });
      const profiles = [
        rootProfile,
        ...[1, 2].map((spawnDepth) => {
          const sessionKey = `agent:main:subagent:child-${spawnDepth}`;
          return resolveConversationCapabilityProfile({
            config,
            agentId: "main",
            workspaceDir: root,
            sessionKey,
            preparedSessionCapabilityStore: {
              [sessionKey]: {
                sessionId: sessionKey,
                spawnDepth,
                spawnedBy:
                  spawnDepth === 1 ? "agent:main:x:group:guest" : "agent:main:subagent:child-1",
                ...inherited,
              },
            },
          });
        }),
      ];
      for (const profile of profiles) {
        expect(profile.policy.workspaceOnlyRead).toBe(true);
        const read = createOpenClawCodingTools({
          config,
          workspaceDir: root,
          skillsSnapshot,
          conversationCapabilityProfile: profile,
          skillUsagePaths: [
            {
              skillName: "known-outside",
              skillSource: "workspace",
              skillFile: filePath,
              readPath: filePath,
            },
          ],
        }).find((tool) => tool.name === "read")!;
        expect(getTextContent(await read.execute("inside", { path: "proof.txt" }))).toContain(
          "repository read succeeds",
        );
        for (const target of [filePath, "../installed-skill/SKILL.md", "escaped-skill/SKILL.md"]) {
          await expect(read.execute("outside", { path: target })).rejects.toThrow(
            /escapes|outside|symlink/i,
          );
        }
        // Inline bodies, including virtual workspace locators, must not bypass path admission.
        for (const locator of [filePath, "node://node-1/skills/known-outside/SKILL.md"]) {
          const virtual = createOpenClawCodingTools({
            config,
            workspaceDir: root,
            conversationCapabilityProfile: profile,
            skillsSnapshot: {
              ...skillsSnapshot,
              resolvedSkills: [
                {
                  ...skillsSnapshot.resolvedSkills[0]!,
                  filePath: locator,
                  readContent: "protected inline instructions",
                },
              ],
            },
          }).find((tool) => tool.name === "read")!;
          await expect(virtual.execute("inline", { path: locator })).rejects.toThrow();
        }
      }
      // Ordinary authorized agents retain the existing selected external-skill exception.
      const normal = createOpenClawCodingTools({ config, workspaceDir: root, skillsSnapshot }).find(
        (tool) => tool.name === "read",
      )!;
      expect(getTextContent(await normal.execute("normal", { path: filePath }))).toContain(
        "protected outside instructions",
      );
    });
  });
});
