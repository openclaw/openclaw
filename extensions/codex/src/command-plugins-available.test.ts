import { beforeEach, expect, it, vi } from "vitest";
import { splitArgs } from "./command-handler-args.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import {
  buttonCommands,
  fakeCtx,
  inMemoryIO,
  pluginCatalog,
  pluginRuntime,
  pluginSummary,
} from "./command-plugins-management.test-support.js";

function catalogRuntime(description = "Review project notes") {
  const listed = pluginCatalog(
    [
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
    "company-tools",
    "/repo/company/marketplace.json",
  );
  listed.marketplaces.push({
    name: "openai-curated-remote",
    plugins: [
      pluginSummary("github", "openai-curated-remote", {
        availability: "DISABLED_BY_ADMIN",
        interface: { longDescription: "Inspect issues" },
      }),
    ],
  });
  return {
    ...pluginRuntime(),
    list: vi.fn(async () => listed),
  };
}

let runtime: ReturnType<typeof catalogRuntime>;
let io: ReturnType<typeof inMemoryIO>;
beforeEach(() => {
  runtime = catalogRuntime();
  io = inMemoryIO();
});
const search = (...args: string[]) =>
  handleCodexPluginsSubcommand(fakeCtx, ["available", ...args], io, runtime);
const follow = (command: string | undefined) =>
  handleCodexPluginsSubcommand(fakeCtx, splitArgs(command).slice(2), io, runtime);
it("makes every result reachable through the returned page commands", async () => {
  runtime = catalogRuntime("");
  let result = await search();
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
    result = await follow(next);
    expect(result.text).toContain(`page ${page}/4`);
    seen.push(...pluginRows(result.text));
  }
  expect(seen).toHaveLength(37);
  expect(new Set(seen).size).toBe(37);
  expect(result.text).toContain("Showing 31–37 of 37");
  expect(result.text).toContain("github@company-tools");
  const previous = buttonCommands(result).find((command) => command.includes("--page 3"));
  const restored = await follow(previous);
  expect(restored.text).toContain("Showing 21–30 of 37");
  expect(restored.text).not.toContain("github@company-tools");
});

it("round-trips quoted multiword search text through pagination", async () => {
  const query = "Owner's --page notes";
  runtime = catalogRuntime(query);
  const first = await search("--", query);
  const next = buttonCommands(first).find((command) => command.includes("--page 2"));
  const second = await follow(next);
  expect(second.text).toContain("Showing 11–20 of 35");
  expect(second.text).toContain(query);
  expect(second.text).not.toContain("github@");
});

it("gives useful recovery for no matches and a page beyond the results", async () => {
  const empty = await search("missing-plugin");
  expect(empty.text).toContain("No Codex plugins match");
  expect(buttonCommands(empty)).toContain("/codex plugins available");
  const outOfRange = await search("github", "--page", "2");
  expect(outOfRange.text).toContain("No plugin page 2");
  const firstPage = buttonCommands(outOfRange).find((command) => command.includes("--page 1"));
  const recovered = await follow(firstPage);
  expect(recovered.text).toContain("of 2");
  expect(recovered.text).toContain("github@company-tools");
});

it.each([
  [["--page", "0"], fakeCtx, "Usage:"],
  [["x".repeat(101)], fakeCtx, "Usage:"],
  [
    ["github"],
    { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.write"] },
    "Only an owner or operator.admin",
  ],
] satisfies [string[], typeof fakeCtx, string][])(
  "rejects invalid or unauthorized discovery: %j",
  async (args, ctx, message) => {
    const result = await handleCodexPluginsSubcommand(ctx, ["available", ...args], io, runtime);
    expect(result.text).toContain(message);
    expect(runtime.workspaceDir).not.toHaveBeenCalled();
    expect(runtime.list).not.toHaveBeenCalled();
  },
);
