import { describe, expect, it, vi } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import { splitArgs } from "./command-handler-args.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import {
  buttonCommands,
  fakeCtx,
  inMemoryIO,
  pluginRuntime,
  pluginSummary,
} from "./command-plugins-management.test-support.js";

function catalogRuntime(description = "Review project notes") {
  return {
    ...pluginRuntime(),
    list: vi.fn(
      async () =>
        ({
          marketplaces: [
            {
              name: "company-tools",
              path: "/repo/company/marketplace.json",
              plugins: [
                ...Array.from({ length: 35 }, (_, index) =>
                  pluginSummary(`catalog-${String(index).padStart(2, "0")}`, "company-tools", {
                    interface: { shortDescription: description },
                  }),
                ),
                pluginSummary("github", "company-tools", {
                  installed: true,
                  enabled: true,
                  interface: {
                    displayName: "Repository Companion",
                    developerName: "Example Labs",
                    shortDescription: "Read pull requests",
                  },
                }),
              ],
            },
            {
              name: "openai-curated-remote",
              plugins: [
                pluginSummary("github", "openai-curated-remote", {
                  availability: "DISABLED_BY_ADMIN",
                  interface: { longDescription: "Inspect issues" },
                }),
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        }) satisfies v2.PluginListResponse,
    ),
  };
}

describe("Codex available plugin search and pages", () => {
  function search(runtime: ReturnType<typeof catalogRuntime>, args: string[]) {
    return handleCodexPluginsSubcommand(fakeCtx, ["available", ...args], inMemoryIO(), runtime);
  }
  function follow(runtime: ReturnType<typeof catalogRuntime>, command: string | undefined) {
    return handleCodexPluginsSubcommand(
      fakeCtx,
      splitArgs(command).slice(2),
      inMemoryIO(),
      runtime,
    );
  }
  it("makes every result reachable through the returned page commands", async () => {
    const runtime = catalogRuntime("");
    let result = await search(runtime, []);
    expect(result.text).toContain("Showing 1–10 of 37");
    expect(result.text).toContain("Publisher: Not provided. No description provided.");
    expect(result.text).not.toContain("catalog-10@");
    const pluginRows = (text: string | undefined) =>
      [...(text ?? "").matchAll(/^- (?:[^\n]*? — )?([a-z0-9-]+@[a-z0-9-]+) \(/gm)].map(
        (match) => match[1],
      );
    const seen = pluginRows(result.text);
    for (const page of [2, 3, 4]) {
      const next = buttonCommands(result).find((command) => command.includes(`--page ${page}`));
      expect(next).toBeDefined();
      result = await follow(runtime, next);
      expect(result.text).toContain(`page ${page}/4`);
      seen.push(...pluginRows(result.text));
    }
    expect(seen).toHaveLength(37);
    expect(new Set(seen).size).toBe(37);
    expect(result.text).toContain("Showing 31–37 of 37");
    expect(result.text).toContain("github@company-tools");
    const previous = buttonCommands(result).find((command) => command.includes("--page 3"));
    const restored = await follow(runtime, previous);
    expect(restored.text).toContain("Showing 21–30 of 37");
    expect(restored.text).not.toContain("github@company-tools");
  });

  it("round-trips quoted multiword search text through pagination", async () => {
    const query = "Owner's --page notes";
    const runtime = catalogRuntime(query);
    const first = await search(runtime, ["--", query]);
    const next = buttonCommands(first).find((command) => command.includes("--page 2"));
    const second = await follow(runtime, next);
    expect(second.text).toContain("Showing 11–20 of 35");
    expect(second.text).toContain(query);
    expect(second.text).not.toContain("github@");
  });

  it("gives useful recovery for no matches and a page beyond the results", async () => {
    const runtime = catalogRuntime();
    const empty = await search(runtime, ["missing-plugin"]);
    expect(empty.text).toContain("No Codex plugins match");
    expect(buttonCommands(empty)).toContain("/codex plugins available");
    const outOfRange = await search(runtime, ["github", "--page", "2"]);
    expect(outOfRange.text).toContain("No plugin page 2");
    const firstPage = buttonCommands(outOfRange).find((command) => command.includes("--page 1"));
    const recovered = await follow(runtime, firstPage);
    expect(recovered.text).toContain("of 2");
    expect(recovered.text).toContain("github@company-tools");
  });

  it.each([["--page", "0"], ["x".repeat(101)]])(
    "rejects invalid options before discovery: %j",
    async (...args) => {
      const runtime = catalogRuntime();
      const result = await search(runtime, args);
      expect(result.text).toContain("Usage:");
      expect(runtime.workspaceDir).not.toHaveBeenCalled();
      expect(runtime.list).not.toHaveBeenCalled();
    },
  );

  it("checks operator authority before searching", async () => {
    const runtime = catalogRuntime();
    const result = await handleCodexPluginsSubcommand(
      { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.write"] },
      ["available", "github"],
      inMemoryIO(),
      runtime,
    );
    expect(result.text).toContain("Only an owner or operator.admin");
    expect(runtime.workspaceDir).not.toHaveBeenCalled();
    expect(runtime.list).not.toHaveBeenCalled();
  });
});
