import { expect, it } from "vitest";
import { remapInjectedContextFilesToWorkspace } from "./attempt-setup.js";

it("remaps workspace context paths while preserving outside references", () => {
  const files = [
    { path: "/real/workspace/AGENTS.md", content: "agents" },
    { path: "/real/workspace/nested/SOUL.md", content: "soul" },
    { path: "/real/workspace/..context/USER.md", content: "dot-prefixed context" },
    { path: "/outside/README.md", content: "outside" },
  ];
  expect(
    remapInjectedContextFilesToWorkspace({
      files,
      sourceWorkspaceDir: "/real/workspace",
      targetWorkspaceDir: "/sandbox/workspace",
    }),
  ).toEqual([
    { path: "/sandbox/workspace/AGENTS.md", content: "agents" },
    { path: "/sandbox/workspace/nested/SOUL.md", content: "soul" },
    { path: "/sandbox/workspace/..context/USER.md", content: "dot-prefixed context" },
    files[3],
  ]);
});
