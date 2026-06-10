import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadSkills } from "./harness/skills.js";
import { compileSystemPrompt } from "./harness/system-prompt.js";
import { LlmOpsSubsystem } from "./llmops/index.js";

describe("LLMOps Prompt Registry Content Inspection Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("👁️ should display the retrieved AGENTS framework prompt canvas", async () => {
    const mockAgentsContent =
      "# LEXGUARD SYSTEM MANIFEST\n" +
      "Role: Senior Compliance Officer Enclave\n" +
      "Directives:\n" +
      "  - Audit incoming cross-context payloads for compliance drift.\n" +
      "  - Execute node isolation workflows on security anomalies.";

    const mockTemplate = {
      compile: vi.fn().mockReturnValue(mockAgentsContent),
    };

    vi.spyOn(LlmOpsSubsystem, "getInstance").mockReturnValue({
      tracker: {
        config: { prompts: { enabled: true } },
        getPrompt: vi.fn().mockResolvedValue(mockTemplate),
      },
    } as any);

    // 🎯 FIX 1: Pass empty/target promptConfig as 3rd arg, move contextVars to 4th arg
    const compiledPrompt = await compileSystemPrompt(
      "/dummy/path/AGENTS.md",
      [],
      { path: "workspace/agents/lexguard-compliance-service/AGENTS", label: "production" },
      { sessionId: "test-session-lexguard" },
    );

    console.log(`\n======================================================================`);
    console.log(`📡 [LANGFUSE REGISTRY RESIDENCY] -> openclaw-agents-manifest`);
    console.log(`======================================================================`);
    console.log(compiledPrompt);
    console.log(`======================================================================\n`);

    expect(compiledPrompt).toContain("LEXGUARD SYSTEM MANIFEST");
  });

  it("👁️ should display the retrieved SKILL tool instruction canvas", async () => {
    const mockSkillContent =
      "---\n" +
      "name: contract-risk-scanner\n" +
      "description: 'Deep text scanner for validation checks'\n" +
      "---\n" +
      "# TOOL GUIDELINES\n" +
      "Execute line-by-line regression scans over target PDF document assets.";

    const mockTemplate = {
      compile: vi.fn().mockReturnValue(mockSkillContent),
    };

    const mockGetPrompt = vi.fn().mockResolvedValue(mockTemplate);

    vi.spyOn(LlmOpsSubsystem, "getInstance").mockReturnValue({
      tracker: {
        config: { prompts: { enabled: true } },
        getPrompt: mockGetPrompt,
      },
    } as any);

    const mockEnv = {
      fileInfo: vi
        .fn()
        .mockResolvedValue({
          ok: true,
          value: { kind: "directory", path: "/test/skills/risk-checker" },
        }),
      listDir: vi
        .fn()
        .mockResolvedValue({
          ok: true,
          value: [{ name: "SKILL.md", kind: "file", path: "/test/skills/risk-checker/SKILL.md" }],
        }),
      readTextFile: vi.fn().mockResolvedValue({ ok: true, value: mockSkillContent }),
    };

    const result = await loadSkills(mockEnv as any, "/test/skills/risk-checker");

    console.log(`\n======================================================================`);
    console.log(`🛠️ [LANGFUSE REGISTRY RESIDENCY] -> workspace/skills/contract-risk-scanner`);
    console.log(`======================================================================`);
    console.log(result.skills[0].content);
    console.log(`======================================================================\n`);

    // 🎯 FIX 2: Assert against the frontmatter-extracted name "contract-risk-scanner"
    expect(mockGetPrompt).toHaveBeenCalledWith(
      "workspace/skills/contract-risk-scanner",
      undefined,
      expect.any(Object),
    );
    expect(result.skills[0].content).toContain("TOOL GUIDELINES");
  });
});
